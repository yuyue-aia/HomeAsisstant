/**
 * System Prompt 组装器：按加载模式选不同模板，替换占位符产出最终 instructions。
 *
 * 设计要点：
 * - 模板外置在 prompts/ 目录（仓库根），文案改动不需要动代码；
 * - 两种模式各用独立模板（system.eager.md / system.lazy.md），不通过条件分支
 *   在同一段文案里塞 if/else，避免一改一处坏一处；
 * - base 段（system.base.md）两种模式共用，永远拼在最前面，作为最稳定的缓存前缀；
 * - 输出做归一化（去尾随空白），保证字节级稳定，命中上游 prompt cache。
 */
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  type SkillMeta,
  type SkillFull,
  buildSkillsInlineBlock,
  buildSkillsListBlock,
} from './skills/skill-loader';

export type SkillsLoadMode = 'eager' | 'lazy';

export interface BuildSystemPromptOptions {
  mode: SkillsLoadMode;
  skills: SkillMeta[];
  /** mode === 'eager' 时必传：所有 skill 的正文（已 readStable 归一化）。 */
  skillsFull?: SkillFull[];
  /** 模板目录，默认 ./prompts。 */
  promptsDir?: string;
}

export interface BuildSystemPromptResult {
  instructions: string;
  /** sha256 前 12 位，用于启动日志/排查 cache 命中。 */
  fingerprint: string;
  bytes: number;
}

function readTemplate(file: string): string {
  // 读模板时同样归一化 CRLF→LF + trim 末尾，与 skill-loader.readStable 行为一致，
  // 防止编辑器/checkout 阶段引入的不可见字节差异击穿缓存。
  return readFileSync(file, 'utf8').replace(/\r\n?/g, '\n').replace(/\s+$/, '');
}

/**
 * 严格替换：占位符必须出现且只替换一次。缺占位符 / 多占位符都直接抛错——
 * 这是配置错误，宁可启动失败也别在线上无声生成残缺 prompt。
 */
function strictReplace(template: string, placeholder: string, value: string): string {
  const idx = template.indexOf(placeholder);
  if (idx === -1) {
    throw new Error(`Prompt template missing placeholder: ${placeholder}`);
  }
  if (template.indexOf(placeholder, idx + placeholder.length) !== -1) {
    throw new Error(`Prompt template has duplicate placeholder: ${placeholder}`);
  }
  return template.slice(0, idx) + value + template.slice(idx + placeholder.length);
}

export function buildSystemPrompt(opts: BuildSystemPromptOptions): BuildSystemPromptResult {
  const dir = resolve(opts.promptsDir ?? 'prompts');

  const base = readTemplate(join(dir, 'system.base.md'));

  let modeSection: string;
  if (opts.mode === 'eager') {
    if (!opts.skillsFull) {
      throw new Error("buildSystemPrompt: skillsFull is required when mode === 'eager'");
    }
    const tpl = readTemplate(join(dir, 'system.eager.md'));
    modeSection = strictReplace(tpl, '{{SKILLS_INLINE}}', buildSkillsInlineBlock(opts.skillsFull));
  } else {
    const tpl = readTemplate(join(dir, 'system.lazy.md'));
    modeSection = strictReplace(tpl, '{{SKILLS_LIST}}', buildSkillsListBlock(opts.skills));
  }

  // 没有任何 skill 时，跳过模式段，直接回 base，避免冒出空的【技能规则】标题。
  const instructions = opts.skills.length === 0 ? base : `${base}\n\n${modeSection}`;

  const fingerprint = createHash('sha256').update(instructions).digest('hex').slice(0, 12);
  return { instructions, fingerprint, bytes: Buffer.byteLength(instructions, 'utf8') };
}
