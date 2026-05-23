import { tool } from '@openai/agents';
import { z } from 'zod';
import { logger } from '../../common/logger';
import { getReminderService } from '../../services/reminder-service';
import type { ReminderRecurrence } from '../../services/reminder-types';
import type { VoiceAgentContext } from '../types';

/**
 * manage_reminder：管理用户的提醒事项。
 *
 *   - 时间解析由 LLM 完成（先调 get_current_time 拿当前本机时间，再算 ISO）；
 *   - 服务端只接 ISO 字符串并做严格校验；
 *   - 播报话术统一在 ReminderService 里拼，工具直接把 message 返回供 LLM 念出。
 */

const params = z.object({
  action: z
    .enum(['create', 'list', 'cancel'])
    .describe('动作：create=新建提醒；list=列出我的提醒；cancel=取消提醒'),

  // create
  text: z
    .string()
    .nullable()
    .optional()
    .describe(
      '提醒内容，简短一句，不要带"提醒我"等冗余前缀。例如"送余跃去打球"',
    ),
  fire_at_iso: z
    .string()
    .nullable()
    .optional()
    .describe(
      '触发时间的 ISO 8601 字符串（带本机时区偏移，如 2026-05-25T16:00:00+08:00）。create 必填；daily 时表示首次/今日/明日的目标时刻',
    ),
  recurrence: z
    .enum(['once', 'daily'])
    .nullable()
    .optional()
    .describe('重复方式：once=一次性（默认）；daily=每天 fire_at_iso 的时分'),

  // cancel
  id: z
    .string()
    .nullable()
    .optional()
    .describe('要取消的提醒 id（精确匹配，可选）'),
  query: z
    .string()
    .nullable()
    .optional()
    .describe(
      '当用户用自然语言取消时（如"打球那个"），传关键词，由服务端按 text 模糊匹配',
    ),
});

type ManageReminderResult = {
  ok: boolean;
  action: 'create' | 'list' | 'cancel';
  reason?: string;
  message: string;
  reminder?: {
    id: string;
    text: string;
    nextFireAtIso: string;
    recurrence: ReminderRecurrence;
  };
  items?: Array<{
    id: string;
    text: string;
    nextFireAtIso: string;
    recurrence: ReminderRecurrence;
  }>;
  matches?: Array<{
    id: string;
    text: string;
    nextFireAtIso: string;
  }>;
};

export const manageReminderTool = tool<typeof params, VoiceAgentContext, ManageReminderResult>({
  name: 'manage_reminder',
  description:
    '管理用户的提醒事项：创建一次性或每日提醒、列出未来的提醒、按 id 或关键词取消提醒。到点会自动用 TTS 播报。时间解析由你来做：先调 get_current_time 拿到当前本机时间，再换算成本机时区的 ISO 8601 字符串作为 fire_at_iso。',
  parameters: params,
  async execute({ action, text, fire_at_iso, recurrence, id, query }) {
    const svc = getReminderService();
    try {
      if (action === 'create') {
        if (!text || !text.trim()) {
          return {
            ok: false,
            action,
            reason: 'invalid_text',
            message: '要提醒什么？再说一遍。',
          };
        }
        if (!fire_at_iso) {
          return {
            ok: false,
            action,
            reason: 'invalid_time',
            message: '什么时候提醒？再说一遍时间。',
          };
        }
        const rec: ReminderRecurrence =
          recurrence === 'daily'
            ? { kind: 'daily', atHHmm: extractHHmm(fire_at_iso) || '00:00' }
            : { kind: 'once' };

        const r = svc.create({
          text: text.trim(),
          fireAtIso: fire_at_iso,
          recurrence: rec,
        });
        logger.info('tool.reminder.create', {
          ok: r.ok,
          reason: r.reason,
          id: r.reminder?.id,
        });
        return {
          ok: r.ok,
          action,
          reason: r.reason,
          message: r.message,
          reminder: r.reminder
            ? {
                id: r.reminder.id,
                text: r.reminder.text,
                nextFireAtIso: r.reminder.nextFireAtIso,
                recurrence: r.reminder.recurrence,
              }
            : undefined,
        };
      }

      if (action === 'list') {
        const r = svc.list({ onlyActive: true });
        logger.info('tool.reminder.list', { count: r.items.length });
        return {
          ok: true,
          action,
          message: r.message,
          items: r.items.map((it) => ({
            id: it.id,
            text: it.text,
            nextFireAtIso: it.nextFireAtIso,
            recurrence: it.recurrence,
          })),
        };
      }

      // cancel
      const r = svc.cancel({ id: id ?? null, query: query ?? null });
      logger.info('tool.reminder.cancel', {
        ok: r.ok,
        reason: r.reason,
        id: r.cancelled?.id,
        matches: r.matches?.length ?? 0,
      });
      return {
        ok: r.ok,
        action,
        reason: r.reason,
        message: r.message,
        reminder: r.cancelled
          ? {
              id: r.cancelled.id,
              text: r.cancelled.text,
              nextFireAtIso: r.cancelled.nextFireAtIso,
              recurrence: r.cancelled.recurrence,
            }
          : undefined,
        matches: r.matches?.map((it) => ({
          id: it.id,
          text: it.text,
          nextFireAtIso: it.nextFireAtIso,
        })),
      };
    } catch (error) {
      const msg = (error as Error).message;
      logger.error('tool.reminder.exception', { action, error: msg });
      return {
        ok: false,
        action,
        message: `处理提醒出错了：${msg}`,
      };
    }
  },
});

/** 从 ISO 字符串里抽取本地时区的 HH:MM。 */
function extractHHmm(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
