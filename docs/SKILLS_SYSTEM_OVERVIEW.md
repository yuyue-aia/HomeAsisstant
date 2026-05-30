# Skills System Overview

## What is this?

This is a **progressive disclosure skill loading system** that implements the [agentskills.io](https://agentskills.io) open standard. It allows the LLM-based home voice assistant to load domain-specific instructions on-demand, keeping the system prompt focused and token-efficient.

---

## How It Works (3 Stages)

### Stage 1: Discovery (Startup)
- **When**: When `OpenAIAgentRuntime` is instantiated
- **What**: Scans `skills/` directory for `SKILL.md` files
- **How**: `discoverSkills()` reads YAML frontmatter from each file
- **Result**: Metadata (name + description) cached in memory
- **Why**: Fast startup, minimal memory, no body content loaded yet

```
app start → new OpenAIAgentRuntime() 
  → discoverSkills() 
  → reads all frontmatter 
  → builds 【可用技能】 section
  → injects into system prompt
  → ready
```

### Stage 2: Activation (During Conversation)
- **When**: LLM detects user request matches a skill description
- **What**: LLM calls `load_skill(name: "music")`
- **How**: Tool callback reads full SKILL.md body from disk
- **Result**: LLM gets detailed instructions in context
- **Why**: Only load details when needed, saves tokens

```
user says "放一首歌" 
  → LLM sees 【可用技能】 list
  → judges this is music skill
  → calls load_skill("music")
  → gets full SKILL.md instructions
  → now has rules + tools available
```

### Stage 3: Execution
- **When**: After LLM has loaded skill instructions
- **What**: LLM calls domain-specific tools (e.g., `search_music`)
- **How**: Tools execute, results returned to LLM
- **Result**: Response synthesized and returned to user

---

## Key Components

### 1. **Skill Loader** (`src/agent/skills/skill-loader.ts`)
Handles discovery and loading of skills.

| Function | Purpose |
|----------|---------|
| `discoverSkills()` | Scan skills/, extract metadata |
| `parseFrontmatter()` | Parse YAML frontmatter (no dependencies) |
| `loadSkillBody()` | Fetch full skill instructions on-demand |
| `buildSkillsPromptSection()` | Format skill list for LLM |

### 2. **Load Skill Tool** (`src/agent/tools/load-skill.tool.ts`)
Exposes a tool that LLM can call to fetch full skill instructions.

- Tool name: `load_skill`
- Parameter: `name` (skill name)
- Returns: `{ ok, name, directory, instructions }`

### 3. **Agent Runtime** (`src/agent/openai-agent-runtime.ts`)
Orchestrates everything.

- Calls `discoverSkills()` in constructor
- Builds system prompt with skill list via `buildInstructions()`
- Creates Agent with `load_skill` tool
- Passes skill metadata to tool for lookups

---

## File Structure

```
project/
├── skills/                           ← Skill directory (default)
│   ├── music/
│   │   └── SKILL.md                 ← Contains: frontmatter + body
│   ├── reminder/
│   │   └── SKILL.md
│   ├── air-conditioner/
│   │   └── SKILL.md
│   └── game/
│       └── SKILL.md
│
└── src/agent/
    ├── skills/
    │   └── skill-loader.ts          ← Discovery & loading
    ├── tools/
    │   └── load-skill.tool.ts       ← Tool definition
    └── openai-agent-runtime.ts      ← Integration
```

---

## SKILL.md Format

```markdown
---
name: music
description: 处理"放/来首/想听/..."等点歌与音乐控制请求
---

# 音乐 Skill

## 对应工具
- `search_music`: 搜索歌曲或歌单
- `control_music_player`: 播放/控制/红心

## 决策路径

| 用户的话 | 走法 |
|---|---|
| "播放周杰伦的稻香" | search_music(...) → play_track(...) |
| "来点轻音乐" | search_music(...) → play_playlist(...) |
...
```

**Frontmatter** (lines 1-4):
- **name**: Unique identifier, must match directory name
- **description**: One-liner for LLM to decide when to load

**Body** (lines 6+):
- Detailed instructions in Markdown
- Tool mappings, decision paths, rules
- Can reference helper files in skill directory

---

## System Prompt Generation

### When
During `OpenAIAgentRuntime` constructor, before Agent creation

### How
```ts
buildInstructions() {
  const section = buildSkillsPromptSection(this.skills);
  return `${BASE_INSTRUCTIONS}\n\n${section}`;
}
```

### Result
```
你是家里的语音助手"小鱼"。...

【可用技能】
当用户请求匹配下列某个技能的描述时，先调用 load_skill 工具...

- music: 处理"放/来首/..."等点歌与音乐控制请求
- reminder: 处理"提醒我..."类请求
- air-conditioner: 处理空调相关控制
- game: 处理小朋友想玩游戏机...
```

---

## Environment Variables

### AGENT_SKILLS_DIR
- **Default**: `./skills`
- **Format**: Colon-separated paths
- **Example**: `export AGENT_SKILLS_DIR="/home/user/skills:/etc/skills"`
- **Behavior**: Scans paths in order, first match wins (allows overrides)

---

## Adding a New Skill

### Step 1: Create Directory
```bash
mkdir skills/my-skill
```

### Step 2: Create SKILL.md
```markdown
---
name: my-skill
description: One-sentence description of what this skill does
---

# My Skill

## How to Use
Detailed instructions...
```

### Step 3: Restart Agent
Skills are discovered **only at startup**. No hot-reload.

```bash
# Trigger new OpenAIAgentRuntime() constructor
# which calls discoverSkills()
```

### Step 4: Verify
Check logs for:
```
skills.discover.done count: 5 skills: [music, reminder, air-conditioner, game, my-skill]
```

---

## Important Constraints

### ✓ What Works
- Adding new SKILL.md files (after restart)
- Editing SKILL.md body (works at runtime if skill loaded)
- Multiple skill directories (via AGENT_SKILLS_DIR)
- Case-insensitive skill name matching
- Skill directory can contain helper files (scripts, refs, assets)

### ✗ What Doesn't Work
- Hot-reload of new SKILL.md files (no restart = not discovered)
- Editing frontmatter without restart (metadata not re-scanned)
- Dynamic skill registration at runtime
- Deleting SKILL.md at runtime (already cached)

---

## Timing & Lifecycle

```
T=0 (App Start)
├─ discoverSkills() → read all frontmatter
├─ buildSkillsPromptSection() → format skill list
├─ new Agent() → pass system prompt + load_skill tool
└─ App ready

T=X (User sends message)
├─ LLM reads system prompt (skill list visible)
├─ LLM judges: "This is music skill"
├─ LLM calls: load_skill("music")
├─ Callback reads: skills/music/SKILL.md body
├─ LLM receives: detailed instructions
├─ LLM calls: search_music(...), control_music_player(...)
├─ Tools execute, results returned
└─ Response synthesized

T=Y (App Restart)
├─ discoverSkills() runs again
├─ New skills detected (if added)
├─ Edited SKILL.md metadata re-parsed
└─ Fresh system prompt built
```

---

## Design Principles

### Progressive Disclosure
- **Goal**: Minimize system prompt size while maximizing capability
- **Stage 1**: Only metadata (name + description) in prompt
- **Stage 2**: Full instructions loaded on-demand
- **Benefit**: Scales well, avoids cross-domain interference, token efficient

### No Heavy Dependencies
- Frontmatter parser is hand-written
- No YAML library dependency
- Reduces supply chain risk
- Simple enough to be maintainable

### Flexible Skill Discovery
- Configurable via environment variable
- Multiple search paths supported
- Override mechanism (project skills > global skills)
- Clear logging for debugging

---

## Key Data Structures

### SkillMeta
```ts
interface SkillMeta {
  name: string;           // e.g., "music"
  description: string;    // e.g., "处理点歌请求"
  directory: string;      // e.g., "/path/to/skills/music"
  file: string;           // e.g., "/path/to/skills/music/SKILL.md"
}
```

### Load Result
```ts
{
  ok: true;
  name: string;           // skill name
  directory: string;      // path to skill directory (for assets)
  body: string;           // markdown instructions (no frontmatter)
} | {
  ok: false;
  error: string;          // error message
}
```

---

## Logging

### Discovery Events
- `skills.discover.done` - Summary with count and names
- `skills.discover.missing_frontmatter` - Invalid SKILL.md
- `skills.discover.duplicate_skipped` - Duplicate skill name
- `skills.discover.read_file_failed` - File system error

### Debug Tips
1. Check `skills/` directory exists
2. Verify SKILL.md files have correct frontmatter
3. Look for `skills.discover.done` in logs
4. Restart app after adding/editing skills
5. Check for typos in field names (exactly: `name:` and `description:`)

---

## Related Documentation

- **Full Analysis**: `SKILLS_LOADING_SYSTEM.md` - Comprehensive technical details
- **Flow Diagram**: `SKILLS_FLOW_DIAGRAM.txt` - Visual ASCII diagrams
- **Quick Reference**: `SKILLS_QUICK_REFERENCE.txt` - Checklists and troubleshooting

---

## Questions?

- How to debug? → See `SKILLS_QUICK_REFERENCE.txt` section 9-10
- How to add a skill? → See section above or Quick Reference section 1
- How does the system prompt get built? → See `System Prompt Generation` above
- What if skills don't load at runtime? → Restart the app (discovery happens at startup only)

