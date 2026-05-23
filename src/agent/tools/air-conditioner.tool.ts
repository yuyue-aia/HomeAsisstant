import { tool } from '@openai/agents';
import { z } from 'zod';
import { logger } from '../../common/logger';
import {
  AcPartner,
  AC_TEMP_MIN,
  AC_TEMP_MAX,
  type AcMode,
  type AcFanLevel,
  type AcState,
} from './ac-partner-client';
import type { VoiceAgentContext } from '../types';

/**
 * 控制各房间空调（小米空调伴侣 cuco.acpartner.cp6）。
 *
 * 房间配置从环境变量读取，格式：AC_<ROOM>_IP / AC_<ROOM>_TOKEN
 * 例如：
 *   AC_LIVING_ROOM_IP=192.168.0.20
 *   AC_LIVING_ROOM_TOKEN=xxxxxxxx
 *
 * 房间 key 与中文名映射在 ROOM_ALIASES 中维护。
 */

interface RoomConfig {
  /** 用于 enum 参数的英文 key */
  key: string;
  /** 给模型看的中文标签 */
  label: string;
  /** 中文别名（模型/用户可能说出的名字），用于 description */
  aliases: string[];
  /** 环境变量前缀，比如 AC_LIVING_ROOM */
  envPrefix: string;
}

const ROOMS: RoomConfig[] = [
  {
    key: 'living_room',
    label: '客厅',
    aliases: ['客厅', '大厅'],
    envPrefix: 'AC_LIVING_ROOM',
  },
  {
    key: 'master_bedroom',
    label: '主卧',
    aliases: ['主卧', '主卧室', '大卧室'],
    envPrefix: 'AC_MASTER_BEDROOM',
  },
  {
    key: 'grandma_room',
    label: '奶奶房间',
    aliases: ['奶奶房间', '奶奶屋', '老人房'],
    envPrefix: 'AC_GRANDMA_ROOM',
  },
  {
    key: 'yuyue_room',
    label: '余跃房间',
    aliases: ['余跃房间', '余跃屋', '余跃的房间'],
    envPrefix: 'AC_YUYUE_ROOM',
  },
  {
    key: 'yuxiao_room',
    label: '余晓房间',
    aliases: ['余晓房间', '余晓屋', '余晓的房间'],
    envPrefix: 'AC_YUXIAO_ROOM',
  },
];

const ROOM_KEYS = ROOMS.map((r) => r.key) as [string, ...string[]];
const ROOM_BY_KEY = new Map(ROOMS.map((r) => [r.key, r]));

function readRoomConfig(key: string): { ip?: string; token?: string; room: RoomConfig } {
  const room = ROOM_BY_KEY.get(key);
  if (!room) {
    throw new Error(`Unknown room: ${key}`);
  }
  const ip = process.env[`${room.envPrefix}_IP`]?.trim() || undefined;
  const token = process.env[`${room.envPrefix}_TOKEN`]?.trim() || undefined;
  return { ip, token, room };
}

const roomDescription = ROOMS.map((r) => `${r.key}=${r.aliases.join('/')}`).join('；');

const MODE_LABEL: Record<AcMode, string> = {
  cool: '制冷',
  heat: '制热',
  auto: '自动',
  fan: '送风',
  dehumidify: '除湿',
};
const FAN_LABEL: Record<AcFanLevel, string> = {
  auto: '自动风',
  low: '低风',
  medium: '中风',
  high: '高风',
};

const controlAirConditionerParameters = z.object({
  room: z
    .enum(ROOM_KEYS)
    .describe(`要控制的房间，候选：${roomDescription}`),
  action: z
    .enum([
      'turn_on',
      'turn_off',
      'toggle',
      'status',
      'set_temperature',
      'increase_temperature',
      'decrease_temperature',
      'set_mode',
      'set_fan_level',
    ])
    .describe(
      '动作：turn_on/turn_off/toggle/status 控制开关与查询；' +
        'set_temperature 设定温度（需 temperature，16~30）；' +
        'increase_temperature/decrease_temperature 升降温（可选 delta，默认 1）；' +
        'set_mode 切换模式（需 mode）；set_fan_level 调风速（需 fan_level）。',
    ),
  temperature: z
    .number()
    .int()
    .min(AC_TEMP_MIN)
    .max(AC_TEMP_MAX)
    .nullable()
    .optional()
    .describe(`目标温度（摄氏度，整数 ${AC_TEMP_MIN}-${AC_TEMP_MAX}），仅 set_temperature 使用。`),
  delta: z
    .number()
    .int()
    .min(-10)
    .max(10)
    .nullable()
    .optional()
    .describe('升/降温步长（℃，默认 1），仅 increase_temperature/decrease_temperature 使用。'),
  mode: z
    .enum(['cool', 'heat', 'auto', 'fan', 'dehumidify'])
    .nullable()
    .optional()
    .describe('空调模式：cool=制冷, heat=制热, auto=自动, fan=送风, dehumidify=除湿。'),
  fan_level: z
    .enum(['auto', 'low', 'medium', 'high'])
    .nullable()
    .optional()
    .describe('风速：auto=自动, low=低风, medium=中风, high=高风。'),
});

type ControlAirConditionerAction =
  | 'turn_on'
  | 'turn_off'
  | 'toggle'
  | 'status'
  | 'set_temperature'
  | 'increase_temperature'
  | 'decrease_temperature'
  | 'set_mode'
  | 'set_fan_level';

type ControlAirConditionerResult = {
  ok: boolean;
  room: string;
  label: string;
  action: ControlAirConditionerAction;
  state?: 'on' | 'off';
  mode?: AcMode;
  targetTemperature?: number;
  fanLevel?: AcFanLevel;
  message: string;
};

function describeState(label: string, s: AcState): string {
  return (
    `${label}空调当前状态：${s.on ? '开' : '关'}` +
    `，模式 ${MODE_LABEL[s.mode]}，设定温度 ${s.targetTemperature}℃，风速 ${FAN_LABEL[s.fanLevel]}。`
  );
}

export const controlAirConditionerTool = tool<
  typeof controlAirConditionerParameters,
  VoiceAgentContext,
  ControlAirConditionerResult
>({
  name: 'control_air_conditioner',
  description:
    '控制家里各房间空调（通过小米空调伴侣 cuco.acpartner.cp6 红外控制）。' +
    '支持开关/切换/查询，以及设定温度（16~30℃）、升降温、切换模式（制冷/制热/自动/送风/除湿）、调风速（自动/低/中/高）。' +
    '可用房间：' +
    ROOMS.map((r) => `${r.label}(${r.key})`).join('、') +
    '。',
  parameters: controlAirConditionerParameters,
  async execute({ room, action, temperature, delta, mode, fan_level }) {
    const { ip, token, room: cfg } = readRoomConfig(room);
    if (!ip || !token) {
      return {
        ok: false,
        room,
        label: cfg.label,
        action,
        message: `未配置 ${cfg.label} 空调：请在 .env 中设置 ${cfg.envPrefix}_IP 和 ${cfg.envPrefix}_TOKEN。`,
      };
    }

    const ac = new AcPartner(ip, token);
    try {
      if (action === 'status') {
        const s = await ac.getState();
        logger.info('tool.ac.status', { room, ...s });
        return {
          ok: true,
          room,
          label: cfg.label,
          action,
          state: s.on ? 'on' : 'off',
          mode: s.mode,
          targetTemperature: s.targetTemperature,
          fanLevel: s.fanLevel,
          message: describeState(cfg.label, s),
        };
      }

      if (action === 'turn_on') {
        await ac.on();
        logger.info('tool.ac.on', { room });
        return {
          ok: true,
          room,
          label: cfg.label,
          action,
          state: 'on',
          message: `已打开${cfg.label}空调。`,
        };
      }

      if (action === 'turn_off') {
        await ac.off();
        logger.info('tool.ac.off', { room });
        return {
          ok: true,
          room,
          label: cfg.label,
          action,
          state: 'off',
          message: `已关闭${cfg.label}空调。`,
        };
      }

      if (action === 'toggle') {
        const next = await ac.toggle();
        logger.info('tool.ac.toggle', { room, next });
        return {
          ok: true,
          room,
          label: cfg.label,
          action,
          state: next ? 'on' : 'off',
          message: `${cfg.label}空调已切换为${next ? '开' : '关'}。`,
        };
      }

      if (action === 'set_temperature') {
        if (temperature == null) {
          return {
            ok: false,
            room,
            label: cfg.label,
            action,
            message: `设定温度需要提供 temperature 参数（${AC_TEMP_MIN}-${AC_TEMP_MAX}℃）。`,
          };
        }
        const applied = await ac.setTargetTemperature(temperature);
        logger.info('tool.ac.set_temperature', { room, applied });
        return {
          ok: true,
          room,
          label: cfg.label,
          action,
          targetTemperature: applied,
          message: `已将${cfg.label}空调设定温度调到 ${applied}℃。`,
        };
      }

      if (action === 'increase_temperature' || action === 'decrease_temperature') {
        const step = Math.abs(delta ?? 1) || 1;
        const signed = action === 'increase_temperature' ? step : -step;
        const next = await ac.adjustTargetTemperature(signed);
        logger.info('tool.ac.adjust_temperature', { room, delta: signed, next });
        return {
          ok: true,
          room,
          label: cfg.label,
          action,
          targetTemperature: next,
          message:
            action === 'increase_temperature'
              ? `已升高${cfg.label}空调温度至 ${next}℃。`
              : `已降低${cfg.label}空调温度至 ${next}℃。`,
        };
      }

      if (action === 'set_mode') {
        if (!mode) {
          return {
            ok: false,
            room,
            label: cfg.label,
            action,
            message: '切换模式需要提供 mode 参数（cool/heat/auto/fan/dehumidify）。',
          };
        }
        await ac.setMode(mode);
        logger.info('tool.ac.set_mode', { room, mode });
        return {
          ok: true,
          room,
          label: cfg.label,
          action,
          mode,
          message: `已将${cfg.label}空调切换到${MODE_LABEL[mode]}模式。`,
        };
      }

      if (action === 'set_fan_level') {
        if (!fan_level) {
          return {
            ok: false,
            room,
            label: cfg.label,
            action,
            message: '调风速需要提供 fan_level 参数（auto/low/medium/high）。',
          };
        }
        await ac.setFanLevel(fan_level);
        logger.info('tool.ac.set_fan_level', { room, fan_level });
        return {
          ok: true,
          room,
          label: cfg.label,
          action,
          fanLevel: fan_level,
          message: `已将${cfg.label}空调风速调到${FAN_LABEL[fan_level]}。`,
        };
      }

      return {
        ok: false,
        room,
        label: cfg.label,
        action,
        message: `不支持的动作：${action}`,
      };
    } catch (error) {
      const msg = (error as Error).message;
      logger.error('tool.ac.exception', { room, action, error: msg });
      return {
        ok: false,
        room,
        label: cfg.label,
        action,
        message: `控制${cfg.label}空调失败：${msg}`,
      };
    } finally {
      ac.close();
    }
  },
});

export const SUPPORTED_AC_ROOMS = ROOMS;
