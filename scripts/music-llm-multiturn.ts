/**
 * 音乐 LLM 多轮链路冒烟：在同一个 OpenAIAgentRuntime 实例里连说多句话，
 * 验证"放歌 → 暂停 → 继续"在 LLM 有上下文时能正确触发 tool。
 *
 * 模拟真实 DialogSession 内的连续对话（ask 命令每次都新建 runtime，所以丢上下文）。
 */
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config/env';
import { OpenAIAgentRuntime } from '../src/agent/openai-agent-runtime';
import { execFileSync } from 'node:child_process';

async function main(): Promise<void> {
  const config = loadConfig();
  const runtime = new OpenAIAgentRuntime(config);
  const sessionId = randomUUID();

  // 清空磁盘 history，让本次跑全在内存里
  runtime.resetHistory();

  const turns = [
    '放周杰伦的稻香',
    '暂停',
    '继续',
    '停了吧',
  ];

  for (const text of turns) {
    console.log(`\n>> ${text}`);
    const start = Date.now();
    const r = await runtime.run({ sessionId, text });
    console.log(`<< (${Date.now() - start}ms) ${r.text}`);

    // 看一眼播放器实际状态
    try {
      const out = execFileSync('ncm-cli', ['state', '--output', 'json'], {
        encoding: 'utf8',
      });
      const j = JSON.parse(out);
      const s = j.state || {};
      console.log(`   [player] status=${s.status} title=${s.title ?? '∅'}`);
    } catch (e) {
      console.log(`   [player] state probe failed`);
    }

    // 给 pause/resume 留点时间
    await new Promise((r) => setTimeout(r, 500));
  }

  // 清场
  try {
    execFileSync('ncm-cli', ['stop'], { encoding: 'utf8' });
  } catch {}

  await runtime.shutdown();
  process.exit(0);
}

main().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
