<div align="center">

# Sapper

**Terminal-first AI coding assistant powered by local Ollama models.**

[![npm version](https://img.shields.io/npm/v/sapper-iq.svg?style=flat-square&color=cb3837)](https://www.npmjs.com/package/sapper-iq)
[![npm downloads](https://img.shields.io/npm/dm/sapper-iq?style=flat-square&color=cb3837)](https://www.npmjs.com/package/sapper-iq)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A516-brightgreen?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)
[![Local-first](https://img.shields.io/badge/local--first-100%25-success?style=flat-square)](#)

[Install](#installation) · [Quick Start](#quick-start) · [Commands](#commands) · [Tools](#tool-catalog) · [Voice](#voice--whisper) · [Config](#configuration)

</div>

---

Sapper is a Node.js CLI that pairs with locally-running Ollama models to act as an autonomous development agent. It reads and writes files, runs shell commands, manages git, browses the web, and now transcribes your voice — all from a single conversational loop in your terminal.

> **100% local. 100% private. Zero telemetry.** Your code, prompts, and audio never leave your machine.

---

## Table of Contents

- [Highlights](#highlights)
- [Screens](#screens)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
- [Commands](#commands)
- [Tool Catalog](#tool-catalog)
- [Voice / Whisper](#voice--whisper)
- [Agents & Skills](#agents--skills)
- [Configuration](#configuration)
- [Session Memory](#session-memory)
- [Project Layout](#project-layout)
- [Development](#development)
- [License](#license)

---

## Highlights

| | |
|---|---|
| **Local-first** | Connects to any Ollama model on your machine — no API keys, no cloud calls |
| **28+ built-in tools** | Files, shell, git, web, AST symbols, embeddings |
| **Native tool calling** | First-class support for Ollama's function-calling API, with a legacy text-marker fallback |
| **Voice input** | Talk to Sapper with Whisper (`/v live`) — interactive model picker, archive, push-to-stop, Arabic + multilingual |
| **Auto-summarization** | Compresses old turns when the context window fills, transparently |
| **Custom agents & skills** | Drop a Markdown file in `.sapper/agents/` or `.sapper/skills/` and it's live |
| **Background shell** | Long-running commands hand off to tracked background sessions you can read/stop |
| **Approval gate** | Inline approval prompts with feedback for shell and write operations |
| **Semantic memory** | Embedding-based recall surfaces relevant past context automatically |
| **Per-project state** | Everything lives in `.sapper/` — clean, portable, gitignore-friendly |

---

## Screens

### Startup Dashboard

On launch, Sapper shows the full state of your workspace before asking for input.

```
Sapper  terminal coding workspace
Local models, live tools, and focused coding in one loop
/your/project  ·  v1.1.40

Quick start  @file attach  ·  /commands palette  ·  /agents modes

┌──────────────────────────────────────────────────────────────┐
│ [workspace]  5 files  ·  0 symbols  ·  indexed 36103m ago    │
│ [memory]     .sapper/  ·  auto-attach on                     │
│ [prompt]     default prompt                                  │
│ [thinking]   mode auto                                       │
│ [tools]      limit 40 rounds                                 │
│ [shell]      stream on  ·  bg auto  ·  0 active              │
│ [stream]     heartbeat on  ·  phases on                      │
│ [summary]    phases on  ·  trigger 65%                       │
│ [voice]      whisper-cli  ·  archive on                      │
│ [agents]     3  ·  [skills]  2                               │
└──────────────────────────────────────────────────────────────┘

Previous session found in .sapper/context.json
Resume session? [y/N]
```

### Model Picker

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
```

### Live Session

```
  [model]    gemma4:e4b-mlx-bf16
  [tools]    native tool calling
  [context]  35,000 tokens  (custom limit, model: 131,072)

  [gemma4] [default] [2% ctx]
  ██░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  765 / 35,000 tokens
  >
```

The context bar updates after every turn. When usage approaches the `summarizeTriggerPercent` threshold, Sapper compresses older turns into a summary and continues — no interruption.

---

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                          SAPPER CLI                            │
│                                                                │
│   User Input  ──►  Prompt Builder  ──►  Ollama (local)         │
│      ▲                  │                    │                 │
│      │            Context / Memory      Streaming              │
│      │            Embeddings            Response               │
│      │            Agent / Skills            │                  │
│      │                  │                   ▼                  │
│      └──── Tool Parser ◄────  AI Response (native or text)     │
│                  │                                             │
│        ┌─────────┼──────────┬──────────┬────────────┐          │
│        ▼         ▼          ▼          ▼            ▼          │
│   File System  Shell    Git / Web   Voice       AST / Memory   │
│   READ WRITE   SHELL    PUSH FETCH  WHISPER     SYMBOL RECALL  │
└────────────────────────────────────────────────────────────────┘
```

---

## Prerequisites

- **[Node.js](https://nodejs.org)** ≥ 16.0.0
- **[Ollama](https://ollama.ai)** installed and running locally with at least one model
- *(optional, for voice)* **[whisper.cpp](https://github.com/ggerganov/whisper.cpp)** and **ffmpeg** — see [Voice / Whisper](#voice--whisper)

```bash
ollama pull llama3
```

---

## Installation

```bash
npm install -g sapper-iq
```

Or run it without installing:

```bash
npx sapper-iq
```

---

## Quick Start

```bash
cd /path/to/your/project
sapper
```

Pick a model, then start talking:

```
> analyze this project and tell me what it does
> add a REST endpoint for user authentication
> run the tests and fix any failures
> commit the changes with a descriptive message
```

Or use your voice:

```
> /v lang en
> /v live
🔴 Live preview — press any key to stop.
> [you speak]  →  transcript is sent to the AI
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

Run these inside Sapper at the prompt. Press `Tab` for slash-command autocomplete.

### Session

| Command | Description |
|---|---|
| `/help`, `/commands` | Show the full command palette |
| `/reset`, `/clear-session` | Start a new conversation session |
| `/session-info` | Display current session metadata |
| `/log` | View the current session activity log |
| `/attach <file>` | Attach a file to the next prompt |
| `//text` | Send literal text that starts with `/` |
| `exit` | Exit Sapper |

### Model & Tools

| Command | Description |
|---|---|
| `/model` | Switch the active Ollama model mid-session |
| `/tools` | Browse the built-in tool catalog |
| `/step` | Toggle step-by-step tool approval mode |
| `/symbol <name>` | Search for a code symbol via the AST index |

### Memory

| Command | Description |
|---|---|
| `/recall <query>` | Search semantic embeddings for past context |
| `/memory` | Inspect markdown long-memory notes |
| `/memory add <title> ::: <note> ::: <tags>` | Save a durable project note |
| `/memory search <query>` | Search markdown long-memory notes |

### Voice

| Command | Description |
|---|---|
| `/v`, `/voice` | Show voice status and settings |
| `/v live`, `/v stream` | Live preview while you speak, clean final transcript on stop |
| `/v record [seconds]` | Record from mic (push-to-stop, or fixed duration) |
| `/v talk` | Alias for push-to-stop recording |
| `/v file <path>` | Transcribe an existing audio file |
| `/v model` | Interactive picker — list available Whisper models |
| `/v lang <code>` | Lock language (e.g. `en`, `ar`, `auto`) |
| `/v archive on\|off\|open` | Toggle or reveal the recordings archive |

### Shell, UI & Summary

| Command | Description |
|---|---|
| `/shell` | Inspect shell config and tracked background sessions |
| `/shell read <id>` | Read buffered output from a background session |
| `/shell stop <id>` | Stop a tracked background shell session |
| `/git` | Inspect repository state and git shortcuts |
| `/summary` | View or change auto-summarization settings |
| `/summary trigger 60` | Set summarization trigger to 60 % of context |
| `/ui style sapper\|clean\|ultra` | Switch the frontend style |
| `/ui compact auto\|on\|off` | Responsive compact rendering |

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

## Voice / Whisper

Sapper can transcribe your voice using local [whisper.cpp](https://github.com/ggerganov/whisper.cpp). Nothing is sent to the cloud — audio and transcripts stay on your machine.

### Setup (macOS)

```bash
brew install whisper-cpp ffmpeg
mkdir -p ~/models
curl -L -o ~/models/ggml-large-v3-turbo.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
```

Then in Sapper:

```
/v model           # pick from auto-detected models
/v lang ar         # lock language for best quality (or 'en', 'auto', etc.)
/v live            # press any key to stop, transcript goes to AI
```

### Modes

| Mode | What it does |
|---|---|
| `/v live` | Streams a live preview as you speak, then runs one clean pass on the full WAV for the final transcript |
| `/v record` | Push-to-stop recording with live ticker |
| `/v record 8` | Fixed N-second capture |
| `/v file <path>` | Transcribe an existing audio file |

### Archive

Every recording is saved (when archive is on) to:

```
<project>/.sapper/voice/YYYY-MM-DD/HHMMSS-<mode>.{wav,txt}
```

Use `/v archive open` to reveal it in Finder, `/v archive off` to disable.

### Quality tips

- **Lock the language** with `/v lang <code>` — `auto` works but per-chunk detection can bleed between languages
- Use **`ggml-large-v3-turbo`** for the best speed/quality trade-off (~1.5 GB)
- `large-v3` is slower but slightly more accurate (~2.9 GB)
- Sapper auto-strips common silence hallucinations (`[BLANK_AUDIO]`, `"you"`, `"Thank you."`, subtitle credits, etc.)

---

## Agents & Skills

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

Sapper maintains three layers of memory per project — all stored locally under `.sapper/`:

| Layer | File | Purpose |
|---|---|---|
| **Short-term** | `.sapper/context.json` | Full conversation history; auto-summarized as the context window fills |
| **Semantic** | `.sapper/embeddings.json` | Chunked text with cosine-similarity recall; auto-surfaced on relevant prompts. Search with `/recall <query>` |
| **Durable** | `.sapper/long-memory.md` | Markdown project patterns, decisions, fixes. Managed with `/memory add` / `/memory search` |

Every tool call and AI turn is also logged to `.sapper/logs/session-<timestamp>.md` for auditing.

---

## Project Layout

```
.sapper/
├── config.json         runtime configuration (hot-reload, JSONC)
├── context.json        conversation history for session resume
├── embeddings.json     semantic vector memory
├── workspace.json      file index and dependency graph
├── long-memory.md      durable project notes
├── voice/              audio + transcript archive (YYYY-MM-DD/)
├── agents/             custom agents (.md + YAML frontmatter)
├── skills/             reusable skill blocks (.md + YAML frontmatter)
└── logs/               per-session activity audit logs
```

---

## Development

```bash
git clone https://github.com/aledanee/sapper.git
cd sapper
npm install
chmod +x sapper.mjs
node sapper.mjs
```

CI runs on push to `main` across Node.js 16, 18, and 20.

### Releasing

See [PUBLISHING.md](PUBLISHING.md) for the full npm release flow.

---

## License

MIT — see [LICENSE](LICENSE).

---

<div align="center">

**Built by [Ibrahim Ihsan](https://github.com/aledanee)** · [npm](https://www.npmjs.com/package/sapper-iq) · [GitHub](https://github.com/aledanee/sapper) · [Issues](https://github.com/aledanee/sapper/issues)

<sub>If Sapper saves you time, a ⭐ on GitHub means a lot.</sub>

</div>
