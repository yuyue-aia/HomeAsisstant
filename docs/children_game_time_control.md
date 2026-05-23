# 小朋友游戏时间管理 设计方案

## 1. 需求

1. 通过智能插板（Gosund/小米插线板）控制 Switch 游戏机的通电/断电，实现游戏机的可用与不可用。
2. 家中有两个小朋友：**余晓 / 余跃**。
3. 配额规则（默认）：
   - 周一 ~ 周五：**禁止游戏**
   - 周六 / 周日：每人**每天 2 小时**
   - 配额按"自然天 + 单人"独立计数，跨天清零。
4. 启用游戏机的对话流程：
   - 小朋友通过语音对话申请游戏。
   - 助手询问要玩的时长。
   - 检查当日剩余配额：
     - 有配额 → 通电启动游戏机，启动定时器。
     - 没配额 / 不在允许日期 → 拒绝并说明原因。
   - 到期前 **5 分钟**、**1 分钟** 主动语音提醒。
   - 时间到期 → 自动断电，并语音播报。

---

## 2. 总体架构

复用现有语音管线，新增一个"游戏配额服务"和一个"游戏控制工具"。

```
        ┌──────────────────────────────────────────────────────────────┐
        │                     DialogSession (语音轮询)                 │
        └──────────────────────────────────────────────────────────────┘
                       │ 语音指令                  ▲ 主动播报
                       ▼                           │
        ┌─────────────────────────┐    ┌──────────────────────────────┐
        │   OpenAI Agent Runtime  │    │   GameSessionTimer (调度)    │
        │   + control_game_console│───▶│  setTimeout: 提前提醒/到期  │
        └─────────────────────────┘    └──────────────────────────────┘
                       │                           │
                       ▼                           ▼
        ┌─────────────────────────┐    ┌──────────────────────────────┐
        │   GameQuotaService      │    │  GosundPlug (game_console    │
        │   - 校验配额             │    │   插孔: turn_on / turn_off)  │
        │   - 扣减/退还配额        │    └──────────────────────────────┘
        │   - 持久化               │
        └─────────────────────────┘
                       │
                       ▼
                .runtime/game-quota.json
```

新增三个模块：

| 模块 | 路径 | 职责 |
|---|---|---|
| `GameQuotaService` | `src/services/game-quota.ts` | 配额规则、按天/按人计数、持久化 |
| `GameSessionTimer` | `src/services/game-session-timer.ts` | 单实例定时器（5min/1min/到期回调） |
| `controlGameConsoleTool` | `src/agent/tools/game-console.tool.ts` | 暴露给 Agent 的工具，组合上面两个服务 + GosundPlug |

---

## 3. 数据模型

### 3.1 配置（`.env`）

```bash
# 游戏机所在的插孔（默认 s1，按实际接线调整）
GAME_CONSOLE_PLUG_DID=s1

# 配额规则（可选，默认即下方值）
GAME_DAILY_QUOTA_MINUTES=120          # 周末单人单日额度
GAME_ALLOWED_WEEKDAYS=6,0             # 允许的星期（周日=0，周六=6）
GAME_REMINDER_MINUTES=5,1             # 到期前提醒点（分钟）
GAME_MAX_SINGLE_SESSION_MINUTES=120   # 单次申请上限
GAME_MIN_SINGLE_SESSION_MINUTES=10    # 单次申请下限

# 持久化文件位置（可选）
GAME_QUOTA_FILE=.runtime/game-quota.json
```

### 3.2 持久化数据（`.runtime/game-quota.json`）

```jsonc
{
  "version": 1,
  "users": {
    "yuxiao":  { "date": "2026-05-23", "usedMinutes": 30 },
    "yuyue":   { "date": "2026-05-23", "usedMinutes": 0 }
  },
  "activeSession": {
    "child": "yuxiao",
    "startedAt": "2026-05-23T11:30:00.000Z",
    "plannedMinutes": 60,
    "endsAt": "2026-05-23T12:30:00.000Z",
    "plugDid": "s1"
  }
}
```

- `users[child].date` 与今天不一致 → 视为新一天，`usedMinutes` 自动归零。
- `activeSession` 用于**进程重启后恢复**：如果还在窗口内就继续跑（重新挂定时器、可选验证插板状态），如果已超时就立即断电并标记结束（同时把已用时长扣进 `usedMinutes`）。

### 3.3 内置儿童档案

```ts
const CHILDREN = [
  { key: 'yuxiao', label: '余晓', aliases: ['余晓', '小晓', '晓晓'] },
  { key: 'yuyue',  label: '余跃', aliases: ['余跃', '小跃', '跃跃'] },
];
```

---

## 4. 状态机

```
            可申请 / 已禁用                     游戏中
   ┌──────────── idle ─────────────┐   ┌───────── running ─────────┐
   │                               │   │                            │
   ▼                               ▼   ▼                            ▼
 工作日(周一~五) → 拒绝          通电 → 计时 → 5min提醒 → 1min提醒 → 到期断电
   配额=0      → 拒绝
   不在允许日期 → 拒绝
```

**状态字段** = `activeSession === null ? 'idle' : 'running'`，全局只允许一个 active session（即一个时刻只有一个小朋友在玩）。

---

## 5. 核心流程

### 5.1 申请启动游戏（`start_game`）

输入：`child = yuxiao | yuyue`，`minutes = number`

1. **基础校验**
   1. `child` 必须是已注册儿童。
   2. `today.weekday` 必须 ∈ `GAME_ALLOWED_WEEKDAYS`，否则返回"周一到周五不允许玩游戏"。
   3. `minutes` ∈ [`GAME_MIN_SINGLE_SESSION_MINUTES`, `GAME_MAX_SINGLE_SESSION_MINUTES`]。
2. **配额校验** —— `GameQuotaService.getRemainingMinutes(child)`
   - 如果 `minutes > remaining` → 返回剩余配额，让 Agent 询问"剩 X 分钟，是否就玩 X 分钟？"。
3. **互斥校验**
   - 已有 `activeSession` → 拒绝（返回当前会话信息），由 Agent 提示对方先停。
4. **通电** —— `GosundPlug(GAME_CONSOLE_PLUG_DID).on()`
   - 失败则**不写 activeSession**，原样返回错误，配额不扣。
5. **记录 + 调度**
   - 写入 `activeSession`（含 `endsAt`）。
   - `GameSessionTimer.start(endsAt, reminders=[5, 1])`：
     - 在 `endsAt - 5min` 触发 `onReminder(5)`
     - 在 `endsAt - 1min` 触发 `onReminder(1)`
     - 在 `endsAt` 触发 `onExpired()`
   - 持久化。
6. **TTS 回复**："好的，余晓玩 60 分钟，到 12 点 30 结束，5 分钟前我会提醒你。"

### 5.2 提前停止（`stop_game`）

输入：可选 `child`（不传时默认就是当前 active）

1. 没有 active → 返回"现在没有人在玩"。
2. **断电** —— `GosundPlug.off(plugDid)`。
3. **结算配额**：`actualMinutes = ceil((now - startedAt) / 60s)`，`quotaService.consume(child, actualMinutes)`。
4. 取消所有定时器，清空 `activeSession`。
5. TTS：`已关闭游戏机，本次玩了 X 分钟，今天还剩 Y 分钟。`

### 5.3 查询（`status` / `query_quota`）

无副作用，返回：

- 今天是否允许游戏（基于 weekday）。
- 每个孩子今日剩余配额。
- 当前是否有人在玩（child / 已玩多久 / 还剩多久）。

### 5.4 提醒回调（被动触发）

```
onReminder(5)  → 主动 TTS："余晓，还有 5 分钟就要关游戏机了。"
onReminder(1)  → 主动 TTS："余晓，还有 1 分钟。"
onExpired()    → 断电 + 主动 TTS："时间到了，已经关闭游戏机，今天的游戏时间用完啦。"
```

主动播报通过给 `DialogSession` 加一个 `announce(text)` 方法实现：

```ts
// dialog-session.ts (新增)
async announce(text: string): Promise<void> {
  // 简单策略：仅在 idle / followup_wait 状态下立即播报；
  // 在 listening / thinking 阶段把消息缓存，等下一次 idle 再播。
  if (this.state === 'idle' || this.state === 'followup_wait') {
    await this.speak(text);
    this.afterSpeakingComplete();
  } else {
    this.pendingAnnouncements.push(text);
  }
}
```

`GameSessionTimer` 通过构造时注入的 `announce(text)` 回调播报，**不直接依赖 DialogSession**，便于后续接入其他通道（如手机推送）。

### 5.5 进程重启恢复

启动时（`OpenAIAgentRuntime` 或更上一层 bootstrap）：

```
读取 game-quota.json
  └── activeSession 存在？
      ├── now < endsAt          → 重新挂定时器，按剩余时间提醒/断电
      ├── now >= endsAt         → 立即断电；将 plannedMinutes 计入 usedMinutes；清空 activeSession
      └── activeSession 与日期不一致(跨天) → 同上，按已实际经过时间扣额，清空
```

---

## 6. 接口与工具定义

### 6.1 `GameQuotaService`（`src/services/game-quota.ts`）

```ts
export type ChildKey = 'yuxiao' | 'yuyue';

export interface QuotaSnapshot {
  child: ChildKey;
  date: string;        // YYYY-MM-DD（本地时区）
  dailyQuotaMin: number;
  usedMinutes: number;
  remainingMinutes: number;
  allowedToday: boolean;
}

export class GameQuotaService {
  constructor(opts?: { file?: string });

  /** 当日是否允许（仅看星期） */
  isAllowedToday(now?: Date): boolean;

  /** 当日剩余配额（自动按天滚动） */
  getSnapshot(child: ChildKey, now?: Date): QuotaSnapshot;

  /** 扣减（min 必须 ≥ 0）。返回扣后剩余 */
  consume(child: ChildKey, minutes: number, now?: Date): number;

  /** 退还（用户提前停止时不退；崩溃恢复时按需调用） */
  refund(child: ChildKey, minutes: number, now?: Date): number;

  /** 当前活跃会话（最多 1 个） */
  getActiveSession(): ActiveSession | null;
  setActiveSession(s: ActiveSession | null): void;
}
```

### 6.2 `GameSessionTimer`

```ts
export interface StartOptions {
  child: ChildKey;
  endsAt: Date;
  reminderMinutes: number[];      // 默认 [5, 1]
  onReminder: (minutesLeft: number) => void;
  onExpired: () => void;          // 必须在内部完成断电 + 配额结算
}

export class GameSessionTimer {
  start(opts: StartOptions): void;
  cancel(): void;                 // 用户主动停止时取消所有 timer
  isRunning(): boolean;
}
```

实现细节：用一组 `setTimeout`，进程退出前 `cancel()`；不依赖 cron。

### 6.3 Agent Tool：`control_game_console`

```ts
parameters = z.object({
  action: z.enum(['start_game', 'stop_game', 'status']),
  child:   z.enum(['yuxiao', 'yuyue']).nullable().optional(),
  minutes: z.number().int().min(10).max(120).nullable().optional(),
});
```

返回值（统一结构，便于 Agent 拼回复）：

```ts
{
  ok: boolean,
  action: 'start_game' | 'stop_game' | 'status',
  child?: 'yuxiao' | 'yuyue',
  reason?: 'not_weekend' | 'no_quota' | 'session_in_progress'
         | 'plug_failed' | 'invalid_child' | 'invalid_minutes',
  remainingMinutes?: number,
  plannedMinutes?: number,
  endsAtIso?: string,
  active?: { child, startedAtIso, endsAtIso, remainingMinutes },
  message: string,   // 给 TTS 直接念的中文
}
```

### 6.4 Agent System Prompt 追加片段

```
对小朋友游戏机控制：
- 当余晓/余跃说"我想玩游戏"或"打开游戏机"时，先调用 control_game_console(action="status") 查询配额；
- 启动需要明确的 child 和 minutes，不确定就追问"你想玩多久"；
- 工具返回的 message 字段已经是面向小朋友的措辞，直接播报；不要编造剩余时间。
- 工具返回 reason=not_weekend / no_quota 时，态度要温和、说明原因，不要责备。
```

---

## 7. 异常与边界

| 场景 | 处理 |
|---|---|
| 插板通电 / 断电请求失败 | 不更新状态，原样把错误返回给 Agent；定时器到期断电失败时重试 1 次，仍失败则播报"游戏机控制失败，请手动关闭电源"。 |
| 进程崩溃后定时器丢失 | 启动时基于 `activeSession.endsAt` 重建（5.5 节）。 |
| 同一秒内两个孩子都想玩 | 互斥检查（4 节状态机），后者拒绝。 |
| 系统时间被改 | 不抗篡改；记录 `startedAt` + `plannedMinutes` 双字段，到期严格用 `endsAt`，提前停止用 `min(now-startedAt, plannedMinutes)`。 |
| 跨天的会话（极端情况：周日 23:30 起 60 分钟） | 跨天时，配额按"开始日"扣；提醒/到期照常；下一天重新统计时不影响。 |
| 配置文件读写失败 | 读失败 → 当作全新；写失败 → 仅打 warn，内存中状态仍生效。 |

---

## 8. 实施步骤（建议提交顺序）

1. **新建 `src/services/game-quota.ts`**：核心配额服务 + 持久化 + 单元约束（不联动设备）。
2. **新建 `src/services/game-session-timer.ts`**：纯定时器，注入回调。
3. **复用 `GosundPlug` 客户端**，无需修改。
4. **新建 `src/agent/tools/game-console.tool.ts`**：组装 1 + 2 + 3，定义工具 schema 与中文 message。
5. **DialogSession 增加 `announce(text)` 方法**：用于定时器回调主动播报；维护 `pendingAnnouncements` 队列避免打断当前对话。
6. **修改 `OpenAIAgentRuntime.constructor`**：注册新工具到 `tools[]`，同时把 system prompt 里"对小朋友游戏机控制..."追加进去。
7. **新增 bootstrap 钩子**：进程启动时调用 `GameQuotaService.recoverActiveSession({ plug, announce })` 完成 5.5 节恢复逻辑。
8. **`.env.example`** 补齐第 3.1 节里的所有变量与默认注释。

---

## 9. 验收用例

| # | 输入 | 期望 |
|---|---|---|
| 1 | 周三晚上小朋友说"我想玩游戏" | 拒绝："今天是周三，平时不能玩哦。" |
| 2 | 周六首次申请，"余晓玩 60 分钟" | 通电；状态文件 `usedMinutes=60` 预扣（或在结束时扣，按实现选择）；TTS 报告结束时间。 |
| 3 | 同上场景下"余跃也要玩 30 分钟" | 拒绝（互斥），提示余晓正在玩。 |
| 4 | 开始 55 分钟时（剩 5 分钟） | 主动 TTS：还剩 5 分钟。 |
| 5 | 开始 59 分钟时 | 主动 TTS：还剩 1 分钟。 |
| 6 | 到 60 分钟 | 自动断电；TTS 时间到了。 |
| 7 | 周六余晓已玩 100 分钟，再申请 30 分钟 | 拒绝并提示剩 20 分钟，问是否要玩 20 分钟。 |
| 8 | 进程在剩 30 分钟时被杀掉再启动 | 自动恢复定时器，5 分钟/1 分钟提醒、到期断电仍正常。 |
| 9 | 玩到一半，"我不玩了" | 立即断电；按已用分钟扣配额；TTS 告知剩余配额。 |
| 10 | 周日 0 点跨天后 | 各自的 `usedMinutes` 自动清零。 |

---

## 10. 后续可选增强

- **家长授权**：每次启动前要求家长口令（或手机端审批），Tool 增加 `parent_approval` 校验。
- **跨周累计/借用**：把"今日配额"换成"周配额 + 当日上限"。
- **节假日规则**：可选接入节假日 API，节假日按周末规则。
- **多通道通知**：除了 TTS 主动播报，可推送到家长手机 / 微信。
- **使用日志**：把每次 session 写入 `.runtime/game-history.jsonl`，便于复盘。
