# Design Patterns and Key Findings

## Table of Contents

1. [Critical Design Insights](#critical-design-insights)
2. [Architectural Patterns](#architectural-patterns)
3. [Technology Choices](#technology-choices)
4. [Performance Characteristics](#performance-characteristics)
5. [Scalability Considerations](#scalability-considerations)
6. [Common Pitfalls and How They're Avoided](#common-pitfalls-and-how-theyre-avoided)
7. [Testing Strategy](#testing-strategy)
8. [Future Enhancement Opportunities](#future-enhancement-opportunities)

---

## Critical Design Insights

### 1. **Two-Pass Inference is Intentional Trade-off**

**Insight**: The extra 500-800ms latency is a deliberate choice, not a limitation.

**Why it matters**:
- **Without two-pass**: All skill rules (~130 tokens) in every prompt
  - Wastes tokens on non-skill requests
  - Harder to scale (10 skills = 300+ tokens)
  - Rules interfere with each other in LLM reasoning
  
- **With two-pass**: Rules loaded on-demand
  - Only when skill chosen
  - Cleaner reasoning per domain
  - Scales to 20+ skills with minimal overhead

**Evidence from code**:
```typescript
// Line 37-49 in openai-agent-runtime.ts
// BASE_INSTRUCTIONS is lean (~50 lines)
// Skill-specific rules in separate SKILL.md files
// LLM decides which skill to load via progressive disclosure
```

**User Impact**: 2-3 second response time is acceptable for home voice assistant where:
- Most requests are not time-critical
- Network to OpenAI dominates anyway (~1.6s for 2 round-trips)
- Benefit of clearer domain reasoning outweighs latency

### 2. **Skill System is NOT Content Management**

**Insight**: SKILL.md files are NOT just documentation—they're executable instructions.

**Misconception**: "Skills are just rules, docs, or configuration"

**Reality**:
```
Discovery (startup)      → SKILL.md metadata extracted
Activation (PASS 1)      → LLM sees {name, description}
Loading (load_skill)     → Full SKILL.md body read from disk
Execution (PASS 2)       → LLM follows rules to make tool calls
```

**Key difference**: 
- Config files (JSON/YAML) = static data
- SKILL.md = instructions embedded in markdown that LLM reads and follows
- LLM doesn't parse the markdown—it reads it as instructions

**Example from skills/game/SKILL.md**:
```markdown
## 操作规则

### 三类请求 → 三种 action
| 用户意图 | action | 关键参数 |
|---|---|---|
| 想开始玩 | `start_game` | `who`、`minutes` |
| 想停下 | `stop_game` | `who` |
| 查状态 | `status` | — |

## 重点：必须先确认是谁
```

This is direct instruction to LLM, not configuration.

### 3. **No Custom Tool Routing Needed**

**Insight**: OpenAI Agents SDK handles tool dispatch automatically by name matching.

**Common misconception**: "Need to build custom routing layer"

**Reality**: Line 123-136 in openai-agent-runtime.ts
```typescript
this.agent = new Agent({
  tools: [
    controlDeviceTool,
    controlAirConditionerTool,
    // ... more tools
  ]
});
```

**How it works**:
1. LLM outputs: `{ "type": "function", "name": "control_air_conditioner", ... }`
2. SDK searches tools array: `find(t => t.name === "control_air_conditioner")`
3. Found? Call handler
4. Result goes back to LLM for next iteration

**Why this matters**: Reduces codebase complexity significantly
- No custom router implementation needed
- No routing bugs
- Natural scaling: add tool = add to array

### 4. **Game Quota is Multi-Layer Validation, Not Just Storage**

**Insight**: Game quota management has 5 independent layers:

```
Layer 1: Is child valid?                 ← Identity validation
Layer 2: Is today a play day?            ← Schedule validation
Layer 3: Daily quota available?          ← Budget validation
Layer 4: No active session?              ← Concurrency control
Layer 5: Is plug reachable?              ← Device connectivity
```

**Why separate layers**:
- Each can fail independently
- Clear error messages for each failure
- Easy to add new layers (e.g., parent permission check)
- Testable in isolation

**Code evidence**: `src/services/game-console-controller.ts` start() method
- 5 separate if-blocks
- Each returns early with specific message
- Stops at first failure

### 5. **AC Control is LAN-First, Cloud-Optional**

**Insight**: AC control uses local UDP (Xiaomi MIOT) for speed, not cloud.

**Why this matters**:
- ~30ms round-trip on LAN vs ~200ms+ to cloud
- Works without internet (LAN only)
- More reliable (no cloud dependency)
- Faster (network dominates latency budget)

**Technology**: MIOT (Xiaomi IoT) over miio binary protocol
- Proprietary but widely documented (reverse engineered)
- Efficient: binary payload (not JSON)
- Encrypted: token-based auth
- UDP: stateless (no TCP handshake)

**Trade-off accepted**: Xiaomi-specific
- Works with any AC via Xiaomi AC Partner (IR blaster)
- Could be abstracted to other protocols (future work)

### 6. **History Filtering is Deliberate Data Loss**

**Insight**: Tool calls and results are removed before persisting history.

**Why accept this loss**:
```
With tools in history:
├─ File size bloats (web_search returns 5 results)
├─ Truncation can cut tool_call/tool_result pairs
├─ LLM gets confused on restart (half-baked context)
└─ Mostly unnecessary (tools are ephemeral)

Without tools in history:
├─ Cleaner history (just human words)
├─ Safe truncation (always valid JSON to replay)
├─ Tool results fade naturally (not needed after response)
└─ Trade-off: restart loses tool context (acceptable)
```

**Evidence**: `src/agent/openai-agent-runtime.ts` lines 407-411
```typescript
private filterHistoryForDisk(items: AgentInputItem[]): AgentInputItem[] {
  return items.filter((item) => {
    const role = (item as { role?: string }).role;
    return role === 'system' || role === 'user' || role === 'assistant';
  });
}
```

**Why acceptable**: Most home dialogue is stateless
- "Turn on AC" doesn't depend on previous tool calls
- "Check time" doesn't care about history
- Multi-turn scenarios restart from empty history anyway

---

## Architectural Patterns

### Pattern 1: Progressive Disclosure (Skill Loading)

**Pattern Name**: Progressive Disclosure / Lazy Loading / Just-In-Time

**Problem**: Scale skills without bloating prompt

**Solution**:
```
├─ Discovery: Metadata only (~1 token per skill)
├─ Activation: LLM decides based on one-liner description
├─ Loading: Full rules loaded on-demand
└─ Execution: LLM follows loaded rules
```

**Where implemented**:
- `skill-loader.ts`: Discovery + loading mechanism
- `load-skill.tool.ts`: Activation → loading bridge
- `openai-agent-runtime.ts`: Two-pass orchestration

**Cost-Benefit**:
- Cost: +500-800ms per skill request
- Benefit: 
  - Scales from 4 to 40 skills with minimal prompt overhead
  - Cleaner reasoning per domain
  - Rules easier to maintain (separate files)

**When to use**: Anytime you have 3+ semi-independent domains

### Pattern 2: Dependency Injection (Announcer)

**Pattern Name**: Dependency Injection / Hollywood Principle

**Problem**: Timer in GameSessionTimer needs to announce via TTS, but shouldn't import DialogSession (circular dependency)

**Solution**:
```typescript
// 1. Define callback type
type Announcer = (message: string) => Promise<void>;

// 2. Inject from consumer
class DialogSession {
  constructor() {
    const announcer = (msg: string) => this.tts.synthesizeAndPlay(msg);
    this.gameController = getGameConsoleController(announcer);
  }
}

// 3. Provider uses callback without knowing consumer
class GameSessionTimer {
  schedule(..., announcer: Announcer, ...) {
    setTimeout(() => {
      announcer("Still 5 minutes left"); // Decoupled call
    }, delay);
  }
}
```

**Why this pattern**:
- No circular dependencies
- GameConsoleController is UI-agnostic
- Testable: mock announcer in tests
- Reusable: any announcer implementation works (TTS, logging, webhook, etc.)

**Trade-off**: Extra abstraction layer (worth it)

### Pattern 3: Atomic Writes with Promise Chaining

**Pattern Name**: Serial Writes / Promise Pipeline

**Problem**: Multiple agent.run() calls happen quickly. Need to persist history without corruption.

**Solution**:
```typescript
this.historyWriteChain = Promise.resolve();

scheduleHistoryFlush() {
  this.historyWriteChain = this.historyWriteChain
    .catch(() => undefined)  // Continue on error
    .then(async () => {
      writeFileSync(tmp, data);
      renameSync(tmp, final);  // ATOMIC
    });
}
```

**Why effective**:
- Serial: Each write waits for previous
- Atomic: rename() is atomic at OS level
- Non-blocking: Async, doesn't block agent loop
- Error-resilient: Catches, logs, continues

**Trade-off**: Slight write latency (acceptable—async anyway)

### Pattern 4: State Machine with Events

**Pattern Name**: State Machine / Event Emitter

**Problem**: Voice pipeline has many interdependent stages (listening → thinking → speaking → followup).

**Solution**:
```typescript
class DialogSession {
  private state: State;
  
  private emit(event: string) { ... }
  
  acceptPcm16(buffer: Buffer) {
    if (this.state === 'idle') {
      if (detectWakeWord(buffer)) {
        this.state = 'listening';
        this.emit('state', 'listening');
      }
    }
  }
}

// Consumer listens for events
session.on('state', (newState) => {
  console.log(`State changed to ${newState}`);
});
```

**Why effective**:
- Clear state transitions
- Observable (events tell you what's happening)
- Extensible (easy to add listeners)
- Debuggable (log all state changes)

**Trade-off**: More code than imperative flow, but much clearer

### Pattern 5: Singleton Services with DI

**Pattern Name**: Singleton / Service Locator

**Problem**: GameConsoleController needs to be:
- Used by agent tool
- Used by startup recovery
- Injected into DialogSession for announcer

**Solution**:
```typescript
let instance: GameConsoleController | null = null;

export function getGameConsoleController(announcer: Announcer): GameConsoleController {
  if (!instance) {
    instance = new GameConsoleController(announcer);
  }
  return instance;
}
```

**Why effective**:
- Shared global state (only one active session)
- Single point of management
- Observable (one place to inspect state)
- Testable (can create new instance per test)

**Trade-off**: Must be thread-safe (Node.js is single-threaded, OK here)

### Pattern 6: Environment-Driven Configuration

**Pattern Name**: Twelve-Factor / Configuration as Environment

**Problem**: Deploy same code to different homes with different device IPs/tokens.

**Solution**:
```bash
# .env file (per home)
AC_LIVING_ROOM_IP=192.168.1.51
AC_LIVING_ROOM_TOKEN=xyz123
GOSUND_PLUG_IP=192.168.1.50
```

**In code**: `src/config/env.ts`
```typescript
export function loadConfig(): AppConfig {
  return {
    openaiApiKey: process.env.OPENAI_API_KEY!,
    homeAssistantBaseUrl: process.env.HOME_ASSISTANT_BASE_URL,
    // ...
  };
}
```

**Why effective**:
- Zero code changes per deployment
- Secrets not in source code
- Easy to test (swap env)
- Clear what needs to be configured

**Trade-off**: Must remember all env vars (mitigated by .env.example)

---

## Technology Choices

### OpenAI Agents vs Alternatives

**Why Agents SDK (not raw Chat Completions)**:

| Aspect | Chat Completions | Agents SDK |
|--------|------------------|-----------|
| Tool calling | Manual loop | Automatic |
| Tool dispatch | Build router | Built-in |
| Error handling | Manual try/catch | Handled |
| Streaming | Raw tokens | Structured events |
| History mgmt | Manual | Tracked |
| **Use for** | Simple calls | Multi-tool reasoning |

**Code evidence**: Using `@openai/agents` SDK (not raw API)
- Lines 1-9: SDK imports
- Line 114: `new Runner()` - SDK orchestrator
- Line 119: `new Agent()` - SDK agent

### Tencent Cloud ASR/TTS vs Alternatives

**Why Tencent** (over Google/Azure/AWS):
- Operates in China (low latency)
- Good Chinese language support
- Per-minute billing (cost-effective)
- Streaming ASR (partial results)

**Trade-off**: Vendor lock-in on Chinese deployment

### Xiaomi MIOT vs HomeAssistant

**Why MIOT for AC** (not always HomeAssistant):
- LAN-only communication (faster)
- Works without HomeAssistant
- Direct to device (no middleware)

**When to use MIOT**: AC units (local control priority)
**When to use HomeAssistant**: Other devices (abstraction value)

### Sherpa-ONNX vs Cloud KWS

**Why local KWS**:
- No latency (local inference)
- Privacy (no audio sent to cloud)
- Works offline
- Always listening (cost-free)

**Trade-off**: Less accurate than cloud, but acceptable for "小鱼"

---

## Performance Characteristics

### Latency Budget (per request)

```
┌─ PASS 1 (Skill Selection)        ~800ms (network dominates)
├─ load_skill Tool                 ~50ms  (file I/O)
├─ PASS 2 (Execution)              ~800ms (network dominates)
├─ Tool Execution (AC, Game, etc)  ~100-200ms
├─ TTS Synthesis                   ~200ms
└─ TTS Playback                    ~300-500ms
───────────────────────────────────────────
TOTAL                              ~2.0-2.5 seconds
```

### Network Latency Analysis

```
OpenAI API round-trip (~400ms each way):
├─ Upload: ~200ms (send tokens to OpenAI, CA to US)
├─ Processing: ~100-200ms (inference)
└─ Download: ~200ms (receive response)

x2 (PASS 1 + PASS 2) = ~800ms network time

Where to optimize:
├─ Caching PASS 1 decisions (if repeating same skill) → risky
├─ Batching requests (if you can wait) → defeats voice UI
├─ Using gpt-4o-mini (cheaper, smaller latency) ← best option
└─ Regional endpoint (if available) → might help EU
```

### Memory Characteristics

```
Typical memory usage at runtime:
├─ History (20 items, ~10KB)
├─ Skills metadata (~1KB)
├─ Agent instance (~5MB)
├─ Tencent ASR client (~10MB)
├─ TTS synthesis cache (~20MB)
└─ Node.js overhead (~50MB)
────────────────────────────
Total: ~100-150MB per running instance
```

**Scaling**: Multiple rooms
- Each room = separate DialogSession instance
- Room 1: ~150MB
- Room 2: +50MB (shared SKDs)
- Room 3: +50MB
- → 3 rooms ≈ 250-300MB

---

## Scalability Considerations

### Skill Scaling

**Current**: 4 skills (game, AC, reminder, music)
**Designed for**: 10-20 skills

**How it scales**:
```
With progressive disclosure:
├─ 1 skill  → 1 line in prompt (~1 token)
├─ 4 skills → 4 lines (~8 tokens)
├─ 20 skills → 20 lines (~40 tokens)
└─ 100 skills → 100 lines (~200 tokens)

Total prompt still manageable because:
- Base instructions: ~50 tokens (fixed)
- All skills: ~200 tokens (worst case)
- User message: variable
- Total: still well under 4K context (gpt-4o limit 100K)
```

**Limit**: ~50 skills before PASS 1 latency matters (more skill descriptions = slower LLM)

### Device Scaling

**Current**: 5 AC rooms + 1 game console
**Designed for**: 100+ devices (rooms, appliances)

**Scaling mechanism**:
- Each AC room: separate IP, token in environment
- Each device: separate tool call or parameter
- Batch operations handled by LLM (e.g., "turn on all ACs")

**Bottleneck**: Device IP lookup (environment variables)
- **Could optimize**: Device registry (database instead of env)
- **Current**: OK up to ~50 devices

### User/Session Scaling

**Current**: Single user, single session
**Scalability**: Limited (not designed for multi-user)

**Why not multi-user**:
- Quota system assumes one family per installation
- Game console is singular (can't play multiplayer)
- DialogSession is singleton per room

**To support multi-user**:
- Per-user quota files
- Per-user history
- User identification at wake
- Shared device access control (conflict resolution)

### Geographic Scaling

**Current**: Single home (single location)
**Scalability**: Each installation is independent

**To support multiple homes**:
- Central backend (track all homes)
- Per-home agent (local deployment)
- Webhook callbacks (home → backend)
- Not implemented here (local-first design)

---

## Common Pitfalls and How They're Avoided

### Pitfall 1: Bloated Base Prompt

**What could go wrong**: All skill rules in BASE_INSTRUCTIONS
```typescript
// BAD: All rules always
const BASE_INSTRUCTIONS = `
${GAME_RULES}
${AC_RULES}
${REMINDER_RULES}
${MUSIC_RULES}
...
`; // ~300 tokens every request
```

**How avoided**: Progressive disclosure
```typescript
// GOOD: Only names initially
const BASE_INSTRUCTIONS = `
...generic rules...
【可用技能】
1. game: ...one-liner...
2. air-conditioner: ...one-liner...
`;

// Full rules loaded only if needed
```

**Code**: `skill-loader.ts` + `load-skill.tool.ts`

### Pitfall 2: Circular Dependencies

**What could go wrong**: GameConsoleController imports DialogSession imports GameConsoleController
```typescript
// BAD: Circular
class GameConsoleController {
  constructor(private dialog: DialogSession) {} // Dialog imports this
}
```

**How avoided**: Dependency injection
```typescript
// GOOD: Abstract the callback
class GameConsoleController {
  constructor(private announcer: Announcer) {} // Just a callback
}

// DialogSession provides the announcer
const announcer = (msg) => this.dialogSession.tts.play(msg);
```

**Code**: `src/services/game-console-controller.ts` constructor

### Pitfall 3: Tool Call / Tool Result Corruption

**What could go wrong**: History truncation cuts between tool_call and tool_result
```json
[
  { role: 'assistant', content: 'tool_call: search_web' },
  // ← TRUNCATION BOUNDARY (max 20 items)
  { role: 'tool', content: '[search results]' },
  // ← Missing! LLM confused on restart
]
```

**How avoided**: Filter tool calls before persisting
```typescript
filterHistoryForDisk(items) {
  return items.filter(item => 
    item.role === 'system' || 
    item.role === 'user' || 
    item.role === 'assistant'  // No tool calls!
  );
}
```

**Trade-off**: Tool context lost on restart (acceptable—tools are ephemeral)

**Code**: `src/agent/openai-agent-runtime.ts` lines 407-411

### Pitfall 4: File Corruption on Concurrent Writes

**What could go wrong**: Multiple agent.run() calls write simultaneously
```
Process 1: write(history.json, data1) ← Incomplete
Process 2: write(history.json, data2) ← Overwrites, corrupts data1
```

**How avoided**: Atomic writes + serial queue
```typescript
// Write to temp first
writeFileSync(tmp, data);
// Then atomic rename
renameSync(tmp, final);

// Queue writes serially
this.historyWriteChain = this.historyWriteChain
  .then(() => { /* do write */ });
```

**Code**: `src/agent/openai-agent-runtime.ts` lines 424-438

### Pitfall 5: Game Session State Loss

**What could go wrong**: Process restarts mid-game, no shutdown timer
```
├─ User: "玩30分钟" → activeSession set
├─ Agent restarts (crash, deploy)
├─ Plug still on, but timer lost
└─ Parent never gets announcement, forget to turn off
```

**How avoided**: Startup recovery
```typescript
// On DialogSession startup
async initialize() {
  const active = await this.gameController.getActiveSession();
  if (active) {
    // Resume timer
    this.gameController.timer.schedule(
      active.child,
      active.remainingMinutes,
      ...
    );
  }
}
```

**Code**: `src/dialog/dialog-session.ts` constructor

### Pitfall 6: Token Explosion with Context

**What could go wrong**: History grows unbounded
```
├─ Day 1: 50 turns → ~5KB history
├─ Day 2: 100 turns → ~10KB history
├─ ...
└─ Day 30: 1500 turns → ~150KB
```

**How avoided**: Daily reset + item limit
```typescript
// Reset every day
getTodayHistoryFile() { 
  // Uses current date, old files ignored
}

// Limit items
if (this.history.length > historyMaxItems) {
  this.history = this.history.slice(-historyMaxItems);
}
```

**Code**: `src/agent/openai-agent-runtime.ts` lines 350-356, 312-314

---

## Testing Strategy

### Unit Testing Opportunities

**Skill Loader**:
```typescript
test('discoverSkills finds all SKILL.md files', () => {
  const skills = discoverSkills();
  expect(skills.length).toBe(4);
  expect(skills[0]).toHaveProperty('name');
});

test('parseFrontmatter extracts name and description', () => {
  const yaml = '---\nname: game\ndescription: test\n---\nBody';
  const result = parseFrontmatter(yaml);
  expect(result.name).toBe('game');
});
```

**Game Quota**:
```typescript
test('validates child is in CHILDREN', () => {
  expect(isValidChild('yuxiao')).toBe(true);
  expect(isValidChild('invalid')).toBe(false);
});

test('checks weekday restrictions', () => {
  expect(isPlayableToday('yuxiao', 5)).toBe(true); // Saturday
  expect(isPlayableToday('yuxiao', 3)).toBe(false); // Wednesday
});

test('resets quota at midnight', () => {
  setQuota('yuxiao', { date: '2026-05-28', remaining: 0 });
  // Time passes to 2026-05-29
  expect(getRemainingQuota('yuxiao')).toBe(60); // Reset!
});
```

**AC Partner**:
```typescript
test('builds MIOT payload correctly', () => {
  const payload = buildMiotPayload(3, 1, true);
  expect(payload).toContainEqual({ siid: 3, piid: 1, value: true });
});

test('encrypts payload with token', () => {
  const encrypted = encryptMiio(payload, token);
  expect(encrypted).not.toEqual(payload); // Should be different
  expect(decryptMiio(encrypted, token)).toEqual(payload);
});
```

### Integration Testing Opportunities

**Two-Pass Inference**:
```typescript
test('load_skill called in PASS 1, execution in PASS 2', async () => {
  const input = { text: '开空调', sessionId: '1' };
  const output = await runtime.run(input);
  
  // Verify history contains both passes
  expect(history).toContainEqual(
    { role: 'assistant', content: 'tool_call: load_skill' }
  );
  expect(history).toContainEqual(
    { role: 'tool', name: 'load_skill', content: '[AC rules]' }
  );
  expect(history).toContainEqual(
    { role: 'assistant', content: 'tool_call: control_air_conditioner' }
  );
});
```

**Game Flow**:
```typescript
test('start_game validates all 5 layers', async () => {
  // Layer 1: Invalid child
  let result = await tool.handler({ action: 'start_game', child: 'invalid', minutes: 30 });
  expect(result.ok).toBe(false);
  
  // Layer 2: Wrong day
  // Mock weekday to Wednesday
  result = await tool.handler({ action: 'start_game', child: 'yuxiao', minutes: 30 });
  expect(result.ok).toBe(false);
  
  // Layer 3: No quota (if using all 60 mins first)
  // ...
});
```

### End-to-End Testing

**Voice Pipeline**:
```typescript
test('voice input → ASR → LLM → AC control → TTS', async () => {
  const mockWaveform = generateWaveform('开空调');
  
  const result = await dialogSession.acceptPcm16(mockWaveform);
  
  expect(result).toMatch(/空调.*打开/); // Response mentions AC opened
  expect(acDevice.state).toEqual({ power: true }); // Device state updated
  expect(ttsOutput).toBeDefined(); // Audio queued
});
```

### What NOT to Test

**Don't test external services**:
- OpenAI API calls (mock instead)
- Tencent ASR/TTS (mock instead)
- Actual device communication (mock instead)

**Don't test implementation details**:
- Exact history format (test behavior)
- File I/O patterns (test persistence end result)
- Promise chains (test atomicity)

---

## Future Enhancement Opportunities

### Priority 1: Performance

**Reduce PASS 1 latency**:
- Cache skill selection if repeating same skill
- Pre-load skills based on time-of-day (morning = music, evening = game)
- Use faster model for PASS 1 (gpt-4o-mini) vs PASS 2 (gpt-4o)

**Approach**:
```typescript
// Hypothesis: User often repeats same skill
if (lastTurnSkill === 'air-conditioner') {
  skipPass1Ifpossible = true;
  // PASS 2 directly with cached skill rules
}
```

### Priority 2: Scalability

**Multi-room support**:
- Each room: separate DialogSession + agent
- Shared device registry (central list of IPs/tokens)
- Room-aware routing (automatically direct commands)

**Approach**:
```typescript
// Central registry
const deviceRegistry = {
  rooms: {
    living_room: { ac_ip: '192.168.1.51', ... },
    bedroom: { ac_ip: '192.168.1.52', ... }
  }
};

// Per-room agent
rooms['living_room'].agent = new OpenAIAgentRuntime(
  { homeAssistantContext: 'living_room' }
);
```

### Priority 3: Natural Interaction

**Conversational context**:
- Better pronoun resolution ("turn it on" → which device?)
- Implicit context ("lower it" → lower AC temp, not volume)
- Synonym understanding ("decrease" vs "lower" vs "cool down")

**Approach**:
- Expand skill rules with examples of common phrasings
- Add explicit context to tool calls (last mentioned device)

**Example SKILL.md enhancement**:
```markdown
## 常见表达
- "关空调" / "关闭" / "停机" / "别吹了" → 都表示关闭
- "升温" / "高一点" / "热一点" / "温度高" → 都表示升温
- "降温" / "低一点" / "凉快点" / "太热了" → 都表示降温

## 上文引用
如果用户说"降低它"，自动假设"它"是上文提到的空调，不需要问。
```

### Priority 4: Reliability

**Fault tolerance**:
- Retry failed device commands
- Fallback to HomeAssistant if MIOT fails
- Graceful degradation (AC offline → still respond)

**Approach**:
```typescript
async function controlAC(room, action) {
  try {
    // Try MIOT first (fast)
    return await miioClient.execute(siid, piid, value);
  } catch {
    // Fallback to HomeAssistant (slower but more reliable)
    return await homeAssistant.turnOnEntity(`climate.${room}`);
  }
}
```

### Priority 5: User Customization

**Skill templates**:
- Users can add custom skills without code changes
- Example: "Book a taxi", "Order food", "Check mail"
- Define SKILL.md + tool handler, system discovers it

**Approach**:
```
skills/
├── game/SKILL.md
├── air-conditioner/SKILL.md
├── custom-taxi/SKILL.md  ← User-added
│  └─ handler: custom-taxi.tool.ts
├── custom-food/SKILL.md  ← User-added
│  └─ handler: custom-food.tool.ts
```

### Priority 6: Analytics

**Usage insights**:
- Which skills used most?
- Which commands fail?
- Which times busiest?
- Identify bugs (repeatedly failing commands)

**Approach**:
```typescript
// Log skill usage
logger.info('skill.invoked', {
  skill: 'air-conditioner',
  action: 'set_temperature',
  success: true,
  duration: 2300
});

// Analyze patterns
SELECT skill, COUNT(*) FROM logs WHERE date = TODAY GROUP BY skill;
```

### Priority 7: Privacy

**On-device inference**:
- Run local LLM (e.g., Llama 2 7B)
- No OpenAI API calls (privacy)
- Trade-off: Lower quality (but acceptable for home)

**Approach**:
```typescript
// Use Ollama for local inference
const localModel = new OllamaClient('llama2:7b');
const response = await localModel.generate(prompt);
// vs
// const response = await openai.createChatCompletion(...);
```

**When ready**: After confirming OpenAI cost vs. local inference latency

---

## Summary: Architecture Strengths and Weaknesses

### Strengths

| Aspect | Why Strong |
|--------|-----------|
| **Modularity** | Skills are independent units, no cross-contamination |
| **Scalability** | Progressive disclosure enables 20+ skills without prompt bloat |
| **Maintainability** | Clear separation: discovery → activation → execution |
| **Observability** | State machine + events make flow visible |
| **Testability** | Layered architecture enables isolation testing |
| **Decoupling** | Dependency injection prevents tight coupling |
| **Reliability** | Multi-layer validation, atomic writes, startup recovery |

### Weaknesses

| Aspect | Why Weak | Mitigation |
|--------|---------|-----------|
| **Latency** | 2-pass inference adds 500-800ms | Use gpt-4o-mini, cache decisions |
| **Flexibility** | Xiaomi-specific (MIOT protocol) | Abstract to device registry |
| **Scalability** | Singleton services limit multi-room | Add per-room instances |
| **Privacy** | Sends all requests to OpenAI cloud | Run local LLM (future) |
| **Context** | Filters tool calls from history | Implement tool result caching |
| **Multi-user** | Not designed for shared devices | Add user identification + consent |

---

## Recommended Reading Order

For understanding this codebase:

1. **QUICK_REFERENCE.md** - Get oriented (10 min)
2. **FLOW_DIAGRAMS.md** - See two-pass pattern visually (20 min)
3. **PROJECT_ANALYSIS_COMPLETE.md** - Deep dive by component (60 min)
4. **This document** - Understand why design choices (30 min)
5. **Source code**: Start with these files in order:
   - `src/agent/skills/skill-loader.ts` (Discovery)
   - `src/agent/tools/load-skill.tool.ts` (Activation)
   - `src/agent/openai-agent-runtime.ts` (Orchestration)
   - `src/dialog/dialog-session.ts` (State machine)
   - `src/services/game-console-controller.ts` (Multi-layer validation)
   - `src/agent/tools/ac-partner-client.ts` (MIOT protocol)

