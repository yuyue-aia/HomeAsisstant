/**
 * load_skill 工具：让 LLM 按需把某个 SKILL.md 的正文加载进上下文。
 *
 * 设计要点：
 * - skill 列表在 runtime 启动时一次扫描完成；本工具仅做按 name 查找+读文件，
 *   不做任何业务判断（业务规则全在 SKILL.md 里）。
 * - 返回 directory 字段，LLM 后续如需读取 skill 内附带的 scripts/references/assets，
 *   可用 read_file 工具按这个目录拼路径访问。
 */
import { tool } from '@openai/agents';
import { z } from 'zod';
import type { VoiceAgentContext } from '../types';
import { loadSkillBody, type SkillMeta } from '../skills/skill-loader';

const params = z.object({
  name: z
    .string()
    .describe('Skill name to load, must match one of the names listed in 【可用技能】.'),
});

export function createLoadSkillTool(skills: SkillMeta[]) {
  return tool<typeof params, VoiceAgentContext>({
    name: 'load_skill',
    description:
      'Load the full SKILL.md instructions for a named skill. Call this when a user request matches a skill description listed in 【可用技能】, before executing related tools.',
    parameters: params,
    async execute({ name }) {
      const result = loadSkillBody(skills, name);
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
      return {
        ok: true,
        name: result.name,
        directory: result.directory,
        instructions: result.body,
      };
    },
  });
}
