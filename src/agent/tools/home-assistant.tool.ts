import { tool } from '@openai/agents';
import { z } from 'zod';
import { logger } from '../../common/logger';
import type { VoiceAgentContext } from '../types';

const controlDeviceParameters = z.object({
  entityId: z
    .string()
    .min(1)
    .describe('Home Assistant entity id, e.g. light.living_room or switch.fan'),
  action: z
    .enum(['turn_on', 'turn_off', 'toggle'])
    .describe('Device action to perform'),
});

type ControlDeviceResult = {
  ok: boolean;
  entityId: string;
  action: 'turn_on' | 'turn_off' | 'toggle';
  mode: 'mock' | 'home_assistant';
  message: string;
};

/** 仅允许操作的设备域，避免 LLM 误调用敏感服务 */
const ALLOWED_DOMAINS = new Set([
  'light',
  'switch',
  'fan',
  'media_player',
  'climate',
  'cover',
  'scene',
  'script',
]);

export const controlDeviceTool = tool<
  typeof controlDeviceParameters,
  VoiceAgentContext,
  ControlDeviceResult
>({
  name: 'control_device',
  description:
    'Control a Home Assistant entity. Only allowed domains: light/switch/fan/media_player/climate/cover/scene/script.',
  parameters: controlDeviceParameters,
  async execute({ entityId, action }, runContext) {
    const ctx = runContext?.context;
    const homeAssistant = ctx?.homeAssistant;

    const domain = entityId.split('.')[0];
    if (!ALLOWED_DOMAINS.has(domain)) {
      return {
        ok: false,
        entityId,
        action,
        mode: 'home_assistant',
        message: `不允许操作的设备域：${domain}`,
      };
    }

    if (!homeAssistant?.baseUrl || !homeAssistant?.token) {
      logger.info('tool.control_device.mock', { entityId, action });
      return {
        ok: true,
        entityId,
        action,
        mode: 'mock',
        message: `已模拟执行 ${action} ${entityId}（未配置 Home Assistant，仅演示）。`,
      };
    }

    const url = `${homeAssistant.baseUrl.replace(/\/$/, '')}/api/services/${domain}/${action}`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${homeAssistant.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ entity_id: entityId }),
      });

      if (!response.ok) {
        const text = await response.text();
        logger.warn('tool.control_device.http_error', {
          entityId,
          action,
          status: response.status,
          body: text.slice(0, 200),
        });
        return {
          ok: false,
          entityId,
          action,
          mode: 'home_assistant',
          message: `Home Assistant 返回 ${response.status}：${text.slice(0, 80)}`,
        };
      }

      logger.info('tool.control_device.ok', { entityId, action });
      return {
        ok: true,
        entityId,
        action,
        mode: 'home_assistant',
        message: `已执行 ${action} ${entityId}。`,
      };
    } catch (error) {
      logger.error('tool.control_device.exception', {
        entityId,
        action,
        error: (error as Error).message,
      });
      return {
        ok: false,
        entityId,
        action,
        mode: 'home_assistant',
        message: `调用 Home Assistant 失败：${(error as Error).message}`,
      };
    }
  },
});
