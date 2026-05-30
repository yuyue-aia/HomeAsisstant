# Home Assistant Voice System - Complete Architecture Analysis

## Executive Summary

This is a **Chinese home voice assistant system** called "小鱼" (Little Fish) that uses a **two-pass inference pattern** to control smart home devices (AC units, game consoles, etc.) and execute various skills.

**The two-pass inference pattern:**
1. **Pass 1 (Lightweight)**: LLM sees only skill descriptions (names + one-liner purposes) and decides which skill to invoke
2. **Pass 2 (Heavy)**: LLM loads the full skill instructions and executes the actual control logic

This design optimizes token usage and prevents skill rules from interfering with each other.

---

## System Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    Voice Service (VoiceService)                 │
│  • Microphone input capture                                      │
│  • Wake word detection ("菜包菜包" - default)                   │
│  • ASR (Tencent cloud speech-to-text)                            │
│  • Dialogue state management                                     │
│  • TTS (Tencent cloud text-to-speech)                            │
└──────────────┬──────────────────────────────────────────────────┘
               │ User text input
               ▼
┌─────────────────────────────────────────────────────────────────┐
│            OpenAIAgentRuntime (Agent Orchestrator)               │
│                                                                  │
│  ├─ Loads all skills via SkillLoader at startup                │
│  ├─ Maintains multi-turn conversation history                  │
│  ├─ Calls OpenAI API with base instructions + skill list      │
│  ├─ Handles tool invocations (agent loop)                       │
│  └─ Integrates Langfuse tracing for observability               │
│                                                                  │
│  Instructions = BASE_INSTRUCTIONS + buildSkillsPromptSection    │
└──────────────┬──────────────────────────────────────────────────┘
               │
               ├──────────────────────────────────────────┬──────────────────┐
               │                                          │                  │
        PASS 1: Skill Discovery                    PASS 2: Tool Execution   │
        (Per skill = 1 line)                                                │
               │                                          │                  │
               ▼                                          ▼                  ▼
    ┌──────────────────────┐          ┌──────────────────────────────────────────┐
    │   load_skill tool    │          │        Execution Tools                   │
    │  (triggered by LLM)  │          │                                          │
    │                      │          │  • control_air_conditioner               │
    │ Returns full         │          │  • control_game_console                  │
    │ SKILL.md for         │          │  • manage_reminder                       │
    │ detailed rules       │          │  • control_air_conditioner               │
    └──────────────────────┘          │  • search_music / control_music_player   │
                                      │  • web_search                            │
                                      │  • read_file / write_file                │
                                      │  • get_current_time                      │
                                      │  • ...others                             │
                                      └──────────────────────────────────────────┘
```

---

## Key Components

### 1. **Skill Loader** (`src/agent/skills/skill-loader.ts`)

**Purpose**: Implements progressive disclosure of skill instructions

**Three-Stage Process**:

1. **Discovery** (Startup - one-time scan)
   - Scans `skills/` directory for `SKILL.md` files
   - Extracts only frontmatter: `name` and `description`
   - Creates skill metadata list (very lightweight)

2. **Activation** (Per-request when needed)
   - LLM decides to use a skill based on the one-liner description
   - LLM calls `load_skill` tool with skill name
   - Full `SKILL.md` body is loaded into context

3. **Execution** (After loading full instructions)
   - LLM follows the detailed rules from SKILL.md
   - Calls appropriate execution tools

### 2. **OpenAI Agent Runtime** (`src/agent/openai-agent-runtime.ts`)

Main loop with tool circulation:
- Maintains multi-turn history (persisted daily)
- Builds context with base instructions + skill list
- Runs agent loop with maxTurns=500
- Filters history for persistence

### 3. **Skills Directory Structure**

```
skills/
├── game/                          # Game console management
│   └── SKILL.md
├── air-conditioner/              # AC control
│   └── SKILL.md
├── reminder/                     # Reminders
│   └── SKILL.md
└── music/                        # Music playback
    └── SKILL.md
```

---

## Two-Pass Inference Pattern (WHY IT'S SLOW)

### The Problem This Design Solves

Without progressive disclosure, all skill rules would be in the base prompt all the time, consuming extra tokens even when user doesn't need them.

### The Two-Pass Solution

**PASS 1: Lightweight decision** (~800ms)
```
User: "开空调到二十六度"
LLM sees skill list (4 lines, ~8 tokens)
LLM decides: "I need air-conditioner skill"
LLM calls: load_skill(name: "air-conditioner")
```

**load_skill execution** (~50ms)
```
File I/O from disk
Returns: {ok: true, instructions: "[full AC rules - 35 lines]"}
```

**PASS 2: Heavy execution** (~800ms)
```
LLM now sees expanded context with full AC skill rules
LLM understands full operational rules
LLM calls:
  1. control_air_conditioner(room: "living_room", action: "turn_on")
  2. control_air_conditioner(room: "living_room", action: "set_temperature", temperature: 26)
```

### Cost Analysis

**Without Progressive Disclosure**:
- Every request includes all skill rules: ~130 tokens always

**With Progressive Disclosure**:
- Base request: ~8 tokens (just skill names)
- IF skill needed: +35 tokens for AC rules
- Selective cost

**Slowness Trade-off**: Extra LLM round-trip (~500-800ms) but:
1. Saves tokens on non-skill requests
2. Cleaner reasoning per domain
3. More extensible architecture

---

## Game Console Control Subsystem

### Three Actions

| Intent | Action | Parameters |
|--------|--------|------------|
| Want to play | `start_game` | `who`, `minutes` (5-60) |
| Stop playing | `stop_game` | `who` (optional) |
| Check status | `status` | (none) |

### Key Rules (from `skills/game/SKILL.md`)

1. **Permission**: Only "余晓" and "余跃" can play
2. **Quota**: 1 hour per child per day
3. **Safety**: Always call `status` before `start_game` to check quota
4. **Interaction**: Confirm child identity and duration

---

## Air Conditioner Control Subsystem

### Supported Rooms

- 客厅 (Living room)
- 主卧 (Master bedroom)
- 奶奶房间 (Grandma's room)
- 余跃房间 (Yuyue's room)
- 余晓房间 (Yuxiao's room)

### Actions

- `turn_on` / `turn_off` / `toggle` / `status`
- `set_temperature` (16-30°C)
- `increase_temperature` / `decrease_temperature` (with optional delta)
- `set_mode` (cool/heat/auto/fan/dehumidify)
- `set_fan_level` (auto/low/medium/high)

### Key Rules (from `skills/air-conditioner/SKILL.md`)

1. **Room must be explicit**: Ask if not specified
2. **Combo operations step-by-step**: "开空调到二十六度" = turn_on + set_temperature
3. **Relative changes use delta**: Default delta=2 if not specified
4. **Don't auto-respond to vague complaints**: Confirm first
5. **Batch operations need confirmation**: Confirm before controlling all rooms

---

## Tool Definitions

| Tool | Purpose | When Called |
|------|---------|-------------|
| `load_skill` | Load full skill instructions | PASS 1 (if skill needed) |
| `control_air_conditioner` | AC on/off/temp/mode | PASS 2 (if AC skill loaded) |
| `control_game_console` | Game start/stop/status | PASS 2 (if game skill loaded) |
| `manage_reminder` | Create/modify/delete reminders | PASS 2 (if reminder skill loaded) |
| `search_music` | Find songs by name | PASS 2 (if music skill loaded) |
| `control_music_player` | Play/pause/next/prev | PASS 2 (if music skill loaded) |
| `get_current_time` | Query current time | Always available |
| `web_search` | Search internet | Always available |
| `read_file` / `write_file` | Filesystem I/O | Always available |

---

## Inference Flow Example

```
User: "开客厅空调到二十六度"
  │
  ├─ PASS 1: OpenAI call with skill list
  │   Input:
  │     BASE_INSTRUCTIONS (output rules, tool usage)
  │     【可用技能】section (4 skills, 4 lines)
  │     User message
  │   Output:
  │     Tool call: load_skill("air-conditioner")
  │
  ├─ load_skill tool executes
  │   Output: {ok: true, instructions: "[full AC rules - 35 lines]"}
  │
  ├─ PASS 2: OpenAI call continues (same runner)
  │   Input:
  │     Previous context
  │     + Full air-conditioner skill instructions
  │   Output:
  │     Tool call 1: control_air_conditioner(room="living_room", action="turn_on")
  │     Tool call 2: control_air_conditioner(room="living_room", action="set_temperature", temperature=26)
  │     Final text: "好的，客厅空调已经开到二十六度。"
  │
  └─ Return: {text: "好的，客厅空调已经开到二十六度。"}

Total Latency: ~2-3 seconds
- PASS 1: ~800ms (OpenAI API)
- load_skill: ~50ms (file I/O)
- PASS 2: ~800ms (OpenAI API)
- Tool execution: ~200ms (device control)
- TTS: ~500ms (cloud text-to-speech)
```

---

## Why Two Passes Make It Slow

### Latency Breakdown

| Phase | Time | Reason |
|-------|------|--------|
| **PASS 1 (Skill Detection)** | ~800ms | OpenAI API call (tokenize + inference) |
| load_skill tool | ~50ms | File I/O from disk |
| **PASS 2 (Execution)** | ~800ms | OpenAI API call (with expanded context) |
| Tool execution | ~200ms | AC API / Plug API calls |
| **Total for AC request** | ~1.8-2.5s | Network round-trips dominate |

### Network I/O is the Real Culprit

```
PASS 1 (800ms) = Network (200ms) + Inference (400-500ms) + Network (200ms)
  ↓ load_skill (50ms)
PASS 2 (800ms) = Network (200ms) + Inference (400-500ms) + Network (200ms)
  ↓ Tool execution (200ms)
Total: ~1.8-2.5 seconds
```

The extra network round-trip between PASS 1 and PASS 2 is unavoidable because:
1. The `load_skill` decision **must** come from LLM (not heuristics)
2. LLM reasoning is needed for ambiguous cases
3. We can't reliably pre-predict skill needs

---

## Configuration

### Required Environment Variables

```bash
# OpenAI API
OPENAI_API_KEY=sk-...
OPENAI_API_MODEL=gpt-4o

# Tencent Cloud ASR/TTS
TENCENT_SECRET_ID=...
TENCENT_SECRET_KEY=...

# Game Console (Gosund Plug)
GOSUND_PLUG_IP=192.168.1.50
GOSUND_PLUG_TOKEN=...
GAME_REMINDER_SECONDS=300,60

# AC Units (Xiaomi AC Partner IR blasters)
AC_LIVING_ROOM_IP=192.168.1.51
AC_LIVING_ROOM_TOKEN=...
# ... (one per room)

# Optional: Langfuse Tracing
LANGFUSE_SECRET_KEY=sk-...
```

---

## Key Design Patterns

### 1. Progressive Disclosure of Instructions

- Load only rule names initially
- Full rules loaded just-in-time via `load_skill` tool
- Trade-off: Extra API call vs. cleaner context

### 2. Singleton Services

Game console controller is singleton:
- Used by agent tool
- Used by VoiceService startup recovery
- Used by announcer callbacks

### 3. History Filtering and Persistence

Persisted history excludes `tool_call`/`tool_result`:
- Saves daily slices: `YYYY-MM-DD.json`
- Loads only today's history on startup
- Auto-forgets history from previous days

### 4. Multi-round Conversation Support

- `maxTurns: 500` allows deep reasoning chains
- History maintained per-session
- Tools can invoke other tools in same turn

---

## Summary

The system uses **two inference passes** to achieve:

1. **Modularity**: Skills are isolated units
2. **Token Efficiency**: Load rules only when needed
3. **Maintainability**: Add skills without modifying core
4. **Quality**: LLM focuses on one domain at a time

**Performance Cost**: ~500-800ms extra per skill-requiring request

**Value Delivered**:
- Cleaner reasoning per skill
- Easier to debug and maintain
- Scales better (many skills won't bloat base prompt)
- More extensible (new skills are drop-and-play)
