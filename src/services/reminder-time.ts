/**
 * 提醒功能的时间工具。
 *
 * 设计原则：
 *  - 只放"规则/校验/调度"相关的纯函数，不做任何"给人念的中文格式化"。
 *  - 把绝对时间 → 自然中文（"明天下午四点"）这种依赖语境的工作交给 LLM，
 *    服务端只输出 ISO，让模型基于 get_current_time 自己组织口播。
 *  - 不依赖任何外部状态/IO，便于单测；全部使用本机时区。
 */

/** 解析 ISO 字符串，返回 Date 或 null（无效）。 */
export function parseIso(iso: string): Date | null {
  if (!iso || typeof iso !== 'string') return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

/**
 * 校验一次性提醒的触发时间：必须能解析、必须在未来（允许 1 秒微小漂移）。
 */
export function validateFutureIso(
  iso: string,
  now: Date = new Date(),
): { ok: true; fireAt: Date } | { ok: false; reason: 'invalid' | 'past' } {
  const d = parseIso(iso);
  if (!d) return { ok: false, reason: 'invalid' };
  if (d.getTime() <= now.getTime() - 1000) {
    return { ok: false, reason: 'past' };
  }
  return { ok: true, fireAt: d };
}

/** 校验 "HH:MM" 格式并返回 [hh, mm]，非法则返回 null。 */
export function parseHHmm(hhmm: string): [number, number] | null {
  if (!hhmm || typeof hhmm !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return [hh, mm];
}

/** 把 Date 转成本地的 "HH:MM"。 */
export function formatHHmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 计算从 now 起，下一次满足"本地时区 HH:MM"的时刻。
 *  - 若今天该时刻仍在未来 → 返回今天该时刻；
 *  - 否则 → 明天该时刻。
 */
export function nextDailyFire(hhmm: string, now: Date = new Date()): Date | null {
  const parsed = parseHHmm(hhmm);
  if (!parsed) return null;
  const [hh, mm] = parsed;
  const today = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    hh,
    mm,
    0,
    0,
  );
  if (today.getTime() > now.getTime()) return today;
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
    hh,
    mm,
    0,
    0,
  );
}

/**
 * 模糊匹配：返回包含 query 任一关键字的提醒索引集合。
 *  - 大小写不敏感；
 *  - 中文按子串匹配。
 */
export function fuzzyMatch<T extends { text: string; id: string }>(
  items: T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const exact = items.find((it) => it.id === query);
  if (exact) return [exact];
  return items.filter((it) => it.text.toLowerCase().includes(q));
}
