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

## Installation

```bash
npm install -g sapper
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
- `/step` - Toggle step-by-step mode
- `/help` - Show command help
- `exit` - Exit Sapper

### Example Interactions

```
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

## Supported Tools

- `SHELL` - Execute terminal commands
- `READ` - Read file contents
- `WRITE` - Create/edit files
- `MKDIR` - Create directories
- `LIST` - List directory contents
- `SEARCH` - Search for text in files

## Examples

**Create a Next.js project:**
```
> create a Next.js app with TypeScript and Tailwind in ./my-nextjs-app
```

**Add features to existing project:**
```
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