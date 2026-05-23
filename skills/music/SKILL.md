---
name: music
description: 处理"放/来首/想听/换一首/暂停/继续/下一首/声音大一点/收藏/取消收藏/每日推荐/心动模式"等点歌与音乐控制请求。
---

# 音乐 Skill

对应工具：
- `search_music`：搜索歌曲或歌单（返回精筛后的候选列表）。
- `control_music_player`：所有播放/控制/红心操作（合并 action）。

## 决策路径

| 用户的话 | 走法 |
|---|---|
| "播放周杰伦的稻香" / "放一首红日" | `search_music(query=歌名, artist=歌手?, type='track', user_input=用户原话)` → 取首条 → `control_music_player(action='play_track', encrypted_id, original_id)` |
| "来点轻音乐" / "学习的背景音乐" / "下雨的歌单" | `search_music(query=场景词, type='playlist', user_input=用户原话)` → 取首条 → `control_music_player(action='play_playlist', encrypted_id, original_id)` |
| "随便来点" / "每日推荐" / "今天有什么推荐" | `control_music_player(action='daily_recommend', user_input=用户原话)` |
| "再来一首类似的" / "心动模式" | `control_music_player(action='heart_mode', user_input=用户原话)` |
| "暂停" / "停下" 一类 | `control_music_player(action='pause')` |
| "继续" / "接着放" | `control_music_player(action='resume')` |
| "停了吧" / "别放了" | `control_music_player(action='stop')` |
| "下一首" / "换一首" | `control_music_player(action='next')` |
| "上一首" / "刚才那首" | `control_music_player(action='prev')` |
| "大声点" / "小声点" / "音量 50" | `control_music_player(action='set_volume', volume_level=0-100)`，凭印象设增减 20 |
| "收藏" / "我喜欢这首" / "加红心" | `control_music_player(action='like', user_input=用户原话)` |
| "取消收藏" / "不喜欢这首" | `control_music_player(action='unlike', user_input=用户原话)` |
| "现在放的是什么" | `control_music_player(action='now_playing')` |

## 关键规则

### 0. 搜到 → 必须立刻播（**最高优先级**）

`search_music` 返回的 `items[0]` **不是终点**，**只是中间结果**。
拿到非空 `items` 之后，你**必须**在**同一轮回复里立刻**继续调一次 `control_music_player`，绝对不要只发文本就结束。

具体规则：
- `search_music(type='track')` 返回 `ok=true` 且 `items` 非空 → **立刻**调 `control_music_player(action='play_track', encrypted_id=items[0].encrypted_id, original_id=items[0].original_id)`。
- `search_music(type='playlist')` 返回 `ok=true` 且 `items` 非空 → **立刻**调 `control_music_player(action='play_playlist', encrypted_id=items[0].encrypted_id, original_id=items[0].original_id)`。
- `search_music(type='track')` 返回 `ok=false, reason='not_found'` 且用户原意是"播某歌手/某场景" → **立刻**改用 `search_music(type='playlist')` 重搜，然后 `play_playlist`，**不要**先回答用户"没找到"。
- 只有 `play_xxx` 也失败时，才用文本回复用户。

错误示范（**禁止**）：
> 工具返回了 `items=[{name:'孙燕姿热门50单曲',...}]`
> 你回复："好的，给你放孙燕姿热门50单曲。"  ← **错！没调 play_playlist，根本没起播。**

正确示范：
> 工具返回了 `items=[{name:'孙燕姿热门50单曲', encrypted_id:'...', original_id:...}]`
> 你**继续调用** `control_music_player(action='play_playlist', encrypted_id='...', original_id=...)`，
> 拿到 `ok:true` 后再回复："好，孙燕姿安排上。"

### 1. 关于 `user_input` 参数
- `search_music`、`daily_recommend`、`heart_mode`、`like`、`unlike` **必须**传 `user_input`（开放平台审计要求）。
- 直接传用户的原话即可，例如 `user_input='给我放首周杰伦的稻香'`。
- 其它播控（pause/resume/stop/next/prev/set_volume/play_track/play_playlist/now_playing）**不要**传。

### 2. 关于 `artist`
- 用户**明确说了**歌手时才填，例如"周杰伦的稻香" → `artist='周杰伦'`。
- 用户**没说**歌手就**留空**，不要凭印象猜（开放平台搜索热度排序不可靠，乱填反而搜不到）。

### 3. 场景词 → 歌单关键词映射（精简表）

| 用户说 | 推荐 query |
|---|---|
| 轻音乐 / 放松 / 解压 | "轻音乐" |
| 学习 / 工作 / 背景 / 专注 | "学习专注" |
| 助眠 / 安静 / 深夜 | "助眠轻音乐" |
| 雨天 | "雨天钢琴" |
| 怀旧 / 老歌 | "怀旧粤语" |
| 跑步 / 健身 | "跑步节奏" |

不在表里就**用用户说的原词**当 query，别瞎扩展。

### 4. 红心拿不到当前曲时
- 用户说"收藏这首"，但你**刚刚没用过 play_track 起播**（比如在播歌单、或刚 next 过），tool 会返回 `reason='unknown_current_track'`。
- 这时你说："不知道现在在播哪首呢，能再说一遍歌名吗？" 然后等用户回，再走 `search_music` → `play_track` 路线（这种情况下原意一般是"播这首"而不只是"收藏"——只要 play 起来就自动可以 like）。

## 播报规则

工具返回的 `message` 字段是**语义提示**（如"正在切换到下一首 → 夏に花が散る - 羽肿"），**不要原样念**，要改写成短而自然的中文。

### 起播
- "好的，给你放稻香。"
- "好，轻音乐安排上。"
- **单句，最长不超过 12 字**，别复述歌单完整名。

### 切歌
- 工具返回的 `message` 里如果带"→ <下一首歌名>"，可以播报"下一首"或"下一首是 XX"。
- 不要逐字念整个 message。

### 暂停/停止/继续
- "好的。" "停了。" "继续。"

### 音量
- "调大了。" "调小了。" **不要复述音量数字**。

### 红心
- "收藏了。" / "取消收藏。"

### now_playing
- `now_playing.title` + `artists` 拼一句："现在放的是稻香，周杰伦。"
- artists 多个时只念前一个。

## 错误处理（按 reason 分支）

| reason | 你要说什么 |
|---|---|
| `not_found` | "没找到合适的，要不换个说法？" |
| `vip_only` | "这首要会员，换一首吧。" |
| `auth_required` | "网易云要登录一下，在终端跑 ncm-cli login。" |
| `player_not_started` | "播放器没反应，再试一次？" |
| `unknown_current_track` | "不知道现在在放哪首，能再说一遍歌名吗？" |
| `network_error` / `parse_error` | "音乐服务出岔子了，等会儿再试。" |
| `spawn_failed` | "找不到 ncm-cli，没法播音乐。" |

## 不要做的事

- 不要念歌曲 ID / encrypted_id。
- 不要逐条念候选列表（除非用户明确问"有哪些版本"）。
- 不要在播放时主动闲聊。
- 用户没说艺人名时 `artist` **必须留空**——不要硬猜"是不是周杰伦的"。
- 不要每次都重复"好的好的"——只说一次。
