# Sapper

🚀 **AI-powered development assistant that executes commands and builds projects**

Sapper is a command-line interface that connects to Ollama models to help you build, manage, and execute development tasks through natural language conversations.

## Features

- 🤖 **AI-powered assistance** - Chat with local Ollama models
- 🛠️ **Multi-tool execution** - File operations, shell commands, directory management
- 💬 **Conversational interface** - Natural language project management
- 🔄 **Session persistence** - Resume previous conversations
- 🎯 **Context-aware** - Automatically detects directory contents
- ⚡ **Live streaming** - See AI responses in real-time
- 🔒 **Security prompts** - Review commands before execution
- ✍️ **Inline approval feedback** - Type feedback, or use `f` and `e` shortcuts at shell or file approval prompts, to make Sapper revise the command or change
- 🧵 **Background shell sessions** - Long-running commands can hand off to tracked background sessions with chunked output inspection

## Installation

```bash
npm install -g sapper-iq
```

Then run:

```bash
sapper
```

## Prerequisites

- Node.js 16+
- [Ollama](https://ollama.ai/) installed and running
- At least one Ollama model downloaded

## Usage

```bash
sapper
```

### Commands

- `/reset` or `/clear-session` - Start a new session
- `/session-info` - Show current session details  
- `/summary` - View or change auto-summary settings
- `/shell` - Inspect shell config and tracked background sessions
- `/shell read <id>` - Read output from a tracked shell session
- `/shell stop <id>` - Stop a tracked shell session
- `/step` - Toggle step-by-step mode
- `/help` - Show command help
- `exit` - Exit Sapper

### Example Interactions

```text
> set up a React project in ./my-app
> run the development server
> create a login component with TypeScript
> add Tailwind CSS styling
```

## How It Works

1. **Connect to Ollama** - Choose from your available local models
2. **Natural conversation** - Describe what you want to build or do
3. **AI executes tools** - Creates files, runs commands, manages projects
4. **Review & approve** - Security prompts for shell commands
5. **Context awareness** - Sapper understands your project structure

## Config

Sapper creates `.sapper/config.json` on first run. You can tune context behavior there.

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
  "prompt": {
    "prepend": "",
    "append": "Prefer concise answers.",
    "coreOverride": ""
  }
}
```

- `toolRoundLimit`: maximum tool-call rounds Sapper will allow in one prompt loop before it forces a final answer. Default: `40`.
- `summaryPhases`: show or hide the step-by-step auto-summary progress list.
- `summarizeTriggerPercent`: start summarizing older context near this percentage of the active context window. Lower values summarize earlier and reduce large-context pauses.
- `shell.streamToModel`: include shell output chunks in tool results when a command is handed off to a background session.
- `shell.backgroundMode`: three modes: `off`, `auto`, or `on`. `off` keeps commands fully attached so you keep seeing live shell output in the terminal. `auto` backgrounds likely long-running commands like dev servers; `on` applies the timeout to every shell command.
- `shell.backgroundAfterSeconds`: how long Sapper waits before handing an eligible running command off to a background shell session.
- `shell.outputChunkChars`: maximum shell output chunk size returned to the model for background handoffs and session reads.
- `thinking.mode`: three modes: `auto`, `on`, or `off`. `auto` skips long reasoning blocks for simple prompts, `on` always enables reasoning for every prompt, and `off` disables it for every prompt. This controls model reasoning visibility, not shell backgrounding.
- `streaming.showPhaseStatus`: show short status lines when Sapper is finalizing output, executing tools, or looping for the next model turn.
- `streaming.showHeartbeat`: keep updating the live progress line during quiet streamed phases instead of looking frozen.
- `streaming.idleNoticeSeconds`: print an idle notice after this many seconds without visible streamed output.
- `prompt.prepend`: insert custom instructions before the default Sapper prompt.
- `prompt.append`: add custom instructions near the end of the system prompt.
- `prompt.coreOverride`: replace the default Sapper core prompt block while keeping the tool, context, agent, and skill sections.

You can also change these inside Sapper with `/summary`, for example `/summary phases off` or `/summary trigger 60`.
Prompt config is read from `.sapper/config.json` and Sapper refreshes it on the next turn if you edit the file while it is running.
Background shell sessions are controlled through `run_shell` with `__shell_list__`, `__shell_read__ <session_id>`, and `__shell_stop__ <session_id>`.
You can also inspect them directly in Sapper with `/shell`, `/shell read <session_id>`, and `/shell stop <session_id>`.
Use `/tools` inside Sapper to inspect the built-in tool catalog and usage patterns.
Use `/git` inside Sapper to inspect repository state and access git-specific shortcuts.

## Supported Tools

- `SHELL` - Execute terminal commands
- `READ` - Read file contents
- `CAT`, `HEAD`, `TAIL` - Read full files or line windows
- `WRITE` - Create/edit files
- `PATCH` - Edit existing files with targeted replacement
- `MKDIR` - Create directories
- `RMDIR` - Remove directories with approval
- `LIST`, `LS` - List directory contents
- `SEARCH`, `GREP` - Search for text in files
- `FIND` - Find files and directories by name
- `PWD`, `CD` - Inspect or change the tool working directory
- `ASK` - Ask the user a clarifying question mid-task
- `STATUS` - Show concise git status information
- `BRANCH` - List, create, or switch branches with approval for changes
- `COMMIT` - Create git commits with approval
- `STASH` - List or manage git stashes with approval for state-changing actions
- `TAG` - List, inspect, create, or delete git tags with approval for changes
- `PUSH` - Push a branch to a remote with approval
- `CHANGES` - Show git status and diffs
- `FETCH` - Fetch web pages as readable text
- `FETCH_MAIN` - Extract the main article or body content from a web page
- `FETCH_MULTI` - Fetch multiple web pages in one call
- `MEMORY` - Search saved conversation memory
- `OPEN` - Open URLs in the default browser with approval

## Examples

**Create a Next.js project:**

```text
> create a Next.js app with TypeScript and Tailwind in ./my-nextjs-app
```

**Add features to existing project:**

```text
> analyze the codebase in ./my-project
> add a user authentication system
> create API endpoints for user management
```

## Development

```bash
git clone https://github.com/yourusername/sapper
cd sapper
npm install
chmod +x sapper.mjs
./sapper.mjs
```

## License

MIT

## Author

Ibrahim Ihsan
