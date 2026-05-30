# Skills Loading System Analysis

## Overview
This project implements a progressive disclosure skill loading system based on agentskills.io standards. Skills are discovered at startup, with metadata injected into prompts, and full instructions loaded on-demand by the LLM.

---

## 1. Physical Structure

```
skills/
  <name>/
    SKILL.md       ← YAML frontmatter + Markdown body
  music/
  reminder/
  air-conditioner/
  game/
```

Each skill is a directory containing a single `SKILL.md` file.

---

## 2. Key Files and Functions

### A. Skill Loader: `src/agent/skills/skill-loader.ts`

**Main Functions:**

1. **`discoverSkills()`** - Line 98
   - Scans skill search paths (default: `./skills/`, configurable via `AGENT_SKILLS_DIR` env var)
   - Reads only frontmatter from each SKILL.md (not full body)
   - Returns array of `SkillMeta[]` with: `{ name, description, directory, file }`
   - Logs discovered skills
   - Skips: non-directories, files without SKILL.md, incomplete frontmatter
   - Handles duplicate names (first one wins)

2. **`parseFrontmatter(content: string)`** - Line 53
   - Simple YAML parser (no third-party dependency)
   - Expects format:
     ```
     ---
     name: skill_name
     description: What this skill does in one sentence
     ---
     [Markdown body follows]
     ```
   - Returns: `{ meta: Record<string, string>, body: string }`

3. **`loadSkillBody(skills: SkillMeta[], name: string)`** - Line 163
   - Called by `load_skill` tool when LLM requests a skill
   - Looks up skill by name (case-insensitive)
   - Reads SKILL.md and extracts body (frontmatter removed)
   - Returns: `{ ok: true, name, directory, body }` or error

4. **`buildSkillsPromptSection(skills: SkillMeta[])`** - Line 194
   - Formats discovered skills into a prompt section
   - Output format:
     ```
     【可用技能】
     当用户请求匹配下列某个技能的描述时，先调用 load_skill 工具读取它的详细指令再执行。
     不要凭印象猜测技能里的规则；同一轮里同一个技能只需加载一次。

     - skill_name_1: Brief description one
     - skill_name_2: Brief description two
     ```

**Frontmatter Fields:**
- `name`: Skill identifier (must match directory name)
- `description`: One-liner for LLM to decide whether to load

---

### B. Load Skill Tool: `src/agent/tools/load-skill.tool.ts`

**Function: `createLoadSkillTool(skills: SkillMeta[])`** - Line 21
- Creates a tool that LLM can call: `load_skill(name: string)`
- Tool definition:
  - Name: `load_skill`
  - Param: `name` (required, must match 【可用技能】 list)
  - Returns: `{ ok: true, name, directory, instructions }` or error
- Uses `loadSkillBody()` from skill-loader

**Tool Parameters (Zod Schema):**
```ts
{
  name: z.string()
    .describe('Skill name to load, must match one of the names listed in 【可用技能】.')
}
```

---

### C. Agent Runtime: `src/agent/openai-agent-runtime.ts`

**Skill Integration Points:**

1. **Constructor** - Line 72
   ```ts
   this.skills = discoverSkills();  // Line 82 - One-time scan at startup
   ```

2. **`buildInstructions()`** - Line 144
   ```ts
   private buildInstructions(): string {
     const section = buildSkillsPromptSection(this.skills);
     if (!section) return BASE_INSTRUCTIONS;
     return `${BASE_INSTRUCTIONS}\n\n${section}`;  // Injected into agent instructions
   }
   ```

3. **Agent Creation** - Line 119
   - Creates agent with instructions from `buildInstructions()`
   - Includes `load_skill` tool (created at line 135)
   - Other tools included: device control, time, web search, file I/O, etc.

4. **Base Instructions** - Line 38
   - Global output format rules, tool usage guidelines
   - Skills-specific rules added via `buildSkillsPromptSection()`

---

## 3. Loading Flow (Progressive Disclosure)

### Stage 1: Discovery (Startup)
```
OpenAIAgentRuntime constructor
  ↓
discoverSkills()
  ↓
scan skills/ directory
  ↓
for each dir:
  - read SKILL.md
  - parse frontmatter only
  - collect SkillMeta[] (name + description)
  ↓
buildSkillsPromptSection(skills)
  ↓
inject "【可用技能】" section into BASE_INSTRUCTIONS
  ↓
Agent created with full instructions + skill list
```

**Result:** LLM sees skill list (one line per skill) in system prompt

### Stage 2: Activation (During Conversation)
```
User asks something
  ↓
LLM reads 【可用技能】 section, judges if load_skill is needed
  ↓
LLM calls load_skill(name: "music")
  ↓
createLoadSkillTool callback executes:
  - loadSkillBody(skills, "music")
  - reads ./skills/music/SKILL.md
  - extracts body (frontmatter removed)
  - returns full instructions to LLM
  ↓
LLM sees detailed rules, makes tool calls (e.g., search_music, control_music_player)
```

**Result:** LLM has domain-specific rules in context only when needed

### Stage 3: Execution
```
LLM calls tools with detailed skill instructions in context
  ↓
Tools execute (device control, web search, file I/O, etc.)
  ↓
Results returned to LLM
  ↓
LLM synthesizes response
```

---

## 4. Configuration

### Environment Variables
- `AGENT_SKILLS_DIR`: Colon-separated paths to skill directories (default: `./skills`)
  - Example: `export AGENT_SKILLS_DIR="/home/user/custom-skills:/etc/skills"`
  - Multiple paths supported; first skill with same name wins

### Agent Configuration
- Model: `config.openaiAgentModel`
- Base URL: `config.openaiBaseUrl`
- API Key: `config.openaiApiKey`
- See `src/config/env.ts` for full config loading

---

## 5. System Prompt Generation

### Where System Prompt is Built
**File:** `src/agent/openai-agent-runtime.ts`  
**Method:** `OpenAIAgentRuntime.buildInstructions()` (Line 144)

### How It Works
```ts
private buildInstructions(): string {
  const section = buildSkillsPromptSection(this.skills);  // ← Generates【可用技能】
  if (!section) return BASE_INSTRUCTIONS;
  return `${BASE_INSTRUCTIONS}\n\n${section}`;             // ← Concatenates
}
```

### Timing
- **Called:** During Agent creation in constructor (Line 119)
- **When:** Once per OpenAIAgentRuntime instance (not per turn)
- **Passed to:** `new Agent({ instructions: this.buildInstructions() })`

### Format of Generated Section
```
【可用技能】
当用户请求匹配下列某个技能的描述时，先调用 load_skill 工具读取它的详细指令再执行。
不要凭印象猜测技能里的规则；同一轮里同一个技能只需加载一次。

- music: 处理"放/来首/想听/..."等点歌请求
- reminder: 处理"提醒我..."类请求
- air-conditioner: 处理空调控制
- game: 处理游戏机时长管理
```

---

## 6. Skill Registration Process

### How New Skills Are Registered
1. Create directory: `skills/my-skill/`
2. Create file: `skills/my-skill/SKILL.md`
3. Add frontmatter:
   ```yaml
   ---
   name: my-skill
   description: One-sentence description of what this skill does
   ---
   # Full Instructions
   ...
   ```
4. Restart agent (skills are discovered at startup only)

### No Runtime Registration
- Skills are **not** dynamically loaded/unloaded
- No registry file needed
- No configuration needed beyond SKILL.md presence
- Reload requires agent restart

---

## 7. Entry Points

### Primary Usage
- **File:** `src/agent/openai-agent-runtime.ts`
- **Class:** `OpenAIAgentRuntime`
- **Methods:**
  - `constructor(config)` - Initializes and discovers skills
  - `run(input)` - Non-streaming execution
  - `runStream(input, onTextDelta)` - Streaming execution

### Calling Code Locations
- `src/cli/cli.ts` - CLI entry point
- `src/dialog/dialog-session.ts` - Dialog session wrapper
- `scripts/music-llm-multiturn.ts` - Test script
- `src/agent/openai-agent-runtime.ts` - Export function `runVoiceAgent()`

### Example Usage
```ts
import { OpenAIAgentRuntime } from './src/agent/openai-agent-runtime';

const runtime = new OpenAIAgentRuntime(config);
// Skills discovered automatically ↑

const output = await runtime.run({
  text: "放一首周杰伦的稻香",
  sessionId: "session-1",
  userId: "user-1"
});
```

---

## 8. Design Principles

### Progressive Disclosure
- **Stage 1:** Only skill names + descriptions in system prompt (minimal tokens)
- **Stage 2:** Full instructions loaded only when LLM requests them
- **Benefits:**
  - Keeps system prompt focused and small
  - Avoids cross-domain rule interference
  - Better token efficiency
  - Scales with more skills

### No Dependencies for Frontmatter Parsing
- Custom simple parser instead of YAML library
- Reduces supply chain risk
- Handles only 2 fields: `name`, `description`

### Conflict Resolution
- First discovered skill wins (load order from search paths)
- Allows project-level skills to override global skills

---

## 9. Example SKILL.md Structure

```markdown
---
name: music
description: 处理"放/来首/想听/..."等点歌与音乐控制请求。
---

# 音乐 Skill

对应工具：
- `search_music`：搜索歌曲
- `control_music_player`：播放/控制

## 决策路径

| 用户的话 | 走法 |
|---|---|
| "播放周杰伦的稻香" | search_music(...) → play_track(...) |
| "来点轻音乐" | search_music(..., type='playlist') → play_playlist(...) |
```

**Frontmatter:** Lines 1-4 (parsed and injected into system prompt)  
**Body:** Lines 6+ (loaded on-demand via `load_skill` tool)

---

## 10. Key Data Structures

### SkillMeta Interface
```ts
interface SkillMeta {
  name: string;              // e.g., "music"
  description: string;       // e.g., "处理点歌请求"
  directory: string;         // e.g., "/path/to/skills/music"
  file: string;              // e.g., "/path/to/skills/music/SKILL.md"
}
```

### LoadSkillBody Result
```ts
{
  ok: true;
  name: string;              // skill name
  directory: string;         // directory path (for accessing assets)
  body: string;              // markdown content (frontmatter removed)
} | {
  ok: false;
  error: string;             // error message
}
```

---

## 11. Logging and Monitoring

### Key Log Events
- `skills.discover.done` - Summary of discovered skills
- `skills.discover.duplicate_skipped` - Duplicate skill names
- `skills.discover.missing_frontmatter` - Invalid SKILL.md
- `skills.discover.read_file_failed` / `read_dir_failed` - File system errors
- `agent.run.start` / `agent.run.end` - Agent execution lifecycle
- `agent.history.loaded` / `agent.history.save_failed` - History persistence

### Log Structure
All logs use structured logging with event names and metadata (see `src/common/logger.ts`)

---

## Summary Table

| Component | Location | Timing | Purpose |
|-----------|----------|--------|---------|
| Skill Discovery | `skill-loader.ts::discoverSkills()` | Startup (constructor) | Scan skills/ and build metadata |
| Prompt Section | `skill-loader.ts::buildSkillsPromptSection()` | Agent creation | Format skill list for LLM |
| System Prompt | `openai-agent-runtime.ts::buildInstructions()` | Agent creation | Inject skills into BASE_INSTRUCTIONS |
| Load Tool | `load-skill.tool.ts::createLoadSkillTool()` | Runtime | Let LLM load full skill instructions |
| Frontmatter Parser | `skill-loader.ts::parseFrontmatter()` | Discovery + Load | Extract metadata and body from SKILL.md |
| LLM Execution | `load_skill` tool call → `loadSkillBody()` | Per turn (on-demand) | Return skill instructions to LLM |

