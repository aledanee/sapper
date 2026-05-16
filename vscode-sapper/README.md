# Sapper for VS Code

**AI-powered coding assistant using local Ollama models — no accounts required.**

Sapper brings the full [Sapper CLI](https://github.com/aledanee/sapper) experience into VS Code as a native extension sidebar panel.

---

## Features

- **Chat with local AI models** via Ollama (no internet, no accounts, no sign-in)
- **File tools**: read, write, patch, list, search, find files directly from the chat
- **Shell execution**: run commands with output streamed back to the AI
- **Git integration**: see diffs and status in chat
- **Web fetch**: pull documentation or web content into context
- **Agents & Skills**: load `.sapper/agents/*.md` and `.sapper/skills/*.md` from your workspace
- **Persistent memory**: embeddings + long-memory notes survive sessions
- **Right-click integration**: "Ask Sapper about this file" in explorer and editor

---

## Requirements

- [Ollama](https://ollama.com) running locally (default: `http://127.0.0.1:11434`)
- At least one Ollama model pulled (e.g. `ollama pull llama3`)

**No VS Code account, no GitHub sign-in, no Microsoft login required.**

---

## Usage

1. Click the **🤖 Sapper** icon in the Activity Bar
2. Select an Ollama model from the dropdown
3. Start chatting — ask it to read files, write code, run commands

### Slash commands (in chat input)

| Command | Action |
|---------|--------|
| `/new` or `/clear` | Start a new session (clears context) |
| `/agent <name>` | Activate a saved agent |
| `/skill <name>` | Load a skill into context |

### Tool syntax (used automatically by the AI)

The AI uses these tool calls internally:
```
[TOOL:READ]path[/TOOL]
[TOOL:WRITE]path]content[/TOOL]
[TOOL:PATCH]path]old text|||new text[/TOOL]
[TOOL:SHELL]command[/TOOL]
[TOOL:SEARCH]pattern[/TOOL]
[TOOL:FETCH]https://url[/TOOL]
```

---

## Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `sapper.ollamaHost` | `http://127.0.0.1:11434` | Ollama server URL |
| `sapper.defaultModel` | *(empty)* | Pre-select a model on startup |
| `sapper.toolRoundLimit` | `40` | Max tool-call rounds per response |
| `sapper.autoAttach` | `true` | Auto-attach workspace context |
| `sapper.shellEnabled` | `true` | Allow shell command execution |

---

## Agents & Skills

Place markdown files in your workspace:

- `.sapper/agents/my-agent.md` — custom agent personas with frontmatter
- `.sapper/skills/my-skill.md` — reusable knowledge snippets

Frontmatter format:
```yaml
---
name: "My Agent"
description: "What this agent does"
tools: [read, write, shell]
---

# Agent instructions here...
```

---

## Privacy

Everything runs locally. No data leaves your machine. No telemetry. No accounts.

---

## License

MIT — [Ibrahim Ihsan](https://github.com/aledanee)
