/**
 * 提醒功能的类型定义。
 *
 * 与 reminder-service 解耦，方便单测纯函数。
 */

export type ReminderId = string;

export type ReminderRecurrence =
  | { kind: 'once' }
  | { kind: 'daily'; atHHmm: string }; // "16:00"

export interface Reminder {
  id: ReminderId;
  /** 用于播报的提醒内容："送余跃去打球" —— 不带"提醒我"等冗余前缀 */
  text: string;
  createdAtIso: string;
  /** 下一次应该触发的绝对时间。daily 也用这个字段表示"下一次"。 */
  nextFireAtIso: string;
  recurrence: ReminderRecurrence;
  status: 'active' | 'fired' | 'cancelled' | 'missed';
  /** 上一次实际播报时刻，用于 recover 判断是否需要补播。 */
  lastFiredAtIso?: string;
}

/** 文件落盘的容器结构。 */
export interface ReminderFilePayload {
  version: 1;
  items: Reminder[];
}
