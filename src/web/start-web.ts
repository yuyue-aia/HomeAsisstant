#!/usr/bin/env node
/**
 * 独立启动 Web 游戏管家（开发/内网单机场景）。
 *
 *   npm run web            # 前台启动，Ctrl+C 退出
 *
 * 生产环境如需与语音链路同进程共享状态，可在 VoiceService 启动流程里改为
 * 直接调用 getWebServer().start()（复用同一批 service 单例）。
 */

// 必须最先加载 .env，保证下方 controller 构造时能读到 GOSUND_PLUG_* 等插板凭据。
import 'dotenv/config';
import { getGameConsoleController } from '../services/game-console-controller';
import { getWebServer } from './web-server';

async function main(): Promise<void> {
  const controller = getGameConsoleController();
  // 进程启动时恢复可能仍在进行中的游戏会话（重新挂定时器 / 补断电）。
  await controller.recoverActiveSession();

  const server = getWebServer();
  server.start();

  const shutdown = async (signal: string) => {
    console.log(`\n收到 ${signal}，正在关闭 Web 服务…`);
    try {
      await server.stop();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
