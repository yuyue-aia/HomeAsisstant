# Quick Reference: Two-Pass Architecture

## The Three Keys to Understanding This System

### 1. **Progressive Disclosure** 
Why the system has TWO LLM calls instead of one:
- **PASS 1**: LLM decides WHICH skill to use (sees 4 skill names)
- **PASS 2**: LLM executes the skill (sees full skill rules)
- **Benefit**: Keeps context focused, scales better with many skills
- **Cost**: Extra 500-800ms per request (network round-trip)

### 2. **Skill-Based Architecture**
How the system is organized:
```
skills/
├── game/              → "Can I play?"        (1hr/day limit)
├── air-conditioner/   → "Control AC"        (5 rooms)
├── reminder/          → "Remind me"         (scheduling)
└── music/             → "Play music"        (search & control)
```

Each skill is:
- A markdown file with detailed rules
- Loaded on-demand by LLM decision
- Independent (no cross-contamination of rules)

### 3. **Tool Execution**
How commands actually work:
```
LLM decision → load_skill() → Full instructions → Tool calls → Devices
               ↑                                  ↑
           PASS 1                             PASS 2
```

---

## File Locations Cheat Sheet

| What | Where | Purpose |
|------|-------|---------|
| Main orchestrator | `src/agent/openai-agent-runtime.ts` | Runs the two-pass loop |
| Skill loader | `src/agent/skills/skill-loader.ts` | Implements progressive disclosure |
| load_skill tool | `src/agent/tools/load-skill.tool.ts` | LLM calls this in PASS 1 |
| AC control tool | `src/agent/tools/air-conditioner.tool.ts` | Executes AC commands |
| Game tool | `src/agent/tools/game-console.tool.ts` | Executes game commands |
| Game controller | `src/services/game-console-controller.ts` | Game business logic |
| **Game rules** | **skills/game/SKILL.md** | **Full game skill instructions** |
| **AC rules** | **skills/air-conditioner/SKILL.md** | **Full AC skill instructions** |
| History | `.runtime/agent-history/YYYY-MM-DD.json` | Conversation persistence |
| CLI | `src/cli/cli.ts` | Command-line entry point |

---

## Typical Execution Sequence

### Example: "开客厅空调到二十六度"

```
0. User speaks → ASR → Text: "开客厅空调到二十六度"

1. PASS 1 (~800ms)
   Agent: Here's the user message + 4 skill names
   LLM: "I need the air-conditioner skill"
   LLM output: Tool call load_skill("air-conditioner")

2. load_skill tool (~50ms)
   Action: Read skills/air-conditioner/SKILL.md
   Return: Full AC rules (35 lines)

3. PASS 2 (~800ms)
   Agent: Here's the full AC skill rules + user message
   LLM: "User wants living room AC to 26°. I'll turn_on, then set_temp"
   LLM output:
     - Tool call: control_air_conditioner(room="living_room", action="turn_on")
     - Wait for result
     - Tool call: control_air_conditioner(room="living_room", 
         action="set_temperature", temperature=26)
     - Final text: "好的，客厅空调已经开到二十六度。"

4. Tool execution (~200ms)
   Action 1: Send IR signal to AC blaster for power on
   Action 2: Send IR signal to AC blaster for set temp to 26

5. TTS (~500ms)
   Text: "好的，客厅空调已经开到二十六度。" → Speech → Speaker

Total: ~2.5 seconds
```

---

## How Skills Are Defined

### What's in a SKILL.md File

```yaml
---
name: game
description: 处理小朋友想玩游戏机、停游戏、查询剩余时长的请求
---

# 游戏管理 Skill

## 适用场景
用户（通常是小朋友）说出以下意图时启用：
- "我想玩游戏" / "给我开游戏"
- "还能玩多久" / "现在谁在玩"
- "停一下" / "下机"

## 操作规则

### 三类请求 → 三种 action

| 用户意图 | action | 关键参数 |
|---|---|---|
| 想开始玩 | `start_game` | `who`、`minutes` |
| 想停下 | `stop_game` | `who` |
| 查状态 | `status` | — |

## More rules...
```

### Discovery vs. Activation vs. Execution

| Stage | When | What Happens | Who Does It |
|-------|------|-------------|------------|
| **Discovery** | Startup | Scan skills/, extract name+description | SkillLoader |
| **Activation** | During PASS 1 | LLM decides to use a skill | OpenAI LLM (tool call) |
| **Activation Tech** | PASS 1→2 | load_skill tool reads full SKILL.md | load_skill tool |
| **Execution** | PASS 2 | LLM reads full rules and calls tools | OpenAI LLM (tool calls) |

---

## Common Scenarios

### Scenario 1: AC Control (Requires Skill)

```
User: "开空调"
       ↓
PASS 1: LLM needs air-conditioner skill → load_skill("air-conditioner")
        ↓ (skill loaded)
PASS 2: LLM sees full AC rules
        LLM: "Room not specified, must ask"
        LLM output: "您想控制哪个房间的空调？"
        ↓ (No tool call yet, LLM is asking)
End: Awaits next user response (follow-up turn)
```

### Scenario 2: Game Start (Requires Skill)

```
User: "我想玩游戏"
       ↓
PASS 1: LLM needs game skill → load_skill("game")
        ↓ (skill loaded)
PASS 2: LLM sees full game rules
        LLM reads: "必须先确认是谁"
        LLM output: "是余晓还是余跃想玩？"
        ↓ (No tool call yet)
End: Awaits clarification
```

### Scenario 3: Time Query (No Skill Needed)

```
User: "现在几点"
       ↓
PASS 1: LLM sees skill list, no skill matches
        LLM decides to call: get_current_time()
        ↓ (tool call in PASS 1)
        Tool returns: "14:30"
        ↓ (LLM generates response)
PASS 2: LLM output: "现在是下午两点半"
End: Done (only PASS 1)
```

---

## Game Console Rules (Quick)

**Who can play?**
- Only: 余晓 (Yuxiao), 余跃 (Yuyue)
- Others: Politely refuse

**Daily quota?**
- Each child: 1 hour per day (60 minutes)
- Check with `status` before `start_game`

**How to start?**
```
User: "我想玩游戏"
Agent: "是余晓还是余跃想玩？"
User: "余晓"
Agent: "想玩多少分钟？"
User: "30"
Agent: [calls start_game(child="yuxiao", minutes=30)]
       "好的，你可以玩30分钟。"
```

**Automatic shutdown:**
- Plug disconnects at timer expiry
- Pre-warnings at 5 min + 1 min before end

---

## AC Control Rules (Quick)

**Required room?**
- Yes! Always ask if not specified
- Supported: 客厅, 主卧, 奶奶房间, 余跃房间, 余晓房间

**Combo operations?**
- "开到26度" = turn_on + set_temperature
- Call multiple times, announce at end

**Temperature?**
- Range: 16-30°C
- Increase/decrease: default delta = 2°C

**Vague requests?**
- "有点热" ≠ auto-control command
- Respond: "要帮您开空调吗?" (confirm first)

---

## Architecture in One Picture

```
┌────────────────────────────────────────────────────────────┐
│  User Input (Voice/Text)                                   │
│  "开客厅空调到二十六度"                                    │
└────────────────┬─────────────────────────────────────────┘
                 │
        ┌────────▼────────┐
        │ OpenAIAgentRuntime
        │ (Main Orchestrator)
        │ - History mgmt
        │ - Base instructions
        │ - Skill list
        └────────┬────────┘
                 │
        ┌────────▼──────────────────────────────────────┐
        │ PASS 1: Skill Selection (~800ms)            │
        │ LLM: "I need air-conditioner skill"         │
        │ Output: load_skill("air-conditioner")       │
        └────────┬──────────────────────────────────────┘
                 │
        ┌────────▼──────────────────────────────────────┐
        │ load_skill Tool (~50ms)                      │
        │ Action: Read skills/air-conditioner/SKILL.md│
        │ Return: Full AC rules (35 lines)            │
        └────────┬──────────────────────────────────────┘
                 │
        ┌────────▼──────────────────────────────────────┐
        │ PASS 2: Execution (~800ms)                   │
        │ LLM: "turn_on + set_temperature"            │
        │ Output: Tool calls                          │
        │ - control_air_conditioner(turn_on)          │
        │ - control_air_conditioner(set_temp=26)      │
        │ - Final text: "好的，..."                    │
        └────────┬──────────────────────────────────────┘
                 │
        ┌────────▼──────────────────────────────────────┐
        │ Tool Execution (~200ms)                      │
        │ - Send IR commands to AC blaster             │
        │ - Receive ACK                                │
        └────────┬──────────────────────────────────────┘
                 │
        ┌────────▼──────────────────────────────────────┐
        │ TTS + Output (~500ms)                        │
        │ - "好的，客厅空调已经开到二十六度。"        │
        │ - Convert to speech, play                    │
        └────────┬──────────────────────────────────────┘
                 │
                 ▼
            User hears response
```

---

## Why It's Slow: The Trade-offs

### Speed Cost: +500-800ms
- One extra network round-trip to OpenAI
- Network dominates (each way ~200ms)

### What We Gain:
1. **Modularity**: Add 10 skills without bloating base prompt
2. **Clarity**: LLM focused on one domain at a time
3. **Maintainability**: Skill rules in separate file
4. **Extensibility**: New skills don't interfere with old

### When It's Not Slow:
- Time queries (no skill needed)
- Web search (built-in tool)
- File operations (built-in tool)
- These skip skill loading entirely

---

## Debugging Tips

### Check if skill was loaded
```bash
# Look at OpenAI trace or logs for load_skill call
grep -r "load_skill" .runtime/agent-history/
```

### See conversation history
```bash
cat .runtime/agent-history/2024-05-29.json | jq '.'
```

### Test single query
```bash
npm run ask -- "开空调到二十六度"
```

### Watch logs
```bash
npm run logs -f
```

### Check device config
```bash
env | grep AC_
env | grep GOSUND_
```

---

## Summary Table

| Aspect | Detail |
|--------|--------|
| **Architecture Pattern** | Two-pass inference with progressive disclosure |
| **Pass 1 Time** | ~800ms (skill decision) |
| **Pass 2 Time** | ~800ms (execution) |
| **Main Bottleneck** | Network to OpenAI (2 round-trips) |
| **Number of Skills** | 4 (game, ac, reminder, music) |
| **Execution Tools** | 10+ (air-conditioner, game-console, music, etc.) |
| **History Storage** | Per-day JSON files in `.runtime/` |
| **Multi-turn Support** | Yes (maxTurns=500) |
| **Device Integration** | HomeAssistant, Xiaomi IR, Gosund plugs |
| **Language** | Primarily Chinese |
