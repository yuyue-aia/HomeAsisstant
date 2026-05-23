# 音乐播放 Skill 设计方案

> 目标：给「小鱼」加上语音点歌能力。底层音乐能力已由网易云开放平台官方 CLI **`@music163/ncm-cli`** 提供——我们只做一层薄壳，把命令封进 `MusicService`，并通过 Tool/Skill 暴露给 Agent。

**本文档基于 2026-05-24 在开发机（M 系列 macOS，ncm-cli v0.1.5，已登录实名账号，已装 mpv）上的全链路实测结果**。所有命令模型、字段名、返回结构、坑点都来自真实跑通，不再有"假设/待验证"。

---

## 1. 范围与非目标

**首期范围（MVP）**
- 按歌名 / 歌手 / 场景词点播
- 整张歌单播放（关键词搜歌单 → 整体入队）
- 基本控制：暂停 / 继续 / 上一首 / 下一首 / 音量 / 停止
- 红心 / 取消红心
- 每日推荐 / 心动模式
- 与 TTS 互斥：助手说话时自动暂停，说完恢复
- 与对话状态机集成：唤醒/listening 时直接 pause（mac mini 无 AEC）

**非目标（后续阶段）**
- 多房间 / 多设备同步
- 本地音乐库（阶段 2 再加，结构上预留 `MusicSource` 抽象）
- AEC 回声消除（先用「pause + 短延迟」兜底）
- 歌词显示 / 可视化 UI

---

## 2. 关键事实（实测来源）

在动手前必须把这些"反直觉"事实摆在最显眼位置——它们决定了 service 的实现方式。

| # | 事实 | 影响 |
|---|---|---|
| F1 | **`ncm-cli` 包揽了 OAuth、token 刷新、加密 API 签名、mpv 子进程、播放队列、音量、状态查询** | 我们不再自己写 `NeteaseSource` 和 `MpvBackend`，旧设计第 4/5 节作废 |
| F2 | **`play` 命令是 fire-and-forget**：CLI 立即返回（`--output json` 时 stdout 可能为空），mpv 后台 daemon 异步起播 | 调 play 后**必须**轮询 `state` 才能知道是否真起来；超时 3s 仍非 `playing` 视为失败 |
| F3 | **登录态持久化在 `~/.config/ncm-cli/credentials.enc.json`** | 部署机上首次跑 `ncm-cli login --background` 扫码后无需再管，token 自动续期 |
| F4 | **搜索 / 推荐 / 评论等"内容类"命令必须传 `--userInput "<上下文摘要>"`**（开放平台审计要求） | tool 调用必须把用户原话或摘要传到 service 层 |
| F5 | **`play`/`pause`/`resume`/`stop`/`next`/`prev`/`seek`/`volume`/`state` 这些"播控类"命令不要 `--userInput`** | 控制类 tool 调用更简洁 |
| F6 | **歌曲真实艺人在 `fullArtists[]` 字段**，`artists[]` 是脱敏版（原唱"周杰伦"会被显示成翻唱者"Montagem"） | 匹配/播报必须读 `fullArtists` |
| F7 | **`visible: false` 的歌曲不能播**（开放平台政策性下架） | search 结果必须按 `visible === true` 过滤 |
| F8 | **开放平台搜索热度算法 ≠ 网易云 App**：搜"稻香 周杰伦"前 8 条全是翻唱 | LLM 不能傻取首条；service 提供按艺人精确匹配的二次过滤选项 |
| F9 | **`state` 不返回当前音量**（`volume: null`）；`queue` 命令也只返回 `{success, message}`，**列不出队列内容** | 旧设计承诺的 `queue.list()` 给 LLM 看做不到；音量需要 service 自己缓存"上次设的值" |
| F10 | **`play --playlist` 一次入队多达几十首**（实测轻音乐歌单一次 71 首），自动播第一首 | 歌单播放交给 ncm-cli 即可，我们不维护 queue 数据结构 |
| F11 | **付费过滤三件套**：`vipPlayFlag` / `payPlayFlag` / `freeTrialPrivilege.cannotListenReason` | search 结果按这三个字段过滤试听/收费曲 |
| F12 | **响应一律是 `{success, message, ...}` 或 `{code: 200, data: ...}`** 两种 JSON 结构 | `success` 类→播控；`code` 类→内容查询 |

---

## 3. 总体架构

```
              ┌──────────────────────────────────────────┐
              │  OpenAIAgentRuntime                      │
              │  ├─ tools: search_music                  │
              │  │         control_music_player          │
              │  └─ skills/music/SKILL.md                │
              └──────────────────┬───────────────────────┘
                                 │ execute
              ┌──────────────────▼───────────────────────┐
              │  MusicService (单例)                      │
              │  ├─ NcmCli   ← spawn ncm-cli 子进程       │
              │  ├─ StateCache ← 缓存音量、上次播报曲目     │
              │  └─ DuckController ← 订阅 DialogSession   │
              └──────────────────┬───────────────────────┘
                                 │ exec
              ┌──────────────────▼───────────────────────┐
              │  ncm-cli (v0.1.5+, 系统级二进制)          │
              │  ├─ OAuth / token / 签名                  │
              │  ├─ 内容 API（搜索/推荐/歌单/红心/...）     │
              │  └─ mpv daemon（idle, sock IPC, 自管理）  │
              └──────────────────────────────────────────┘
```

设计要点：
- **零自研 API/播放器代码**：所有网易云交互和 mpv 控制都通过 `ncm-cli` 子进程完成。我们只做命令构造 + JSON 解析 + 业务规则（过滤、艺人匹配、duck）。
- **薄壳原则**：`NcmCli` 类只暴露强类型方法（`search/play/state/...`），内部统一 `execFile('ncm-cli', [...args])`。
- **Skill + Tool 双层**：与现有 `reminder` skill 同构。
- **状态机集成**：DuckController 订阅 `DialogSession` 的 state 事件，唤醒/TTS 时直接 pause；不做 30% duck（mac mini 无 AEC，30% 音乐声仍会污染 mic）。

---

## 4. 目录结构

```
src/
  services/
    music/
      music-service.ts          ← MusicService 单例入口
      ncm-cli.ts                ← ncm-cli 子进程封装（强类型 API）
      types.ts                  ← Track / Playlist / PlayerState
      duck-controller.ts        ← TTS 互斥逻辑
  agent/
    tools/
      music.tool.ts             ← search_music + control_music_player
skills/
  music/
    SKILL.md
docs/
  music-skill-design.md         ← 本文档
```

无第三方依赖（mpv 是系统二进制，ncm-cli 是 npm 全局/本地包；本项目代码用 Node 内置 `child_process` 即可）。

---

## 5. ncm-cli 命令模型（实测）

### 5.1 我们用到的命令清单

| 用途 | 命令 | 关键参数 | 返回结构 |
|---|---|---|---|
| 搜单曲 | `search song` | `--keyword <s> --userInput <s>` | `{code:200, data:{records:Track[]}}` |
| 搜歌单 | `search playlist` | `--keyword <s> --userInput <s>` | `{code:200, data:{records:Playlist[]}}` |
| 综合搜索 | `search all` | `--keyword <s> --userInput <s>` | — |
| 每日推荐 | `recommend daily` | `--userInput <s>` | `{code:200, data: Track[30]}` |
| 心动模式 | `recommend heartbeat` | `--songId <hex> --userInput <s>` | `{code:200, data: Track[]}` |
| 播单曲 | `play --song` | `--encrypted-id <hex> --original-id <num>` | `{success, ...}`（**stdout 可能空，见 F2**） |
| 播歌单 | `play --playlist` | `--encrypted-id <hex> --original-id <num>` | 同上，一次入队整张 |
| 暂停 | `pause` | — | `{success, message}` |
| 继续 | `resume` | — | 同上 |
| 停止 | `stop` | — | 同上 |
| 下一首 | `next` | — | `{success, message:"正在切换到下一首 → ..."}` |
| 上一首 | `prev` | — | 同上 |
| 音量 | `volume <0-100>` | — | `{success, message:"音量已设置为 30"}` |
| 状态 | `state` | — | `{success, state:{status, title, position, duration, progress, currentIndex, queueLength}}` |
| 红心 | `song like` | `--encrypted-id <hex> --userInput <s>` | `{code:200, ...}` |
| 取消红心 | `song dislike` | `--encrypted-id <hex> --userInput <s>` | 同上 |
| 我的红心歌单 | `user favorite` | `--userInput <s>` | `{code:200, data: Playlist}` |
| 登录检查 | `login --check` | — | `{success, message}` |

### 5.2 必须的过滤规则

`search song` / `recommend daily` 返回的 `Track[]` 在交给 LLM 或直接播放之前，**必须**：

1. 过滤 `visible === true`
2. 过滤 `vipPlayFlag === false && payPlayFlag === false && freeTrialPrivilege?.cannotListenReason == null`
3. 当用户提供了艺人名时，按 **`fullArtists[].name`** 模糊匹配（包含即可，避免"周杰伦-"末尾横杠落选）；找不到精确匹配则降级为"第一首满足前两条的"

### 5.3 起播验证流程（绕开 F2 的 fire-and-forget 坑）

```ts
async function playAndVerify(opts: PlayOpts) {
  await ncmcli.play(opts);              // 立即返回
  for (let i = 0; i < 6; i++) {         // 最多轮询 6 次 ×500ms = 3s
    await sleep(500);
    const s = await ncmcli.state();
    if (s.status === 'playing' && s.title) return s;
  }
  throw new MusicError('player_not_started');
}
```

### 5.4 鉴权与首次部署

部署机首次需要扫码：

```bash
ncm-cli login --background        # 后台模式，立即返回登录链接（短链）
# 用户用网易云音乐 App 扫码 / 直接打开链接 → 自动完成
ncm-cli login --check             # → {success:true, message:"已登录实名账号"}
```

之后 token 自动续期，token 文件落在 `~/.config/ncm-cli/credentials.enc.json`，权限 600。

代码侧：`MusicService.init()` 启动时跑一次 `ncm-cli login --check`：
- `success: true` → 进入 ready 状态
- `success: false` → 进入 `auth_required` 状态，所有内容类调用返回 `reason: 'auth_required'`，由 SKILL.md 教 LLM 提示用户"网易云需要扫码登录，请在终端执行 `ncm-cli login`"

---

## 6. NcmCli 封装

```ts
// src/services/music/ncm-cli.ts
class NcmCli {
  constructor(private bin = 'ncm-cli') {}

  // ── 内容类（需 userInput）────────────────────────────
  async searchSong(keyword: string, userInput: string): Promise<Track[]>;
  async searchPlaylist(keyword: string, userInput: string): Promise<Playlist[]>;
  async dailyRecommend(userInput: string): Promise<Track[]>;
  async heartbeat(seedSongId: string, userInput: string): Promise<Track[]>;
  async like(encryptedId: string, userInput: string): Promise<void>;
  async dislike(encryptedId: string, userInput: string): Promise<void>;
  async myFavoritePlaylist(userInput: string): Promise<Playlist>;

  // ── 播控类（不需 userInput）──────────────────────────
  async playSong(encryptedId: string, originalId: number): Promise<void>;
  async playPlaylist(encryptedId: string, originalId: number): Promise<void>;
  async pause(): Promise<void>;
  async resume(): Promise<void>;
  async stop(): Promise<void>;
  async next(): Promise<void>;
  async prev(): Promise<void>;
  async setVolume(level: number): Promise<void>;  // 0-100
  async state(): Promise<PlayerState>;

  // ── 系统类 ─────────────────────────────────────────
  async checkLogin(): Promise<boolean>;

  // 内部：execFile + JSON parse + error map
  private async exec<T>(args: string[]): Promise<T>;
}
```

实现要点：
- 用 `child_process.execFile`（避免 shell 注入），不要 `exec`
- `--output json` 全部显式传（虽然默认就是 json）
- stdout 为空 + exitCode 0 也视为成功（F2）
- exitCode != 0 时按 stderr/stdout 内的 `message` 翻译错误
- 内容类调用，`userInput` 字段从 tool 层透传（LLM 触发该 tool 时用户的原话或摘要）

---

## 7. Track / Playlist / PlayerState 类型

```ts
interface Track {
  encryptedId: string;        // 32 位 hex，API 用
  originalId: number;         // 数字 ID，play 命令必传
  name: string;
  artists: string[];          // 来自 fullArtists[].name（非 artists！）
  album?: string;
  durationMs: number;
  coverUrl?: string;
  vipOnly: boolean;           // = vipPlayFlag || payPlayFlag || cannotListenReason
}

interface Playlist {
  encryptedId: string;
  originalId: number;
  name: string;
  trackCount: number;
  creator?: string;
}

interface PlayerState {
  status: 'playing' | 'paused' | 'stopped';
  title?: string;             // 形如 "稻香 - 周杰伦-"
  positionSec?: number;
  durationSec?: number;
  progress?: string;          // 形如 "0:25 / 3:03"
  currentIndex?: number;
  queueLength?: number;
  // 注意：没有 volume 字段（F9）
}
```

---

## 8. MusicService

```ts
class MusicService {
  private cli = new NcmCli();
  private currentVolume = 70;          // 缓存（因为 state 不返回，F9）
  private lastUserVolume = 70;         // duck 前的音量，用于恢复
  private ducked = false;

  async init(): Promise<void> {
    if (!await this.cli.checkLogin()) {
      logger.warn('网易云未登录，音乐能力进入 degraded 模式');
    }
    await this.cli.setVolume(this.currentVolume);
  }

  // ── search & play ─────────────────────────────────
  async searchTrack(query: string, userInput: string, artist?: string): Promise<Track[]>;
  async searchPlaylist(query: string, userInput: string): Promise<Playlist[]>;
  async playTrack(t: Track): Promise<PlayerState>;       // 内部走 playAndVerify
  async playPlaylist(p: Playlist): Promise<PlayerState>;
  async playDailyRecommend(userInput: string): Promise<PlayerState>;
  async playHeartMode(userInput: string): Promise<PlayerState>;

  // ── control ───────────────────────────────────────
  async pause(): Promise<void>;
  async resume(): Promise<void>;
  async stop(): Promise<void>;
  async next(): Promise<void>;
  async prev(): Promise<void>;
  async setVolume(level: number): Promise<void>;         // 同步更新 lastUserVolume
  async like(userInput: string): Promise<void>;          // 用 state.title 反查 encryptedId 太麻烦——改成「需要 LLM 把当前曲的 ID 也传过来」或「缓存 currentTrack」
  async unlike(userInput: string): Promise<void>;

  // ── duck（被 DuckController 调用，不暴露给 tool）─────
  async duckPause(): Promise<void> { /* 记下 wasPlaying，pause */ }
  async duckResume(): Promise<void> { /* 若 wasPlaying 则 resume */ }

  // ── 状态查询 ──────────────────────────────────────
  async nowPlaying(): Promise<{title?: string; artist?: string} | null>;
}
```

**重要**：上面 `like()` 需要"当前曲的 encryptedId"——`state` 命令不返回 ID（只返回 title 字符串）。解决：service 内部维护 `currentTrack` 缓存，每次 `playTrack/playPlaylist` 时记录，对于歌单整体播放则当 `next/prev` 后无法获知新曲 ID（ncm-cli 的限制）——此时 `like` tool 返回 `reason: 'unknown_current_track'`，让 LLM 提示用户"刚才那首歌是什么名字？"再走 search → like。

---

## 9. DuckController（与 TTS 互斥）

mac mini 无 AEC，**不做音量 duck，统一改成 pause/resume**。

| dialog 状态 | 音乐行为 | 备注 |
|---|---|---|
| `idle` | 正常播放 | — |
| `listening` (wake/followup) | **pause** | 避免污染 ASR |
| `thinking` | 维持 paused | — |
| `speaking` (TTS) | 维持 paused | TTS 与音乐共用扬声器 |
| `followup_wait` | **resume** | TTS 结束等用户跟话时已不录音 |
| 状态回到 `idle` 且 prev=`speaking` | **resume** | TTS 结束自然回到 idle |

```ts
class DuckController {
  attach(session: DialogSession): void {
    session.on('state', (next, prev) => this.handle(next, prev));
  }
  private handle(next: DialogState, prev: DialogState) {
    if (next === 'listening' || next === 'speaking' || next === 'thinking') {
      this.service.duckPause();        // 内部记 wasPlaying
    } else if (next === 'idle' || next === 'followup_wait') {
      this.service.duckResume();
    }
  }
}
```

需在 `DialogSession.setState` emit 时同时携带 `prev`（确认现有信号是否有 prev，没有就补；MoneyAgent 套路）。

---

## 10. Skill (LLM 决策层)

### 10.1 SKILL.md frontmatter

```yaml
---
name: music
description: 处理"播放/来首/想听/换一首/暂停音乐/声音大一点/收藏/取消收藏/每日推荐/心动模式"等点歌与音乐控制请求。
---
```

### 10.2 SKILL 正文章节

1. **触发关键词**：来首 / 想听 / 放点 / 播放 / 换首 / 下一首 / 暂停 / 继续 / 大点声 / 小点声 / 停了 / 收藏 / 红心 / 取消红心 / 每日推荐 / 心动 / 我的红心歌单
2. **决策路径**：
   - **具体歌名 + 歌手** → `search_music(query="歌名", artist="歌手")` → 取首条 → `control_music_player(action=play_track, encrypted_id=..., original_id=...)`
   - **只给歌名** → `search_music(query="歌名")` → 第一首 visible
   - **场景/风格词**（"轻音乐""学习背景""下雨天") → `search_music(query="<场景词>", type=playlist)` → `control_music_player(action=play_playlist, ...)`
   - **每日推荐 / 随便来点** → `control_music_player(action=daily_recommend)`
   - **心动模式** → 当前曲为种子 → `control_music_player(action=heart_mode)`（service 内部用 currentTrack 缓存）
   - **控制类**（暂停 / 下一首 / 音量 / 红心 / 取消红心） → 直接 `control_music_player`
3. **场景词 → 歌单关键词** 映射表（精简版，让 LLM 别瞎搜）：

   | 用户说 | 推荐搜索词 |
   |---|---|
   | 深夜 / 安静 / 助眠 | "助眠轻音乐" "深夜电台" |
   | 学习 / 工作 / 背景 | "学习专注" "Lo-fi" |
   | 怀旧 / 老歌 | "怀旧粤语" "80后回忆" |
   | 雨天 | "下雨天的钢琴" "雨天爵士" |
   | 健身 / 跑步 | "跑步节奏" "EDM 健身" |
   | 轻松 / 放松 | "轻音乐" "解压" |
4. **播报规则**：
   - 起播：「好的，给你放（歌名）」「好，轻音乐安排上」（**单句，不超过 12 字**）
   - 切歌：tool 返回的 `message` 含目标曲名（如"正在切换到下一首 → 夏に花が散る - 羽肿"），LLM 改写成"下一首"或简短播报
   - 暂停/停止：「好的」
   - 音量：「调大了」「调小了」，不复述数字
   - 红心：「收藏了」/「取消收藏」
   - 找不到：「没找到合适的，要不换个说法？」
   - **VIP 歌**：tool 返回 `reason=vip_only`，LLM 说"这首要会员，要不换一首？"
   - **未登录**：tool 返回 `reason=auth_required`，LLM 说"网易云需要登录一下，请在终端执行 ncm-cli login"
   - **起播超时**：tool 返回 `reason=player_not_started`，LLM 说"播放器好像没反应，要不再试一次？"
5. **不要做的事**：
   - 不念歌曲 ID
   - 不逐条念候选列表（用户问"有哪些"时除外）
   - 播放时不主动闲聊
   - 不要在用户没说艺人名的情况下硬猜（artist 字段为空就别填）

### 10.3 主 prompt 影响

零变化——继续走 progressive disclosure，只新增一行 skill 清单：

> `- music: 处理"播放/来首..."等点歌与音乐控制请求。`

---

## 11. Tool 设计

### 11.1 `search_music`

```ts
const params = z.object({
  query: z.string().describe('搜索关键词：歌名、歌单名、风格词'),
  artist: z.string().nullable().optional()
    .describe('当用户明确说了歌手名时填，否则留空。service 会按此字段精确过滤'),
  type: z.enum(['track', 'playlist']).nullable().optional()
    .describe('track=单曲；playlist=歌单；默认 track'),
  user_input: z.string()
    .describe('用户的原话或简短摘要，必填（开放平台审计要求）'),
});

// 返回：
{
  ok: boolean;
  type: 'track' | 'playlist';
  items: Array<{
    encrypted_id: string;
    original_id: number;
    name: string;
    artists?: string[];           // 仅 track
    track_count?: number;          // 仅 playlist
  }>;
  reason?: 'not_found' | 'auth_required' | 'network_error';
  message: string;
}
```

返回的 `items` **已经经过 visible/付费过滤 + artist 精确匹配**，LLM 直接取首条即可。

### 11.2 `control_music_player`

```ts
const params = z.object({
  action: z.enum([
    'play_track',         // 需 encrypted_id + original_id
    'play_playlist',      // 需 encrypted_id + original_id
    'daily_recommend',
    'heart_mode',
    'pause',
    'resume',
    'stop',
    'next',
    'prev',
    'set_volume',         // 需 volume_level（0-100）
    'like',               // 红心当前曲
    'unlike',
    'now_playing',
  ]),
  encrypted_id: z.string().nullable().optional(),
  original_id: z.number().int().nullable().optional(),
  volume_level: z.number().int().min(0).max(100).nullable().optional(),
  user_input: z.string().nullable().optional()
    .describe('仅 daily_recommend / heart_mode / like / unlike 需要'),
});

// 返回：
{
  ok: boolean;
  reason?: 'not_found' | 'vip_only' | 'auth_required' | 'player_not_started'
         | 'unknown_current_track' | 'network_error';
  message: string;
  now_playing?: { title: string; artists: string[] };  // play 类成功后带上
}
```

### 11.3 错误模型

统一 reason 字段（见上）。Service 抛 `MusicError(reason, message)`，tool 转 `{ ok:false, reason, message }`。LLM 根据 SKILL.md 第 10.2.4 节决定播报。

---

## 12. 与现有代码的集成点

| 文件 | 改动 |
|---|---|
| `src/config/env.ts` | 加 `musicEnabled: boolean`（默认 true）、`ncmCliBin: string`（默认 `'ncm-cli'`） |
| `src/agent/openai-agent-runtime.ts` | tools 数组加 `searchMusicTool, controlMusicPlayerTool`；构造时 `getMusicService().init()` |
| `src/dialog/dialog-session.ts` | 启动时 `getMusicService().attachDuck(this)`；确认 state 事件携带 prev |
| `src/agent/skills/skill-loader.ts` | 自动扫描即可（已支持 `skills/<name>/SKILL.md`） |
| `skills/music/SKILL.md` | 新增 |
| `src/services/music/*` | 全部新增 |
| `.env.example` | 加注释说明：需先全局装 `@music163/ncm-cli` 并扫码登录一次 |
| `package.json` | **不引任何 npm 依赖**——`ncm-cli` 是系统级二进制 |
| `dev.md` | 加一节"音乐 Skill 部署"，写清楚 `npm i -g @music163/ncm-cli` + `brew install mpv` + `ncm-cli login` 三步 |

---

## 13. 实施阶段

### 阶段 1 — Service 骨架（半晚）
- [ ] `src/services/music/ncm-cli.ts`：execFile 封装 + JSON 解析 + 错误映射
- [ ] `src/services/music/types.ts`
- [ ] `src/services/music/music-service.ts`：search/play 核心路径 + currentTrack 缓存 + playAndVerify
- [ ] 单元自测脚本：`node -r tsx/cjs scripts/music-smoke.ts`，跑通"搜稻香 → 过滤 → 播放 → state 验证 → stop"

### 阶段 2 — Tool & Skill 接入（半晚）
- [ ] `src/agent/tools/music.tool.ts`：两个 tool
- [ ] `skills/music/SKILL.md`
- [ ] 注册到 `openai-agent-runtime.ts`
- [ ] 终端跑一遍：说"放周杰伦的稻香"，听到出声

### 阶段 3 — DuckController & 状态机融合（半晚）
- [ ] `duck-controller.ts` + DialogSession 集成
- [ ] 唤醒前 pause、TTS 期间 paused、回到 idle resume
- [ ] 验证：放歌时说"小鱼"，能正常识别 + 答完恢复播放

### 阶段 4 — 高级能力（1 晚）
- [ ] 每日推荐 / 心动模式
- [ ] 红心 / 取消红心（解决 currentTrack 在歌单 next 后丢失的问题：service 在 next/prev 后调一次 state 拿 title，再 search 反查 encryptedId；如果太慢就直接放弃，返回 `unknown_current_track`）
- [ ] 风格词映射表试用，按实际体验微调

### 阶段 5 — 部署到 Mac mini（半晚）
- [ ] mac mini 上 `npm i -g @music163/ncm-cli`
- [ ] mac mini 上装 mpv：无 brew，从 mpv.io 下静态包，把二进制软链到 `/usr/local/bin/mpv`
- [ ] `ncm-cli login --background` 扫码（用本地 ssh 拿到短链 → 手机扫）
- [ ] `ncm-cli login --check` 验证
- [ ] 跑 HomeAssistant 主程序，全链路验证

---

## 14. 风险与对策

| 风险 | 概率 | 影响 | 对策 |
|---|---|---|---|
| ncm-cli 版本升级破坏命令格式 | 中 | 全功能失效 | service 启动跑 `ncm-cli --version`，记录到日志；CI 加版本兼容矩阵；锁定一个已知好版本作为基线（当前 0.1.5） |
| 网易云开放平台搜索热门排序差 | 已发生 | 找不到原唱 | service 内置 artist 精确匹配（按 `fullArtists`），找不到再降级；SKILL.md 鼓励 LLM 主动追问"是某某的版本吗？" |
| mpv 子进程崩溃 | 低 | 播放中断 | ncm-cli 自带 mpv daemon 重连；service 检测到 state.status 异常时主动重发 play |
| token 失效（用户改密码 / 撤销授权） | 低 | 全部内容 API 失败 | service 捕获 → 提示重扫码；进入 degraded（控制类仍能 pause/stop） |
| 用户点了 VIP 歌 | 中 | 播不出 | service 起播前根据 vipPlayFlag 提前拒绝，返回 vip_only |
| mac mini 无 AEC，音乐声触发 KWS | 高 | 误唤醒 | DuckController 改用 pause 而非 duck（已采纳） |
| ncm-cli stdout 突然变格式 | 低 | JSON 解析失败 | execFile 拿到的字符串解析失败时记 stderr + stdout 全文到 log，service 抛 `parse_error`，LLM 提示"音乐服务异常，请稍后再试" |
| 网络不通 | 中 | search/play 失败 | ncm-cli 会返回 code != 200 或 success=false，service 一律包成 `network_error` |

---

## 15. 与现有「提醒 Skill」的风格对齐

| 维度 | reminder | music | 对齐情况 |
|---|---|---|---|
| Skill 渐进披露 | ✓ | ✓ | 一致 |
| Tool 合并 action | manage_reminder | control_music_player | 一致 |
| Service 单例 | reminder-service.ts | music-service.ts | 一致 |
| 副作用统一在 service | ✓ | ✓ | 一致 |
| Tool 参数中文 describe | ✓ | ✓ | 一致 |
| 主 prompt 只多一行 skill 清单 | ✓ | ✓ | 一致 |

---

## 16. 已决定 / 待确认

**已定**
- 内容与播放器都委托 `@music163/ncm-cli`，零自研 NeteaseSource / MpvBackend
- Skill + Tool 双层，Skill 给规则，Tool 给能力
- Mac mini 无 AEC，duck 策略统一改成 pause/resume
- 不维护 queue 数据结构（ncm-cli 已经管了）

**追加已定（2026-05-24）**
- **风格词映射**：先 6 个精简版上线，日志驱动扩展（用户实际说什么再加什么）
- **like 无 ID 兜底**：`reason: 'unknown_current_track'`，让 LLM 让用户再报一次歌名，不做反查
- **ncm-cli 路径**：走 PATH，不引 `.env` 配置（部署机 PATH 里有 `ncm-cli` 即可）
- **Mac mini 部署**：阶段 5 暂缓，先把开发机闭环跑通
