# Architecture Quick Reference Guide

## File Structure Map

```
src/
├── agent/                          # LLM inference engine
│   ├── openai-agent-runtime.ts     # Main Agent + Runner setup
│   ├── types.ts                    # TypeScript interfaces (VoiceAgentContext, etc.)
│   ├── tools/                      # Tool definitions (executors)
│   │   ├── load-skill.tool.ts      # 【KEY】 Dynamic skill loader
│   │   ├── air-conditioner.tool.ts # 【KEY】 AC control interface
│   │   ├── game-console.tool.ts    # 【KEY】 Gaming quota + timer control
│   │   ├── ac-partner-client.ts    # Xiaomi MIOT protocol implementation
│   │   ├── gosund-plug-client.ts   # Smart plug control (miio protocol)
│   │   ├── reminder.tool.ts        # Reminder CRUD
│   │   ├── music.tool.ts           # Music player control
│   │   ├── web-search.tool.ts      # Search integration
│   │   └── [other tools...]
│   ├── skills/                     # Runtime skill management
│   │   └── skill-loader.ts         # Discovery + loading logic
│   └── tracing/                    # Observability
│       └── langfuse-tracer.ts      # Optional: Langfuse integration
│
├── services/                       # Business logic + state
│   ├── game-console-controller.ts  # 【KEY】 Orchestrates quota + timer + plug
│   ├── game-quota.ts               # 【KEY】 Quota rules + daily tracking
│   ├── game-session-timer.ts       # 【KEY】 In-game timeouts + reminders
│   ├── reminder-service.ts         # Reminder scheduling
│   ├── music/
│   │   ├── music-service.ts        # Music player daemon control
│   │   ├── ncm-cli.ts              # NetEase Cloud Music CLI wrapper
│   │   └── duck-controller.ts      # Volume ducking on dialog events
│   └── [other services...]
│
├── dialog/                         # Conversation state machine
│   └── dialog-session.ts           # 【KEY】 Orchestrates ASR/Agent/TTS
│
├── cli/                            # Command-line interface
│   ├── cli.ts                      # Entry point (start/stop/ask/logs)
│   ├── voice-service.ts            # Manages VoiceService lifecycle
│   └── audio-io.ts                 # PCM audio I/O
│
├── asr/                            # Speech-to-Text
│   └── tencent-asr-client.ts       # Tencent Cloud ASR client
│
├── tts/                            # Text-to-Speech
│   └── tencent-tts-client.ts       # Tencent Cloud TTS client
│
├── wake/                           # Wake word detection
│   └── wake-word-service.ts        # Sherpa-ONNX KWS
│
├── config/                         # Configuration
│   └── env.ts                      # Environment loading + validation
│
└── common/                         # Utilities
    └── logger.ts                   # Structured logging

skills/                            # Skill definitions (Progressive Disclosure)
├── air-conditioner/
│   └── SKILL.md                    # Frontmatter (name, description) + rules
├── game/
│   └── SKILL.md
├── music/
│   └── SKILL.md
└── reminder/
    └── SKILL.md

.runtime/                          # Runtime state (git-ignored)
├── agent-history/
│   ├── 2024-05-29.json             # Daily conversation history
│   ├── 2024-05-30.json
│   └── [...]
├── game-quota.json                 # Game quota config
└── voice.pid                       # Background process PID
```

---

## Key Files by Feature

### Skills System
- **Discovery**: `src/agent/skills/skill-loader.ts::discoverSkills()`
- **Loading**: `src/agent/tools/load-skill.tool.ts::createLoadSkillTool()`
- **Definitions**: `skills/*/SKILL.md` files
- **Integration**: `src/agent/openai-agent-runtime.ts::buildInstructions()`

### Game Control
- **Tool Interface**: `src/agent/tools/game-console.tool.ts`
- **Controller/Orchestrator**: `src/services/game-console-controller.ts`
- **Quota Rules**: `src/services/game-quota.ts`
- **Timers**: `src/services/game-session-timer.ts`
- **Plug Control**: `src/agent/tools/gosund-plug-client.ts`

### AC Control
- **Tool Interface**: `src/agent/tools/air-conditioner.tool.ts`
- **MIOT Protocol**: `src/agent/tools/ac-partner-client.ts`
- **Skill Rules**: `skills/air-conditioner/SKILL.md`

### Inference Pipeline
- **Entry**: `src/dialog/dialog-session.ts::doTurn()`
- **Agent Runtime**: `src/agent/openai-agent-runtime.ts::run()` / `runStream()`
- **History Management**: `src/agent/openai-agent-runtime.ts::loadHistoryFromDisk()` / `scheduleHistoryFlush()`
- **Tracing**: `src/agent/tracing/langfuse-tracer.ts`

---

## Request Flow Diagrams

### Simple AC Control Request

```
"开客厅空调"
    ↓
Dialog: ASR("开客厅空调") → text
    ↓
Agent.run(text)
    ├─ Load history from .runtime/agent-history/YYYY-MM-DD.json
    ├─ Build prompt: BASE_INSTRUCTIONS + 【可用技能】
    └─ Call OpenAI with tools
        ↓
LLM: "Matches 'air-conditioner' skill"
    ├─ Call load_skill("air-conditioner")
    │   └─ Tool: read skills/air-conditioner/SKILL.md body
    ├─ Call control_air_conditioner(room="living_room", action="turn_on")
    │   └─ Tool: AcPartner.on() → MIOT protocol
    └─ Generate response: "好的，客厅空调已打开"
        ↓
Dialog: TTS("好的，客厅空调已打开") → MP3
    ↓
Speaker: play audio
```

### Game Control Request (Multi-Turn)

```
Turn 1: "我想玩游戏"
    ↓
LLM: load_skill("game") → reads rules
LLM: "是余晓还是余跃想玩？"
    ↓
Turn 2: "余晓"
    ↓
LLM: control_game_console(action="status") → quota info
LLM: "余晓想玩多少分钟？"
    ↓
Turn 3: "20分钟"
    ↓
LLM: control_game_console(action="start_game", child="yuxiao", minutes=20)
    ├─ GameConsoleController checks quota
    ├─ GameSessionTimer schedules:
    │   ├─ Reminder at 15 min
    │   ├─ Reminder at 1 min
    │   └─ Auto-stop at 20 min
    └─ Returns: "余晓，游戏机已打开..."
        ↓
LLM generates response
```

### Game Session In Progress (Proactive Reminder)

```
20 min game session active
    ↓
[At 15 min mark]
GameSessionTimer fires reminder
    ├─ GameConsoleController.announce("还能玩5分钟")
    └─ DialogSession receives announcement
        ├─ Buffers if mid-conversation
        └─ Or TTS immediately if idle
            ↓
Speaker: "还能玩5分钟"
```

---

## Core Interfaces

### SKILL.md Format
```yaml
---
name: skill-name
description: One-liner explaining when LLM should load this skill
---

# Skill Title

Markdown content with:
- Rules and constraints
- Decision trees
- Tool references
```

### Tool Execution Pattern
```typescript
tool<ParametersSchema, ContextType, ReturnType>({
  name: "tool_name",
  description: "What the LLM sees",
  parameters: z.object({ /* Zod schema */ }),
  async execute(params, context) {
    // Implementation
    return { ok: true, message: "..." };
  }
})
```

### History Persistence
```typescript
// Saved to: .runtime/agent-history/YYYY-MM-DD.json
[
  { role: "system", content: "你是家里的语音助手..." },
  { role: "user", content: "开客厅空调" },
  { role: "assistant", content: "好的，客厅空调已打开" },
]

// Tool calls/results NOT persisted (filtered out)
// Only user/assistant/system messages kept
```

### Game Quota Rules
```typescript
// Per-child per-day
{
  key: "yuxiao",
  label: "余晓",
  dailyQuotaMin: 60,           // 60 min total per day
  playDaysOfWeek: [5, 6]        // Friday (5), Saturday (6)
}
```

---

## Debugging Checklist

### Skills Not Loading?
1. Check `skills/*/SKILL.md` exists
2. Verify YAML frontmatter: `name:` and `description:` required
3. Run: `grep -r "skill_name" ./src --include="*.ts"` to verify discovery
4. Check logs: `npm logs | grep "skills.discover"`

### AC Control Failing?
1. Verify env vars: `AC_<ROOM>_IP` and `AC_<ROOM>_TOKEN`
2. Test miio connectivity: Check IP reachability from network
3. Check MIOT property IDs in `ac-partner-client.ts` match device spec
4. Logs: `grep "tool.ac" logs/*.log`

### Game Quota Not Working?
1. Check `.runtime/game-quota.json` exists and is valid JSON
2. Verify today is in `playDaysOfWeek` (0=Sun, 5=Fri, 6=Sat)
3. Check daily usage: `grep "game_console.start" logs/*.log`
4. Verify Gosund plug is reachable: `GOSUND_PLUG_IP` and `GOSUND_PLUG_TOKEN`

### History Not Persisting?
1. Check `.runtime/agent-history/` directory exists
2. Look for write errors: `grep "history.save_failed" logs/*.log`
3. Verify disk space available
4. Check permissions: `ls -la .runtime/agent-history/`

### LLM Not Calling Tools?
1. Check tool descriptions are clear (LLM won't call vague tools)
2. Verify tool parameters match Zod schema
3. Run single request with tracing enabled (Langfuse)
4. Check model: is it configured to support tools? (gpt-4o-mini ✓)

---

## Configuration Quick Lookup

### Essential Env Vars
```bash
# LLM
OPENAI_API_KEY=sk-...
OPENAI_AGENT_MODEL=gpt-4o-mini

# AC (1 per room)
AC_LIVING_ROOM_IP=...
AC_LIVING_ROOM_TOKEN=...

# Game
GOSUND_PLUG_IP=...
GOSUND_PLUG_TOKEN=...
GAME_CONSOLE_PLUG_DID=s1

# History
OPENAI_AGENT_HISTORY_MAX=20

# Tencent
TENCENT_SECRET_ID=...
TENCENT_SECRET_KEY=...
```

### Adding a New AC Room

1. Add env vars:
   ```bash
   AC_MYROOM_IP=192.168.0.X
   AC_MYROOM_TOKEN=hextoken
   ```

2. Update `src/agent/tools/air-conditioner.tool.ts` ROOMS array:
   ```typescript
   {
     key: 'myroom',
     label: '我的房间',
     aliases: ['我的房间'],
     envPrefix: 'AC_MYROOM',
   }
   ```

3. Update `skills/air-conditioner/SKILL.md` room list

### Adding a New Skill

1. Create `skills/my-skill/SKILL.md`:
   ```yaml
   ---
   name: my-skill
   description: One-liner for LLM
   ---
   
   # Skill Rules
   ```

2. Create tool in `src/agent/tools/` if needed

3. Restart agent (discovery runs at startup)

---

## Performance Tips

### Reduce Token Usage
- Keep skill descriptions short (one line)
- Only load SKILL.md when needed (load_skill tool)
- Filter out tool calls from history (already done)

### Improve Response Time
- Enable history caching (Langfuse)
- Pre-warm TTS with "在的" (already done)
- Use gpt-4o-mini instead of gpt-4 (already done)

### Reduce Context Size
- History truncated to 20 items (OPENAI_AGENT_HISTORY_MAX)
- Tool results paginated (top-N only)
- Daily history slicing (no cross-day context)

---

## Key Takeaways

| Concept | Files | Pattern |
|---------|-------|---------|
| **Skills** | `src/agent/skills/skill-loader.ts` + `skills/*/SKILL.md` | Progressive Disclosure |
| **Game Control** | `src/services/game-*` + `src/agent/tools/game-console.tool.ts` | State Machine + Quota |
| **AC Control** | `src/agent/tools/air-conditioner.tool.ts` + `ac-partner-client.ts` | MIOT Protocol |
| **Inference** | `src/agent/openai-agent-runtime.ts` | Tool Calling Loop |
| **Dialog** | `src/dialog/dialog-session.ts` | State Machine (idle → listening → thinking → speaking) |
| **History** | `.runtime/agent-history/*.json` | Per-Day Slicing |
| **Persistence** | `src/agent/openai-agent-runtime.ts::scheduleHistoryFlush()` | Atomic Write |

