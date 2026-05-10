# Sapper

[![npm version](https://img.shields.io/npm/v/sapper-iq.svg?style=flat-square)](https://www.npmjs.com/package/sapper-iq)
[![Node.js](https://img.shields.io/badge/node-%3E%3D16.0.0-brightgreen?style=flat-square)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/sapper-iq?style=flat-square)](https://www.npmjs.com/package/sapper-iq)

**Terminal-first AI coding assistant for real developer workflows.**

Sapper is a Node.js CLI that connects to locally running Ollama models and acts as an autonomous development agent — reading, writing, searching, running shell commands, managing git, and browsing the web, all from a single conversational interface in your terminal.

---

## Table of Contents

- [Terminal Interface](#terminal-interface)
- [Architecture](#architecture)
- [Features](#features)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
- [Commands](#commands)
- [Tool Catalog](#tool-catalog)
- [Agents and Skills](#agents-and-skills)
- [Configuration](#configuration)
- [Session Memory](#session-memory)
- [Development](#development)
- [License](#license)

---

## Terminal Interface

Sapper presents three distinct screens during a session, each with a focused purpose.

### Startup — Session Dashboard

When Sapper launches it immediately displays the full state of the current working directory before asking for any input.

```
Sapper  terminal coding workspace
Local models, live tools, and focused coding in one loop
/your/project  ·  v1.1.38

Quick start  @file attach  ·  /commands palette  ·  /agents modes

┌──────────────────────────────────────────────────────────────┐
│ [workspace]  5 files  ·  0 symbols  ·  indexed 36103m ago    │
│ [memory]     .sapper/  ·  auto-attach on                     │
│ [prompt]     default prompt                                   │
│ [thinking]   mode auto                                        │
│ [tools]      limit 40 rounds                                  │
│ [shell]      stream on  ·  bg auto  ·  0 active              │
│ [stream]     heartbeat on  ·  phases on                       │
│ [summary]    phases on  ·  trigger 65%                        │
│ [agents]     3  ·  [skills]  2                                │
└──────────────────────────────────────────────────────────────┘

Previous session found in .sapper/context.json
Resume session? [y/N]
```

The dashboard shows workspace indexing state, memory configuration, active agents and skills count, shell mode, and context summarization trigger. If a previous session exists, Sapper offers to resume it.

---

### Model Selection — Interactive Picker

Before each session, Sapper reads the locally available Ollama models and presents an interactive picker. Models are listed with their disk footprint and last-used time.

```
Model selection  use ↑↓ or j/k, enter to confirm

> 01  gemma4:e4b-mlx-bf16              14.9 GB  ·  54m ago
  02  qwen3.6:35b-a3b-coding-nvfp4    20.4 GB  ·  9d ago
  03  gemma-4-E4B-it-heretic-GGUF      7.48 GB  ·  13d ago  ·  7.5B
  04  qwen3-14b-abliterated:q8_0      14.6 GB  ·  13d ago  ·  14.8B
  05  qwen3.5:4b-mlx-bf16              8.47 GB  ·  18d ago

Preview
  Selected   gemma4:e4b-mlx-bf16
  Footprint  14.9 GB
  Updated    54m ago
  Profile    safetensors
  Quant      default
```

Keyboard controls: `↑` `↓` or `j` / `k` to navigate, `Enter` to confirm. A live preview panel shows model metadata before committing.

---

### Active Session — Context Bar

Once a model is selected the prompt loop begins. A persistent context bar at the bottom of each turn shows token consumption against the configured limit.

```
Session

  [model]    gemma4:e4b-mlx-bf16
  [tools]    native tool calling
  [context]  35,000 tokens  (custom limit, model: 131,072)

  [gemma4] [default] [2% ctx]
  ██░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  765 / 35,000 tokens
  >
```

The bar updates after every turn. When usage approaches the configured `summarizeTriggerPercent` threshold, Sapper automatically compresses older turns into a summary and continues without interruption.

---

### .sapper/ Data Folder

All persistent state is isolated inside `.sapper/` at the root of each project, keeping your workspace clean.

```
.sapper/
├── config.json       runtime configuration (hot-reload)
├── context.json      conversation history for session resume
├── embeddings.json   semantic vector memory, cosine similarity recall
├── workspace.json    file index and dependency graph
├── agents/           custom agent definitions (.md + YAML frontmatter)
├── skills/           reusable instruction blocks (.md + YAML frontmatter)
└── logs/             per-session activity audit logs (.md)
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         SAPPER CLI                          │
│                                                             │
│   User Input  ──►  Prompt Builder  ──►  Ollama API         │
│                         │                    │             │
│                    Context / Memory      Streaming         │
│                    Embeddings            Response          │
│                    Agent / Skills            │             │
│                         │                    ▼             │
│                    Tool Parser  ◄────  AI Response         │
│                         │                                   │
│         ┌───────────────┼───────────────────┐              │
│         ▼               ▼                   ▼              │
│    File System       Shell               Git / Web         │
│  READ WRITE PATCH   SHELL SHELL(bg)   COMMIT PUSH FETCH    │
└─────────────────────────────────────────────────────────────┘
```

```
.sapper/
├── config.json        ← Runtime configuration
├── context.json       ← Conversation history
├── embeddings.json    ← Vector memory store
├── workspace.json     ← Project dependency graph
├── agents/            ← Custom agent definitions (.md)
├── skills/            ← Reusable skill definitions (.md)
└── logs/              ← Per-session activity logs (.md)
```

---

## Features

| Area | Capability |
|---|---|
| AI Integration | Connects to any local Ollama model; model picker on startup |
| Tool Execution | 28 built-in tools covering files, shell, git, and web |
| Context Management | Auto-summarization when context window approaches limit |
| Session Memory | Embedding-based semantic memory with cosine similarity recall |
| Agents & Skills | Custom `.md` agent files with YAML frontmatter and tool restrictions |
| Background Shell | Long-running commands hand off to tracked background sessions |
| Approval Gate | Prompted approval with inline feedback for shell and write operations |
| Activity Logging | Every tool call and AI turn is logged to `.sapper/logs/` |
| AST Parsing | Symbol extraction (functions, classes) with `/symbol` search |
| Streaming | Live token-by-token output with heartbeat and phase status |

---

## Prerequisites

- [Node.js](https://nodejs.org) >= 16.0.0
- [Ollama](https://ollama.ai) installed and running locally
- At least one model pulled, for example:

```bash
ollama pull llama3
```

---

## Installation

```bash
npm install -g sapper-iq
```

---

## Quick Start

```bash
sapper
```

Sapper will prompt you to select a model, then you can start conversing immediately.

```
  Model: llama3
  Working directory: /your/project

> analyze this project and list what it does
> add a REST endpoint for user authentication
> run the tests and fix any failures
> commit the changes with a descriptive message
```

---

## How It Works

```
User prompt
    │
    ▼
┌──────────────────────────────────────┐
│  1. Build system prompt              │
│     - Core instructions              │
│     - Active agent / skills          │
│     - Workspace context              │
│     - Conversation history           │
│     - Semantic memory recall         │
└──────────────────┬───────────────────┘
                   │
                   ▼
┌──────────────────────────────────────┐
│  2. Stream response from Ollama      │
│     - Parse tool calls in real time  │
│     - Execute tools as they arrive   │
│     - Feed results back to model     │
└──────────────────┬───────────────────┘
                   │
                   ▼
┌──────────────────────────────────────┐
│  3. Tool execution loop              │
│     - Approval prompts for           │
│       shell / write operations       │
│     - Inline feedback to revise      │
│     - Loop until no more tool calls  │
└──────────────────┬───────────────────┘
                   │
                   ▼
          Final answer rendered
          to terminal with syntax
          highlighting and markdown
```

---

## Commands

Run these inside Sapper at the prompt:

| Command | Description |
|---|---|
| `/help` | Show the full command palette |
| `/commands` | Alias for `/help` |
| `Tab` | Autocomplete slash commands while typing |
| `/reset` | Start a new conversation session |
| `/clear-session` | Alias for `/reset` |
| `/session-info` | Display current session metadata |
| `/summary` | View or change auto-summarization settings |
| `/summary phases off` | Hide summarization step list |
| `/summary trigger 60` | Set summarization trigger to 60 % of context |
| `/ui` | Show current frontend style and compact mode |
| `/ui style clean` | Switch to a cleaner Codex/OpenCode-like frontend style |
| `/ui style ultra` | Switch to an ultra-clean single-line frontend style |
| `/ui style sapper` | Switch back to the default Sapper frontend style |
| `/ui compact auto` | Set responsive compact rendering mode |
| `/shell` | Inspect shell config and list tracked background sessions |
| `/shell read <id>` | Read buffered output from a background session |
| `/shell stop <id>` | Stop a tracked background shell session |
| `/step` | Toggle step-by-step tool approval mode |
| `/tools` | Browse the built-in tool catalog |
| `/git` | Inspect repository state and git shortcuts |
| `/symbol <name>` | Search for a code symbol via AST index |
| `/recall <query>` | Search semantic memory for past context |
| `/memory` | Inspect markdown long-memory notes |
| `/memory add <title> ::: <note> ::: <tags>` | Save durable project notes/patterns in markdown |
| `/memory search <query>` | Search markdown long-memory notes |
| `/log` | View the current session activity log |
| `/attach <file>` | Attach a file to the next prompt |
| `//text` | Send literal text that starts with `/` |
| `exit` | Exit Sapper |

---

## Tool Catalog

### File System

| Tool | Description |
|---|---|
| `READ` | Read a file's full contents |
| `CAT` | Alias for READ |
| `HEAD` | Read the first N lines of a file |
| `TAIL` | Read the last N lines of a file |
| `WRITE` | Create or overwrite a file |
| `PATCH` | Replace a specific block of text inside an existing file |
| `MKDIR` | Create a directory tree |
| `RMDIR` | Remove a directory (requires user approval) |
| `LIST` / `LS` | List directory contents |
| `FIND` | Find files and directories by name pattern |
| `SEARCH` / `GREP` | Search file contents with regex |
| `PWD` | Show the current tool working directory |
| `CD` | Change the tool working directory |

### Shell

| Tool | Description |
|---|---|
| `SHELL` | Execute a terminal command, with optional background handoff |

### Git

| Tool | Description |
|---|---|
| `STATUS` | Show concise git status |
| `CHANGES` | Show git status and diffs |
| `BRANCH` | List, create, or switch branches (changes require approval) |
| `COMMIT` | Create a git commit (requires approval) |
| `STASH` | List or apply/drop stashes (state changes require approval) |
| `TAG` | List, inspect, create, or delete tags (changes require approval) |
| `PUSH` | Push a branch to a remote (requires approval) |

### Web

| Tool | Description |
|---|---|
| `FETCH` | Fetch a web page as plain readable text |
| `FETCH_MAIN` | Extract main article body from a web page |
| `FETCH_MULTI` | Fetch multiple URLs in one call |
| `OPEN` | Open a URL in the default browser (requires approval) |

### Interaction

| Tool | Description |
|---|---|
| `ASK` | Pause and ask the user a clarifying question mid-task |
| `MEMORY` | Search saved semantic memory from past sessions |

---

## Agents and Skills

Sapper supports custom agents and reusable skills defined as Markdown files with YAML frontmatter, stored in `.sapper/agents/` and `.sapper/skills/`.

**Example agent** — `.sapper/agents/backend.md`:

```markdown
---
name: Backend Engineer
description: Focused on API design, database queries, and server-side code
tools: [read, write, patch, shell, search, find, git]
---

You are a senior backend engineer. Prefer typed interfaces, validate inputs at boundaries,
and write efficient SQL. Always check existing patterns before introducing new abstractions.
```

Frontmatter fields:

| Field | Description |
|---|---|
| `name` | Display name for the agent |
| `description` | Short description shown in the agent picker |
| `tools` | Comma-separated list of allowed tools (restricts the default set) |
| `model` | Override the active Ollama model for this agent |

Skills follow the same format and are injected into the system prompt as reusable instruction blocks.

---

## Configuration

Sapper writes `.sapper/config.json` on first run. The file supports JSON-style comments (`//` and `/* ... */`). All fields are optional; missing values use the defaults shown below.

```json
{
  "autoAttach": true,
  "contextLimit": null,
  "toolRoundLimit": 40,
  "summaryPhases": true,
  "summarizeTriggerPercent": 65,
  "shell": {
    "streamToModel": true,
    "backgroundMode": "auto",
    "backgroundAfterSeconds": 8,
    "outputChunkChars": 4000
  },
  "thinking": {
    "mode": "auto"
  },
  "streaming": {
    "showPhaseStatus": true,
    "showHeartbeat": true,
    "idleNoticeSeconds": 4
  },
  "ui": {
    "compactMode": "auto",
    "style": "sapper"
  },
  "prompt": {
    "prepend": "",
    "append": "",
    "coreOverride": "",
    "system": {
      "core": "...",
      "nativeTools": "...",
      "legacyTools": "...",
      "importantContext": "..."
    },
    "ui": {
      "bannerTitle": "Sapper",
      "bannerSubtitle": "terminal coding workspace",
      "bannerTagline": "Model selection, live tools, and focused sessions in one loop"
    },
    "questions": {
      "resumeSession": "Resume session",
      "agentName": "\\nAgent name (lowercase, no spaces): ",
      "skillName": "\\nSkill name (lowercase, no spaces): "
    }
  }
}
```

| Key | Default | Description |
|---|---|---|
| `autoAttach` | `true` | Automatically include directory contents in context |
| `contextLimit` | `null` | Override the model's context window size in tokens |
| `toolRoundLimit` | `40` | Maximum tool-call rounds before forcing a final answer |
| `summaryPhases` | `true` | Show step list during auto-summarization |
| `summarizeTriggerPercent` | `65` | Summarize when context reaches this % of the window |
| `shell.streamToModel` | `true` | Stream shell output chunks back to the model in background mode |
| `shell.backgroundMode` | `"auto"` | `off` — always attached; `auto` — background long commands; `on` — background everything |
| `shell.backgroundAfterSeconds` | `8` | Seconds before a running command is handed off to a background session |
| `shell.outputChunkChars` | `4000` | Max chars per background shell output chunk returned to the model |
| `thinking.mode` | `"auto"` | `auto` / `on` / `off` — controls model reasoning block visibility |
| `streaming.showPhaseStatus` | `true` | Show status lines during tool execution and model turns |
| `streaming.showHeartbeat` | `true` | Update progress line during quiet streaming phases |
| `streaming.idleNoticeSeconds` | `4` | Print an idle notice after N seconds of no visible output |
| `ui.compactMode` | `"auto"` | `auto` / `on` / `off` — compact layout for smaller terminals |
| `ui.style` | `"sapper"` | `sapper` / `clean` / `ultra` — default style, clean minimal, or ultra-clean single-line frontend |
| `prompt.prepend` | `""` | Inject custom instructions before the default system prompt |
| `prompt.append` | `""` | Inject custom instructions after the default system prompt |
| `prompt.coreOverride` | `""` | Replace the core prompt block entirely (tool and context sections are preserved) |
| `prompt.system.*` | built-in text | Full system prompt sections, including core behavior, tool instructions, agent wrapper, and skill wrapper |
| `prompt.ui.*` | built-in text | Startup banner, model picker labels, unknown-command title, and other UI labels |
| `prompt.questions.*` | built-in text | Interactive confirmations and questions shown during approval, attach, agent creation, skill creation, and step mode |

Configuration is hot-reloaded — edit the file while Sapper is running and changes take effect on the next prompt turn. Prompt text is now managed from config, so you can inspect and customize the major system, UI, and question prompts directly in `.sapper/config.json`. Sapper preserves and regenerates built-in explanatory comments when it rewrites the file.

---

## Session Memory

Sapper maintains two layers of memory per project:

```
┌─────────────────────────────────────────────────────┐
│  Short-term  →  .sapper/context.json                │
│  Full conversation history for the current session  │
│  Auto-summarized as the context window fills up     │
├─────────────────────────────────────────────────────┤
│  Long-term   →  .sapper/embeddings.json             │
│  Chunked text embedded with cosine similarity       │
│  Recalled automatically on relevant prompts         │
│  Searchable manually with /recall <query>           │
├─────────────────────────────────────────────────────┤
│  Durable notes →  .sapper/long-memory.md            │
│  Markdown project patterns/decisions/fixes          │
│  Managed with /memory add, /memory search, /memory  │
└─────────────────────────────────────────────────────┘
```

All activity is also written to `.sapper/logs/session-<timestamp>.md` for auditing.

---

## Development

```bash
git clone https://github.com/aledanee/sapper.git
cd sapper
npm install
chmod +x sapper.mjs
node sapper.mjs
```

CI runs automatically on push to `main` across Node.js 16, 18, and 20.

---

## License

MIT — see [LICENSE](LICENSE)

---

**Author:** Ibrahim Ihsan  
**Package:** [sapper-iq on npm](https://www.npmjs.com/package/sapper-iq)  
**Repository:** [github.com/aledanee/sapper](https://github.com/aledanee/sapper)
