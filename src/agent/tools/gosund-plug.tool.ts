import { tool } from '@openai/agents';
import { z } from 'zod';
import { logger } from '../../common/logger';
import { GosundPlug, SWITCH_SIID_BY_DID } from './gosund-plug-client';
import type { VoiceAgentContext } from '../types';

/**
 * 控制 Gosund 插线板（cuco.plug.cp5d）的某一路开关。
 *
 * 配置（在 .env 中）：
 *   GOSUND_PLUG_IP    设备局域网 IP，例如 192.168.0.27
 *   GOSUND_PLUG_TOKEN 32 位 hex 设备 token
 */

const DID_VALUES = Object.keys(SWITCH_SIID_BY_DID) as [string, ...string[]];

const controlGosundPlugParameters = z.object({
  did: z
    .enum(DID_VALUES)
    .default('master')
    .describe(
      'Switch channel: master/state=主开关, s1/s2/s3/s4=各插孔, usb=USB 插孔',
    ),
  action: z
    .enum(['turn_on', 'turn_off', 'toggle', 'status'])
    .describe('要执行的动作'),
});

type ControlGosundPlugResult = {
  ok: boolean;
  did: string;
  action: 'turn_on' | 'turn_off' | 'toggle' | 'status';
  state?: 'on' | 'off';
  message: string;
};

function defaultIp(): string | undefined {
  return process.env.GOSUND_PLUG_IP?.trim() || undefined;
}

function defaultToken(): string | undefined {
  return process.env.GOSUND_PLUG_TOKEN?.trim() || undefined;
}

export const controlGosundPlugTool = tool<
  typeof controlGosundPlugParameters,
  VoiceAgentContext,
  ControlGosundPlugResult
>({
  name: 'control_gosund_plug',
  description:
    '控制家里 Gosund (MiHome) 插线板的开关。支持总开关 master/state、四个插孔 s1~s4、以及 USB 插孔。可执行打开 turn_on、关闭 turn_off、切换 toggle、查询 status。',
  parameters: controlGosundPlugParameters,
  async execute({ did, action }) {
    const ip = defaultIp();
    const token = defaultToken();

    if (!ip || !token) {
      return {
        ok: false,
        did,
        action,
        message: '未配置插线板：请在 .env 中设置 GOSUND_PLUG_IP 和 GOSUND_PLUG_TOKEN。',
      };
    }

    const plug = new GosundPlug(ip, token);
    try {
      if (action === 'status') {
        const on = await plug.status(did);
        logger.info('tool.gosund_plug.status', { did, on });
        return {
          ok: true,
          did,
          action,
          state: on ? 'on' : 'off',
          message: `${did} 当前状态：${on ? '开' : '关'}。`,
        };
      }

      if (action === 'turn_on') {
        await plug.on(did);
        logger.info('tool.gosund_plug.on', { did });
        return {
          ok: true,
          did,
          action,
          state: 'on',
          message: `已打开 ${did}。`,
        };
      }

      if (action === 'turn_off') {
        await plug.off(did);
        logger.info('tool.gosund_plug.off', { did });
        return {
          ok: true,
          did,
          action,
          state: 'off',
          message: `已关闭 ${did}。`,
        };
      }

      // toggle
      const next = await plug.toggle(did);
      logger.info('tool.gosund_plug.toggle', { did, next });
      return {
        ok: true,
        did,
        action,
        state: next ? 'on' : 'off',
        message: `${did} 已切换为${next ? '开' : '关'}。`,
      };
    } catch (error) {
      const msg = (error as Error).message;
      logger.error('tool.gosund_plug.exception', { did, action, error: msg });
      return {
        ok: false,
        did,
        action,
        message: `控制插线板失败：${msg}`,
      };
    } finally {
      plug.close();
    }
  },
});
