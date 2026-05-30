# Home Voice Assistant — 小鱼

一个跑在自家树莓派 / Mac mini 上的中文家庭语音助手。本地唤醒词 + 腾讯云 ASR / TTS + OpenAI Agents SDK 编排的 LLM agent，加上小米空调伴侣、Gosund 插线板、Home Assistant、网易云音乐等本地家居控制工具，外加一套基于 [Agent Skills](https://agentskills.io/) 标准的"按需加载技能包"机制，把家务话术与具体规则解耦。

唤醒词默认是 **"小鱼"**（也可以训练成"菜包菜包"等任意词组），整套链路全中文。

---

## 功能一览

- **本地唤醒词检测**：[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) zipformer KWS，离线、低功耗，唤醒词从 `models/kws/keywords-caibao.txt` 加载。
- **流式 ASR**：腾讯云实时语音识别（16kHz 中文）。
- **流式 TTS**：腾讯云语音合成，支持 WebSocket 流式 + 句级 pipeline，首字延迟 ≈ 1 秒。
- **多轮对话 Agent**：基于 `@openai/agents` SDK，可对接 OpenAI / DeepSeek / 任意 OpenAI 兼容网关（如腾讯 TokenHub）。
- **会话历史按天分片**：`.runtime/agent-history/YYYY-MM-DD.json`，跨天自动失忆，单日上限可配。
- **可观测性**：可选接入 [Langfuse](https://langfuse.com/) OTLP，零侵入采集 trace / token / 工具调用。
- **家居工具集**：
  - 小米空调伴侣（`cuco.acpartner.cp6`）—— 5 个房间独立控制
  - Gosund / 米家智能插板（`cuco.plug.cp5d`）—— 多孔位独立开关
  - Home Assistant REST API —— 通用设备透传
  - 游戏机限时管理（接在插板某一孔的 Switch，按周次/单日额度配额）
  - 提醒 / 闹钟（自然语言时间解析 + 重复规则 + 自动提前量）
  - 网易云音乐（基于 `ncm-cli` 的 mpv daemon）
  - 联网搜索（DuckDuckGo / Brave / Tavily / SerpAPI / Bing 自适配）
  - 本机文件读写
- **Skill 系统**：领域规则（空调话术、游戏配额规则、音乐操控、提醒口播…）以 `skills/<name>/SKILL.md` 形式外置，启动时按 `eager` / `lazy` 两种模式注入 system prompt。
- **CLI 守护**：内置 daemon 化、PID 文件、`stop / status / logs -f`、单次问答 `ask "…"`。

---

## 快速开始

### 1. 安装依赖

```bash
# macOS
brew install sox node@20

# Debian / 树莓派
sudo apt install sox alsa-utils
```

```bash
npm install
```

可选：

- 网易云音乐播放需要 [`ncm-cli`](https://github.com/srcrip/ncm-cli)（一个 mpv 包装），自行 `brew install ncm-cli` 或下载二进制。
- Langfuse trace 上报可选，不配置就走默认（无 trace 上报）。

### 2. 配置 `.env`

```bash
cp .env.example .env
# 至少填好：OPENAI_API_KEY / TENCENTCLOUD_*
$EDITOR .env
```

详细字段见 [`.env.example`](./.env.example)。最小可跑配置：`OPENAI_API_KEY` + 腾讯云三件套（`TENCENTCLOUD_APP_ID/SECRET_ID/SECRET_KEY`）。

### 3. 下载唤醒词模型

```bash
npm run kws:download-model
```

会把 sherpa-onnx 中文 KWS 模型放到 `models/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01/`。

要改唤醒词，参考 [sherpa-onnx KWS 文档](https://k2-fsa.github.io/sherpa/onnx/kws/index.html)，把 token 写到 `models/kws/keywords-*.txt`，然后改 `KWS_KEYWORDS_FILE`。仓库内置的 `keywords-caibao.txt` 是"菜包菜包"，可换成任意 4–6 个汉字。

### 4. 启动

```bash
# 前台跑
npm run start

# 后台 daemon
npm run start -- --daemon
npm run logs -- -f
npm run stop
npm run status

# 单次问答（不走麦克风/TTS，直接文本进出）
npm run ask -- "客厅空调开到二十六度"
```

启动成功后控制台会出现：

```
[10:23:12] Home Voice Assistant 已启动，请说唤醒词："小鱼"
[10:23:18] [唤醒] 小鱼，我在，请说指令…
[10:23:21] [用户] 余跃房间空调调到二十四度
[10:23:23] [小鱼] 好的，余跃房间空调已经调到二十四度。
```

---

## 目录结构

```
.
├── prompts/                       # System prompt 模板（外置，纯文案）
│   ├── system.base.md             # 通用基线（人设 / 输出格式 / 工具使用原则）
│   ├── system.eager.md            # 把所有 SKILL.md 内联进 prompt 的模式
│   └── system.lazy.md             # 仅注入清单 + load_skill 工具的模式
│
├── skills/                        # Agent Skills（领域规则包）
│   ├── air-conditioner/SKILL.md
│   ├── game/SKILL.md
│   ├── music/SKILL.md
│   └── reminder/SKILL.md
│
├── src/
│   ├── cli/                       # 命令行入口 + daemon + 麦克风/扬声器 IO
│   ├── wake/                      # sherpa-onnx KWS 封装
│   ├── asr/                       # 腾讯云 ASR 客户端
│   ├── tts/                       # 腾讯云 TTS 客户端（WebSocket 流式）
│   ├── dialog/                    # 对话状态机：idle → listening → thinking → speaking
│   ├── agent/
│   │   ├── openai-agent-runtime.ts        # @openai/agents 启动与历史管理
│   │   ├── system-prompt-builder.ts       # 模板拼装 + 字节稳定 fingerprint
│   │   ├── skills/skill-loader.ts         # 扫描 skills/、归一化、frontmatter 解析
│   │   ├── tools/                         # 各类工具（空调、插板、提醒、音乐、搜索…）
│   │   └── tracing/langfuse-tracer.ts     # OTLP → Langfuse 接入
│   ├── services/                  # 业务子模块（游戏配额、提醒、音乐 daemon 包装…）
│   ├── config/env.ts              # `.env` → AppConfig 的唯一入口
│   └── common/logger.ts           # 结构化日志（按天滚动 logs/app-YYYY-MM-DD.log）
│
├── models/                        # KWS 模型目录（git ignore）
├── .runtime/                      # PID / 日志 / 历史分片 / 游戏配额（git ignore）
├── logs/                          # 结构化日志（git ignore）
└── demos/                         # 独立可跑脚本（KWS 测试、小米 token 抓取等）
```

---

## Skill 加载机制（重点）

Agent 的领域规则不写在代码里，全部以 Markdown 形式存放在 `skills/<name>/SKILL.md`，启动时由 `src/agent/skills/skill-loader.ts` 扫描装载。

### 两种模式

由 `AGENT_SKILLS_LOAD_MODE` 控制：

| 模式 | system prompt 长度 | 是否注册 `load_skill` 工具 | 适用场景 |
|---|---|---|---|
| **eager**（默认） | 较长（所有 SKILL 正文内联） | 否 | 语音对话——首字延迟优先 |
| **lazy** | 较短（仅 name+description 清单） | 是，按需读取 | token 敏感场景 |

eager 模式下，启动后所有规则已"开箱即用"；lazy 模式下，LLM 看到清单后会自己调 `load_skill(name)` 把对应规则读进上下文，再执行后续工具调用——多一次 round-trip 换更小的 prompt。

### 字节级稳定（命中 prompt cache）

整套设计围绕"同一份 skills 多次启动得到完全一致的 system prompt"展开，目标是把 13 KB 左右的前缀全部命中上游网关 prompt cache：

1. `discoverSkills()` 末尾按 `name` 字典序排序（固定 `'en'` locale），消除 `readdir` 顺序差异。
2. 所有文件读取都走 `readStable()`：UTF-8 → CRLF/CR 归一化为 LF → 去尾随空白。
3. SKILL frontmatter 不进 prompt，避免新增字段污染缓存。
4. 模板里的占位符走 `strictReplace`（缺/多都直接抛错），宁可启动失败也不在线上无声生成残缺 prompt。
5. eager 模式启动时 `loadAllSkillBodies()` 一次性把正文锁进内存，避免运行中 SKILL.md 被改击穿缓存。
6. 启动日志会打印 `agent.system_prompt.fingerprint`（sha256 前 12 位），同一份配置多次启动应得到同一 hash。

### 写一个新 Skill

```
skills/my-feature/
└── SKILL.md
```

```markdown
---
name: my-feature
description: 一句话说"用户什么时候应该让你介入"，给 LLM 决定是否加载它。
---

# 我的技能

对应工具：`xxx_tool`。

## 操作规则

…（按规则风格写。LLM 会按"适用场景"匹配，按规则文字直接执行）
```

可选地在该目录里放 `scripts/`、`references/`、`assets/`，用 `read_file` 工具按 `loadSkillBody` 返回的 `directory` 拼路径读。

---

## 配置参考（`.env`）

完整列表见 [`.env.example`](./.env.example)。下面只列最常被改的几项。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `OPENAI_API_KEY` | — | 必填 |
| `OPENAI_BASE_URL` | （官方）| 三方网关填这里，非空时自动切到 chat-completions API |
| `OPENAI_AGENT_MODEL` | `gpt-4.1` | 推荐 `deepseek-v4-flash` 之类的快模型，语音对话延迟敏感 |
| `OPENAI_AGENT_HISTORY_DIR` | `.runtime/agent-history` | 多轮历史按天分片目录 |
| `OPENAI_AGENT_HISTORY_MAX` | `20` | 单日条数上限，超出滑窗 |
| `AGENT_SKILLS_LOAD_MODE` | `eager` | 改 `lazy` 切按需加载 |
| `AGENT_SKILLS_DIR` | `skills` | 多目录用 `:` 分隔，先发现的优先 |
| `TTS_STREAMING` | `false` | 设 `true` 走 WebSocket 流式 TTS（需控制台开通"实时语音合成"） |
| `KWS_KEYWORDS_FILE` | `models/kws/keywords-caibao.txt` | 切换唤醒词 |
| `WAKE_DIAG` | — | `=1` 时启用麦克风滚动录音诊断（`kill -USR2 <pid>` 触发 dump） |
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_BASE_URL` | — | 三项配齐即开启 trace 上报 |

### 设备 token 获取

- 小米空调伴侣 / 智能插板 token：用仓库内 `Xiaomi-cloud-tokens-extractor`（米家账号登录抓取）或 `demos/xiaomi-token-by-ip.py`（同网段按 IP 探测）。
- 各设备 IP / token 填到 `AC_<ROOM>_IP / AC_<ROOM>_TOKEN`、`GOSUND_PLUG_IP / GOSUND_PLUG_TOKEN`。

---

## CLI 命令

```
home-voice start                 前台运行（Ctrl+C 退出）
home-voice start --daemon        后台运行（detached，写 .runtime/voice.pid）
home-voice stop                  SIGTERM 后台进程，5s 不退则 SIGKILL
home-voice status                查询后台状态
home-voice logs [-f]             tail -200 后台日志，-f 实时跟随
home-voice ask "问题"            一次性文本问答（不走 ASR/TTS）
```

`npm run xxx` 等价于 `home-voice xxx`。

---

## 工作流程（语音链路）

```
麦克风 16kHz PCM
   ↓
WakeWordService (sherpa-onnx KWS)        # 本地，离线
   ↓ (命中 "小鱼")
DialogSession: idle → listening
   ↓
TencentAsrClient (流式)                   # final 触发结束
   ↓ user text
OpenAIAgentRuntime.runStream()           # @openai/agents
   │  ├─ system prompt（base + skills，已 cache）
   │  ├─ tools: control_*, manage_reminder, search_music, …
   │  └─ history: 当天分片（最多 N 条）
   ↓ output_text_delta（句级切分）
StreamingSentenceSplitter
   ↓ 一段一段送
TencentTtsClient (WebSocket 或 RESTful)
   ↓ mp3/pcm chunk
playAudioBuffer（afplay / mpg123 / ffplay 自适配）
   ↓
DialogSession: speaking → followup_wait → 下一轮 / idle
```

---

## 故障排查

| 现象 | 排查 |
|---|---|
| 启动报 `Missing OPENAI_API_KEY` | `.env` 没加载或字段写错；前台启动会打印 stack |
| 麦克风没声音 / `spawn sox ENOENT` | 没装 sox：`brew install sox` 或 `apt install sox` |
| 唤醒不灵 | 用 `WAKE_DIAG=1 npm run start` 启动，唤醒词试不出后 `kill -USR2 <pid>`，得到的 wav 可以肉眼看波形 |
| `npm run logs` 看到 `prompt_cache_hit_tokens=0` 一直为 0 | 检查 `agent.system_prompt.fingerprint` 是否每次启动都不一样；通常是 SKILL.md / 模板被编辑器改过尾随换行符 |
| 退出后音乐还在放 | `ncm-cli` 起的是 mpv daemon，正常路径下 `voice-service` 退出会发 stop；崩溃路径有 `process.on('exit')` 的同步 spawn 兜底 |
| 历史串台 / 答非所问 | `.runtime/agent-history/<今天>.json` 删掉重启即可；或 `OPENAI_AGENT_HISTORY_MAX=0` 临时关闭多轮 |

---

## 设计要点速览

- **prompts 与代码分离**：人设、输出格式、技能规则全部 Markdown，改文案不动代码、不重构、不漏一处。
- **模式分模板而非 if/else**：`system.eager.md` / `system.lazy.md` 各自完整，避免在同一段文案里塞条件分支改一处坏一处。
- **字节稳定优先**：所有文件读取归一化、所有列表排序固定、frontmatter 不进 prompt——为的是把 prompt cache 命中率拉满。
- **失败显式而非降级**：占位符缺失、frontmatter 不全、必填配置缺失都会立刻抛错或 warn，绝不静默生成残缺 prompt。
- **历史按天分片**：避免单文件无限增长；跨天自动失忆，符合家庭语音"独立轮次"的实际使用模式。
- **关键退出路径冗余**：SIGINT/SIGTERM/SIGHUP/uncaughtException/unhandledRejection 五条路径都会发 `ncm-cli stop`，加上 `process.on('exit')` 的同步兜底。

---

## 相关文档

仓库根有几份针对单点的深度文档，按需取用：

- `ARCHITECTURE.md` / `ARCHITECTURE_QUICK_REFERENCE.md` —— 整体架构
- `FLOW_DIAGRAMS.md` —— 关键流程图
- `docs/SKILLS_LOADING_SYSTEM.md` —— Skill 加载子系统详解
- `docs/SKILLS_FLOW_DIAGRAM.txt` —— Skill 加载链路图

---

## License

私有项目，未授权请勿使用。
