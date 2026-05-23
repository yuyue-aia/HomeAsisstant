/**
 * Agent Skills 加载器（遵循 agentskills.io 开放标准的最小实现）。
 *
 * 物理结构：
 *   skills/
 *     <name>/
 *       SKILL.md   ← YAML frontmatter (name + description) + Markdown 正文
 *
 * 渐进式披露（Progressive Disclosure）：
 *   1. Discovery：启动时扫描所有 SKILL.md，仅解析 frontmatter，把 name+description
 *      作为清单注入到主 prompt（每个 skill 仅一行）。
 *   2. Activation：LLM 判断需要某 skill 时，调用 `load_skill` 工具拿到完整 SKILL.md。
 *   3. Execution：按 SKILL.md 指示干活；如需附带资源（scripts/references/assets）
 *      用通用文件读取工具按返回的 directory 路径访问。
 *
 * 这样主 prompt 只剩"通用规则 + skill 清单"，单个领域指南只在被需要时才进上下文，
 * 既省 token 也避免不同领域规则互相干扰。
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { logger } from '../../common/logger';

export interface SkillMeta {
  /** 唯一标识，必须与目录名一致（便于排错），由 frontmatter 提供。 */
  name: string;
  /** 何时使用本 skill 的一句话说明，给 LLM 看，决定它会不会主动调 load_skill。 */
  description: string;
  /** SKILL.md 所在目录的绝对路径，便于后续读附带资源。 */
  directory: string;
  /** SKILL.md 文件的绝对路径。 */
  file: string;
}

/** 默认从仓库根目录的 skills/ 扫描，可通过环境变量覆盖（多目录用冒号分隔）。 */
function getSkillSearchPaths(): string[] {
  const fromEnv = process.env.AGENT_SKILLS_DIR;
  if (fromEnv && fromEnv.trim()) {
    return fromEnv
      .split(':')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => resolve(p));
  }
  return [resolve('skills')];
}

/**
 * 解析 SKILL.md 的 YAML frontmatter。
 *
 * 不引第三方 yaml 依赖：frontmatter 字段就 name/description 两个固定的、
 * 一行一个 `key: value` 的简单格式，手写解析就够，避免供应链。
 */
function parseFrontmatter(content: string): {
  meta: Record<string, string>;
  body: string;
} {
  // 必须以 `---` 开头，否则视为没有 frontmatter
  if (!content.startsWith('---')) {
    return { meta: {}, body: content };
  }
  // 找第二个 `---` 作为 frontmatter 结束
  const endIdx = content.indexOf('\n---', 3);
  if (endIdx === -1) {
    return { meta: {}, body: content };
  }
  const fm = content.slice(3, endIdx).trim();
  // 跳过结束的 `\n---` 以及随后的换行
  let bodyStart = endIdx + 4;
  if (content[bodyStart] === '\n') bodyStart += 1;
  const body = content.slice(bodyStart);

  const meta: Record<string, string> = {};
  for (const rawLine of fm.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    // 去掉值上可能的成对引号
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) meta[key] = value;
  }
  return { meta, body };
}

/**
 * 扫描指定目录下的所有 skill。
 *
 * 跳过：不是目录的条目、没有 SKILL.md 的目录、frontmatter 缺 name/description 的 skill。
 * 同名冲突：先发现的优先（便于将来项目级 skills 覆盖全局 skills）。
 */
export function discoverSkills(): SkillMeta[] {
  const result: SkillMeta[] = [];
  const seen = new Set<string>();

  for (const root of getSkillSearchPaths()) {
    if (!existsSync(root)) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch (error) {
      logger.warn('skills.discover.read_dir_failed', {
        root,
        error: (error as Error).message,
      });
      continue;
    }

    for (const entry of entries) {
      const dir = join(root, entry);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      const file = join(dir, 'SKILL.md');
      if (!existsSync(file)) continue;

      let raw: string;
      try {
        raw = readFileSync(file, 'utf8');
      } catch (error) {
        logger.warn('skills.discover.read_file_failed', {
          file,
          error: (error as Error).message,
        });
        continue;
      }

      const { meta } = parseFrontmatter(raw);
      const name = meta.name?.trim();
      const description = meta.description?.trim();
      if (!name || !description) {
        logger.warn('skills.discover.missing_frontmatter', { file });
        continue;
      }
      if (seen.has(name)) {
        logger.info('skills.discover.duplicate_skipped', { name, file });
        continue;
      }
      seen.add(name);
      result.push({ name, description, directory: dir, file });
    }
  }

  logger.info('skills.discover.done', {
    count: result.length,
    skills: result.map((s) => s.name),
  });
  return result;
}

/**
 * 读取并返回某 skill 的 SKILL.md 正文（去掉 frontmatter，因为 LLM 已在清单里看过了）。
 * 找不到时返回错误对象，让 LLM 能自己说明情况。
 */
export function loadSkillBody(
  skills: SkillMeta[],
  name: string,
): { ok: true; name: string; directory: string; body: string } | { ok: false; error: string } {
  const target = skills.find(
    (s) => s.name.toLowerCase() === name.toLowerCase().trim(),
  );
  if (!target) {
    return {
      ok: false,
      error: `Skill '${name}' not found. Available: ${skills.map((s) => s.name).join(', ') || '(none)'}`,
    };
  }
  try {
    const raw = readFileSync(target.file, 'utf8');
    const { body } = parseFrontmatter(raw);
    return {
      ok: true,
      name: target.name,
      directory: target.directory,
      body: body.trim(),
    };
  } catch (error) {
    return {
      ok: false,
      error: `Failed to read skill '${name}': ${(error as Error).message}`,
    };
  }
}

/** 把 skills 清单格式化成主 prompt 里的 `<available_skills>` 段落。 */
export function buildSkillsPromptSection(skills: SkillMeta[]): string {
  if (skills.length === 0) return '';
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`).join('\n');
  return `
【可用技能】
当用户请求匹配下列某个技能的描述时，先调用 load_skill 工具读取它的详细指令再执行。
不要凭印象猜测技能里的规则；同一轮里同一个技能只需加载一次。

${lines}
`.trim();
}
