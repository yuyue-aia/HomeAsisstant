#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig, requireOpenAIConfig } from '../config/env';
import { OpenAIAgentRuntime } from '../agent/openai-agent-runtime';
import { VoiceService } from './voice-service';

/**
 * 命令行入口：
 *   home-voice start                    前台运行（Ctrl+C 退出）
 *   home-voice start --daemon           后台运行（detached）
 *   home-voice stop                     停止后台进程
 *   home-voice status                   查询后台进程状态
 *   home-voice logs [-f]                查看后台日志
 *   home-voice ask "问题"               单次问答（不启用语音链路）
 */

const RUNTIME_DIR = path.resolve('.runtime');
const PID_FILE = path.join(RUNTIME_DIR, 'voice.pid');
const LOG_FILE = path.join(RUNTIME_DIR, 'voice.log');

function ensureRuntimeDir(): void {
  if (!existsSync(RUNTIME_DIR)) mkdirSync(RUNTIME_DIR, { recursive: true });
}

function readPid(): number | undefined {
  if (!existsSync(PID_FILE)) return undefined;
  const raw = readFileSync(PID_FILE, 'utf8').trim();
  const pid = Number(raw);
  return Number.isFinite(pid) && pid > 0 ? pid : undefined;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// commands
// ============================================================

async function cmdStartForeground(): Promise<void> {
  const service = new VoiceService();
  service.start();

  const shutdown = async (signal: string) => {
    console.log(`\n收到 ${signal}，正在退出…`);
    await service.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

function cmdStartDaemon(): void {
  ensureRuntimeDir();

  const existing = readPid();
  if (existing && isAlive(existing)) {
    console.error(`已有后台进程在运行（pid=${existing}）。如需重启请先 \`npm run stop\`。`);
    process.exit(1);
  }

  // 用 stdout/stderr 重定向到 LOG_FILE，detach 后父进程立刻退出
  const out = openSync(LOG_FILE, 'a');
  const err = openSync(LOG_FILE, 'a');

  // 重新调用自己；要传 process.execArgv（tsx 通过它注入 loader），
  // 否则后台 node 进程无法识别 .ts 文件。
  const child = spawn(
    process.execPath,
    [...process.execArgv, process.argv[1], 'start', '--foreground', '--daemon-child'],
    {
      detached: true,
      stdio: ['ignore', out, err],
      env: { ...process.env, HOME_VOICE_DAEMON: '1' },
      cwd: process.cwd(),
    },
  );

  if (typeof child.pid !== 'number') {
    console.error('启动后台进程失败');
    process.exit(1);
  }

  writeFileSync(PID_FILE, String(child.pid), 'utf8');
  child.unref();

  console.log(`后台服务已启动，pid=${child.pid}`);
  console.log(`日志文件: ${LOG_FILE}`);
  console.log('可使用 `npm run logs` 实时查看，或 `npm run stop` 停止。');
}

function cmdStop(): void {
  const pid = readPid();
  if (!pid) {
    console.log('未发现后台进程（无 pid 文件）。');
    return;
  }
  if (!isAlive(pid)) {
    console.log(`pid=${pid} 已不存在，清理 pid 文件。`);
    try {
      unlinkSync(PID_FILE);
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`已向 pid=${pid} 发送 SIGTERM。`);
  } catch (error) {
    console.error(`停止失败：${(error as Error).message}`);
    process.exit(1);
  }
  // 等待最多 5s
  const deadline = Date.now() + 5000;
  const wait = () => {
    if (!isAlive(pid)) {
      try {
        unlinkSync(PID_FILE);
      } catch {
        /* ignore */
      }
      console.log('已退出。');
      return;
    }
    if (Date.now() >= deadline) {
      console.warn('5 秒内未退出，发送 SIGKILL。');
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* ignore */
      }
      try {
        unlinkSync(PID_FILE);
      } catch {
        /* ignore */
      }
      return;
    }
    setTimeout(wait, 200);
  };
  wait();
}

function cmdStatus(): void {
  const pid = readPid();
  if (!pid) {
    console.log('status: stopped (no pid file)');
    return;
  }
  if (isAlive(pid)) {
    console.log(`status: running (pid=${pid})`);
  } else {
    console.log(`status: stale pid file (pid=${pid} not alive)`);
  }
}

function cmdLogs(follow: boolean): void {
  if (!existsSync(LOG_FILE)) {
    console.log('暂无日志文件。');
    return;
  }
  const args = follow ? ['-n', '200', '-f', LOG_FILE] : ['-n', '200', LOG_FILE];
  const child = spawn('tail', args, { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
}

async function cmdAsk(text: string): Promise<void> {
  if (!text) {
    console.log('Usage: npm run ask -- "你的问题"');
    return;
  }
  const config = loadConfig();
  requireOpenAIConfig(config);
  const runtime = new OpenAIAgentRuntime(config);
  const result = await runtime.run({ sessionId: randomUUID(), text });
  console.log(result.text);
}

// ============================================================
// entry
// ============================================================

function printHelp(): void {
  console.log(
    [
      'Home Voice Assistant CLI',
      '',
      '  npm run start                 # 前台启动语音服务',
      '  npm run start -- --daemon     # 后台启动（detached）',
      '  npm run stop                  # 停止后台进程',
      '  npm run status                # 查询状态',
      '  npm run logs                  # 查看后台日志（追加 -- -f 实时跟随）',
      '  npm run ask -- "问题"          # 单次文本问答',
      '',
      'Tips:',
      '  • 若提示找不到录音工具，请：brew install sox（macOS）或 apt install sox（debian）',
      '  • 默认唤醒词：菜包菜包（可改 KWS_KEYWORDS_FILE）',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? 'help';
  const rest = argv.slice(1);

  switch (cmd) {
    case 'start': {
      if (rest.includes('--daemon') && !rest.includes('--daemon-child')) {
        cmdStartDaemon();
      } else {
        await cmdStartForeground();
      }
      return;
    }
    case 'stop':
      cmdStop();
      return;
    case 'status':
      cmdStatus();
      return;
    case 'logs':
      cmdLogs(rest.includes('-f') || rest.includes('--follow'));
      return;
    case 'ask': {
      const text = rest.join(' ').trim();
      await cmdAsk(text);
      return;
    }
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      return;
    default:
      console.error(`Unknown command: ${cmd}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
