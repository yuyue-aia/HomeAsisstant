# 提醒功能设计方案

更新时间：2026-05-24

## 1. 目标

在现有语音助手中新增"提醒"能力，覆盖如下用户故事：

- "提醒我明天下午 4 点送余跃去打球。"
- "10 分钟后提醒我把锅从火上拿下来。"
- "每天晚上 9 点提醒小朋友刷牙。"
- "我有哪些提醒？" / "把刚才那个打球的提醒取消掉。"

到点后，助手主动用 TTS 播报一句话提醒（无需用户唤醒），并在用户问起时能列出/取消已有提醒。

进程重启不丢失提醒，跨天恢复。

---

## 2. 需求拆解

### 2.1 功能需求

| 编号 | 能力 | 说明 |
| --- | --- | --- |
| F1 | 创建一次性提醒 | 自然语言时间（"明天下午 4 点"、"10 分钟后"）→ 绝对时间戳 |
| F2 | 创建周期性提醒 | 每天 / 每周某天 / 工作日 等简单规则；本期先做"每天 HH:MM" 一种 |
| F3 | 列出提醒 | 按时间正序返回未来未触发的提醒 |
| F4 | 取消/删除提醒 | 按 id 或自然语言（"取消打球那个"）模糊匹配 |
| F5 | 到点播报 | 通过 `DialogSession.announce()` 走 TTS 播报 |
| F6 | 持久化 + 崩溃恢复 | 进程退出/重启不丢；启动时补播错过的（在容忍窗口内） |
| F7 | 时区一致 | 全程使用本机时区（默认 `Asia/Shanghai`），存 ISO 字符串 |

### 2.2 非功能需求

- 与现有架构对齐：单进程、本地文件持久化、Agent Tool 暴露给 LLM。
- 零额外云依赖：不引入数据库、不引入云调度。
- 失败优雅：写文件失败/调度失败要打日志且不影响主对话。
- 可观测：所有创建/触发/取消都打 `logger.info`。

### 2.3 不在本期范围

- 跨设备同步、跨用户多账号；
- 复杂 RRULE（每月最后一个周五等）；
- 推送到手机；
- 地理围栏触发（"到家提醒")。

---

## 3. 核心设计思路

复用现有"游戏机控制器 + 主动播报"这一已经跑通的范式：

```
GameConsoleController  ──┐
                         ├── DialogSession.setAnnouncer(text => session.announce(text))
ReminderService(新增) ───┘                                   │
                                                              ▼
                                                       TTS → 播放器
```

要点：

1. **复用 `DialogSession.announce(text)`**：它已经处理了"忙时缓存、闲时播放"的所有边界条件（idle/listening/thinking/speaking 各状态），无需重新设计。
2. **新增 `ReminderService` 单例**，负责：调度（`setTimeout`）、持久化（JSON 文件）、CRUD、启动恢复。
3. **新增 `manage_reminder` 一个 Agent Tool**，参数用 action 多路分发（create/list/cancel），与 `control_game_console` 同构。
4. **时间解析放在 Tool 层**：让 LLM 把自然语言时间解析为 ISO 字符串作为参数传入；服务层不做 NLP。这样既稳定又便于测试。

---

## 4. 模块设计

### 4.1 数据结构

```ts
// src/services/reminder-types.ts
export type ReminderId = string;

export type ReminderRecurrence =
  | { kind: 'once' }
  | { kind: 'daily';   atHHmm: string }       // "16:00"
  | { kind: 'weekly';  atHHmm: string; weekdays: number[] }; // 0=周日

export interface Reminder {
  id: ReminderId;
  text: string;                  // 用于播报的提醒内容："送余跃去打球"
  createdAtIso: string;
  /** 下一次应该触发的绝对时间。periodic 也用这个字段表示"下一次"。 */
  nextFireAtIso: string;
  recurrence: ReminderRecurrence;
  /** 触发后是否还活着（once → false；周期 → true 并更新 nextFireAtIso）。 */
  status: 'active' | 'fired' | 'cancelled';
  /** 防漏播：上次实际播报时刻。用于启动恢复判断是否要补播。 */
  lastFiredAtIso?: string;
}
```

播报话术统一在 `ReminderService` 里拼，不让 LLM 自由发挥，避免每次说法不一：

```
"提醒一下，{text}。"
```

### 4.2 `ReminderService`（单例）

文件：`src/services/reminder-service.ts`

职责：

- 加载 / 保存提醒列表（文件 `.runtime/reminders.json`，原子写）；
- 维护 `Map<ReminderId, NodeJS.Timeout>` 调度表；
- 对 `setTimeout` 的 `2^31-1 ms ≈ 24.8 天`上限做分级调度：> 23 天的提醒只挂"中转 timer"，到点再排下一段；
- 暴露 CRUD：`create / list / cancel / get`；
- 暴露 `setAnnouncer(fn)`，接收 `DialogSession` 的播报回调；
- 暴露 `recover()`，进程启动时调用：
  - 已过期但在容忍窗口（默认 5 分钟）内 → 立即补播一次，标记 fired；
  - 已过期超过窗口 → 标记 missed（仍写一行日志告知用户："你昨晚 21:00 的提醒因为助手离线没播出来"，用户问起时能查到；本期不主动播报这条 missed 提示）；
  - 周期性提醒被错过 → 把 `nextFireAtIso` 推进到下一次合法时刻，重新挂定时器；
  - 在未来 → 重新 `scheduleOne`。

关键 API：

```ts
class ReminderService {
  setAnnouncer(fn: (text: string) => void | Promise<void>): void;

  create(input: {
    text: string;
    fireAtIso: string;
    recurrence?: ReminderRecurrence; // 默认 once
  }): Reminder;

  list(opts?: { onlyActive?: boolean }): Reminder[];

  cancel(idOrFuzzy: string): { ok: boolean; cancelled?: Reminder; matches?: Reminder[] };

  recover(): Promise<void>;

  // 测试/调试
  getCount(): { active: number; total: number };
}
```

调度核心：

```
private scheduleOne(r: Reminder) {
  const ms = new Date(r.nextFireAtIso).getTime() - Date.now();
  if (ms <= 0) { void this.fire(r); return; }
  const cap = 23 * 24 * 3600 * 1000; // < 2^31-1 留余量
  const delay = Math.min(ms, cap);
  const timer = setTimeout(() => {
    if (delay < ms) this.scheduleOne(r);   // 中转：再挂一段
    else void this.fire(r);
  }, delay);
  this.timers.set(r.id, timer);
}
```

`fire()` 流程：

1. 调用 announcer 播报 `提醒一下，${r.text}。`；
2. `lastFiredAtIso = now`；
3. 若 `recurrence.kind === 'once'` → `status = 'fired'`，从调度表移除；
4. 若周期 → 计算下一次触发时间，更新 `nextFireAtIso`，重新 `scheduleOne`；
5. 落盘。

### 4.3 Agent Tool：`manage_reminder`

文件：`src/agent/tools/reminder.tool.ts`

参数（沿用项目现有的 zod + action 路由风格）：

```ts
const params = z.object({
  action: z.enum(['create', 'list', 'cancel']),
  // create
  text: z.string().nullable().optional()
    .describe('提醒内容，简短一句，不要带"提醒我"等冗余前缀'),
  fire_at_iso: z.string().nullable().optional()
    .describe('一次性提醒触发时间（本机时区的 ISO 8601，如 2026-05-25T16:00:00+08:00）'),
  recurrence: z.enum(['once', 'daily']).nullable().optional()
    .describe('重复方式：once=一次性（默认）；daily=每天 fire_at_iso 的时分'),
  // cancel
  id: z.string().nullable().optional(),
  query: z.string().nullable().optional()
    .describe('当用户用自然语言取消时（如"打球那个"），传关键词，由服务端模糊匹配'),
});
```

返回结构同样有 `ok / message`，`message` 是面向 TTS 的中文。

LLM 提示词补充（追加到 `DEFAULT_INSTRUCTIONS` 的【工具使用】块下，新增"【提醒】"小节）：

```
【提醒】
- 用户说"提醒我...""到点喊我..."→ 调 manage_reminder action=create。
- 时间解析由你来做：先调 get_current_time 取当前本机时间，再把"明天下午4点""10 分钟后"
  换算成本机时区的 ISO 8601 字符串，作为 fire_at_iso 传入。
- 没说重复，默认 once。
- 用户说"我有什么提醒""今天还有什么事"→ action=list；
  把返回的列表念出来时，时间用"今天下午 4 点""明天上午 9 点"这种口语；最多念 3 条。
- "取消那个打球的提醒"→ action=cancel，把"打球"作为 query 传入。
- 创建成功后用 message 字段播报，不要自己再编。
```

为什么把时间解析放给 LLM：

- 项目本来就有 `get_current_time` 工具；
- 中文时间表达极其多样（"下下周二"、"本周末"、"晚饭后"），写规则难以覆盖；
- LLM + 已知"现在时间" + ISO 输出，是最稳的组合；
- 服务端只对 ISO 做严格校验：必须能解析、必须在未来（一次性）。

### 4.4 与 `DialogSession` 的集成

在 `DialogSession` 构造函数末尾追加（参考现有 game-console 的写法）：

```ts
try {
  getReminderService().setAnnouncer((text) => this.announce(text));
  void getReminderService().recover().catch((error) => {
    logger.warn('dialog.reminder.recover_failed', { error: (error as Error).message });
  });
} catch (error) {
  logger.warn('dialog.reminder.bind_failed', { error: (error as Error).message });
}
```

在 `OpenAIAgentRuntime` 的 `tools` 数组里挂上 `manageReminderTool`。

### 4.5 持久化

- 路径：`.runtime/reminders.json`（与 `agent-history` 同目录约定）；
- 格式：`{ "version": 1, "items": Reminder[] }`；
- 写盘：tmp + rename 原子替换，串行 chain（参考 `openai-agent-runtime.ts` 里 `historyWriteChain` 的做法）；
- 读盘失败 → 视为空列表 + warn 日志，不阻塞启动。

### 4.6 时间换算工具

新增 `src/services/reminder-time.ts`，纯函数无副作用：

- `validateFutureIso(iso, now)`：返回 `{ ok, ms }`；
- `nextDailyFire(hhmm: string, now: Date): Date`：计算"今天/明天最近一次 HH:MM"；
- `formatForSpeak(iso: string, now: Date)`：把 ISO 转成"今天下午 4 点 / 明天上午 9 点 / 5 月 30 日上午 8 点"，用于 list 的 message 拼接。

---

## 5. 端到端流程

### 5.1 创建提醒

```
用户："提醒我明天下午 4 点送余跃去打球。"
  → ASR final → Agent
  → Agent 调 get_current_time（拿到 2026-05-24T00:31:00+08:00）
  → Agent 计算出 fire_at_iso = 2026-05-25T16:00:00+08:00
  → Agent 调 manage_reminder(action=create, text="送余跃去打球", fire_at_iso=...)
  → ReminderService.create() → scheduleOne() → 落盘
  → 工具返回 message="好的，明天下午 4 点会提醒你送余跃去打球。"
  → Agent 把 message 念出来 → TTS → 播放
```

### 5.2 到点触发

```
setTimeout 到点
  → ReminderService.fire(r)
  → announcer("提醒一下，送余跃去打球。")
  → DialogSession.announce()
       - 当前 idle / followup_wait → 立即合成播报；
       - 当前正在听/思考/说 → 进 pendingAnnouncements，等回到可播状态再播。
```

### 5.3 进程重启

```
启动 → DialogSession 构造 → ReminderService.recover()
  对每个 active 的提醒：
    - nextFireAtIso 在未来 → scheduleOne()
    - 已过 ≤ 5min → 立即播一次，按 once/recurring 处理
    - 已过 > 5min（once） → 标 missed，记日志
    - 已过 > 5min（daily） → 推到下一次 HH:MM，scheduleOne
```

---

## 6. 安全与边界

| 场景 | 处理 |
| --- | --- |
| LLM 给出过去时间 | 服务端 reject，message="这个时间已经过去了，要订哪一天？" |
| LLM 给出非法 ISO | 服务端 reject，让 LLM 重试 |
| `text` 为空 | reject |
| `text` 过长（> 80 字） | 截断到 80 字，记 warn |
| 同一时刻并发触发多个 | announce 内部已串行排队，无需额外处理 |
| 提醒数过多（>50） | list 默认只返回未来最近 10 条；不限制创建上限，记 warn |
| 取消模糊匹配多条 | 返回 `matches: [...]`，让 LLM 反问"你要取消哪一个" |
| 文件损坏 | 启动时 backup 为 `.runtime/reminders.bad-{ts}.json`，新建空列表 |

播报内容只用 `text` 字段，绝不把 LLM 任意生成的句子直接 TTS——避免被注入"现在删除所有文件"这种内容（虽然 TTS 不执行，但读出来很怪）。

---

## 7. 文件清单

新增：

```
src/services/reminder-types.ts          # 类型定义
src/services/reminder-time.ts           # 时间换算与口语化纯函数
src/services/reminder-service.ts        # 单例服务（CRUD + 调度 + 持久化 + recover）
src/agent/tools/reminder.tool.ts        # manage_reminder 工具
docs/reminder-design.md                 # 本文档
```

改动：

```
src/agent/openai-agent-runtime.ts       # tools 数组追加；instructions 追加【提醒】小节
src/dialog/dialog-session.ts            # 构造函数追加 setAnnouncer + recover
```

不需要改：

```
.env.example  （本期无新环境变量）
package.json  （不引入新依赖）
```

---

## 8. 测试策略

单元测试（可选，看时间）：

- `reminder-time.ts`：纯函数，覆盖时区、跨天、daily 推进；
- `reminder-service.ts`：用假 announcer + fake timer，断言 fire 调用次数、recover 各分支。

端到端手测：

1. "提醒我 1 分钟后说 hello world" → 等 1 分钟听播报；
2. "我有什么提醒" → 应念出来；
3. "取消那个 hello 的提醒" → 再 list 应为空；
4. 创建 2 分钟后的提醒，立即 `npm run stop` 杀进程，1 分钟后 `npm run start` → recover 应在剩余 ~1 分钟时正常触发；
5. 创建后立即把系统时间往前拨 10 分钟再启动 → 走 missed 分支（不播但记日志）。

---

## 9. 后续可扩展

- `daily` 之外加 `weekly / weekdays / cron`；
- 给小朋友定的提醒走 ChildKey 区分音色；
- 提醒前 N 分钟预告（"还有 10 分钟就到送余跃打球的时间了"）——直接复用 `game-session-timer` 的 reminderSeconds 思路；
- 长期看可加"对话内确认"：到点先问"现在播报方便吗"，否则推迟 5 分钟。

---

## 10. 待确认问题

1. 提醒到点是否要**强制打断**当前对话播报？当前方案是排队，不打断。
2. 是否需要"快到点了再提醒一次"（如提前 5 分钟）？本期不做。
3. 多人语音助手后，提醒是否区分用户？本期单用户。
