# 小鱼 Voice Assistant - Complete Project Analysis

**Project**: Chinese Home Voice Assistant ("小鱼" - Little Fish)
**Date**: 2026-05-29
**Focus Areas**: Skill System, Game Control, AC Control, Tool Execution Flow, Two-Pass Architecture

---

## Executive Overview

This is a sophisticated TypeScript-based home voice assistant that implements a **two-pass inference pattern** to control smart home devices. The architecture prioritizes modularity, scalability, and clear separation of concerns through a skill-based system where domain-specific rules are loaded on-demand rather than bloating the base prompt.

**Key Innovation**: Progressive disclosure of skill instructions - LLM only sees lightweight skill descriptions until it decides a skill is needed, then full rules are loaded for that specific domain.

---

## Table of Contents

1. [Project Structure](#project-structure)
2. [Skill System Architecture](#skill-system-architecture)
3. [Two-Pass Inference Pattern](#two-pass-inference-pattern)
4. [Game Console Control](#game-console-control)
5. [Air Conditioner Control](#air-conditioner-control)
6. [Tool Execution Flow](#tool-execution-flow)
7. [Dialogue State Machine](#dialogue-state-machine)
8. [History and Persistence](#history-and-persistence)
9. [Key Design Patterns](#key-design-patterns)

---

## Project Structure

```
HomeAssistant/
├── src/
│   ├── agent/
│   │   ├── openai-agent-runtime.ts       # Main orchestrator (two-pass inference)
│   │   ├── skills/
│   │   │   └── skill-loader.ts            # Discovery, activation, loading mechanism
│   │   ├── tools/
│   │   │   ├── load-skill.tool.ts         # PASS 1: Load full skill instructions
│   │   │   ├── game-console.tool.ts       # PASS 2: Game control interface
│   │   │   ├── air-conditioner.tool.ts    # PASS 2: AC control interface
│   │   │   ├── ac-partner-client.ts       # MIOT protocol implementation
│   │   │   ├── gosund-plug.tool.ts        # Smart plug control
│   │   │   ├── reminder.tool.ts           # Reminder management
│   │   │   ├── music.tool.ts              # Music search and playback
│   │   │   ├── web-search.tool.ts         # Internet search
│   │   │   ├── file-system.tool.ts        # File I/O
│   │   │   ├── get-current-time.tool.ts   # Time queries
│   │   │   └── home-assistant.tool.ts     # HomeAssistant integration
│   │   └── tracing/
│   │       └── langfuse-tracer.ts         # Observability
│   ├── services/
│   │   ├── game-console-controller.ts     # Game orchestration
│   │   ├── game-quota.ts                  # Quota validation
│   │   ├── game-session-timer.ts          # Timer and announcements
│   │   ├── ac-partner-client.ts           # (also in tools/)
│   │   └── ... (other services)
│   ├── dialog/
│   │   └── dialog-session.ts              # State machine and flow orchestration
│   ├── common/
│   ├── config/
│   └── cli/
├── skills/
│   ├── game/
│   │   └── SKILL.md                       # Game skill rules
│   ├── air-conditioner/
│   │   └── SKILL.md                       # AC skill rules
│   ├── reminder/
│   │   └── SKILL.md                       # Reminder skill rules
│   └── music/
│       └── SKILL.md                       # Music skill rules
├── .runtime/
│   ├── agent-history/                     # Per-day conversation history
│   └── game-quota.json                    # Game quota state
├── ARCHITECTURE.md                        # System architecture docs
├── QUICK_REFERENCE.md                     # Quick lookup guide
└── package.json
```

---

## Skill System Architecture

### What is a Skill?

A skill represents a domain-specific capability (game, AC, reminder, music). Each skill has:
1. **Metadata** (name + description): Lightweight, always in prompt
2. **Rules** (SKILL.md body): Heavy, loaded only when needed
3. **Implementation** (tool calls): Executed in PASS 2

### Skill File Format: SKILL.md

```yaml
---
name: game
description: 处理小朋友想玩游戏机、停游戏、查询剩余时长的请求
---

# 游戏管理 Skill

## 适用场景
用户（通常是小朋友）说出以下意图时启用：
- "我想玩游戏" / "给我开游戏"
- ...

## 操作规则

### 三类请求 → 三种 action
| 用户意图 | action | 关键参数 |
|---|---|---|
| 想开始玩 | `start_game` | `who`、`minutes` |
| 想停下 | `stop_game` | `who` |
| 查状态 | `status` | — |
```

### Skill Discovery Mechanism (startup)

**File**: `src/agent/skills/skill-loader.ts`

```typescript
export function discoverSkills(): SkillMetadata[] {
  const skillsDir = resolve(__dirname, '../../skills');
  const entries = readdirSync(skillsDir, { withFileTypes: true });
  
  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const skillPath = join(skillsDir, entry.name, 'SKILL.md');
      const frontmatter = parseFrontmatter(readFileSync(skillPath, 'utf8'));
      return {
        name: frontmatter.name,
        description: frontmatter.description,
        directory: join(skillsDir, entry.name),
      };
    });
}
```

**Output**: Array of skill metadata (only name + description, ~8 tokens for all 4 skills)

### Skill Activation Trigger (PASS 1)

**Context**: LLM sees:
- BASE_INSTRUCTIONS (output format, tool usage guidelines)
- **【可用技能】** section with skill names and one-liner descriptions
- User message

**Example**:
```
【可用技能】
1. game: 处理小朋友想玩游戏机、停游戏、查询剩余时长的请求
2. air-conditioner: 控制五个房间的空调开关、温度、模式、风速等
3. reminder: 设置、修改、删除定时提醒
4. music: 搜索音乐库并播放
```

**LLM Decision**: When user says "我想玩游戏", LLM decides:
```
"I need the game skill to understand game control rules"
→ Tool call: load_skill(name: "game")
```

### Skill Loading (load_skill Tool)

**File**: `src/agent/tools/load-skill.tool.ts`

```typescript
export function createLoadSkillTool(skills: SkillMetadata[]) {
  return {
    name: 'load_skill',
    description: 'Load full instructions for a specific skill',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Skill name (e.g., "game", "air-conditioner")',
          enum: skills.map(s => s.name),
        },
      },
    },
    handler: async (input: { name: string }) => {
      const skill = skills.find(s => s.name === input.name);
      const instructions = loadSkillBody(skill.directory);
      return {
        ok: true,
        name: skill.name,
        directory: skill.directory,
        instructions,
      };
    },
  };
}
```

**Performance**: ~50ms file I/O, returns full SKILL.md content

### Skill Execution (PASS 2)

**Context**: LLM now sees:
- Previous context (BASE_INSTRUCTIONS + skill list)
- **Full skill instructions** from SKILL.md
- User message
- Tool execution results from previous attempts

**LLM Reasoning**: With full rules loaded, LLM understands:
- Valid action types
- Required parameters
- Business rules (quotas, constraints)
- Output format expectations

**Example for Game**:
```
LLM reads: "必须先确认是谁" (must confirm which child)
User input: "我想玩游戏" (vague, no child specified)
LLM output: "是余晓还是余跃想玩?" (asking for clarification)
```

---

## Two-Pass Inference Pattern

### Why Two Passes?

**Problem**: Including all skill rules in base prompt means:
- ~130 tokens consumed on every request
- Even when user doesn't need skills
- Reduces context available for reasoning
- Difficult to scale (10 skills = 300+ tokens wasted)

**Solution**: Progressive disclosure
- Base prompt: only skill names (~8 tokens)
- IF skill needed: load full rules (~35 tokens for AC)
- Selective cost: only pay when needed

### The Two-Pass Flow

```
USER: "开客厅空调到二十六度"
   │
   ├─ PASS 1 (Lightweight Decision) ~800ms
   │  ├─ Input:
   │  │  - BASE_INSTRUCTIONS
   │  │  - Skill list (4 lines, ~8 tokens)
   │  │  - User message
   │  │
   │  ├─ LLM Processing:
   │  │  "User wants to control AC"
   │  │  "I should use air-conditioner skill"
   │  │
   │  └─ Output:
   │     Tool call: load_skill("air-conditioner")
   │
   ├─ load_skill Execution ~50ms
   │  └─ File I/O: Read skills/air-conditioner/SKILL.md
   │     Output: { ok: true, instructions: "[35 lines of AC rules]" }
   │
   ├─ PASS 2 (Heavy Execution) ~800ms
   │  ├─ Input:
   │  │  - Previous context
   │  │  - **Full AC skill instructions (35 lines, ~260 tokens)**
   │  │  - User message
   │  │
   │  ├─ LLM Processing:
   │  │  "Room: living_room (from context)"
   │  │  "Action 1: turn_on"
   │  │  "Action 2: set_temperature(26)"
   │  │
   │  └─ Output:
   │     Tool call 1: control_air_conditioner(
   │       room="living_room", 
   │       action="turn_on"
   │     )
   │     Tool call 2: control_air_conditioner(
   │       room="living_room",
   │       action="set_temperature",
   │       temperature=26
   │     )
   │
   ├─ Tool Execution ~200ms
   │  ├─ AC Partner IR blaster sends power-on signal
   │  ├─ Receives ACK
   │  ├─ AC Partner IR blaster sends set-temp signal
   │  └─ Receives ACK
   │
   └─ Final Response
      Text: "好的，客厅空调已经开到二十六度。"
```

### Critical Distinction: Two Passes vs Two Rounds

**Two Passes** (within single `agent.run()` call):
- PASS 1 and PASS 2 are **transparent to user**
- Both happen within same conversation turn
- Result: Single response message
- Network overhead: 2 round-trips to OpenAI (~1.6 seconds)

**Two Rounds** (dialogue history):
- Previous turn + current turn = multi-turn conversation
- Each turn can have its own two-pass loop
- Example: "我想玩游戏" → "是谁想玩?" → "余晓" → "玩多久?" → "30分钟"

### Latency Breakdown

| Component | Time | Reason |
|-----------|------|--------|
| PASS 1 LLM Call | ~800ms | OpenAI API: tokenize + inference + response |
| load_skill Tool | ~50ms | File I/O from disk |
| PASS 2 LLM Call | ~800ms | OpenAI API: expanded context + inference |
| Tool Execution | ~200ms | Device API calls (AC, Plug, etc.) |
| **Total for Skill Request** | ~1.8-2.5s | Network dominates (2x 400ms each way) |

### Why It Can't Be Faster

1. **load_skill must come from LLM**: Can't pre-predict which skill without reasoning
2. **Can't batch into one call**: 
   - Would mean loading ALL skills upfront
   - Defeats purpose (bloats prompt)
3. **Network is bottleneck**: Each OpenAI API call = ~200ms each way minimum

---

## Game Console Control

### Architecture Overview

```
User: "我想玩游戏"
   │
   ├─ PASS 1: load_skill("game")
   │
   ├─ PASS 2: LLM reads game rules
   │   "Rules say: 必须先确认是谁"
   │   Output: "是余晓还是余跃想玩?"
   │
   ├─ User: "余晓"
   │
   ├─ PASS 1: load_skill("game")
   │
   ├─ PASS 2: LLM sees "余晓" in context
   │   "Rules say: 必须先查配额"
   │   Tool call: control_game_console(action="status")
   │   Result: { ok: true, quotas: [{ child: "yuxiao", remaining: 60 }] }
   │   "Quota available, ask for minutes"
   │   Output: "想玩多少分钟？"
   │
   ├─ User: "30"
   │
   ├─ PASS 1: load_skill("game")
   │
   ├─ PASS 2: LLM has all info
   │   Tool call: control_game_console(
   │     action="start_game",
   │     child="yuxiao",
   │     minutes=30
   │   )
   │   
   └─ GameConsoleController processes multi-layer validation
```

### Multi-Layer Validation

**File**: `src/services/game-console-controller.ts`

```typescript
async start(child: string, minutes: number, announcer: Announcer): Promise<{
  ok: boolean;
  message: string;
  activeSession?: GameSession;
}> {
  // Layer 1: Is this a valid child?
  if (!CHILDREN[child]) {
    return { ok: false, message: '只有余晓和余跃可以玩游戏' };
  }
  
  // Layer 2: Is today a play day?
  const childConfig = CHILDREN[child];
  if (!childConfig.playDaysOfWeek.includes(new Date().getDay())) {
    return { ok: false, message: '今天不能玩游戏' };
  }
  
  // Layer 3: Is daily quota available?
  const remaining = await this.quotaService.getRemainingQuota(child);
  if (remaining <= 0) {
    return { ok: false, message: '今天的游戏时间已用完' };
  }
  
  // Layer 4: Is there an active session already?
  if (this.activeSession?.child === child) {
    return { ok: false, message: '正在游戏中，不能再开' };
  }
  
  // Layer 5: Is the plug reachable?
  try {
    await this.gosundPlug.turnOn('s1');
  } catch (error) {
    return { ok: false, message: '游戏机离线' };
  }
  
  // All layers passed: start session
  this.activeSession = { child, startedAt: Date.now(), minutes };
  
  // Schedule auto-shutdown timer with announcements
  this.timer.schedule(
    child,
    minutes,
    announcer,
    () => this.stop() // Callback: auto-shutdown
  );
  
  await this.quotaService.deductMinutes(child, minutes);
  
  return {
    ok: true,
    message: `好的，${childConfig.label}可以玩${minutes}分钟`,
    activeSession: this.activeSession,
  };
}
```

### Game Children Configuration

**File**: `src/services/game-quota.ts`

```typescript
export const CHILDREN: Record<string, ChildConfig> = {
  yuxiao: {
    key: 'yuxiao',
    label: '余晓',
    aliases: ['晓晓', '小晓'],
    dailyQuotaMin: 60,           // 1 hour per day
    playDaysOfWeek: [5, 6],       // Sat, Sun only
  },
  yuyue: {
    key: 'yuyue',
    label: '余跃',
    aliases: ['小跃', '跃跃'],
    dailyQuotaMin: 60,            // 1 hour per day
    playDaysOfWeek: [5, 6],       // Sat, Sun only
  },
};
```

### Quota State Persistence

```json
{
  "yuxiao": {
    "date": "2026-05-29",
    "quotaMin": 60,
    "usedMin": 30,
    "remaining": 30
  },
  "yuyue": {
    "date": "2026-05-29",
    "quotaMin": 60,
    "usedMin": 0,
    "remaining": 60
  }
}
```

**Auto-reset**: When date changes, quota resets to `dailyQuotaMin`

### Timer and Announcements

**File**: `src/services/game-session-timer.ts`

```typescript
schedule(
  child: string,
  minutes: number,
  announcer: Announcer,
  onExpiry: () => Promise<void>
) {
  // T-5 minutes: Announcement
  setTimeout(() => {
    announcer.announce(`${CHILDREN[child].label}还能玩5分钟`);
  }, (minutes - 5) * 60 * 1000);
  
  // T-1 minute: Announcement
  setTimeout(() => {
    announcer.announce(`${CHILDREN[child].label}还能玩1分钟，要停了`);
  }, (minutes - 1) * 60 * 1000);
  
  // T+0: Auto-shutdown
  setTimeout(async () => {
    await onExpiry();
    await gosundPlug.turnOff('s1');
  }, minutes * 60 * 1000);
}
```

**Key Pattern**: Announcer callback injected from DialogSession
- Enables game timer to trigger TTS without tight coupling
- GameConsoleController is domain-agnostic (no TTS import)
- DialogSession handles TTS integration

---

## Air Conditioner Control

### Architecture: Xiaomi MIOT Protocol

The AC control uses Xiaomi's proprietary **MIOT (Mijia Internet of Things)** protocol:

```
User Request
   │
   ├─ AC Tool receives: room, action, temperature, mode
   │
   ├─ Read environment: AC_<ROOM>_IP, AC_<ROOM>_TOKEN
   │
   ├─ Instantiate AcPartner client with IP/token
   │
   ├─ Call appropriate method: on(), off(), setTargetTemperature(), setMode(), setFanLevel()
   │
   ├─ AcPartner sends binary MIOT protocol packet over LAN
   │  (via miio protocol to Xiaomi AC Partner device)
   │
   └─ Receives ACK, updates local state
```

### Supported Rooms

**File**: `src/agent/tools/air-conditioner.tool.ts`

```typescript
const ROOMS: RoomConfig[] = [
  {
    key: 'living_room',
    label: '客厅',
    aliases: ['客厅', '起居室', '大厅'],
    envKey: 'AC_LIVING_ROOM_IP',
    envTokenKey: 'AC_LIVING_ROOM_TOKEN',
  },
  {
    key: 'master_bedroom',
    label: '主卧',
    aliases: ['主卧', '主卧室', '大卧'],
  },
  {
    key: 'grandma_room',
    label: '奶奶房间',
    aliases: ['奶奶房间', '奶奶房', '老人房'],
  },
  {
    key: 'yuyue_room',
    label: '余跃房间',
    aliases: ['余跃房间', '小跃房间', '跃跃房'],
  },
  {
    key: 'yuxiao_room',
    label: '余晓房间',
    aliases: ['余晓房间', '小晓房间', '晓晓房'],
  },
];
```

### AC Control Tool Interface

**File**: `src/agent/tools/air-conditioner.tool.ts` (~200 lines)

```typescript
export const controlAirConditionerTool = {
  name: 'control_air_conditioner',
  description: 'Control AC units in different rooms',
  parameters: {
    type: 'object',
    properties: {
      room: {
        type: 'string',
        description: 'Room key (living_room, master_bedroom, etc.)',
        enum: ROOMS.map(r => r.key),
      },
      action: {
        type: 'string',
        description: 'Action to perform',
        enum: [
          'turn_on',
          'turn_off',
          'toggle',
          'status',
          'set_temperature',
          'increase_temperature',
          'decrease_temperature',
          'set_mode',
          'set_fan_level',
        ],
      },
      temperature: {
        type: 'number',
        description: 'Target temperature (16-30°C)',
        minimum: 16,
        maximum: 30,
      },
      delta: {
        type: 'number',
        description: 'Temperature change (for increase/decrease)',
        default: 2,
      },
      mode: {
        type: 'string',
        enum: ['cool', 'heat', 'auto', 'fan', 'dehumidify'],
      },
      fan: {
        type: 'string',
        enum: ['auto', 'low', 'medium', 'high'],
      },
    },
    required: ['room', 'action'],
  },
  handler: async (input: ACControlInput) => {
    const roomConfig = ROOMS.find(r => r.key === input.room);
    if (!roomConfig) {
      return { ok: false, message: '房间未配置' };
    }
    
    const acPartner = new AcPartner(
      readRoomConfig(roomConfig).ip,
      readRoomConfig(roomConfig).token
    );
    
    let result;
    switch (input.action) {
      case 'turn_on':
        result = await acPartner.on();
        break;
      case 'turn_off':
        result = await acPartner.off();
        break;
      case 'set_temperature':
        result = await acPartner.setTargetTemperature(input.temperature!);
        break;
      case 'set_mode':
        result = await acPartner.setMode(input.mode!);
        break;
      // ... other actions
    }
    
    return {
      ok: true,
      room: roomConfig.label,
      action: input.action,
      status: result,
      message: formatACMessage(roomConfig, input.action, result),
    };
  },
};
```

### MIOT Protocol Implementation

**File**: `src/agent/tools/ac-partner-client.ts` (~400 lines)

```typescript
export class AcPartner {
  private readonly ip: string;
  private readonly token: string;
  private readonly siid = 3;  // Service: air-conditioner
  
  async on(): Promise<ACStatus> {
    // Set piid=1 (power) to true
    return this.setProperty(1, true);
  }
  
  async setTargetTemperature(temp: number): Promise<ACStatus> {
    // Set piid=4 (targetTemp) to temperature
    return this.setProperty(4, temp);
  }
  
  async setMode(mode: string): Promise<ACStatus> {
    // Map mode string to int value
    const modeValue = {
      cool: 0,
      heat: 1,
      auto: 2,
      fan: 3,
      dehumidify: 4,
    }[mode];
    
    // Set piid=2 (mode) to modeValue
    return this.setProperty(2, modeValue);
  }
  
  async setFanLevel(level: string): Promise<ACStatus> {
    const levelValue = {
      auto: 0,
      low: 1,
      medium: 2,
      high: 3,
    }[level];
    
    // Set piid=5 (fanLevel) to levelValue
    return this.setProperty(5, levelValue);
  }
  
  private async setProperty(piid: number, value: any): Promise<ACStatus> {
    // Build MIOT protocol packet
    const payload = buildMiotPayload(this.siid, piid, value);
    
    // Send over LAN via miio binary protocol
    const response = await this.miot('miio.sec.setProperty', {
      siid: this.siid,
      piid,
      value,
    });
    
    // Parse response and update local state
    return {
      power: response.power,
      temperature: response.targetTemp,
      mode: response.mode,
      // ...
    };
  }
  
  private async miot(method: string, params: any): Promise<any> {
    // Implement Xiaomi MIOT binary protocol
    // 1. Encrypt payload with token
    // 2. Send UDP packet to AC Partner device IP:54321
    // 3. Receive and decrypt response
    // 4. Parse result
    
    const encrypted = encryptMiio(JSON.stringify(params), this.token);
    const response = await sendUDP(this.ip, 54321, encrypted);
    return decryptMiio(response, this.token);
  }
}
```

### Skill Rules (AC SKILL.md)

**Key Rules**:

1. **Room must be explicit**
   ```
   User: "开空调"
   LLM: "您想控制哪个房间的空调？"
   (Ask first, don't assume)
   ```

2. **Combo operations step-by-step**
   ```
   User: "开客厅空调到二十六度"
   
   LLM executes:
   1. control_air_conditioner(room="living_room", action="turn_on")
   2. control_air_conditioner(room="living_room", action="set_temperature", temperature=26)
   3. Output: "好的，客厅空调已经开到二十六度。"
   ```

3. **Temperature adjust uses delta**
   ```
   User: "升温两度"
   
   LLM: "Use delta=2"
   Tool call: control_air_conditioner(
     room="living_room",
     action="increase_temperature",
     delta=2
   )
   ```

4. **Vague complaints need confirmation**
   ```
   User: "有点热"
   LLM: "要帮您开空调吗？" (Ask first)
   (Don't auto-control on emotional complaint)
   ```

5. **Batch operations need confirmation**
   ```
   User: "把所有房间的空调都开上"
   LLM: "确定要开所有房间的空调吗？" (Confirm before batch)
   ```

---

## Tool Execution Flow

### The Complete Call Chain

```
User Input (Voice/Text)
   │
   └─ OpenAIAgentRuntime.run(input)
      │
      ├─ Load history from .runtime/agent-history/YYYY-MM-DD.json
      │
      ├─ Build context:
      │  └─ buildInstructions()
      │     ├─ BASE_INSTRUCTIONS
      │     └─ buildSkillsPromptSection(skills)
      │        └─ 【可用技能】 section with 4 skills (8 tokens)
      │
      ├─ Create turnInput:
      │  └─ [...history, { role: 'user', content: input.text }]
      │
      ├─ Call runner.run(agent, turnInput, { maxTurns: 500 })
      │  │
      │  └─ Agent Loop (up to 500 iterations):
      │     │
      │     └─ Iteration 1: PASS 1 (Skill Selection)
      │        ├─ LLM Input:
      │        │  ├─ system: BASE_INSTRUCTIONS + Skill list
      │        │  └─ user: Input message
      │        │
      │        ├─ LLM Output: (one of three paths)
      │        │  ├─ Path A: Tool call load_skill(name)
      │        │  ├─ Path B: Tool call for direct action (e.g., get_current_time)
      │        │  └─ Path C: Final text response (no tools)
      │        │
      │        └─ If tool call:
      │           ├─ Tool: load_skill(name="air-conditioner")
      │           │  └─ Returns: { ok: true, instructions: "[35 lines]" }
      │           │
      │           ├─ History updated: [... + assistant message + tool result]
      │           │
      │           └─ Continue to Iteration 2
      │
      │     └─ Iteration 2: PASS 2 (Execution) - if skill was loaded
      │        ├─ LLM Input:
      │        │  ├─ system: BASE_INSTRUCTIONS + Skill list + Full AC rules
      │        │  ├─ assistant: Previous tool call
      │        │  ├─ tool_result: Skill instructions
      │        │  └─ user: Original message
      │        │
      │        ├─ LLM Output:
      │        │  ├─ Tool call 1: control_air_conditioner(room, action)
      │        │  ├─ Wait for tool result
      │        │  ├─ Tool call 2: control_air_conditioner(room, action, temperature)
      │        │  ├─ Wait for tool result
      │        │  └─ Final text: "好的，客厅空调已经开到二十六度。"
      │        │
      │        └─ History updated: [... + tool calls + tool results + assistant]
      │
      ├─ Loop exits when:
      │  ├─ LLM output is final text (no more tool calls), OR
      │  ├─ maxTurns (500) reached
      │
      ├─ commitHistory(turnInput, result.history)
      │  ├─ Merge result.history with turnInput
      │  ├─ Truncate to historyMaxItems (20)
      │  └─ Filter out tool_call/tool_result
      │
      ├─ scheduleHistoryFlush()
      │  └─ Atomic write to .runtime/agent-history/YYYY-MM-DD.json
      │
      └─ Return { text: finalOutput }

Final Response
   │
   └─ DialogSession receives text
      ├─ TTS conversion
      ├─ Audio playback
      └─ State transition to idle/listening
```

### Tool Registration (No Custom Router Needed)

**File**: `src/agent/openai-agent-runtime.ts` lines 123-136

```typescript
this.agent = new Agent<VoiceAgentContext>({
  name: 'Home Voice Assistant',
  model: config.openaiAgentModel,
  instructions: this.buildInstructions(),
  tools: [
    // Execution tools (PASS 2)
    controlDeviceTool,                    // HomeAssistant device control
    controlGosundPlugTool,                // Smart plug control
    controlAirConditionerTool,            // AC control
    controlGameConsoleTool,               // Game console control
    manageReminderTool,                   // Reminder management
    searchMusicTool,                      // Music search
    controlMusicPlayerTool,               // Music playback
    
    // Utility tools (always available)
    getCurrentTimeTool,                   // Time query
    webSearchTool,                        // Internet search
    readFileTool,                         // File read
    writeFileTool,                        // File write
    
    // Special tool (PASS 1 → PASS 2 bridge)
    createLoadSkillTool(this.skills),     // Skill loading
  ],
});
```

**How Dispatch Works**:
- OpenAI Agents SDK matches tool calls by name automatically
- No custom routing layer needed
- Each tool has:
  - `name`: Identifier for LLM to call
  - `description`: What it does (for LLM)
  - `parameters`: JSON schema of inputs
  - `handler`: Actual implementation function

---

## Dialogue State Machine

### Architecture

**File**: `src/dialog/dialog-session.ts` (~600 lines)

```
           ┌─────────────────────────────────────────┐
           │ VoiceService                             │
           │ - Microphone capture (acceptPcm16)       │
           │ - Wake word detection                    │
           │ - Orchestration                          │
           └──────────┬──────────────────────────────┘
                      │
           ┌──────────▼──────────────────────────────┐
           │ DialogSession (State Machine)            │
           │                                          │
           │ States: idle → listening → thinking →   │
           │         speaking → followup_wait → ...  │
           │                                          │
           │ Components:                              │
           │ - WakeWordService (local KWS)           │
           │ - TencentAsrClient (streaming ASR)      │
           │ - OpenAIAgentRuntime (inference)        │
           │ - TencentTtsClient (synthesis)          │
           │ - GameConsoleController (game logic)    │
           └──────────┬──────────────────────────────┘
                      │
           ┌──────────▼──────────────────────────────┐
           │ Smart Home Devices                       │
           │ - AC units (MIOT protocol)              │
           │ - Game console (Gosund plug)            │
           │ - Music player                          │
           │ - Reminders                             │
           └──────────────────────────────────────────┘
```

### State Diagram

```
        idle
         ▲
         │ (wake word detected)
         │ event: 'wake'
         │
         ├─────────────────┐
         │                 │
    ┌────▼─────┐      ┌───▼────────┐
    │listening  │      │Partial ASR │
    │           │      │ (streaming)│
    └────┬──────┘      └───────────┘
         │ (ASR complete)
         │ event: 'asr'
         │
    ┌────▼─────────┐
    │thinking      │  (LLM inference)
    │              │
    └────┬─────────┘
         │ (LLM response ready)
         │ event: 'agent'
         │
    ┌────▼─────────┐
    │speaking      │  (TTS synthesis & playback)
    │              │
    └────┬─────────┘
         │ (TTS complete)
         │ event: 'tts'
         │
    ┌────▼──────────────┐
    │followup_wait       │  (listen for follow-up)
    │                    │  (or timeout to idle)
    └────┬───────────────┘
         │
         ├─ (new user input) → listening
         └─ (timeout) → idle
```

### Components Integration

1. **WakeWordService**
   - Local ONNX model (Sherpa-ONNX)
   - Detects "小鱼" keyword from PCM audio stream
   - Zero cloud calls, always-on privacy

2. **TencentAsrClient**
   - Streaming ASR with partial results
   - Emits intermediate text as user speaks
   - Final transcript when silence detected

3. **OpenAIAgentRuntime**
   - Main inference engine
   - Receives: final ASR text + history
   - Returns: final response text

4. **TencentTtsClient**
   - Sentence splitting
   - Parallel synthesis of multiple sentences
   - Audio playback integration

5. **GameConsoleController**
   - Injected into DialogSession
   - Singleton: shared with game-console tool
   - Announcer callback integration (for timer TTS)

### Key Design: Announcer Pattern

**Problem**: Timer expiry needs to announce via TTS, but GameConsoleController shouldn't import DialogSession (circular dependency).

**Solution**: Dependency injection

```typescript
// DialogSession creates controller with callback
const announcer: Announcer = (message: string) => {
  return this.tts.synthesizeAndPlay(message);
};

this.gameController = getGameConsoleController(announcer);

// In game-session-timer.ts
// Timer calls announcer callback without knowing about DialogSession
setTimeout(() => {
  announcer.announce("还能玩5分钟");
}, delay);
```

---

## History and Persistence

### Daily Segmentation Strategy

```
.runtime/agent-history/
├── 2026-05-27.json  (Yesterday's conversation - not loaded)
├── 2026-05-28.json  (Day before - not loaded)
└── 2026-05-29.json  (Today's conversation - loaded at startup)
```

**Benefit**: Automatic daily "forgetting"
- Preserves recent context within a day
- Prevents unbounded growth
- Simple to understand and debug

### History File Format

```json
[
  {
    "role": "user",
    "content": "开客厅空调到二十六度"
  },
  {
    "role": "assistant",
    "content": "好的，客厅空调已经开到二十六度。"
  },
  {
    "role": "user",
    "content": "还能降低两度吗"
  },
  {
    "role": "assistant",
    "content": "好的，已经降低两度到二十四度。"
  }
]
```

**Note**: Tool calls and results are **filtered out** before saving

### Filtering Logic

**File**: `src/agent/openai-agent-runtime.ts` lines 407-411

```typescript
private filterHistoryForDisk(items: AgentInputItem[]): AgentInputItem[] {
  return items.filter((item) => {
    const role = (item as { role?: string }).role;
    return role === 'system' || role === 'user' || role === 'assistant';
  });
}
```

**Why filter tool calls?**
1. Prevents cutting tool_call/tool_result pairs at truncation boundary
2. Reduces file size (web_search results can be large)
3. Tool calling is implementation detail, not conversation history

**Trade-off**: On restart, LLM doesn't know what tools were called
- **Acceptable** because most home dialogue is stateless
- Streaming sessions don't restart mid-conversation

### Atomic Write Pattern

```typescript
private scheduleHistoryFlush(): void {
  const snapshot = this.filterHistoryForDisk(this.history);
  const file = this.getTodayHistoryFile();
  
  this.historyWriteChain = this.historyWriteChain
    .catch(() => undefined)  // Continue on error
    .then(async () => {
      mkdirSync(this.historyDir, { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(snapshot), 'utf8');
      renameSync(tmp, file);  // Atomic swap
    });
}
```

**Benefits**:
- **Serial writes**: Multiple runs don't corrupt file (historyWriteChain ensures ordering)
- **Atomic**: temp file + rename prevents half-written corruption
- **Non-blocking**: Writes scheduled asynchronously
- **Error-resilient**: Catches and logs, doesn't crash agent

### Truncation Strategy

```typescript
// Line 312-314 in openai-agent-runtime.ts
if (this.historyMaxItems > 0 && this.history.length > this.historyMaxItems) {
  this.history = this.history.slice(this.history.length - this.historyMaxItems);
}
```

**Configured by**: `OPENAI_AGENT_HISTORY_MAX` (default: 20)

**Why keep last 20 instead of all?**
- ~20 turns ≈ 10-15 minutes of conversation
- Enough context for follow-ups ("还能...吗?")
- Prevents context inflation (older turns less relevant)
- Faster LLM processing with smaller context

---

## Key Design Patterns

### 1. Progressive Disclosure

**Goal**: Scale skills without bloating base prompt

**Implementation**:
- Startup: Scan skills/, extract metadata only
- PASS 1: LLM sees skill list (8 tokens for all 4)
- Decision: Load full rules if needed
- PASS 2: LLM executes with complete context

**Trade-off**: Extra 500-800ms per skill request

### 2. Dependency Injection (Announcer Pattern)

**Goal**: Decouple GameConsoleController from DialogSession

**Implementation**:
```typescript
// Dependency flows downward
DialogSession
  → creates Announcer callback
  → passes to GameConsoleController
  → passed to GameSessionTimer
  → called at timer expiry
```

**Benefits**:
- No circular dependencies
- Testable (mock announcer in tests)
- Reusable (any announcer implementation works)

### 3. Singleton Services

**Goal**: Share global state across multiple contexts

**Implementation**:
```typescript
// GameConsoleController is singleton
const controller = getGameConsoleController(announcer);

// Used by:
// 1. game-console.tool.ts (LLM calls)
// 2. DialogSession startup recovery
// 3. GameSessionTimer (timer callbacks)
```

### 4. Atomic History Persistence

**Goal**: Never lose conversation history to crashes

**Implementation**:
```
→ Buffer in memory
→ Schedule async write
→ Write to temp file
→ Atomic rename
→ Chained promises (serial writes)
```

### 5. State Machine with Events

**Goal**: Clear orchestration of voice processing pipeline

**Implementation**:
```typescript
class DialogSession {
  private state: 'idle' | 'listening' | 'thinking' | 'speaking' | 'followup_wait';
  
  private emit(event: string) { /* ... */ }
  
  acceptPcm16(buffer: Buffer) {
    // State-aware processing
    if (this.state === 'idle') {
      // Wake word detection
      this.state = 'listening';
      this.emit('state', this.state);
    }
  }
}
```

### 6. Environment-Driven Configuration

**Goal**: Deploy same code to different homes

**Implementation**:
```bash
AC_LIVING_ROOM_IP=192.168.1.51
AC_LIVING_ROOM_TOKEN=...
GOSUND_PLUG_IP=192.168.1.50
GOSUND_PLUG_TOKEN=...
```

### 7. Streaming TTS with First-Sentence Latency

**Goal**: Start playing audio before entire response is ready

**Implementation**:
1. LLM generates text incrementally (token by token)
2. Split into sentences on the fly
3. Send complete sentences to TTS
4. Play as audio arrives
5. Network latency now: `first_sentence_tts` instead of `entire_response_tts`

---

## Summary

| Aspect | Implementation | Trade-off |
|--------|----------------|-----------|
| **Skill Scaling** | Progressive disclosure (2-pass) | +500-800ms per request |
| **Game Control** | Multi-layer validation + state machine | Complex but bulletproof |
| **AC Control** | MIOT protocol over LAN | Device-specific integration |
| **History** | Per-day JSON + atomic writes | Filtered history (no tool calls) |
| **Decoupling** | Dependency injection (Announcer) | Extra abstraction layers |
| **Concurrency** | Serial history writes | No parallel optimization |
| **State Management** | 5-state dialogue machine | State explosion risk with more states |

---

## Recommended Further Reading

1. **ARCHITECTURE.md** - Complete system overview
2. **QUICK_REFERENCE.md** - Execution sequence examples
3. **skills/game/SKILL.md** - Full game rules
4. **skills/air-conditioner/SKILL.md** - Full AC rules
5. **src/agent/openai-agent-runtime.ts** - Main orchestrator
6. **src/dialog/dialog-session.ts** - State machine
7. **src/services/game-console-controller.ts** - Multi-layer validation
8. **src/agent/tools/ac-partner-client.ts** - MIOT protocol

