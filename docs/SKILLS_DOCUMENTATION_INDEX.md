# Skills System Documentation Index

This directory contains comprehensive documentation about the **Skills Loading System** - a progressive disclosure skill management system based on the agentskills.io standard.

---

## Quick Navigation

### For First-Time Users
1. **Start here**: [`SKILLS_SYSTEM_OVERVIEW.md`](SKILLS_SYSTEM_OVERVIEW.md)
   - 5-minute overview of what the system is and how it works
   - 3-stage loading process explained simply
   - Key components and design principles
   - How to add a new skill

### For Developers Implementing Skills
2. **Quick reference**: [`SKILLS_QUICK_REFERENCE.txt`](SKILLS_QUICK_REFERENCE.txt)
   - Step-by-step: how to add a new skill
   - File locations and structure
   - Environment variables
   - Common mistakes and gotchas
   - Debugging tips and logging events

### For Technical Deep Dives
3. **Full analysis**: [`SKILLS_LOADING_SYSTEM.md`](SKILLS_LOADING_SYSTEM.md)
   - Complete technical breakdown
   - All functions explained with line numbers
   - System prompt generation details
   - Skill registration process
   - Entry points and calling code locations
   - Design principles explained
   - Data structures and interfaces
   - Monitoring and logging guide

### For Visual Learners
4. **Flow diagrams**: [`SKILLS_FLOW_DIAGRAM.txt`](SKILLS_FLOW_DIAGRAM.txt)
   - ASCII flow diagrams showing:
     - Startup/initialization phase
     - Runtime/conversation phase
     - File discovery scan tree
     - Key timing markers
     - Memory and context usage pattern
     - Data structures in memory

---

## Document Matrix

| Document | Audience | Best For | Time |
|----------|----------|----------|------|
| **OVERVIEW** | Everyone | Understanding the system | 5 min |
| **QUICK REFERENCE** | Developers | Adding skills, debugging | 15 min |
| **FULL ANALYSIS** | Architects, Maintainers | Technical implementation details | 30 min |
| **FLOW DIAGRAMS** | Visual learners | Understanding data flow | 10 min |

---

## Key Facts (TL;DR)

✓ **What it is**: Progressive disclosure skill system based on agentskills.io  
✓ **Where skills live**: `skills/<name>/SKILL.md` (one file per skill)  
✓ **Frontmatter format**: Simple YAML with `name:` and `description:`  
✓ **When discovered**: At app startup (no hot-reload)  
✓ **How LLM uses skills**: System prompt contains skill list → LLM calls `load_skill()` → full instructions loaded  
✓ **Token efficiency**: Only metadata in system prompt, bodies loaded on-demand  
✓ **Configuration**: `AGENT_SKILLS_DIR` environment variable for custom paths  

---

## File Locations in Code

### Implementation Files
- `src/agent/skills/skill-loader.ts` - Discovery and loading logic
- `src/agent/tools/load-skill.tool.ts` - Tool exposed to LLM
- `src/agent/openai-agent-runtime.ts` - Integration and orchestration

### Skill Definitions
- `skills/music/SKILL.md` - Music playing and control
- `skills/reminder/SKILL.md` - Reminder management
- `skills/air-conditioner/SKILL.md` - Air conditioner control
- `skills/game/SKILL.md` - Game console time management

### Configuration
- `src/config/env.ts` - Environment variable loading
- `.env` / `.env.example` - Environment settings (includes AGENT_SKILLS_DIR)

---

## Common Tasks

### Add a New Skill
1. See: [`SKILLS_QUICK_REFERENCE.txt`](SKILLS_QUICK_REFERENCE.txt) Section 1
2. Or: [`SKILLS_SYSTEM_OVERVIEW.md`](SKILLS_SYSTEM_OVERVIEW.md) "Adding a New Skill"

### Debug Skill Loading Issues
1. See: [`SKILLS_QUICK_REFERENCE.txt`](SKILLS_QUICK_REFERENCE.txt) Sections 9-10
2. Check logs for: `skills.discover.done`, `missing_frontmatter`, `duplicate_skipped`

### Understand System Prompt Generation
1. See: [`SKILLS_SYSTEM_OVERVIEW.md`](SKILLS_SYSTEM_OVERVIEW.md) "System Prompt Generation"
2. Or: [`SKILLS_LOADING_SYSTEM.md`](SKILLS_LOADING_SYSTEM.md) Section 5

### Modify SKILL.md Format
1. See: [`SKILLS_QUICK_REFERENCE.txt`](SKILLS_QUICK_REFERENCE.txt) Section 7
2. Look at: `skills/music/SKILL.md` for examples

### Configure Custom Skill Directories
1. See: [`SKILLS_QUICK_REFERENCE.txt`](SKILLS_QUICK_REFERENCE.txt) Section 6
2. Set: `export AGENT_SKILLS_DIR="/path/to/skills:/another/path"`

---

## Key Concepts

### Progressive Disclosure
The system loads skill instructions in stages:
- **Stage 1 (Startup)**: Only metadata (name + description)
- **Stage 2 (Activation)**: Full instructions on-demand when LLM needs them
- **Benefit**: Keeps system prompt focused and token-efficient

### SKILL.md Structure
Each skill is a directory with one file: `SKILL.md`
```
---
name: skill-name
description: One-sentence description
---
# Detailed Instructions
...
```

### Discovery vs. Loading
- **Discovery**: Happens once at startup, reads all frontmatter
- **Loading**: Happens on-demand at runtime, reads body
- **Implication**: New SKILL.md files need app restart to be discovered

### System Prompt Injection
Skills are injected into the system prompt as the `【可用技能】` section:
```
【可用技能】
- skill1: description 1
- skill2: description 2
...
```

---

## Important Constraints

### ✓ Supported
- Adding new SKILL.md files (after restart)
- Editing SKILL.md body at runtime
- Multiple skill directories via `AGENT_SKILLS_DIR`
- Helper files in skill directories (scripts, assets, refs)

### ✗ Not Supported
- Hot-reload of new skills (requires restart)
- Dynamic skill registration at runtime
- Editing frontmatter without restart
- Deleting skills at runtime without reload

---

## Debugging Checklist

- [ ] Verify `skills/` directory exists
- [ ] Check SKILL.md frontmatter has exactly `name:` and `description:`
- [ ] Look for `skills.discover.done` log entry
- [ ] Restart app after adding/editing SKILL.md files
- [ ] Check `AGENT_SKILLS_DIR` environment variable is set correctly
- [ ] Ensure skill name matches directory name (usually)
- [ ] Look for error logs: `read_file_failed`, `missing_frontmatter`, `duplicate_skipped`

---

## Related Project Documentation

- Architecture: `../ARCHITECTURE.md`
- Design Patterns: `../DESIGN_PATTERNS_AND_FINDINGS.md`
- Flow Diagrams: `../FLOW_DIAGRAMS.md`
- Quick Reference: `../QUICK_REFERENCE.md`

---

## Questions & Support

For specific questions, reference:

| Question | Document | Section |
|----------|----------|---------|
| What is the skills system? | OVERVIEW | Intro |
| How do I add a skill? | QUICK REFERENCE | 1 |
| How does discovery work? | FULL ANALYSIS | 3 |
| How does system prompt get built? | OVERVIEW or FULL ANALYSIS | Section 5 |
| Why isn't my skill being discovered? | QUICK REFERENCE | 10 |
| What are the timing constraints? | QUICK REFERENCE or OVERVIEW | 8 |
| How do I configure custom skill paths? | QUICK REFERENCE | 6 |

---

## Version & Last Updated

- **Last Updated**: 2026-05-29
- **System**: Skills Loading System (agentskills.io standard)
- **Implementation**: OpenAI Agents SDK with progressive disclosure

---

**Start reading**: [`SKILLS_SYSTEM_OVERVIEW.md`](SKILLS_SYSTEM_OVERVIEW.md)
