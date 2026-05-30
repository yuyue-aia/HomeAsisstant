# Home Voice Assistant - Architecture Deep Dive

## Project Overview

This is a **Chinese home voice assistant** ("小鱼" - Little Fish) that processes voice commands, controls smart home devices, and manages gaming sessions for children. It integrates with:
- OpenAI's Agent framework for decision-making
- Xiaomi smart home devices (AC partners, smart plugs)
- Tencent ASR/TTS for voice processing
- Local wake-word detection

**Key Technologies:**
- Framework: OpenAI Agents SDK (`@openai/agents`)
- Language: TypeScript (compiled to Node.js)
- Voice: Tencent Cloud ASR/TTS + Sherpa-ONNX KWS
- Device Control: Xiaomi miio protocol

---

## 1. SKILLS SYSTEM - Progressive Disclosure Pattern

### Architecture Philosophy

Skills follow the **Progressive Disclosure** pattern with 3 phases:

1. **Discovery** (startup, once): Scan `skills/` directory, extract YAML frontmatter from SKILL.md files
2. **Activation** (per-request, LLM-driven): When user intent matches a skill description, LLM calls `load_skill` tool
3. **Execution** (per-request, agent + tools): Follow SKILL.md instructions to execute domain-specific logic

### Why This Design?

- **Reduced prompt size**: Main prompt only contains skill *names* + *descriptions* (one line each)
- **Modularity**: Each skill is a self-contained folder with its own rules, tools, and assets
- **Scalability**: New skills can be added without modifying core agent code
- **Token efficiency**: Domain-specific rules only loaded when needed

### File Structure

```
skills/
├── air-conditioner/
│   ├── SKILL.md                    ← Frontmatter (name, description) + rules
│   ├── scripts/                    ← Optional: helper scripts
│   └── references/                 ← Optional: lookup tables, constants
├── game/
│   └── SKILL.md
├── music/
│   └── SKILL.md
└── reminder/
    └── SKILL.md
```

### SKILL.md Format

```yaml
---
name: air-conditioner
description: 处理空调相关控制——开关、调温、升温降温、模式切换、批量关闭。涉及"空调""冷风"等说法时加载本 skill。
---

# 空调控制 Skill

对应工具：`control_air_conditioner`。

## 房间清单
...

## 操作规则
...
```

- **YAML Frontmatter** (lines 1-3):
  - `name`: unique identifier, used by `load_skill` tool
  - `description`: one-sentence hint for LLM (what user utterances match this skill?)
  
- **Markdown Body** (lines 5+):
  - Plain Markdown text (rules, decision trees, constraints)
  - LLM reads this *after* user request matches the description
  - Parsed by `parseFrontmatter()` in `skill-loader.ts`

### Runtime Flow: Skill Discovery

**File:** `src/agent/skills/skill-loader.ts` → `discoverSkills()`

```
1. Read AGENT_SKILLS_DIR (default: ./skills)
2. For each subdirectory:
   - Check if SKILL.md exists
   - Parse frontmatter → extract name + description
   - Validate: name and description both required
   - Store as SkillMeta: { name, description, directory, file }
3. Return array of SkillMeta (sorted by discovery order)
```

**Output:** Array of skills injected into main prompt via `buildSkillsPromptSection()`:

```
【可用技能】
当用户请求匹配下列某个技能的描述时，先调用 load_skill 工具读取它的详细指令再执行。

- air-conditioner: 处理空调相关控制...
- game: 处理小朋友想玩游戏机...
- music: 播放音乐、暂停、调音量...
- reminder: 设置提醒、删除提醒...
```

### Runtime Flow: Skill Activation

**Tool:** `load_skill` (created in `openai-agent-runtime.ts`)

**Example Interaction:**

```
User: "开一下客厅空调"
     ↓
LLM thinks: "用户说要开空调，描述匹配 'air-conditioner' skill"
     ↓
LLM calls: load_skill(name="air-conditioner")
     ↓
Tool execution:
  1. Search SkillMeta array for name="air-conditioner"
  2. Read file: skills/air-conditioner/SKILL.md
  3. Parse frontmatter (remove it)
  4. Return: { ok: true, name, directory, instructions: <body> }
     ↓
LLM appends SKILL.md body to context, then decides next action
     ↓
LLM calls: control_air_conditioner(room="living_room", action="turn_on")
```

**Note:** The directory path is returned so LLM can access referenced files:
```typescript
read_file(directory + "/references/ac-modes.txt")  // ✓ allowed
```

---

## 2. GAME COMMANDS - State Machine + Quota Management

### Overview

Game control involves multiple layers:
1. **Tool Layer** (`game-console.tool.ts`): Agent-facing interface
2. **Controller Layer** (`game-console-controller.ts`): Orchestrates quota + timer + plug
3. **Service Layers**:
   - `game-quota.ts`: Tracks daily/weekly usage, applies rules
   - `game-session-timer.ts`: Manages in-game timers, reminders
   - `gosund-plug-client.ts`: Controls power via smart plug

### Game Command Processing Flow

```
User: "我想玩游戏，玩20分钟"
  ↓
[Dialog Session - ASR → Agent]
  ↓
Agent calls: load_skill(name="game")
  ↓
Agent loads rules from skills/game/SKILL.md:
  - Rule 1: Must confirm who (yuxiao or yuyue)? 
  - Rule 2: If today has no quota left → refuse + don't ask for duration
  - Rule 3: Duration must be 5-60 min
  ↓
Agent interaction:
  "是余晓还是余跃想玩？"
  User: "余晓"
  ↓
Agent calls: status() to check quota
  Control: GameConsoleController.status()
    → Reads GameQuotaService → returns daily quota + remaining
  ↓
If remaining > 0:
  "余晓想玩20分钟，可以吗？" (confirmation from skill rules)
  User: "可以"
  ↓
Agent calls: control_game_console(
  action="start_game",
  child="yuxiao",
  minutes=20
)
  ↓
Tool execution:
  1. GameConsoleController.start("yuxiao", 20)
  2. Check GameQuotaService:
     - Is today weekend? No quota on weekdays
     - Remaining quota? 60 - 0 = 60 min ✓
     - Enough for 20 min? ✓
  3. GameSessionTimer.schedule():
     - Turn on plug s1 (via GosundPlug)
     - Set timeout for 20 min
     - Schedule reminders at 5min, 1min
  4. Return: { ok: true, message: "余晓，游戏机已打开，祝你玩得开心！" }
  ↓
Agent speaks: "余晓，游戏机已打开，祝你玩得开心！"
```

### Quota Rules

**File:** `src/services/game-quota.ts`

```typescript
export interface ChildProfile {
  key: ChildKey;           // "yuxiao" | "yuyue"
  label: string;           // "余晓" | "余跃"
  dailyQuotaMin: number;   // 60 (min per day)
  playDaysOfWeek: number[]; // [5, 6] = Friday, Saturday only
}
```

**Rules Enforced:**

1. **Weekday Lock**: Children can only play on specified weekdays
   ```typescript
   if (CHILDREN.get(child)!.playDaysOfWeek.includes(today)) {
     // Allowed
   } else {
     return { ok: false, reason: 'not_weekend' };
   }
   ```

2. **Daily Quota**: 60 min/day per child
   ```typescript
   const remaining = dailyQuota - usedToday;
   if (remaining < minutes) {
     return { ok: false, reason: 'no_quota' };
   }
   ```

3. **One Session at a Time**
   ```typescript
   if (this.timer.getActiveSession()) {
     return { ok: false, reason: 'session_in_progress' };
   }
   ```

### Game Session Timer

**File:** `src/services/game-session-timer.ts`

Manages in-game timeouts with proactive announcements:

```typescript
export class GameSessionTimer {
  async schedule(child: ChildKey, minutes: number) {
    const endTime = Date.now() + minutes * 60000;
    
    // Schedule reminders at 5min, 1min before end
    for (const seconds of [300, 60]) {
      setTimeout(() => {
        this.announce(`${getLabel(child)}还能玩${seconds/60}分钟`);
      }, endTime - seconds*1000);
    }
    
    // Auto-stop at end time
    setTimeout(() => {
      this.plug.turnOff('s1');
      this.announce(`${getLabel(child)}时间到，游戏机已关闭`);
    }, minutes * 60000);
  }
}
```

The announcer callback is injected from **DialogSession**:
```typescript
getGameConsoleController().setAnnouncer(
  (text) => this.announce(text)  // → TTS synthesis
);
```

---

## 3. AIR CONDITIONING (AC) CONTROL - MIOT Protocol

### Device Architecture

**Hardware:** Xiaomi AC Partner (`cuco.acpartner.cp6`)
- Infrared-based remote for AC control
- Communicates with LAN via Xiaomi **miio** protocol
- Supports **MIOT** property model (service/property IDs)

### AC Control Flow

```
User: "把客厅空调开到26度"
  ↓
[Load air-conditioner skill]
  ↓
Agent knows rules:
  - Room must be specified (客厅, 主卧, etc.)
  - Actions: turn_on, set_temperature, set_mode, etc.
  - Combine operations in order
  ↓
Agent calls: control_air_conditioner(
  room="living_room",
  action="turn_on"
)
  ↓
Tool execution:
  1. Lookup room config: AC_LIVING_ROOM_IP, AC_LIVING_ROOM_TOKEN
  2. Create AcPartner instance (miio + MIOT)
  3. Send IR command: "power on"
  ↓
Agent then calls: control_air_conditioner(
  room="living_room",
  action="set_temperature",
  temperature=26
)
  ↓
Tool → AcPartner.setTargetTemperature(26)
  ↓
Agent speaks: "好的，客厅空调已开到二十六度"
```

### MIOT Protocol Details

**File:** `src/agent/tools/ac-partner-client.ts`

Xiaomi devices expose services and properties via **MIOT** (Xiaomi IoT standard):

```
Service: air-conditioner (siid=3)
├── Property: power (piid=1, bool)         [0/1 = off/on]
├── Property: mode (piid=2, int)           [0=cool, 1=heat, 2=auto, 3=fan, 4=dehumidify]
├── Property: targetTemp (piid=4, uint16)  [16-30, step 1]

Service: fan (siid=4)
└── Property: fanLevel (piid=2, int)       [0=auto, 1=low, 2=medium, 3=high]
```

**Communication:** miio binary protocol over LAN

```typescript
// Get power status
miot('get_properties', [{ siid: 3, piid: 1 }])
→ { result: [{ code: 0, value: true }] }

// Set temperature
miot('set_properties', [{ siid: 3, piid: 4, value: 26 }])
→ { result: [{ code: 0 }] }
```

### Room Configuration

Rooms are mapped via environment variables:

```bash
AC_LIVING_ROOM_IP=192.168.0.20
AC_LIVING_ROOM_TOKEN=9b6200d7db44267348268b4a10ad8f2b

AC_MASTER_BEDROOM_IP=192.168.0.8
AC_MASTER_BEDROOM_TOKEN=c7ec23531bade701e996c05bcb1c18cc

# ... etc for all 5 rooms
```

**Tool parameter validation:**
```typescript
room: z.enum([
  'living_room',
  'master_bedroom',
  'grandma_room',
  'yuyue_room',
  'yuxiao_room'
])
```

---

## 4. INFERENCE/REASONING FLOW - OpenAI Agents SDK

### End-to-End User Request Processing

```
[User speaks into microphone]
  ↓
[Wake Word Detection] (sherpa-onnx local KWS)
  "小鱼" detected
  ↓
[Audio Recording & ASR] (Tencent Cloud)
  Convert to text: "开一下客厅空调"
  ↓
[DialogSession.doTurn()] 
  sessionId = UUID
  text = "开一下客厅空调"
  ↓
[Agent.run() - OpenAI Agents SDK]

  1. Load conversation history from disk
     (YYYY-MM-DD.json format, resets daily)

  2. Build system prompt:
     - BASE_INSTRUCTIONS (universal rules)
     - 【可用技能】 section (skill list)

  3. Add user message to history:
     [ ..., { role: "user", content: "开一下客厅空调" } ]

  4. Call OpenAI Chat Completions API:
     POST /v1/chat/completions
     {
       model: "gpt-4o-mini",
       messages: [system, ...history, user],
       tools: [
         control_air_conditioner,
         control_game_console,
         load_skill,
         web_search,
         ...12 more tools
       ],
       tool_choice: "auto"
     }

  5. LLM responds with tool calls:
     [{ type: "tool_use", name: "load_skill", args: { name: "air-conditioner" } }]

  6. Execute tool: load_skill("air-conditioner")
     → Returns: SKILL.md body with all AC control rules

  7. LLM sees skill rules, calls next tool:
     [{ type: "tool_use", name: "control_air_conditioner", 
        args: { room: "living_room", action: "turn_on" } }]

  8. Execute tool: control_air_conditioner()
     → AcPartner.on() → MIOT command
     → Returns: { ok: true, message: "..." }

  9. LLM generates final response:
     { role: "assistant", content: "好的，客厅空调已打开" }

 10. Save updated history to disk
     (append turn to .runtime/agent-history/YYYY-MM-DD.json)

  ↓
[Returns text to DialogSession]
  text = "好的，客厅空调已打开"

  ↓
[TTS Synthesis] (Tencent Cloud)
  Convert to audio: MP3/WAV

  ↓
[Audio Playback]
  Stream through speaker
```

### Multi-Turn Conversation

History is **persistent per-day**:

```typescript
// At startup
loadHistoryFromDisk()  // Reads .runtime/agent-history/2024-05-29.json
history = [
  { role: "system", content: "你是家里的语音助手..." },
  { role: "user", content: "开客厅空调" },
  { role: "assistant", content: "好的，客厅空调已打开" },
]

// User follows up: "再开一下主卧的"
turnInput = [
  ...history,  // ← includes previous turns
  { role: "user", content: "再开一下主卧的" }
]

result = runner.run(agent, turnInput, ...)

// LLM now understands context:
// - "客厅空调已开" from previous turn
// - "再开一下主卧的" likely means AC in master bedroom
```

**History Management:**
- Persisted to disk after each turn (tmp + atomic rename)
- Loaded at startup (only today's file)
- Truncated to 20 items max (OPENAI_AGENT_HISTORY_MAX)
- Tool calls/results filtered out (only user/assistant/system kept)

### Tool Ecosystem

**File:** `src/agent/openai-agent-runtime.ts` → agent initialization

```typescript
this.agent = new Agent({
  name: 'Home Voice Assistant',
  model: 'gpt-4o-mini',
  instructions: buildInstructions(),  // BASE + skills list
  tools: [
    controlDeviceTool,              // Home Assistant REST API
    controlGosundPlugTool,          // Smart plug (via miio)
    controlAirConditionerTool,      // AC (via miio + MIOT)
    controlGameConsoleTool,         // Gaming quota + timer
    manageReminderTool,             // Set/delete/list reminders
    searchMusicTool,                // Query music service
    controlMusicPlayerTool,         // Play/pause/volume/skip
    getCurrentTimeTool,             // Current date/time
    webSearchTool,                  // Sogou search (via Python)
    readFileTool,                   // Read local file
    writeFileTool,                  // Write local file
    createLoadSkillTool(skills),    // Load SKILL.md by name
  ],
});
```

Each tool is a **Zod schema + executor**:
```typescript
tool<InputSchema, ContextType, ReturnType>({
  name: "...",
  description: "...",
  parameters: z.object({ ... }),
  async execute(params, context) { ... }
})
```

---

## 5. SYSTEM ARCHITECTURE DIAGRAM

```
┌─────────────────────────────────────────────────────────────┐
│                     User (Voice/Text Input)                 │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌──────────────────── DialogSession ───────────────────────────┐
│                  (State Machine: idle → listening            │
│                   → thinking → speaking → followup_wait)     │
│                                                              │
│  ├─ WakeWordService (Sherpa-ONNX KWS)                        │
│  ├─ TencentAsrClient (Speech → Text)                         │
│  └─ TencentTtsClient (Text → Speech)                         │
└──────────────────────────────┬───────────────────────────────┘
                              ↓
┌────────── OpenAIAgentRuntime (Inference Engine) ───────────┐
│                                                             │
│  ├─ Skills Discovery (at startup)                          │
│  │   └─ discoverSkills() → [SkillMeta, ...]                │
│  │                                                         │
│  ├─ Build System Prompt                                    │
│  │   ├─ BASE_INSTRUCTIONS (universal rules)                │
│  │   └─ 【可用技能】 section (skill names + descriptions)  │
│  │                                                         │
│  ├─ Load Conversation History                              │
│  │   └─ .runtime/agent-history/YYYY-MM-DD.json             │
│  │                                                         │
│  ├─ OpenAI Agents SDK Runner                               │
│  │   └─ LLM inference + tool calling loop                  │
│  │                                                         │
│  └─ Tool Registry (12 tools)                               │
│      ├─ load_skill (dynamic SKILL.md loading)              │
│      ├─ control_air_conditioner (MIOT protocol)            │
│      ├─ control_game_console (quota + timer)               │
│      ├─ web_search                                         │
│      ├─ manage_reminder                                    │
│      └─ [more tools...]                                    │
│                                                             │
│  └─ History Persistence (after each turn)                  │
│      └─ atomically write to .runtime/agent-history/...     │
└───────────────┬─────────────────────────┬──────────────────┘
                ↓                         ↓
      ┌──────────────────┐      ┌──────────────────┐
      │  Device Control  │      │  Service Layer   │
      │                  │      │                  │
      │ AcPartner        │      │ GameConsoleCtrl  │
      │ (miio+MIOT)      │      │ ReminderService  │
      │                  │      │ MusicService     │
      │ GosundPlug       │      │                  │
      │ (smart plug)     │      │ GameSessionTimer │
      │                  │      │ GameQuotaService │
      └──────────────────┘      └──────────────────┘
                ↓                         ↓
      ┌──────────────────────────────────────────┐
      │      Smart Home Devices                  │
      │                                          │
      │  Xiaomi AC Partners (5 rooms)            │
      │  Gosund Smart Plug (s1 for game console) │
      │  Home Assistant Instance (generic)       │
      └──────────────────────────────────────────┘
```

---

## 6. KEY DESIGN PATTERNS

### Pattern 1: Progressive Disclosure (Skills)
- Keep main prompt lean (skill list only)
- Load full skill rules on-demand
- Reduces token usage + context confusion

### Pattern 2: Dependency Injection (Announcers)
- Services don't know about DialogSession
- Announcer callback injected at runtime
- Enables: game reminders, reminder alerts, music duck control

### Pattern 3: Per-Day History Slicing
- History stored separately per calendar day
- Auto-reset at midnight
- Prevents unbounded context growth

### Pattern 4: Atomic File Operations
- Use tmp file + rename (not direct write)
- Prevents corruption on crash
- Applied to history, config, logging

### Pattern 5: State Machine (DialogSession)
- Clear state transitions
- Guards against invalid state flows
- Enables reliable multi-turn interaction

### Pattern 6: Middleware/Filter Pattern
- History filtering (strip tool calls before disk)
- Tool result pagination (top-N results only)
- Serialization safety

---

## 7. IMPORTANT CONCEPTS

### Skill Loading Phases

1. **Discovery** (once at startup):
   - Scan skills/ directory
   - Extract name + description from frontmatter
   - Inject into main prompt

2. **Activation** (LLM-driven):
   - LLM calls `load_skill(name="air-conditioner")`
   - Tool reads full SKILL.md file
   - Returns instructions in context

3. **Execution** (tool calls):
   - LLM follows SKILL.md rules
   - Calls appropriate tools
   - Returns result

### Game Quota Decision Tree

```
start_game(child, minutes)
  ↓
1. Is child valid? (yuxiao | yuyue)
   NO → { ok: false, reason: 'invalid_child' }
   ↓
2. Is today a play day? (check playDaysOfWeek)
   NO → { ok: false, reason: 'not_weekend' }
   ↓
3. Is a game session already active?
   YES → { ok: false, reason: 'session_in_progress' }
   ↓
4. Is there enough daily quota remaining?
   NO → { ok: false, reason: 'no_quota' }
   ↓
5. Is smart plug configured?
   NO → { ok: false, reason: 'plug_not_configured' }
   ↓
6. Can turn on plug via miio?
   NO → { ok: false, reason: 'plug_failed' }
   ↓
7. Schedule timer + reminders
   OK → { ok: true, message: "..." }
```

### Tool Calling Loop (OpenAI Agents SDK)

```
LLM generates:
{
  type: "tool_use",
  id: "call_abc123",
  name: "control_air_conditioner",
  input: { room: "living_room", action: "turn_on" }
}
  ↓
SDK executes:
result = await controlAirConditionerTool.execute(input)
  ↓
SDK appends to conversation:
{
  role: "tool",
  tool_use_id: "call_abc123",
  content: { ok: true, message: "..." }
}
  ↓
LLM sees result, decides:
- Call another tool?
- Generate final response?
- Ask user for clarification?
  ↓
(repeat until LLM stops calling tools)
  ↓
Final LLM message appended:
{ role: "assistant", content: "好的，客厅空调已打开。" }
```

---

## 8. Configuration Files

### Environment Variables (.env)

```bash
# OpenAI
OPENAI_API_KEY=sk-...
OPENAI_AGENT_MODEL=gpt-4o-mini

# AC (5 rooms)
AC_LIVING_ROOM_IP=192.168.0.20
AC_LIVING_ROOM_TOKEN=...

AC_MASTER_BEDROOM_IP=192.168.0.8
AC_MASTER_BEDROOM_TOKEN=...

# [3 more rooms...]

# Game Console
GAME_CONSOLE_PLUG_DID=s1
GOSUND_PLUG_IP=192.168.0.27
GOSUND_PLUG_TOKEN=2d60013ef43ee985794683a5d25afe64

# Game Quota (JSON file)
GAME_QUOTA_CONFIG=.runtime/game-quota.json

# History
OPENAI_AGENT_HISTORY_DIR=.runtime/agent-history
OPENAI_AGENT_HISTORY_MAX=20

# Tencent Cloud (ASR/TTS)
TENCENT_SECRET_ID=...
TENCENT_SECRET_KEY=...

# Web Search (Sogou)
SOGOU_API_KEY=...
```

### Game Quota Config (.runtime/game-quota.json)

```json
{
  "children": [
    {
      "key": "yuxiao",
      "label": "余晓",
      "dailyQuotaMin": 60,
      "playDaysOfWeek": [5, 6]
    },
    {
      "key": "yuyue",
      "label": "余跃",
      "dailyQuotaMin": 60,
      "playDaysOfWeek": [5, 6]
    }
  ]
}
```

---

## 9. EXECUTION ENTRY POINTS

### Command Line

```bash
npm start                # Foreground (live microphone + voice loop)
npm start --daemon       # Background (detached process)
npm ask "问题"           # Single-shot Q&A (no voice)
npm stop                 # Kill background process
npm logs [-f]            # View logs
```

### Code Entry Points

```typescript
// CLI
src/cli/cli.ts → cmdStart() / cmdAsk()

// Voice Loop
src/cli/voice-service.ts → VoiceService.start()
  → DialogSession.acceptPcm16(pcmBuffer)
  → DialogSession.doTurn() 
  → OpenAIAgentRuntime.runStream()

// Single Q&A
src/agent/openai-agent-runtime.ts → runVoiceAgent(input)
```

---

## 10. TRACING & OBSERVABILITY

**Framework:** Langfuse (optional, configurable)

```typescript
withTrace('voice.turn', async () => {
  return runner.run(agent, turnInput, ...);
}, {
  groupId: sessionId,
  metadata: {
    input: userText,
    session_id: sessionId,
    user_id: userId,
    model: modelName,
  }
});
```

Traces include:
- LLM API calls (prompt + completion)
- Tool invocations + results
- Latency metrics
- Error diagnostics

---

## Summary: How Requests Flow

```
["开客厅空调到26度"]
  ↓ (ASR)
[Dialog calls agent.run(text)]
  ↓
[Load history, build system prompt + skill list]
  ↓
[LLM sees: "开...空调", matches "air-conditioner" skill description]
  ↓
[LLM calls load_skill("air-conditioner")]
  ↓
[Tool reads skills/air-conditioner/SKILL.md, returns rules]
  ↓
[LLM sees rules: "房间必须明确", knows user said "客厅"]
  ↓
[LLM calls control_air_conditioner(room="living_room", action="turn_on")]
  ↓
[Tool: AcPartner.on() via MIOT protocol]
  ↓
[LLM calls control_air_conditioner(room="living_room", action="set_temperature", temperature=26)]
  ↓
[Tool: AcPartner.setTargetTemperature(26)]
  ↓
[LLM generates: "好的，客厅空调已开到二十六度"]
  ↓
[History saved to disk]
  ↓
[TTS: synthesize to MP3]
  ↓
[Play audio]
```

