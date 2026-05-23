import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tool } from '@openai/agents';
import { z } from 'zod';
import type { VoiceAgentContext } from '../types';

const readFileParameters = z.object({
  path: z.string().min(1).describe('File path under the current workspace. Relative paths are preferred.'),
  maxChars: z.number().int().min(1).max(50_000).optional().describe('Maximum characters to return. Default 20000.'),
});

const writeFileParameters = z.object({
  path: z.string().min(1).describe('File path under the current workspace. Relative paths are preferred.'),
  content: z.string().max(100_000).describe('UTF-8 text content to write.'),
  mode: z.enum(['overwrite', 'append']).optional().describe('Write mode. Default overwrite.'),
});

type FileToolResponse = {
  ok: boolean;
  path: string;
  message: string;
  content?: string;
  truncated?: boolean;
  bytes?: number;
};

const WORKSPACE_ROOT = process.cwd();
const MAX_READ_BYTES = 1_000_000;
const DEFAULT_MAX_CHARS = 20_000;
const DENIED_DIRS = new Set(['.git', '.codebuddy', 'node_modules']);

function resolveWorkspaceFile(inputPath: string): { absolutePath: string; relativePath: string } {
  if (inputPath.includes('\0')) {
    throw new Error('文件路径包含非法字符');
  }

  const absolutePath = path.resolve(WORKSPACE_ROOT, inputPath);
  const relativePath = path.relative(WORKSPACE_ROOT, absolutePath);

  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error('只能访问当前工作区内的文件');
  }

  const segments = relativePath.split(path.sep);
  if (segments.some((segment) => DENIED_DIRS.has(segment))) {
    throw new Error('不允许访问受保护目录');
  }

  const baseName = path.basename(absolutePath);
  if (baseName === '.env' || baseName.startsWith('.env.')) {
    throw new Error('不允许访问环境变量文件');
  }

  return { absolutePath, relativePath };
}

export const readFileTool = tool<typeof readFileParameters, VoiceAgentContext, FileToolResponse>({
  name: 'read_file',
  description: 'Read a UTF-8 text file from the current workspace. Protected files and directories are blocked.',
  parameters: readFileParameters,
  async execute({ path: filePath, maxChars }) {
    try {
      const target = resolveWorkspaceFile(filePath);
      const stat = await fs.stat(target.absolutePath);
      if (!stat.isFile()) {
        return { ok: false, path: target.relativePath, message: '目标不是文件' };
      }
      if (stat.size > MAX_READ_BYTES) {
        return { ok: false, path: target.relativePath, message: '文件过大，拒绝读取' };
      }

      const content = await fs.readFile(target.absolutePath, 'utf8');
      if (content.includes('\0')) {
        return { ok: false, path: target.relativePath, message: '疑似二进制文件，拒绝读取' };
      }

      const limit = maxChars ?? DEFAULT_MAX_CHARS;
      return {
        ok: true,
        path: target.relativePath,
        message: '读取成功',
        content: content.slice(0, limit),
        truncated: content.length > limit,
        bytes: Buffer.byteLength(content, 'utf8'),
      };
    } catch (error) {
      return { ok: false, path: filePath, message: `读取失败：${(error as Error).message}` };
    }
  },
});

export const writeFileTool = tool<typeof writeFileParameters, VoiceAgentContext, FileToolResponse>({
  name: 'write_file',
  description: 'Write UTF-8 text to a file in the current workspace. Supports overwrite or append. Protected files and directories are blocked.',
  parameters: writeFileParameters,
  async execute({ path: filePath, content, mode }) {
    try {
      const target = resolveWorkspaceFile(filePath);
      await fs.mkdir(path.dirname(target.absolutePath), { recursive: true });

      if ((mode ?? 'overwrite') === 'append') {
        await fs.appendFile(target.absolutePath, content, 'utf8');
      } else {
        await fs.writeFile(target.absolutePath, content, 'utf8');
      }

      return {
        ok: true,
        path: target.relativePath,
        message: `${mode ?? 'overwrite'} 写入成功`,
        bytes: Buffer.byteLength(content, 'utf8'),
      };
    } catch (error) {
      return { ok: false, path: filePath, message: `写入失败：${(error as Error).message}` };
    }
  },
});
