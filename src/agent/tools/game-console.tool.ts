import { tool } from '@openai/agents';
import { z } from 'zod';
import { logger } from '../../common/logger';
import { getGameConsoleController } from '../../services/game-console-controller';
import type { VoiceAgentContext } from '../types';

/**
 * 控制 Switch 游戏机（通过 Gosund 插板的 s1 插孔）。
 *
 * 配额规则、定时器、断电逻辑都在 GameConsoleController 中，
 * 这个 tool 只负责把 Agent 的意图分发到 controller 上。
 */

const controlGameConsoleParameters = z.object({
  action: z
    .enum(['start_game', 'stop_game', 'status'])
    .describe('要执行的动作：申请启动 / 提前停止 / 查询配额与状态'),
  child: z
    .enum(['yuxiao', 'yuyue'])
    .nullable()
    .optional()
    .describe('小朋友标识：yuxiao=余晓, yuyue=余跃；start_game 必填，stop_game 可选'),
  minutes: z
    .number()
    .int()
    .min(1)
    .max(240)
    .nullable()
    .optional()
    .describe('要玩的分钟数；start_game 必填'),
});

type ControlGameConsoleResult = {
  ok: boolean;
  action: 'start_game' | 'stop_game' | 'status';
  child?: 'yuxiao' | 'yuyue';
  reason?: string;
  remainingMinutes?: number;
  plannedMinutes?: number;
  actualMinutes?: number;
  endsAtIso?: string;
  active?: {
    child: 'yuxiao' | 'yuyue';
    startedAtIso: string;
    endsAtIso: string;
    remainingMinutes: number;
  };
  quotas?: Array<{
    child: 'yuxiao' | 'yuyue';
    label: string;
    dailyQuotaMin: number;
    usedMinutes: number;
    remainingMinutes: number;
  }>;
  message: string;
};

export const controlGameConsoleTool = tool<
  typeof controlGameConsoleParameters,
  VoiceAgentContext,
  ControlGameConsoleResult
>({
  name: 'control_game_console',
  description:
    '控制小朋友的 Switch 游戏机：申请启动（按配额通电并定时断电）、提前停止、查询今日剩余时间和当前是否有人在玩。仅周末可玩，每人每天 2 小时上限。',
  parameters: controlGameConsoleParameters,
  async execute({ action, child, minutes }) {
    const ctrl = getGameConsoleController();
    try {
      if (action === 'status') {
        const r = ctrl.status();
        logger.info('tool.game_console.status', {
          allowed: r.allowedToday,
          active: r.active?.child ?? null,
        });
        return {
          ok: true,
          action: 'status',
          quotas: r.quotas,
          active: r.active
            ? {
                child: r.active.child,
                startedAtIso: r.active.startedAtIso,
                endsAtIso: r.active.endsAtIso,
                remainingMinutes: r.active.remainingMinutes,
              }
            : undefined,
          message: r.message,
        };
      }

      if (action === 'start_game') {
        if (minutes == null) {
          return {
            ok: false,
            action,
            reason: 'invalid_minutes',
            message: '要先告诉我想玩多少分钟。',
          };
        }
        const r = await ctrl.start(child ?? null, minutes);
        logger.info('tool.game_console.start', {
          child: r.child,
          ok: r.ok,
          reason: r.reason,
          plannedMinutes: r.plannedMinutes,
        });
        return {
          ok: r.ok,
          action,
          child: r.child,
          reason: r.reason,
          remainingMinutes: r.remainingMinutes,
          plannedMinutes: r.plannedMinutes,
          endsAtIso: r.endsAtIso,
          message: r.message,
        };
      }

      // stop_game
      const r = await ctrl.stop(child ?? null);
      logger.info('tool.game_console.stop', {
        child: r.child,
        ok: r.ok,
        actualMinutes: r.actualMinutes,
      });
      return {
        ok: r.ok,
        action,
        child: r.child,
        actualMinutes: r.actualMinutes,
        remainingMinutes: r.remainingMinutes,
        message: r.message,
      };
    } catch (error) {
      const msg = (error as Error).message;
      logger.error('tool.game_console.exception', { action, error: msg });
      return {
        ok: false,
        action,
        message: `控制游戏机出错了：${msg}`,
      };
    }
  },
});
