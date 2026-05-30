/**
 * Agent Skills 加载器（遵循 agentskills.io 开放标准的最小实现）。
 *
 * 物理结构：
 *   skills/
 *     <name>/
 *       SKILL.md   ← YAML frontmatter (name + description) + Markdown 正文
 *
 * 两种装载模式（由 AppConfig.agentSkillsLoadMode 选择）：
 *   - eager：启动时一次性把所有 SKILL.md 正文读出来内联到 system prompt；
 *   - lazy：仅注入 name+description 清单，LLM 调 load_skill 按需取正文。
 *
 * 不论哪种模式，本模块的输出都必须是"字节级稳定"的——
 * 同一份 skills/ 目录在任何机器、任何时间多次启动，得到的 prompt 段落
 * 必须完全一致，否则会击穿上游网关的 prompt cache，把 13KB 前缀变成
 * 每次请求都要重算的开销。
 *
 * 稳定性保障：
 *   1. discoverSkills() 输出按 name 字典序排序，不依赖 readdir 顺序；
 *   2. 所有文件读取归一化 CRLF→LF 并去掉文件末尾空白；
 *   3. frontmatter 不进 prompt（只取 body），避免新增字段污染缓存。
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

export interface SkillFull extends SkillMeta {
  /** SKILL.md 去掉 frontmatter 后的正文，已归一化换行符并去除末尾空白。 */
  body: string;
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
 * 稳定读文件：
 * - utf8 解码；
 * - CRLF / CR 全部归一化成 LF（防御 Windows checkout 带来的换行符差异）；
 * - 去掉文件末尾的空白字符（不同编辑器自动加/去尾随换行的差异）。
 *
 * 这三步保证同一份内容在不同操作系统/编辑器下产出的字节序列完全一致，
 * 是上游 prompt cache 命中的前提。
 */
export function readStable(file: string): string {
  return readFileSync(file, 'utf8').replace(/\r\n?/g, '\n').replace(/\s+$/, '');
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
 *
 * 返回前按 name 字典序排序，保证 system prompt 段落字节稳定。
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
        raw = readStable(file);
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

  // 关键：按 name 字典序排序，去除 readdir 在不同文件系统下的顺序差异，
  // 保证 system prompt 字节稳定（prompt cache 命中前提）。
  // 固定使用 'en' locale，避免不同机器 LANG 环境变量导致排序结果不同。
  result.sort((a, b) => a.name.localeCompare(b.name, 'en'));

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
    const raw = readStable(target.file);
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

/**
 * Eager 模式启动时调用：把每个 skill 的 body 一次性读到内存，避免运行中文件被改导致
 * prompt 漂移（prompt cache 击穿），同时省掉每次 run 的磁盘 I/O。
 */
export function loadAllSkillBodies(skills: SkillMeta[]): SkillFull[] {
  return skills.map((s) => {
    const raw = readStable(s.file);
    const { body } = parseFrontmatter(raw);
    return { ...s, body: body.trim() };
  });
}

/**
 * 拼装 lazy 模式的 skill 清单（用作 system.lazy.md 中 {{SKILLS_LIST}} 的替换值）。
 * 每行 `- name: description`，skills 已在 discoverSkills 里排好序，这里不再二次排序。
 */
export function buildSkillsListBlock(skills: SkillMeta[]): string {
  return skills.map((s) => `- ${s.name}: ${s.description}`).join('\n');
}

/**
 * 拼装 eager 模式的 skill 全文段（用作 system.eager.md 中 {{SKILLS_INLINE}} 的替换值）。
 * 每个 skill 之间用同样的分隔线，便于 LLM 切换上下文；
 * 同时保留 description 作为"适用场景"提示，让 LLM 知道何时该参照该段规则。
 */
export function buildSkillsInlineBlock(skills: SkillFull[]): string {
  return skills
    .map((s) =>
      [
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        `### 技能：${s.name}`,
        `适用场景：${s.description}`,
        '',
        s.body,
      ].join('\n'),
    )
    .join('\n\n');
}
