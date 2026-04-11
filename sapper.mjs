#!/usr/bin/env node
import ollama from 'ollama';
import fs from 'fs';
import { spawn } from 'child_process';
import chalk from 'chalk';
import ora from 'ora';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import * as acorn from 'acorn';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Prevent process from exiting on unhandled errors
process.on('uncaughtException', (err) => {
  console.error(chalk.red('\n❌ Uncaught exception:'), err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error(chalk.red('\n❌ Unhandled rejection:'), reason);
});

// Prevent Ctrl+C from killing the whole process
let ctrlCCount = 0;
process.on('SIGINT', () => {
  ctrlCCount++;
  if (ctrlCCount >= 3) {
    console.log(chalk.red('\nForce quitting...'));
    process.exit(1);
  }
  // Set flag to abort current stream
  abortStream = true;
  
  // Clear current line and move to new one - stops ghost output
  process.stdout.clearLine(0);
  process.stdout.cursorTo(0);
  if (ctrlCCount >= 2) {
    console.log(chalk.yellow('\n⏹️  Press Ctrl+C once more to force quit'));
  } else {
    console.log(UI.slate('\n⏹️  Stopped'));
  }
  
  // Reset terminal immediately
  resetTerminal();
  setTimeout(() => { ctrlCCount = 0; }, 2000); // Reset after 2 seconds
});

// Reset terminal state - fixes "ghost input" after shell commands or AI streaming
function resetTerminal() {
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(false); // Disable raw mode
      process.stdin.pause();           // Pause the stream
      process.stdin.resume();          // Resume to clear buffers
    } catch (e) {
      // Ignore errors if terminal is in weird state
    }
  }
}

// Initialize versioning
let CURRENT_VERSION = "1.1.0";
try {
  const pkg = JSON.parse(fs.readFileSync(join(__dirname, 'package.json'), 'utf8'));
  CURRENT_VERSION = pkg.version;
} catch (e) {}

const spinner = ora();

// ═══════════════════════════════════════════════════════════════
// SAPPER MEMORY FOLDER - All persistent data in one place
// ═══════════════════════════════════════════════════════════════
const SAPPER_DIR = '.sapper';
const CONTEXT_FILE = `${SAPPER_DIR}/context.json`;
const EMBEDDINGS_FILE = `${SAPPER_DIR}/embeddings.json`;
const WORKSPACE_FILE = `${SAPPER_DIR}/workspace.json`;
const CONFIG_FILE = `${SAPPER_DIR}/config.json`;
const AGENTS_DIR = `${SAPPER_DIR}/agents`;
const SKILLS_DIR = `${SAPPER_DIR}/skills`;
const LOGS_DIR = `${SAPPER_DIR}/logs`;
const SAPPERIGNORE_FILE = '.sapperignore';

// ═══════════════════════════════════════════════════════════════
// COMPREHENSIVE ACTIVITY LOGGER
// ═══════════════════════════════════════════════════════════════
const sessionId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const sessionLogFile = () => `${LOGS_DIR}/session-${sessionId}.md`;
const activityLog = []; // In-memory log for current session

function ensureLogsDir() {
  ensureSapperDir();
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
}

// Log entry types: user, ai, tool, system, error, file, shell, summary
function logEntry(type, data) {
  const entry = {
    timestamp: new Date().toISOString(),
    elapsed: activityLog.length > 0
      ? Date.now() - new Date(activityLog[0].timestamp).getTime()
      : 0,
    type,
    ...data
  };
  activityLog.push(entry);
  appendLogToFile(entry);
  return entry;
}

function formatElapsed(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

function appendLogToFile(entry) {
  try {
    ensureLogsDir();
    const file = sessionLogFile();
    const existed = fs.existsSync(file);

    let line = '';
    if (!existed) {
      line += `# Sapper Session Log\n`;
      line += `**Started:** ${new Date(entry.timestamp).toLocaleString()}\n`;
      line += `**Working Directory:** \`${process.cwd()}\`\n\n`;
      line += `---\n\n`;
    }

    const time = new Date(entry.timestamp).toLocaleTimeString();
    const elapsed = formatElapsed(entry.elapsed);

    switch (entry.type) {
      case 'session_start':
        line += `## 🚀 Session Started\n`;
        line += `- **Model:** \`${entry.model}\`\n`;
        line += `- **Resumed:** ${entry.resumed ? 'Yes' : 'No'}\n`;
        line += `- **Context Messages:** ${entry.contextSize}\n\n`;
        break;
      case 'user':
        line += `### 💬 User Input \`${time}\` _(+${elapsed})_\n`;
        line += `\`\`\`\n${entry.message?.substring(0, 500)}${entry.message?.length > 500 ? '\n...' : ''}\n\`\`\`\n`;
        if (entry.attachments?.length > 0) {
          line += `📎 **Attached:** ${entry.attachments.join(', ')}\n`;
        }
        line += '\n';
        break;
      case 'ai':
        line += `### 🤖 AI Response \`${time}\` _(+${elapsed})_\n`;
        line += `- **Tokens:** ~${entry.charCount} chars\n`;
        line += `- **Duration:** ${formatElapsed(entry.duration)}\n`;
        line += `- **Tools Used:** ${entry.toolCount || 0}\n`;
        if (entry.interrupted) line += `- ⚠️ **Interrupted**\n`;
        if (entry.repetitionStopped) line += `- ⚠️ **Stopped: repetitive output**\n`;
        line += `\n<details><summary>Response preview</summary>\n\n`;
        line += `${entry.preview?.substring(0, 800)}${entry.preview?.length > 800 ? '\n...' : ''}\n`;
        line += `\n</details>\n\n`;
        break;
      case 'tool':
        const statusIcon = entry.success ? '✅' : '❌';
        line += `#### 🔧 Tool: \`${entry.toolType}\` ${statusIcon} \`${time}\`\n`;
        line += `- **Target:** \`${entry.path}\`\n`;
        line += `- **Duration:** ${formatElapsed(entry.duration)}\n`;
        if (entry.resultSize) line += `- **Result Size:** ${entry.resultSize} chars\n`;
        if (entry.error) line += `- **Error:** ${entry.error}\n`;
        if (entry.userApproved !== undefined) line += `- **User Approved:** ${entry.userApproved ? 'Yes' : 'No'}\n`;
        line += '\n';
        break;
      case 'shell':
        line += `#### 🖥️ Shell Command \`${time}\`\n`;
        line += `\`\`\`bash\n${entry.command}\n\`\`\`\n`;
        line += `- **Exit Code:** ${entry.exitCode ?? 'N/A'}\n`;
        line += `- **Duration:** ${formatElapsed(entry.duration)}\n`;
        if (entry.userApproved !== undefined) line += `- **User Approved:** ${entry.userApproved ? 'Yes' : 'No'}\n`;
        line += '\n';
        break;
      case 'file':
        const fileIcon = entry.action === 'read' ? '📖' : entry.action === 'write' ? '✏️' : entry.action === 'patch' ? '🔧' : '📁';
        line += `#### ${fileIcon} File: \`${entry.action}\` \`${time}\`\n`;
        line += `- **Path:** \`${entry.path}\`\n`;
        if (entry.size) line += `- **Size:** ${entry.size} bytes\n`;
        if (entry.userApproved !== undefined) line += `- **User Approved:** ${entry.userApproved ? 'Yes' : 'No'}\n`;
        line += '\n';
        break;
      case 'system':
        line += `> ℹ️ **${entry.event}** \`${time}\` — ${entry.detail || ''}\n\n`;
        break;
      case 'error':
        line += `> ❌ **Error** \`${time}\` — \`${entry.message}\`\n\n`;
        break;
      case 'summary':
        line += `### 🧠 Context Summarized \`${time}\`\n`;
        line += `- **Before:** ${entry.before}\n`;
        line += `- **After:** ${entry.after}\n\n`;
        break;
      default:
        line += `> ${entry.type}: ${JSON.stringify(entry)}\n\n`;
    }

    fs.appendFileSync(file, line);
  } catch (e) {
    // Silent fail - logging should never break the app
  }
}

// Render the in-memory activity log to terminal with beautiful formatting
function renderActivityLog(count = 30) {
  const entries = activityLog.slice(-count);
  if (entries.length === 0) return chalk.yellow('No activity recorded yet.');

  const width = Math.min(process.stdout.columns || 80, 90);
  let output = '';

  // Header
  output += chalk.cyan.bold('\n╔' + '═'.repeat(width - 2) + '╗\n');
  output += chalk.cyan.bold('║') + chalk.white.bold('  📋 SAPPER ACTIVITY LOG').padEnd(width - 2) + chalk.cyan.bold('║\n');
  output += chalk.cyan.bold('║') + chalk.gray(`  Session: ${sessionId} | ${activityLog.length} events`).padEnd(width - 2) + chalk.cyan.bold('║\n');
  output += chalk.cyan.bold('╠' + '═'.repeat(width - 2) + '╣\n');

  for (const entry of entries) {
    const time = new Date(entry.timestamp).toLocaleTimeString();
    const elapsed = formatElapsed(entry.elapsed);
    const timeStr = chalk.gray(`${time} +${elapsed}`);

    switch (entry.type) {
      case 'session_start':
        output += chalk.cyan.bold('║') + ` 🚀 ${chalk.green.bold('SESSION START')} ${timeStr}`.padEnd(width + 30) + '\n';
        output += chalk.cyan.bold('║') + `    Model: ${chalk.cyan(entry.model)} | Context: ${entry.contextSize} msgs`.padEnd(width + 20) + '\n';
        break;
      case 'user':
        output += chalk.cyan.bold('║') + ` 💬 ${chalk.blue.bold('USER')} ${timeStr}`.padEnd(width + 30) + '\n';
        const preview = entry.message?.substring(0, 60)?.replace(/\n/g, ' ');
        output += chalk.cyan.bold('║') + `    ${chalk.white(preview)}${entry.message?.length > 60 ? chalk.gray('...') : ''}`.padEnd(width + 20) + '\n';
        if (entry.attachments?.length > 0) {
          output += chalk.cyan.bold('║') + `    📎 ${chalk.yellow(entry.attachments.join(', '))}`.padEnd(width + 20) + '\n';
        }
        break;
      case 'ai':
        const aiStatus = entry.interrupted ? chalk.yellow('⚠️ INTERRUPTED') : entry.repetitionStopped ? chalk.red('⚠️ LOOP') : chalk.green(`~${entry.charCount} chars`);
        output += chalk.cyan.bold('║') + ` 🤖 ${chalk.magenta.bold('AI')} ${timeStr} ${aiStatus}`.padEnd(width + 50) + '\n';
        output += chalk.cyan.bold('║') + `    ⏱ ${chalk.gray(formatElapsed(entry.duration))} | 🔧 ${entry.toolCount || 0} tools`.padEnd(width + 20) + '\n';
        break;
      case 'tool':
        const icon = entry.success ? chalk.green('✓') : chalk.red('✗');
        output += chalk.cyan.bold('║') + `   ${icon} ${chalk.yellow.bold(entry.toolType)} → ${chalk.white(entry.path?.substring(0, 40))} ${timeStr}`.padEnd(width + 40) + '\n';
        if (entry.error) {
          output += chalk.cyan.bold('║') + `     ${chalk.red(entry.error.substring(0, 60))}`.padEnd(width + 20) + '\n';
        }
        break;
      case 'shell':
        output += chalk.cyan.bold('║') + ` 🖥️  ${chalk.red.bold('SHELL')} ${timeStr}`.padEnd(width + 30) + '\n';
        output += chalk.cyan.bold('║') + `    ${chalk.cyan('$ ' + entry.command?.substring(0, 55))}${entry.command?.length > 55 ? chalk.gray('...') : ''}`.padEnd(width + 20) + '\n';
        output += chalk.cyan.bold('║') + `    Exit: ${entry.exitCode === 0 ? chalk.green(entry.exitCode) : chalk.red(entry.exitCode ?? '?')} | ⏱ ${chalk.gray(formatElapsed(entry.duration))}`.padEnd(width + 20) + '\n';
        break;
      case 'file':
        const fIcon = { read: '📖', write: '✏️', patch: '🔧', list: '📂', mkdir: '📁' }[entry.action] || '📄';
        output += chalk.cyan.bold('║') + `   ${fIcon} ${chalk.cyan(entry.action?.toUpperCase())} ${chalk.white(entry.path?.substring(0, 45))} ${timeStr}`.padEnd(width + 40) + '\n';
        break;
      case 'system':
        output += chalk.cyan.bold('║') + ` ℹ️  ${chalk.gray(entry.event + (entry.detail ? ': ' + entry.detail.substring(0, 50) : ''))} ${timeStr}`.padEnd(width + 30) + '\n';
        break;
      case 'error':
        output += chalk.cyan.bold('║') + ` ❌ ${chalk.red.bold('ERROR')} ${chalk.red(entry.message?.substring(0, 50))} ${timeStr}`.padEnd(width + 40) + '\n';
        break;
      case 'summary':
        output += chalk.cyan.bold('║') + ` 🧠 ${chalk.cyan.bold('SUMMARIZED')} ${entry.before} → ${entry.after} ${timeStr}`.padEnd(width + 30) + '\n';
        break;
    }
    output += chalk.cyan.bold('║') + chalk.gray('─'.repeat(width - 2)).padEnd(width - 1) + '\n';
  }

  // Footer
  output += chalk.cyan.bold('╠' + '═'.repeat(width - 2) + '╣\n');
  const stats = getSessionStats();
  output += chalk.cyan.bold('║') + `  📊 ${chalk.white(`Messages: ${stats.userMessages}↑ ${stats.aiMessages}↓`)} | ${chalk.yellow(`Tools: ${stats.toolCalls}`)} | ${chalk.red(`Shells: ${stats.shellCalls}`)} | ${chalk.cyan(`Errors: ${stats.errors}`)}`.padEnd(width + 50) + '\n';
  output += chalk.cyan.bold('║') + `  📁 Log: ${chalk.gray(sessionLogFile())}`.padEnd(width + 20) + '\n';
  output += chalk.cyan.bold('╚' + '═'.repeat(width - 2) + '╝\n');

  return output;
}

function getSessionStats() {
  return {
    userMessages: activityLog.filter(e => e.type === 'user').length,
    aiMessages: activityLog.filter(e => e.type === 'ai').length,
    toolCalls: activityLog.filter(e => e.type === 'tool').length,
    shellCalls: activityLog.filter(e => e.type === 'shell').length,
    errors: activityLog.filter(e => e.type === 'error').length,
    totalDuration: activityLog.length > 0
      ? Date.now() - new Date(activityLog[0].timestamp).getTime()
      : 0,
  };
}

// Ensure .sapper directory exists
function ensureSapperDir() {
  if (!fs.existsSync(SAPPER_DIR)) {
    fs.mkdirSync(SAPPER_DIR, { recursive: true });
  }
}

// Default .sapperignore template — created on first run
const DEFAULT_SAPPERIGNORE = `# ═══════════════════════════════════════════════════════════════
# .sapperignore — Files and folders Sapper should ignore
# Works like .gitignore: one pattern per line, # for comments
# Edit this file to customize what Sapper skips
# ═══════════════════════════════════════════════════════════════

# ── Sapper internal ──
.sapper/

# ── Dependencies ──
node_modules/
vendor/
bower_components/

# ── Build outputs ──
dist/
build/
out/
.next/
.nuxt/
.output/
.vercel/
.netlify/

# ── Environment & secrets ──
.env
.env.*
!.env.example
*.pem
*.key
*.cert

# ── Version control ──
.git/
.svn/
.hg/

# ── IDE / Editor ──
.idea/
.vscode/
*.swp
*.swo
*~

# ── OS files ──
.DS_Store
Thumbs.db
desktop.ini

# ── Caches ──
.cache/
__pycache__/
*.pyc
.pytest_cache/
.mypy_cache/

# ── Coverage & tests ──
coverage/
.nyc_output/
htmlcov/

# ── Logs ──
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*

# ── Lock files (large) ──
package-lock.json
yarn.lock
pnpm-lock.yaml
composer.lock
Gemfile.lock
Cargo.lock

# ── Compiled / binary / large ──
*.min.js
*.min.css
*.map
*.bundle.js
*.chunk.js
*.wasm
*.so
*.dylib
*.dll
*.exe
*.o
*.a
*.class
*.jar
*.war
*.zip
*.tar.gz
*.tgz
*.rar
*.7z
*.iso
*.dmg

# ── Media (large files) ──
*.mp4
*.mp3
*.avi
*.mov
*.mkv
*.wav
*.flac
*.png
*.jpg
*.jpeg
*.gif
*.bmp
*.ico
*.svg
*.webp
*.ttf
*.woff
*.woff2
*.eot
*.otf
*.pdf

# ── Database ──
*.sqlite
*.sqlite3
*.db

# ── Terraform / IaC ──
.terraform/
*.tfstate
*.tfstate.*

# ── Docker ──
*.tar

# ── Gradle / Maven ──
.gradle/
target/
`;

// Create .sapperignore if it doesn't exist (runs on startup)
function ensureSapperIgnore() {
  if (!fs.existsSync(SAPPERIGNORE_FILE)) {
    fs.writeFileSync(SAPPERIGNORE_FILE, DEFAULT_SAPPERIGNORE);
    return true; // newly created
  }
  return false;
}

// Ensure agents and skills directories exist
function ensureAgentsDirs() {
  ensureSapperDir();
  if (!fs.existsSync(AGENTS_DIR)) {
    fs.mkdirSync(AGENTS_DIR, { recursive: true });
  }
  if (!fs.existsSync(SKILLS_DIR)) {
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
  }
}

// ═══════════════════════════════════════════════════════════════
// AGENTS & SKILLS SYSTEM (with YAML frontmatter support)
// ═══════════════════════════════════════════════════════════════

// Parse YAML-like frontmatter from markdown files
// Supports: --- key: value --- blocks at the top of .md files
// Returns { meta: {}, body: string }
function parseFrontmatter(rawContent) {
  const content = rawContent.trim();
  if (!content.startsWith('---')) {
    // No frontmatter — legacy format, extract title from first # heading
    const firstLine = content.split('\n')[0].replace(/^#\s*/, '').trim();
    return {
      meta: { name: firstLine, description: firstLine },
      body: content
    };
  }

  // Find closing ---
  const endIndex = content.indexOf('---', 3);
  if (endIndex === -1) {
    // Malformed — treat entire content as body
    const firstLine = content.split('\n')[0].replace(/^#\s*/, '').replace(/^---\s*/, '').trim();
    return { meta: { name: firstLine }, body: content };
  }

  const frontmatterBlock = content.substring(3, endIndex).trim();
  const body = content.substring(endIndex + 3).trim();

  const meta = {};
  for (const line of frontmatterBlock.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.substring(0, colonIdx).trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
    let value = line.substring(colonIdx + 1).trim();

    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    // Parse arrays: [item1, item2]
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    }

    meta[key] = value;
  }

  // Ensure name fallback from body's first heading
  if (!meta.name) {
    const heading = body.match(/^#\s+(.+)/m);
    meta.name = heading ? heading[1].trim() : 'Unnamed';
  }

  return { meta, body };
}

// Map tool shorthand names from frontmatter to actual TOOL: names
const TOOL_NAME_MAP = {
  'read': 'READ',
  'write': 'WRITE',
  'edit': 'PATCH',
  'patch': 'PATCH',
  'list': 'LIST',
  'search': 'SEARCH',
  'shell': 'SHELL',
  'mkdir': 'MKDIR',
  'todo': 'LIST',   // alias — list tasks
};

function normalizeToolList(toolsValue) {
  if (!toolsValue) return null; // null = all tools allowed
  if (typeof toolsValue === 'string') {
    toolsValue = toolsValue.split(',').map(s => s.trim());
  }
  if (!Array.isArray(toolsValue)) return null;
  return toolsValue.map(t => TOOL_NAME_MAP[t.toLowerCase()] || t.toUpperCase()).filter(Boolean);
}

// Load all agents from .sapper/agents/*.md (with frontmatter support)
function loadAgents() {
  ensureAgentsDirs();
  const agents = {};
  try {
    const files = fs.readdirSync(AGENTS_DIR);
    for (const file of files) {
      if (file.endsWith('.md')) {
        const name = file.replace('.md', '').toLowerCase();
        const rawContent = fs.readFileSync(join(AGENTS_DIR, file), 'utf8');
        const { meta, body } = parseFrontmatter(rawContent);
        agents[name] = {
          name: meta.name || name,
          file,
          content: body,                              // body without frontmatter → injected into system prompt
          description: meta.description || meta.name || name,
          tools: normalizeToolList(meta.tools),        // null = all, or ['READ','WRITE',...]
          argumentHint: meta['argument-hint'] || null,
          meta,                                        // full parsed metadata
        };
      }
    }
  } catch (e) {}
  return agents;
}

// Load all skills from .sapper/skills/*.md (with frontmatter support)
function loadSkills() {
  ensureAgentsDirs();
  const skills = {};
  try {
    const files = fs.readdirSync(SKILLS_DIR);
    for (const file of files) {
      if (file.endsWith('.md')) {
        const name = file.replace('.md', '').toLowerCase();
        const rawContent = fs.readFileSync(join(SKILLS_DIR, file), 'utf8');
        const { meta, body } = parseFrontmatter(rawContent);
        skills[name] = {
          name: meta.name || name,
          file,
          content: body,
          description: meta.description || meta.name || name,
          argumentHint: meta['argument-hint'] || null,
          meta,
        };
      }
    }
  } catch (e) {}
  return skills;
}

// Create default example agent on first run
function createDefaultAgentsAndSkills() {
  ensureAgentsDirs();
  
  const defaultAgents = {
    'sapper-it': `---
name: "Sapper IT"
description: "Expert full-stack coding agent — handles web dev, architecture, debugging, DevOps, databases, APIs, and performance. Use for any coding task."
tools: [read, edit, write, list, search, shell]
---

# Sapper IT - Coding Agent

You are Sapper IT, an expert full-stack coding agent working within Sapper.

## Your Expertise
- Full-stack web development (frontend + backend)
- System architecture and design patterns
- Debugging, refactoring, and code review
- DevOps, CI/CD, and deployment
- Database design and optimization
- API development (REST, GraphQL)
- Performance optimization and security best practices

## Behavior
When the user asks for help, dive into the codebase using Sapper's tools. Read files, understand the structure, then make precise changes.

Be technical, thorough, and code-first. Always verify your changes work by running tests or builds.`,

    'writer': `---
name: "Technical Writer"
description: "Documentation and writing agent — READMEs, API docs, tutorials, guides, and code comments. Use for any writing or documentation task."
tools: [read, edit, write, list, search]
---

# Technical Writer

You are an expert technical writer within Sapper.

## Your Expertise
- API documentation and developer guides
- README files and onboarding docs
- Architecture decision records (ADRs)
- Code comments, JSDoc/TSDoc annotations
- Tutorials, how-to guides, and changelogs
- Clear, structured, audience-aware writing

## Behavior
- Always READ the code first to understand what it does before writing docs
- Use examples and code snippets in documentation
- Keep language simple and scannable
- Match the project's existing documentation style
- Prefer concise bullet points over long paragraphs

## Workflow
1. LIST the project to understand structure
2. READ key files (README, package.json, main entry points)
3. Identify what needs documenting
4. WRITE or PATCH documentation files
5. Cross-reference with existing docs for consistency`,

    'reviewer': `---
name: "Code Reviewer"
description: "Code review agent — analyzes code for bugs, security issues, performance, and best practices. Read-only: won't modify files."
tools: [read, list, search]
---

# Code Reviewer

You are a senior code reviewer within Sapper.

## Your Expertise
- Bug detection and logic errors
- Security vulnerability scanning (OWASP Top 10)
- Performance bottleneck identification
- Code style and best practices
- Architecture and design pattern review
- Dependency and import analysis

## Behavior
- You are READ-ONLY — analyze and report, never modify files
- Be specific: reference exact file paths and line numbers
- Categorize issues by severity: 🔴 Critical, 🟡 Warning, 🟢 Suggestion
- Provide the fix alongside the problem
- Check for: unused variables, error handling gaps, race conditions, SQL injection, XSS, hardcoded secrets

## Review Format
For each issue found:
\`\`\`
🔴/🟡/🟢 [Category] — file:line
  Problem: What's wrong
  Fix: How to fix it
\`\`\``
  };
  
  const defaultSkills = {
    'git-workflow': `---
name: git-workflow
description: "Git best practices — branching, commits, PRs, rebasing, conflict resolution. Use when working with version control."
argument-hint: "Describe the git operation (e.g., 'create feature branch', 'squash commits')"
---

# Git Workflow

Best practices for Git version control.

## Commit Messages
- Format: \`type(scope): description\`
- Types: feat, fix, docs, style, refactor, test, chore, perf
- Keep subject line under 72 characters
- Use imperative mood: "add feature" not "added feature"
- Examples:
  - \`feat(auth): add JWT token refresh\`
  - \`fix(api): handle null response from payment service\`
  - \`docs(readme): add deployment instructions\`

## Branching Strategy
- \`main\` — production-ready code
- \`develop\` — integration branch
- \`feature/name\` — new features
- \`fix/name\` — bug fixes
- \`hotfix/name\` — urgent production fixes

## Common Operations
| Task | Command |
|------|---------|
| New feature branch | \`git checkout -b feature/name develop\` |
| Stage specific files | \`git add file1 file2\` |
| Interactive rebase | \`git rebase -i HEAD~N\` |
| Squash last N commits | \`git rebase -i HEAD~N\` then change pick to squash |
| Undo last commit (keep changes) | \`git reset --soft HEAD~1\` |
| Stash with message | \`git stash push -m "description"\` |
| Cherry-pick a commit | \`git cherry-pick <hash>\` |

## PR Checklist
- [ ] Branch is up to date with target branch
- [ ] Tests pass
- [ ] No console.log / debug statements
- [ ] Commit messages follow convention
- [ ] Documentation updated if needed`,

    'node-project': `---
name: node-project
description: "Node.js project conventions — package.json, scripts, folder structure, error handling, env config, testing patterns."
argument-hint: "Describe what you need (e.g., 'setup express project', 'add testing')"
---

# Node.js Project Conventions

## Project Structure
\`\`\`
project/
├── src/
│   ├── index.js          # Entry point
│   ├── routes/            # Route handlers
│   ├── controllers/       # Business logic
│   ├── models/            # Data models
│   ├── middleware/         # Express middleware
│   ├── services/          # External service integrations
│   └── utils/             # Helper functions
├── tests/
│   ├── unit/
│   └── integration/
├── config/
│   └── index.js           # Environment-based config
├── .env.example
├── .gitignore
├── package.json
└── README.md
\`\`\`

## Package.json Scripts
\`\`\`json
{
  "scripts": {
    "start": "node src/index.js",
    "dev": "nodemon src/index.js",
    "test": "jest --coverage",
    "test:watch": "jest --watch",
    "lint": "eslint src/",
    "lint:fix": "eslint src/ --fix"
  }
}
\`\`\`

## Best Practices
- Use \`const\` by default, \`let\` when needed, never \`var\`
- Always handle async errors with try/catch or .catch()
- Use environment variables via dotenv, never hardcode secrets
- Validate input at API boundaries (use zod, joi, or express-validator)
- Use structured logging (pino or winston), not console.log in production
- Prefer async/await over callbacks and .then() chains
- Exit gracefully: handle SIGTERM and SIGINT`
  };
  
  let created = 0;
  for (const [name, content] of Object.entries(defaultAgents)) {
    const filePath = join(AGENTS_DIR, `${name}.md`);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, content);
      created++;
    }
  }
  for (const [name, content] of Object.entries(defaultSkills)) {
    const filePath = join(SKILLS_DIR, `${name}.md`);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, content);
      created++;
    }
  }
  return created;
}

// Build the system prompt with optional agent and skills
// Global flag — set after model selection, read in buildSystemPrompt
let _useNativeToolsFlag = false;

function buildSystemPrompt(agentContent = null, skillContents = []) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  let prompt = `You are Sapper, an intelligent AI assistant with access to the local filesystem and shell.
You can help with ANY task - coding, writing, research, planning, analysis, and more.
Adapt your personality and expertise based on the active agent role and loaded skills.

CURRENT DATE AND TIME: ${dateStr}, ${timeStr}

RULES:
1. EXPLORE FIRST: Use list and read to understand files before making changes.
2. THINK IN STEPS: Explain what you found and what you plan to do before acting.
3. BE PRECISE: When using patch, ensure the 'old_text' matches exactly.
4. VERIFY: After making changes, verify they work (run tests, check output, etc).
5. NO HALLUCINATIONS: If a file doesn't exist, don't guess its content. List the directory instead.`;

  if (_useNativeToolsFlag) {
    prompt += `

TOOLS:
You have function-calling tools available. Call them directly — do NOT use [TOOL:...] text markers.
Available tools: list_directory, read_file, search_files, write_file, patch_file, create_directory, run_shell.

PATCH TIPS:
- For patch_file, set old_text to "LINE:<number>" to replace a specific line by number (most reliable).
- Always read_file first to see exact content before using patch_file.
- If a patch fails, do NOT retry with slight variations. Switch to LINE:number mode or use write_file instead.`;
  } else {
    prompt += `

TOOL SYNTAX (use these to interact with files and system):
- [TOOL:LIST]dir[/TOOL] - List directory contents
- [TOOL:READ]file_path[/TOOL] - Read file contents
- [TOOL:SEARCH]pattern[/TOOL] - Search files for pattern
- [TOOL:WRITE]path:::content[/TOOL] - Create/overwrite file
- [TOOL:PATCH]path:::old|||new[/TOOL] - Edit existing file (exact match, trimmed, or fuzzy)
- [TOOL:PATCH]path:::LINE:number|||new text[/TOOL] - Replace a specific line by number (PREFERRED — more reliable)
- [TOOL:SHELL]command[/TOOL] - Run shell command

PATCH TIPS:
- PREFER the LINE:number mode when you know which line to change. It is much more reliable than text matching.
- Always READ the file first to see exact content before using PATCH.
- If a PATCH fails, do NOT retry with slight variations. Switch to LINE:number mode or use WRITE instead.

You MUST use the [TOOL:...][/TOOL] syntax above to perform actions. This is how you interact with the filesystem and shell - there is no other way. When you want to read a file, output [TOOL:READ]path[/TOOL] in your response. When you want to list a directory, output [TOOL:LIST].[/TOOL]. Always actually use the tools - do not just describe what you would do.
Do NOT show tool syntax as examples or documentation to the user. Only use them to perform real actions.`;
  }

  prompt += `

IMPORTANT CONTEXT:
- The current working directory is the user's project folder.
- Sapper has a built-in agent/skill system. Agents are managed via /agents, /agent create, /newagent commands - NOT by you creating files manually.
- Do NOT try to build agent frameworks, projects, or directory structures when the user mentions agents. The agent system is already built into Sapper.
- When the user asks you to do something, work within their current project directory.
- Use "." for the current directory when listing, not "/" or "agent/".

When no agent is active, you are a general-purpose assistant. When an agent role is loaded, fully adopt that role.`;

  if (agentContent) {
    prompt += `\n\n═══ ACTIVE AGENT ROLE ═══\n${agentContent}\n═══ END AGENT ROLE ═══\n\nIMPORTANT: You are now operating as the agent described above. Adopt its persona, expertise, and communication style while still having access to Sapper tools.`;
    
    // If the active agent has tool restrictions, inform the AI
    if (currentAgentTools && currentAgentTools.length > 0) {
      const allTools = ['READ', 'WRITE', 'PATCH', 'LIST', 'SEARCH', 'SHELL', 'MKDIR'];
      const forbidden = allTools.filter(t => !currentAgentTools.includes(t));
      prompt += `\n\nTOOL RESTRICTION: This agent can ONLY use these tools: ${currentAgentTools.join(', ')}.
FORBIDDEN TOOLS (DO NOT USE): ${forbidden.join(', ')}. You MUST NOT attempt to use forbidden tools. If you need a forbidden tool, tell the user you cannot perform that action with your current role.`;
    }
  }

  if (skillContents.length > 0) {
    prompt += `\n\n═══ LOADED SKILLS ═══`;
    for (const skill of skillContents) {
      prompt += `\n${skill}\n---`;
    }
    prompt += `\n═══ END SKILLS ═══\n\nUse the knowledge from the loaded skills above when relevant to the user's request.`;
  }

  return prompt;
}

// Track active agent
let currentAgent = null; // null = default Sapper, or agent name string
let currentAgentTools = null; // null = all tools allowed, or array of allowed tool names
let loadedSkills = []; // array of skill names currently loaded

// Load config (settings like autoAttach)
function loadConfig() {
  try {
    ensureSapperDir();
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (e) {}
  return { autoAttach: true, contextLimit: null }; // Default: auto-attach ON, no custom context limit
}

function saveConfig(config) {
  ensureSapperDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// Global config
let sapperConfig = loadConfig();

// Effective context length — user limit overrides model's reported size
function effectiveContextLength() {
  if (sapperConfig.contextLimit && sapperConfig.contextLimit > 0) {
    return sapperConfig.contextLimit;
  }
  return modelContextLength;
}

// ═══════════════════════════════════════════════════════════════
// WORKSPACE GRAPH - Track file relationships and summaries
// ═══════════════════════════════════════════════════════════════

function loadWorkspaceGraph() {
  try {
    ensureSapperDir();
    if (fs.existsSync(WORKSPACE_FILE)) {
      return JSON.parse(fs.readFileSync(WORKSPACE_FILE, 'utf8'));
    }
  } catch (e) {}
  return { indexed: null, files: {}, graph: {} };
}

function saveWorkspaceGraph(workspace) {
  ensureSapperDir();
  fs.writeFileSync(WORKSPACE_FILE, JSON.stringify(workspace, null, 2));
}

// Extract imports/requires from file content
function extractDependencies(content, filePath) {
  const deps = new Set();
  const ext = filePath.split('.').pop()?.toLowerCase();
  
  // JavaScript/TypeScript imports
  if (['js', 'jsx', 'ts', 'tsx', 'mjs'].includes(ext)) {
    // import ... from '...'
    const importMatches = content.matchAll(/import\s+.*?\s+from\s+['"]([^'"]+)['"]/g);
    for (const m of importMatches) deps.add(m[1]);
    
    // require('...')
    const requireMatches = content.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g);
    for (const m of requireMatches) deps.add(m[1]);
    
    // dynamic import('...')
    const dynImportMatches = content.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g);
    for (const m of dynImportMatches) deps.add(m[1]);
  }
  
  // Python imports
  if (ext === 'py') {
    const fromImports = content.matchAll(/from\s+([.\w]+)\s+import/g);
    for (const m of fromImports) deps.add(m[1]);
    
    const imports = content.matchAll(/^import\s+([.\w]+)/gm);
    for (const m of imports) deps.add(m[1]);
  }
  
  // Filter to only local imports (starting with . or no package scope)
  return Array.from(deps).filter(d => d.startsWith('.') || d.startsWith('/'));
}

// Extract exports from file
function extractExports(content, filePath) {
  const exports = new Set();
  const ext = filePath.split('.').pop()?.toLowerCase();
  
  if (['js', 'jsx', 'ts', 'tsx', 'mjs'].includes(ext)) {
    // export function/class/const name
    const namedExports = content.matchAll(/export\s+(?:function|class|const|let|var|async function)\s+(\w+)/g);
    for (const m of namedExports) exports.add(m[1]);
    
    // export { name }
    const bracketExports = content.matchAll(/export\s*\{([^}]+)\}/g);
    for (const m of bracketExports) {
      m[1].split(',').forEach(e => {
        const name = e.trim().split(/\s+as\s+/)[0].trim();
        if (name) exports.add(name);
      });
    }
    
    // export default
    if (content.includes('export default')) exports.add('default');
  }
  
  return Array.from(exports);
}

// Resolve relative import to actual file path
function resolveImportPath(importPath, fromFile) {
  if (!importPath.startsWith('.')) return null;
  
  const fromDir = dirname(fromFile);
  let resolved = join(fromDir, importPath).replace(/\\/g, '/');
  
  // Try common extensions
  const extensions = ['', '.js', '.ts', '.jsx', '.tsx', '.mjs', '/index.js', '/index.ts'];
  for (const ext of extensions) {
    const fullPath = resolved + ext;
    if (fs.existsSync(fullPath)) {
      return fullPath.replace(/^\.\//, '');
    }
  }
  return null;
}

// Build workspace graph from codebase
async function buildWorkspaceGraph(showProgress = true) {
  const workspace = { indexed: new Date().toISOString(), files: {}, graph: {} };
  
  function scanDir(dir, depth = 0) {
    if (depth > 5) return;
    
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = dir === '.' ? entry.name : `${dir}/${entry.name}`;
        
        if (entry.isDirectory()) {
          if (shouldIgnore(entry.name) || entry.name.startsWith('.')) continue;
          scanDir(fullPath, depth + 1);
        } else {
          if (shouldIgnore(fullPath) || shouldIgnore(entry.name)) continue;
          const ext = entry.name.includes('.') ? '.' + entry.name.split('.').pop() : '';
          if (!CODE_EXTENSIONS.has(ext.toLowerCase())) continue;
          
          try {
            const stats = fs.statSync(fullPath);
            if (stats.size > MAX_FILE_SIZE) continue;
            
            const content = fs.readFileSync(fullPath, 'utf8');
            const deps = extractDependencies(content, fullPath);
            const exports = extractExports(content, fullPath);
            
            // Generate brief summary (first meaningful lines)
            const lines = content.split('\n').filter(l => l.trim() && !l.trim().startsWith('//') && !l.trim().startsWith('#'));
            const summary = lines.slice(0, 3).join(' ').substring(0, 150);
            
            workspace.files[fullPath] = {
              size: stats.size,
              modified: stats.mtime.toISOString(),
              imports: deps,
              exports: exports,
              symbols: parseFileSymbols(content, fullPath), // AST-extracted symbols
              summary: summary || '(no summary)'
            };
            
            // Build dependency graph
            workspace.graph[fullPath] = [];
            for (const dep of deps) {
              const resolved = resolveImportPath(dep, fullPath);
              if (resolved) {
                workspace.graph[fullPath].push(resolved);
              }
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
  }
  
  scanDir('.');
  saveWorkspaceGraph(workspace);
  return workspace;
}

// Get related files for a given file (imports + files that import it)
function getRelatedFiles(filePath, workspace, depth = 1) {
  const related = new Set();
  
  // Direct imports
  const imports = workspace.graph[filePath] || [];
  imports.forEach(f => related.add(f));
  
  // Files that import this file (reverse lookup)
  for (const [file, deps] of Object.entries(workspace.graph)) {
    if (deps.includes(filePath)) {
      related.add(file);
    }
  }
  
  // Second level if depth > 1
  if (depth > 1) {
    const firstLevel = Array.from(related);
    for (const f of firstLevel) {
      const secondImports = workspace.graph[f] || [];
      secondImports.forEach(sf => related.add(sf));
    }
  }
  
  related.delete(filePath); // Don't include self
  return Array.from(related);
}

// Format workspace summary for AI context
function formatWorkspaceSummary(workspace) {
  const fileCount = Object.keys(workspace.files).length;
  let output = `\n📊 WORKSPACE INDEX (${fileCount} files)\n`;
  output += '═'.repeat(40) + '\n\n';
  
  // Group files by directory
  const byDir = {};
  for (const [path, info] of Object.entries(workspace.files)) {
    const dir = dirname(path) || '.';
    if (!byDir[dir]) byDir[dir] = [];
    byDir[dir].push({ path, ...info });
  }
  
  for (const [dir, files] of Object.entries(byDir)) {
    output += `📁 ${dir}/\n`;
    for (const f of files.slice(0, 10)) { // Limit per directory
      const name = f.path.split('/').pop();
      const exportList = f.exports?.length ? ` [${f.exports.slice(0, 3).join(', ')}${f.exports.length > 3 ? '...' : ''}]` : '';
      output += `   📄 ${name}${exportList}\n`;
    }
    if (files.length > 10) output += `   ... and ${files.length - 10} more\n`;
    output += '\n';
  }
  
  return output;
}

// ═══════════════════════════════════════════════════════════════
// AST PARSING - Extract symbols (functions, classes, variables)
// ═══════════════════════════════════════════════════════════════

// Parse JavaScript/TypeScript file and extract symbols
function parseFileSymbols(content, filePath) {
  const symbols = [];
  const ext = filePath.split('.').pop()?.toLowerCase();
  
  // Only parse JS/TS files with acorn
  if (!['js', 'jsx', 'ts', 'tsx', 'mjs'].includes(ext)) {
    // For other languages, use regex-based extraction
    return extractSymbolsWithRegex(content, filePath);
  }
  
  try {
    // Parse with acorn (use loose parsing to handle more syntax)
    const ast = acorn.parse(content, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      locations: true,
      allowHashBang: true,
      allowAwaitOutsideFunction: true,
      allowImportExportEverywhere: true,
      // Be lenient with errors
      onComment: () => {},
    });
    
    // Walk the AST to extract symbols
    function walk(node, parentName = null) {
      if (!node || typeof node !== 'object') return;
      
      switch (node.type) {
        case 'FunctionDeclaration':
          if (node.id?.name) {
            symbols.push({
              type: 'function',
              name: node.id.name,
              line: node.loc?.start?.line || 0,
              params: node.params?.map(p => p.name || p.left?.name || '?').join(', ') || '',
              async: node.async || false,
            });
          }
          break;
          
        case 'ClassDeclaration':
          if (node.id?.name) {
            symbols.push({
              type: 'class',
              name: node.id.name,
              line: node.loc?.start?.line || 0,
              extends: node.superClass?.name || null,
            });
            // Extract methods
            if (node.body?.body) {
              for (const member of node.body.body) {
                if (member.type === 'MethodDefinition' && member.key?.name) {
                  symbols.push({
                    type: 'method',
                    name: `${node.id.name}.${member.key.name}`,
                    line: member.loc?.start?.line || 0,
                    kind: member.kind, // 'constructor', 'method', 'get', 'set'
                  });
                }
              }
            }
          }
          break;
          
        case 'VariableDeclaration':
          for (const decl of node.declarations || []) {
            if (decl.id?.name) {
              // Check if it's a function expression or arrow function
              const init = decl.init;
              if (init?.type === 'ArrowFunctionExpression' || init?.type === 'FunctionExpression') {
                symbols.push({
                  type: 'function',
                  name: decl.id.name,
                  line: node.loc?.start?.line || 0,
                  params: init.params?.map(p => p.name || p.left?.name || '?').join(', ') || '',
                  async: init.async || false,
                  arrow: init.type === 'ArrowFunctionExpression',
                });
              } else {
                symbols.push({
                  type: 'variable',
                  name: decl.id.name,
                  line: node.loc?.start?.line || 0,
                  kind: node.kind, // 'const', 'let', 'var'
                });
              }
            }
          }
          break;
          
        case 'ExportNamedDeclaration':
          if (node.declaration) {
            walk(node.declaration, parentName);
          }
          break;
          
        case 'ExportDefaultDeclaration':
          if (node.declaration) {
            if (node.declaration.id?.name) {
              symbols.push({
                type: node.declaration.type === 'ClassDeclaration' ? 'class' : 'function',
                name: node.declaration.id.name,
                line: node.loc?.start?.line || 0,
                exported: 'default',
              });
            }
          }
          break;
      }
      
      // Recursively walk children
      for (const key in node) {
        if (key === 'loc' || key === 'range') continue;
        const child = node[key];
        if (Array.isArray(child)) {
          child.forEach(c => walk(c, parentName));
        } else if (child && typeof child === 'object') {
          walk(child, parentName);
        }
      }
    }
    
    walk(ast);
    
  } catch (e) {
    // If AST parsing fails, fall back to regex
    return extractSymbolsWithRegex(content, filePath);
  }
  
  return symbols;
}

// Fallback: extract symbols using regex (for non-JS or when AST fails)
function extractSymbolsWithRegex(content, filePath) {
  const symbols = [];
  const lines = content.split('\n');
  const ext = filePath.split('.').pop()?.toLowerCase();
  
  // JavaScript/TypeScript patterns
  if (['js', 'jsx', 'ts', 'tsx', 'mjs'].includes(ext)) {
    const funcPattern = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/g;
    const classPattern = /(?:export\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?/g;
    const arrowPattern = /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g;
    const methodPattern = /^\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/gm;
    
    let match;
    while ((match = funcPattern.exec(content))) {
      const line = content.substring(0, match.index).split('\n').length;
      symbols.push({ type: 'function', name: match[1], line });
    }
    while ((match = classPattern.exec(content))) {
      const line = content.substring(0, match.index).split('\n').length;
      symbols.push({ type: 'class', name: match[1], line, extends: match[2] });
    }
    while ((match = arrowPattern.exec(content))) {
      const line = content.substring(0, match.index).split('\n').length;
      symbols.push({ type: 'function', name: match[1], line, arrow: true });
    }
  }
  
  // Python patterns
  if (ext === 'py') {
    const funcPattern = /^(?:async\s+)?def\s+(\w+)\s*\(/gm;
    const classPattern = /^class\s+(\w+)(?:\s*\([^)]*\))?:/gm;
    
    let match;
    while ((match = funcPattern.exec(content))) {
      const line = content.substring(0, match.index).split('\n').length;
      symbols.push({ type: 'function', name: match[1], line });
    }
    while ((match = classPattern.exec(content))) {
      const line = content.substring(0, match.index).split('\n').length;
      symbols.push({ type: 'class', name: match[1], line });
    }
  }
  
  // Java/C#/Go patterns
  if (['java', 'cs', 'go'].includes(ext)) {
    const funcPattern = /(?:public|private|protected|static|func)?\s*(?:\w+\s+)?(\w+)\s*\([^)]*\)\s*(?:throws\s+\w+\s*)?\{/g;
    const classPattern = /(?:public\s+)?(?:class|struct|interface)\s+(\w+)/g;
    
    let match;
    while ((match = funcPattern.exec(content))) {
      const line = content.substring(0, match.index).split('\n').length;
      if (!['if', 'for', 'while', 'switch', 'catch'].includes(match[1])) {
        symbols.push({ type: 'function', name: match[1], line });
      }
    }
    while ((match = classPattern.exec(content))) {
      const line = content.substring(0, match.index).split('\n').length;
      symbols.push({ type: 'class', name: match[1], line });
    }
  }
  
  return symbols;
}

// Search for symbol across workspace
function searchSymbol(query, workspace) {
  const results = [];
  const queryLower = query.toLowerCase();
  
  for (const [filePath, fileInfo] of Object.entries(workspace.files)) {
    if (!fileInfo.symbols) continue;
    
    for (const symbol of fileInfo.symbols) {
      if (symbol.name.toLowerCase().includes(queryLower)) {
        results.push({
          ...symbol,
          file: filePath,
          score: symbol.name.toLowerCase() === queryLower ? 100 : 
                 symbol.name.toLowerCase().startsWith(queryLower) ? 80 : 50
        });
      }
    }
  }
  
  // Sort by score (exact match first) then by name
  results.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return results;
}

// Format symbol for display
function formatSymbol(symbol) {
  const icon = symbol.type === 'function' ? '𝑓' : 
               symbol.type === 'class' ? '◆' :
               symbol.type === 'method' ? '○' :
               symbol.type === 'variable' ? '◇' : '•';
  
  let desc = `${icon} ${symbol.name}`;
  if (symbol.params !== undefined) desc += `(${symbol.params})`;
  if (symbol.async) desc = 'async ' + desc;
  if (symbol.extends) desc += ` extends ${symbol.extends}`;
  
  return desc;
}

// ═══════════════════════════════════════════════════════════════
// EMBEDDINGS & SEMANTIC SEARCH
// ═══════════════════════════════════════════════════════════════

// Load or create embeddings store
function loadEmbeddings() {
  try {
    ensureSapperDir();
    if (fs.existsSync(EMBEDDINGS_FILE)) {
      return JSON.parse(fs.readFileSync(EMBEDDINGS_FILE, 'utf8'));
    }
  } catch (e) {}
  return { chunks: [] }; // { chunks: [{ text, embedding, timestamp }] }
}

function saveEmbeddings(embeddings) {
  ensureSapperDir();
  fs.writeFileSync(EMBEDDINGS_FILE, JSON.stringify(embeddings, null, 2));
}

// Get embedding from Ollama (returns null silently if model not available)
async function getEmbedding(text, model = 'nomic-embed-text') {
  try {
    const response = await ollama.embeddings({ model, prompt: text });
    return response.embedding;
  } catch (e) {
    // Silently return null - caller handles missing embeddings
    return null;
  }
}

// Cosine similarity between two vectors
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dotProduct = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Find most relevant chunks for a query
async function findRelevantContext(query, embeddings, topK = 3) {
  const queryEmbedding = await getEmbedding(query);
  if (!queryEmbedding || embeddings.chunks.length === 0) return [];
  
  const scored = embeddings.chunks.map(chunk => ({
    ...chunk,
    score: cosineSimilarity(queryEmbedding, chunk.embedding)
  }));
  
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).filter(c => c.score > 0.5); // Only return if similarity > 0.5
}

// Add text to embeddings store
async function addToEmbeddings(text, embeddings) {
  const embedding = await getEmbedding(text);
  if (embedding) {
    embeddings.chunks.push({
      text: text.substring(0, 2000), // Limit stored text
      embedding,
      timestamp: Date.now()
    });
    // Keep only last 100 chunks
    if (embeddings.chunks.length > 100) {
      embeddings.chunks = embeddings.chunks.slice(-100);
    }
    saveEmbeddings(embeddings);
  }
}

// ═══════════════════════════════════════════════════════════════
// SMART CONTEXT SUMMARIZATION
// ═══════════════════════════════════════════════════════════════

async function autoSummarizeContext(messages, model, force = false) {
  // Use real token-based threshold if we know the model's context length
  const estimatedTokens = estimateMessagesTokens(messages);
  const contextSize = JSON.stringify(messages).length;
  
  // Summarize when we hit 75% of effective context window (leave room for response)
  const ctxLen = effectiveContextLength();
  const tokenThreshold = ctxLen ? Math.floor(ctxLen * 0.75) : 8000;
  // Also keep the old byte-based check as a fallback
  const shouldSummarize = (ctxLen && estimatedTokens > tokenThreshold) || 
                          (!ctxLen && contextSize > 32000);
  
  if ((!force && !shouldSummarize) || messages.length <= 5) return messages;

  const usagePercent = ctxLen 
    ? Math.round((estimatedTokens / ctxLen) * 100)
    : Math.round((contextSize / 32000) * 100);

  console.log();
  console.log(box(
    `Context: ~${chalk.red.bold(estimatedTokens.toLocaleString())} tokens / ${chalk.white(ctxLen ? ctxLen.toLocaleString() : '?')} max (${chalk.red.bold(usagePercent + '%')})\n` +
    `${chalk.gray(`${messages.length} messages, ${Math.round(contextSize / 1024)}KB raw`)}\n` +
    `${chalk.cyan('Auto-summarizing to stay within context window...')}`,
    '🧠 Context Window Management', 'cyan'
  ));

  const summarySpinner = ora('Summarizing conversation...').start();

  // Separate: system prompt, messages to summarize, recent messages to keep
  const systemPrompt = messages[0];
  const recentCount = 4;
  let recentMessages = messages.slice(-recentCount);
  let oldMessages = messages.slice(1, -recentCount);

  // Smart selection: ensure we keep at least one tool-usage example in recent messages
  // This prevents the AI from "forgetting" how to use tools after summarization
  const hasToolExample = recentMessages.some(m => 
    m.role === 'assistant' && m.content.includes('[TOOL:') && m.content.includes('[/TOOL]')
  );
  if (!hasToolExample) {
    // Search backwards for the most recent assistant message that used tools
    for (let i = messages.length - recentCount - 1; i >= 1; i--) {
      if (messages[i].role === 'assistant' && messages[i].content.includes('[TOOL:') && messages[i].content.includes('[/TOOL]')) {
        // Include this tool-usage message and the user message before it + tool result after it
        const toolExampleMessages = [];
        if (i > 0 && messages[i - 1].role === 'user') toolExampleMessages.push(messages[i - 1]);
        toolExampleMessages.push(messages[i]);
        if (i + 1 < messages.length - recentCount && messages[i + 1].role === 'user' && messages[i + 1].content.startsWith('RESULT')) {
          toolExampleMessages.push(messages[i + 1]);
        }
        // Remove these from oldMessages and prepend to recentMessages
        const toolExampleIndices = new Set();
        for (let j = Math.max(1, i - 1); j <= Math.min(i + 1, messages.length - recentCount - 1); j++) {
          if (toolExampleMessages.includes(messages[j])) toolExampleIndices.add(j);
        }
        oldMessages = messages.slice(1, -recentCount).filter((_, idx) => !toolExampleIndices.has(idx + 1));
        recentMessages = [...toolExampleMessages, ...recentMessages];
        break;
      }
    }
  }

  if (oldMessages.length < 2) {
    summarySpinner.stop();
    return messages; // Nothing meaningful to summarize
  }

  // Build a condensed version of old messages for the summary request
  const conversationText = oldMessages
    .filter(m => m.role !== 'system')
    .map(m => {
      const role = m.role === 'user' ? 'User' : 'Assistant';
      // Truncate very long messages (file contents, scan results, etc.)
      const text = m.content.length > 1500
        ? m.content.substring(0, 1500) + '\n... [truncated]'
        : m.content;
      return `${role}: ${text}`;
    })
    .join('\n\n');

  try {
    const summaryResponse = await ollama.chat({
      model,
      ...(effectiveContextLength() ? { options: { num_ctx: effectiveContextLength() } } : {}),
      messages: [
        {
          role: 'system',
          content: `You are a conversation summarizer for an AI coding agent called Sapper. Produce a concise but thorough summary of the conversation below. Include:
- Key topics discussed and decisions made
- Files that were read, created, or modified (with paths)
- Important code changes or bugs found
- Any pending tasks or open questions
- Technical details that would be needed to continue the conversation
- Which tools were used (LIST, READ, WRITE, PATCH, SHELL, SEARCH) and on what files
- The active agent role (if any) and loaded skills
- Any tool usage patterns or workflows that were established

CRITICAL: The AI assistant uses tools with syntax like [TOOL:READ]path[/TOOL]. Make sure to note which tools were used so the assistant remembers to keep using them after this summary.

Output ONLY the summary, no preamble. Keep it under 800 words. Use bullet points.`
        },
        {
          role: 'user',
          content: `Summarize this conversation:\n\n${conversationText}`
        }
      ],
      stream: false
    });

    const summary = summaryResponse.message.content;

    // Save old messages to embeddings before discarding
    const embeddings = loadEmbeddings();
    const textToEmbed = oldMessages
      .filter(m => m.role !== 'system')
      .map(m => m.content.substring(0, 500))
      .join('\n---\n');

    if (textToEmbed.length > 50) {
      try {
        const embedding = await getEmbedding(textToEmbed);
        if (embedding) {
          embeddings.chunks.push({
            text: textToEmbed.substring(0, 2000),
            embedding,
            timestamp: Date.now()
          });
          if (embeddings.chunks.length > 100) {
            embeddings.chunks = embeddings.chunks.slice(-100);
          }
          saveEmbeddings(embeddings);
        }
      } catch (e) {
        // Silently skip embedding if model not available
      }
    }

    // Build agent role reminder if an agent is active
    const agentReminder = currentAgent ? `\nNote: You are currently operating as the "${currentAgent}" agent. Stay in character.` : '';
    const skillReminder = loadedSkills.length > 0 ? `\nLoaded skills: ${loadedSkills.join(', ')}. Apply this knowledge when relevant.` : '';

    // Rebuild messages: system prompt + summary + tool reinforcement + recent messages
    const newMessages = [
      systemPrompt,
      {
        role: 'user',
        content: `[CONVERSATION SUMMARY - auto-generated]\n${summary}\n[END SUMMARY]\n\nUse this summary as context for our ongoing conversation. Continue using your tools (LIST, READ, WRITE, PATCH, SHELL, SEARCH) as needed.${agentReminder}${skillReminder}`
      },
      {
        role: 'assistant',
        content: _useNativeToolsFlag
          ? `Understood. I have the conversation summary and will continue helping you. I'll use my tools (list_directory, read_file, write_file, patch_file, search_files, run_shell) as needed.\n\nWhat would you like me to do next?`
          : `Understood. I have the conversation summary and will continue helping you. I'll keep using my tools to explore files, make changes, and run commands as needed:\n- [TOOL:LIST] to browse directories\n- [TOOL:READ] to read files\n- [TOOL:WRITE] to create/overwrite files\n- [TOOL:PATCH] to edit existing files\n- [TOOL:SEARCH] to find patterns\n- [TOOL:SHELL] to run commands\n\nWhat would you like me to do next?`
      },
      ...recentMessages
    ];

    // Save immediately
    ensureSapperDir();
    fs.writeFileSync(CONTEXT_FILE, JSON.stringify(newMessages, null, 2));

    const newSize = JSON.stringify(newMessages).length;
    const newTokens = estimateMessagesTokens(newMessages);
    summarySpinner.stop();
    console.log(chalk.green(`✅ Summarized! ~${chalk.white(estimatedTokens.toLocaleString())} → ~${chalk.white(newTokens.toLocaleString())} tokens (${messages.length} → ${newMessages.length} messages)`));
    if (ctxLen) {
      const newPercent = Math.round((newTokens / ctxLen) * 100);
      console.log(chalk.gray(`   📊 Context window usage: ${newPercent}% of ${ctxLen.toLocaleString()} tokens`));
    }
    if (embeddings.chunks.length > 0) {
      console.log(chalk.gray(`   🧠 Old context saved to memory (${embeddings.chunks.length} memories)`));
    }
    logEntry('summary', {
      before: `~${estimatedTokens.toLocaleString()} tokens / ${messages.length} msgs`,
      after: `~${newTokens.toLocaleString()} tokens / ${newMessages.length} msgs`
    });
    console.log();

    return newMessages;
  } catch (e) {
    summarySpinner.stop();
    console.log(chalk.yellow(`⚠️  Auto-summary failed: ${e.message}`));
    console.log(chalk.gray('   Tip: Use /prune to manually reduce context.\n'));
    return messages; // Return unchanged on failure
  }
}

// ═══════════════════════════════════════════════════════════════
// FANCY UI HELPERS
// ═══════════════════════════════════════════════════════════════

const UI = {
  accent: chalk.hex('#7cc4ff'),
  accentSoft: chalk.hex('#b8d9ff'),
  mint: chalk.hex('#9ad7b3'),
  gold: chalk.hex('#d8bc7a'),
  coral: chalk.hex('#de9d8f'),
  slate: chalk.hex('#8a95a6'),
  ink: chalk.hex('#e6ebf2'),
};

const BOX_TONES = {
  cyan: UI.accent,
  green: UI.mint,
  yellow: UI.gold,
  red: UI.coral,
  magenta: chalk.hex('#b7b9ff'),
  gray: UI.slate,
  blue: chalk.hex('#8fb6ff'),
};

const BADGE_STYLES = {
  info: UI.accent,
  success: UI.mint,
  warning: UI.gold,
  error: UI.coral,
  action: chalk.hex('#9bbcff'),
  neutral: UI.slate,
};

const ANSI_PATTERN = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g;

function stripAnsi(value = '') {
  return String(value).replace(ANSI_PATTERN, '');
}

function visibleLength(value = '') {
  return stripAnsi(value).length;
}

function terminalWidth(max = 98) {
  return Math.max(48, Math.min(max, process.stdout.columns || 88));
}

function toneColor(tone = 'cyan') {
  return BOX_TONES[tone] || chalk.cyan;
}

function padAnsi(value = '', width = 0) {
  return `${value}${' '.repeat(Math.max(0, width - visibleLength(value)))}`;
}

function formatBytes(bytes = 0) {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;

  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  const precision = size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(precision)} ${units[unitIndex]}`;
}

function formatRelativeTime(value) {
  if (!value) return 'unknown';

  const delta = Math.max(0, Date.now() - new Date(value).getTime());
  const units = [
    ['d', 24 * 60 * 60 * 1000],
    ['h', 60 * 60 * 1000],
    ['m', 60 * 1000],
  ];

  for (const [label, size] of units) {
    const amount = Math.floor(delta / size);
    if (amount >= 1) return `${amount}${label} ago`;
  }

  return 'just now';
}

const BANNER = [
  `${chalk.hex('#c8ecff').bold('Sapper')} ${UI.slate('terminal workspace')}`,
  UI.slate('Local models, live tools, and focused coding in one loop')
].join('\n');

function box(content, title = '', tone = 'cyan', options = {}) {
  const width = Math.max(28, Math.min(options.width || terminalWidth(72), terminalWidth(72)));
  const header = title ? `${toneColor(tone).bold(title)}\n${divider('─', tone, width)}\n` : '';
  return `${header}${String(content ?? '')}\n${divider('─', tone, width)}`;
}

function divider(char = '─', tone = 'gray', width = terminalWidth(70)) {
  return toneColor(tone)(char.repeat(Math.max(12, width)));
}

function sectionTitle(title, subtitle = '', tone = 'cyan') {
  return `${toneColor(tone).bold(title)}${subtitle ? ` ${UI.slate(subtitle)}` : ''}`;
}

function statusBadge(text, type = 'info') {
  const badge = BADGE_STYLES[type] || BADGE_STYLES.info;
  return badge(`[${text}]`);
}

function keyValue(label, value, width = 12) {
  return `${padAnsi(UI.slate(label), width)} ${value}`;
}

function commandRow(command, description, width = 18) {
  return `${padAnsi(UI.accent(command), width)} ${UI.slate('—')} ${UI.ink(description)}`;
}

function meter(current = 0, total = 0, width = 20) {
  if (!total || total <= 0) return UI.slate('░'.repeat(width));

  const ratio = Math.max(0, Math.min(1, current / total));
  const filled = Math.round(ratio * width);
  const colorFn = ratio >= 0.85 ? toneColor('red') : ratio >= 0.65 ? toneColor('yellow') : toneColor('green');
  return `${colorFn('█'.repeat(filled))}${UI.slate('░'.repeat(Math.max(0, width - filled)))}`;
}

function ellipsis(text = '', max = 48) {
  const plain = String(text);
  if (plain.length <= max) return plain;
  return `${plain.slice(0, Math.max(0, max - 1))}…`;
}

function promptShell(label, detail = '') {
  return `${UI.slate(label)}${detail ? `\n${detail}` : ''}\n${UI.accent('› ')} `;
}

function confirmPrompt(label, type = 'warning') {
  const colors = {
    info: UI.accent,
    success: UI.mint,
    warning: UI.gold,
    error: UI.coral,
    action: chalk.hex('#8fb6ff'),
    neutral: UI.slate,
  };
  const colorFn = colors[type] || UI.gold;
  return colorFn(`\n${label}? `) + UI.slate('[y/N] ');
}

// Configure marked with terminal renderer
marked.use(markedTerminal({
    code: chalk.cyan,
    blockquote: chalk.gray.italic,
    html: chalk.gray,
    heading: chalk.bold.cyan,
    firstHeading: chalk.bold.cyan,
    table: chalk.white,
    tableOptions: {
      chars: {
        top: '─', 'top-mid': '┬', 'top-left': '┌', 'top-right': '┐',
        bottom: '─', 'bottom-mid': '┴', 'bottom-left': '└', 'bottom-right': '┘',
        left: '│', 'left-mid': '├', mid: '─', 'mid-mid': '┼',
        right: '│', 'right-mid': '┤', middle: '│'
      },
      style: { head: ['cyan', 'bold'], border: ['gray'] }
    },
    paragraph: chalk.white,
    strong: chalk.bold.white,
    em: chalk.italic,
    codespan: chalk.cyan,
    del: chalk.strikethrough,
    link: chalk.underline.blue,
    href: chalk.gray,
    showSectionPrefix: true,
    reflowText: true,
    width: Math.min(process.stdout.columns || 80, 120)
}));

// Render markdown to terminal
function renderMarkdown(text) {
  try {
    return marked(text).trim();
  } catch (e) {
    return text; // Fallback to raw text
  }
}

let stepMode = false;
let debugMode = false; // Toggle with /debug command
let abortStream = false; // Flag to interrupt AI response

// ═══════════════════════════════════════════════════════════════
// REAL CONTEXT WINDOW TRACKING
// ═══════════════════════════════════════════════════════════════
let modelContextLength = null;  // Detected from ollama.show() model_info
let lastPromptTokens = 0;      // prompt_eval_count from last response
let lastEvalTokens = 0;        // eval_count from last response

// Estimate token count from text (~4 chars per token for English, ~3 for code)
// This is a rough heuristic - actual counts come from Ollama response stats
function estimateTokens(text) {
  if (!text) return 0;
  // Count code blocks separately (denser tokens)
  const codeBlocks = text.match(/```[\s\S]*?```/g) || [];
  let codeChars = codeBlocks.reduce((sum, b) => sum + b.length, 0);
  let textChars = text.length - codeChars;
  return Math.ceil(textChars / 4 + codeChars / 3.5);
}

// Estimate total tokens for the messages array
function estimateMessagesTokens(messages) {
  let total = 0;
  for (const m of messages) {
    // Each message has ~4 tokens of overhead (role, formatting)
    total += 4;
    total += estimateTokens(m.content);
  }
  return total;
}
let rl = readline.createInterface({ 
  input: process.stdin, 
  output: process.stdout,
  terminal: true,
  historySize: 100
});

function recreateReadline() {
  if (rl) rl.close();
  rl = readline.createInterface({ 
    input: process.stdin, 
    output: process.stdout,
    terminal: true,
    historySize: 100
  });
  // Force resume stdin to keep process alive
  process.stdin.resume();
}

async function safeQuestion(query) {
  resetTerminal(); // Clear terminal state before asking
  if (rl.closed) recreateReadline();
  
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      resolve(answer ? answer.trim() : '');
    });
  });
}

// Directories to ignore when listing files
const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 
  '.next', '.nuxt', '__pycache__', '.cache', 'coverage',
  '.idea', '.vscode', 'vendor', 'target', '.gradle'
]);

// File extensions to include when scanning codebase
const CODE_EXTENSIONS = new Set([
  '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.go', '.rs', '.rb', '.php',
  '.c', '.cpp', '.h', '.hpp', '.cs', '.swift', '.kt', '.scala', '.vue', '.svelte',
  '.css', '.scss', '.sass', '.less', '.html', '.htm', '.json', '.yaml', '.yml',
  '.toml', '.xml', '.md', '.txt', '.sh', '.bash', '.zsh', '.sql', '.graphql',
  '.env.example', '.gitignore', '.dockerignore', 'Dockerfile', 'Makefile',
  '.prisma', '.proto'
]);

// Max file size to include (skip large files like bundled/minified)
const MAX_FILE_SIZE = 100000; // 100KB per file
const MAX_TOTAL_SCAN_SIZE = 1000000; // 1000KB total scan limit
const MAX_URL_SIZE = 200000; // 200KB max for fetched web pages

// ═══════════════════════════════════════════════════════════════
// URL FETCHING — Read web pages and learn from them
// ═══════════════════════════════════════════════════════════════
import https from 'https';
import http from 'http';

// Fetch a URL and return extracted text content
function fetchUrl(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { 
      headers: { 
        'User-Agent': 'Sapper-AI/1.0',
        'Accept': 'text/html,application/json,text/plain,*/*'
      },
      timeout 
    }, (res) => {
      // Follow redirects (up to 3)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http') 
          ? res.headers.location 
          : new URL(res.headers.location, url).href;
        return fetchUrl(redirectUrl, timeout).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      
      let data = '';
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_URL_SIZE) {
          res.destroy();
          reject(new Error(`Page too large (>${Math.round(MAX_URL_SIZE/1024)}KB)`));
          return;
        }
        data += chunk;
      });
      res.on('end', () => resolve(data));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', reject);
  });
}

// Strip HTML tags and extract readable text
function htmlToText(html) {
  let text = html;
  // Remove script and style blocks entirely
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '');
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, '');
  text = text.replace(/<header[\s\S]*?<\/header>/gi, ''); 
  // Convert common block elements to newlines
  text = text.replace(/<\/?(p|div|br|h[1-6]|li|tr|td|th|blockquote|pre|hr)[^>]*>/gi, '\n');
  // Remove all other HTML tags
  text = text.replace(/<[^>]+>/g, '');
  // Decode common HTML entities
  text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
  // Clean up whitespace
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n\s*\n/g, '\n\n');
  text = text.trim();
  // Limit to reasonable size
  if (text.length > 50000) {
    text = text.substring(0, 50000) + '\n\n[... content truncated at 50KB ...]';
  }
  return text;
}

// Detect URLs in text
const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/g;

// ═══════════════════════════════════════════════════════════════
// .sapperignore SUPPORT — like .gitignore for Sapper
// ═══════════════════════════════════════════════════════════════

// Parse .sapperignore patterns (glob-like, one per line, # comments)
function loadSapperIgnorePatterns() {
  const patterns = [];
  try {
    if (fs.existsSync(SAPPERIGNORE_FILE)) {
      const lines = fs.readFileSync(SAPPERIGNORE_FILE, 'utf8').split('\n');
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        // Track negation patterns (lines starting with !)
        const negate = line.startsWith('!');
        const pattern = negate ? line.slice(1) : line;
        patterns.push({ pattern, negate });
      }
    }
  } catch (e) {
    // Silent fail — ignore file is optional
  }
  return patterns;
}

let _sapperIgnorePatterns = null;
function getSapperIgnorePatterns() {
  if (_sapperIgnorePatterns === null) {
    _sapperIgnorePatterns = loadSapperIgnorePatterns();
  }
  return _sapperIgnorePatterns;
}

// Reload patterns (call when .sapperignore changes)
function reloadSapperIgnore() {
  _sapperIgnorePatterns = null;
}

// Convert a .sapperignore glob pattern to a regex
function ignorePatternToRegex(pattern) {
  // Remove trailing slashes (directory markers)
  let p = pattern.replace(/\/+$/, '');
  // Escape regex special chars except * and ?
  p = p.replace(/([.+^${}()|[\]\\])/g, '\\$1');
  // Convert glob wildcards
  p = p.replace(/\*\*/g, '<<<GLOBSTAR>>>');
  p = p.replace(/\*/g, '[^/]*');
  p = p.replace(/<<<GLOBSTAR>>>/g, '.*');
  p = p.replace(/\?/g, '[^/]');
  // Match the whole name or path
  return new RegExp(`(^|/)${p}($|/)`, 'i');
}

// Check if a file/dir name or path should be ignored
function shouldIgnore(nameOrPath) {
  // Always check built-in IGNORE_DIRS first (fast path)
  const baseName = nameOrPath.includes('/') ? nameOrPath.split('/').pop() : nameOrPath;
  if (IGNORE_DIRS.has(baseName)) return true;

  const patterns = getSapperIgnorePatterns();
  if (patterns.length === 0) return false;

  let ignored = false;
  for (const { pattern, negate } of patterns) {
    const regex = ignorePatternToRegex(pattern);
    if (regex.test(nameOrPath) || regex.test(baseName)) {
      ignored = !negate;
    }
  }
  return ignored;
}

// Scan entire codebase and return summary
function scanCodebase(dir = '.', depth = 0, maxDepth = 5) {
  if (depth > maxDepth) return { files: [], totalSize: 0 };
  
  let files = [];
  let totalSize = 0;
  
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = dir === '.' ? entry.name : `${dir}/${entry.name}`;
      
      // Skip ignored directories and files (respects .sapperignore)
      if (entry.isDirectory()) {
        if (shouldIgnore(entry.name) || entry.name.startsWith('.')) continue;
        const subResult = scanCodebase(fullPath, depth + 1, maxDepth);
        files = files.concat(subResult.files);
        totalSize += subResult.totalSize;
      } else {
        // Check if file should be included
        if (shouldIgnore(fullPath) || shouldIgnore(entry.name)) continue;
        const ext = entry.name.includes('.') ? '.' + entry.name.split('.').pop() : entry.name;
        const isCodeFile = CODE_EXTENSIONS.has(ext.toLowerCase()) || CODE_EXTENSIONS.has(entry.name);
        
        if (!isCodeFile) continue;
        
        try {
          const stats = fs.statSync(fullPath);
          if (stats.size > MAX_FILE_SIZE) {
            files.push({ path: fullPath, size: stats.size, skipped: true, reason: 'too large' });
            continue;
          }
          if (totalSize + stats.size > MAX_TOTAL_SCAN_SIZE) {
            files.push({ path: fullPath, size: stats.size, skipped: true, reason: 'total limit reached' });
            continue;
          }
          
          const content = fs.readFileSync(fullPath, 'utf8');
          files.push({ path: fullPath, size: stats.size, content });
          totalSize += stats.size;
        } catch (e) {
          files.push({ path: fullPath, skipped: true, reason: e.message });
        }
      }
    }
  } catch (e) {
    // Directory not readable
  }
  
  return { files, totalSize };
}

// Scan directory for files (for @ file picker)
function getFilesForPicker(dir = '.', prefix = '', maxFiles = 50) {
  let files = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      if (shouldIgnore(entry.name) || entry.name.startsWith('.')) continue;
      
      const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      
      if (entry.isDirectory()) {
        files.push({ path: fullPath + '/', isDir: true });
        // Recurse one level for common structures
        const subFiles = getFilesForPicker(`${dir}/${entry.name}`, fullPath, 20);
        files = files.concat(subFiles.slice(0, 15)); // Limit subdirectory files
      } else {
        const ext = entry.name.includes('.') ? '.' + entry.name.split('.').pop() : '';
        if (CODE_EXTENSIONS.has(ext.toLowerCase()) || CODE_EXTENSIONS.has(entry.name)) {
          try {
            const stats = fs.statSync(`${dir}/${entry.name}`);
            files.push({ path: fullPath, isDir: false, size: stats.size });
          } catch (e) {
            files.push({ path: fullPath, isDir: false, size: 0 });
          }
        }
      }
    }
  } catch (e) {}
  return files.slice(0, maxFiles);
}

// Interactive file picker with arrow keys
async function pickFiles() {
  const files = getFilesForPicker('.', '', 50).filter(f => !f.isDir);
  
  if (files.length === 0) {
    console.log(chalk.yellow('No code files found in current directory.'));
    return [];
  }
  
  const selected = new Set();
  let cursor = 0;
  const pageSize = Math.min(15, process.stdout.rows - 10 || 15);
  
  // Enable raw mode for key capture
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  
  const renderList = () => {
    // Clear screen and move cursor to top
    console.clear();
    console.log(box(
      `${statusBadge('Move', 'info')} ↑ ↓   ${statusBadge('Toggle', 'success')} space   ${statusBadge('All', 'warning')} a\n` +
      `${statusBadge('Confirm', 'success')} enter   ${statusBadge('Cancel', 'error')} q / esc`,
      'Attach Files', 'cyan'
    ));
    console.log();
    
    // Calculate visible range (pagination)
    const startIdx = Math.max(0, Math.min(cursor - Math.floor(pageSize / 2), files.length - pageSize));
    const endIdx = Math.min(startIdx + pageSize, files.length);
    
    // Show scroll indicator if needed
    if (startIdx > 0) {
      console.log(chalk.gray('  ↑ more files above...'));
    }
    
    for (let i = startIdx; i < endIdx; i++) {
      const file = files[i];
      const isSelected = selected.has(i);
      const isCursor = i === cursor;
      
      const checkbox = isSelected ? chalk.green('◉') : chalk.gray('○');
      const prefix = isCursor ? chalk.cyan('▸ ') : '  ';
      const name = isCursor ? chalk.cyan.bold(file.path) : chalk.white(file.path);
      const size = file.size ? chalk.gray(` (${Math.round(file.size/1024)}KB)`) : '';
      
      console.log(`${prefix}${checkbox} ${name}${size}`);
    }
    
    if (endIdx < files.length) {
      console.log(chalk.gray('  ↓ more files below...'));
    }
    
    console.log();
        console.log(`${statusBadge('Selected', 'action')} ${chalk.white(`${selected.size} file${selected.size !== 1 ? 's' : ''}`)}`);
  };
  
  return new Promise((resolve) => {
    renderList();
    
    const onKeypress = (chunk, key) => {
      if (!key) {
        // Handle raw chunk for arrow keys
        const str = chunk.toString();
        if (str === '\x1b[A') key = { name: 'up' };
        else if (str === '\x1b[B') key = { name: 'down' };
        else if (str === '\x1b[C') key = { name: 'right' };
        else if (str === '\x1b[D') key = { name: 'left' };
        else if (str === ' ') key = { name: 'space' };
        else if (str === '\r' || str === '\n') key = { name: 'return' };
        else if (str === '\x1b' || str === 'q') key = { name: 'escape' };
        else if (str === 'a' || str === 'A') key = { name: 'a' };
        else if (str === '\x03') key = { name: 'c', ctrl: true }; // Ctrl+C
      }
      
      if (!key) return;
      
      if (key.name === 'up' || key.name === 'k') {
        cursor = cursor > 0 ? cursor - 1 : files.length - 1;
        renderList();
      } else if (key.name === 'down' || key.name === 'j') {
        cursor = cursor < files.length - 1 ? cursor + 1 : 0;
        renderList();
      } else if (key.name === 'space' || key.name === 'right') {
        if (selected.has(cursor)) {
          selected.delete(cursor);
        } else {
          selected.add(cursor);
        }
        renderList();
      } else if (key.name === 'a') {
        // Toggle all
        if (selected.size === files.length) {
          selected.clear();
        } else {
          for (let i = 0; i < files.length; i++) selected.add(i);
        }
        renderList();
      } else if (key.name === 'return') {
        cleanup();
        const selectedFiles = Array.from(selected).map(i => files[i].path);
        console.log(chalk.green(`\n✓ Selected ${selectedFiles.length} file${selectedFiles.length !== 1 ? 's' : ''}`));
        resolve(selectedFiles);
      } else if (key.name === 'escape' || key.name === 'q' || (key.ctrl && key.name === 'c')) {
        cleanup();
        console.log(chalk.gray('\nCancelled.'));
        resolve([]);
      }
    };
    
    const cleanup = () => {
      process.stdin.removeListener('data', onKeypress);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
    };
    
    process.stdin.on('data', onKeypress);
  });
}

// Format scan results for AI context
function formatScanResults(scanResult) {
  let output = `\n══════════════════════════════════════\n`;
  output += `📁 CODEBASE SCAN (${scanResult.files.length} files, ~${Math.round(scanResult.totalSize/1024)}KB)\n`;
  output += `══════════════════════════════════════\n\n`;
  
  // First list all files
  output += `FILE TREE:\n`;
  for (const file of scanResult.files) {
    if (file.skipped) {
      output += `  ⏭️  ${file.path} (skipped: ${file.reason})\n`;
    } else {
      output += `  📄 ${file.path} (${Math.round(file.size/1024)}KB)\n`;
    }
  }
  
  output += `\n══════════════════════════════════════\n`;
  output += `FILE CONTENTS:\n`;
  output += `══════════════════════════════════════\n\n`;
  
  // Then include contents
  for (const file of scanResult.files) {
    if (file.skipped) continue;
    output += `┌─── ${file.path} ───\n`;
    output += file.content;
    if (!file.content.endsWith('\n')) output += '\n';
    output += `└─── END ${file.path} ───\n\n`;
  }
  
  return output;
}

// Interactive model picker with keyboard navigation
async function pickModel(models) {
  if (!models || models.length === 0) return null;

  let cursor = 0;
  const pageSize = Math.max(5, Math.min(8, (process.stdout.rows || 24) - 14));

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();

  const render = () => {
    const current = models[cursor];
    console.clear();
    console.log(BANNER);
    console.log(`${UI.slate(process.cwd())} ${UI.slate('·')} ${UI.slate(`v${CURRENT_VERSION}`)}`);
    console.log(divider());
    console.log(sectionTitle('Model selection', 'use ↑↓ or j/k, enter to confirm', 'cyan'));
    console.log();

    const startIdx = Math.max(0, Math.min(cursor - Math.floor(pageSize / 2), models.length - pageSize));
    const endIdx = Math.min(startIdx + pageSize, models.length);

    if (startIdx > 0) {
      console.log(UI.slate('  ↑ more models'));
    }

    for (let i = startIdx; i < endIdx; i++) {
      const model = models[i];
      const isActive = i === cursor;
      const marker = isActive ? UI.accent('›') : UI.slate(' ');
      const index = isActive ? UI.accent(String(i + 1).padStart(2, '0')) : UI.slate(String(i + 1).padStart(2, '0'));
      const name = isActive ? UI.accentSoft.bold(ellipsis(model.name, 40)) : chalk.white(ellipsis(model.name, 40));
      const meta = [
        model.size ? formatBytes(model.size) : null,
        model.modified_at ? formatRelativeTime(model.modified_at) : null,
        model.details?.parameter_size || null,
      ].filter(Boolean).join(' · ');

      console.log(`${marker} ${index}  ${name}`);
      if (meta) {
        console.log(`     ${UI.slate(meta)}`);
      }
    }

    if (endIdx < models.length) {
      console.log(UI.slate('  ↓ more models'));
    }

    const family = current.details?.family || current.details?.format || current.details?.parameter_size || 'local model';
    const quant = current.details?.quantization_level || current.details?.quantization || 'default';
    console.log();
    console.log(box(
      `${keyValue('Selected', chalk.white.bold(current.name), 10)}\n` +
      `${keyValue('Footprint', UI.ink(current.size ? formatBytes(current.size) : 'unknown'), 10)}\n` +
      `${keyValue('Updated', UI.ink(current.modified_at ? formatRelativeTime(current.modified_at) : 'unknown'), 10)}\n` +
      `${keyValue('Profile', UI.ink(family), 10)}\n` +
      `${keyValue('Quant', UI.ink(quant), 10)}`,
      'Preview', 'gray'
    ));
  };

  return new Promise((resolve) => {
    render();

    const cleanup = () => {
      process.stdin.removeListener('data', onKeypress);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
    };

    const onKeypress = (chunk, key) => {
      if (!key) {
        const str = chunk.toString();
        if (str === '\x1b[A') key = { name: 'up' };
        else if (str === '\x1b[B') key = { name: 'down' };
        else if (str === '\r' || str === '\n') key = { name: 'return' };
        else if (str === '\x1b' || str === 'q') key = { name: 'escape' };
        else if (str === 'j') key = { name: 'down' };
        else if (str === 'k') key = { name: 'up' };
        else if (str === '\x03') key = { name: 'c', ctrl: true };
      }

      if (!key) return;

      if (key.name === 'up') {
        cursor = cursor > 0 ? cursor - 1 : models.length - 1;
        render();
      } else if (key.name === 'down') {
        cursor = cursor < models.length - 1 ? cursor + 1 : 0;
        render();
      } else if (key.name === 'return') {
        cleanup();
        console.log(UI.slate(`\nUsing ${models[cursor].name}`));
        resolve(models[cursor].name);
      } else if (key.name === 'escape' || key.name === 'q' || (key.ctrl && key.name === 'c')) {
        cleanup();
        console.log(UI.slate(`\nUsing ${models[cursor].name}`));
        resolve(models[cursor].name);
      }
    };

    process.stdin.on('data', onKeypress);
  });
}

const tools = {
  read: (path) => {
    try { return fs.readFileSync(path.trim(), 'utf8'); } 
    catch (error) { return `Error reading file: ${error.message}`; }
  },
  patch: async (path, oldText, newText) => {
    const trimmedPath = path.trim();
    try {
      const content = fs.readFileSync(trimmedPath, 'utf8');

      // --- Line-number mode: LINE:15|||new text ---
      const lineMatch = oldText.match(/^LINE:(\d+)$/);
      if (lineMatch) {
        const lineNum = parseInt(lineMatch[1], 10);
        const lines = content.split('\n');
        if (lineNum < 1 || lineNum > lines.length) {
          return `Error: Line ${lineNum} out of range (file has ${lines.length} lines) in ${trimmedPath}`;
        }
        const oldLine = lines[lineNum - 1];
        lines[lineNum - 1] = newText;
        const newContent = lines.join('\n');
        console.log();
        const diffContent =
          `${keyValue('File', chalk.white(trimmedPath), 8)}\n` +
          `${keyValue('Line', chalk.white(String(lineNum)), 8)}\n` +
          `${UI.slate('Preview')}\n` +
          chalk.red('- ' + oldLine) + '\n' +
          chalk.green('+ ' + newText);
        console.log(box(diffContent, 'Patch Review', 'yellow'));
        const confirm = await safeQuestion(confirmPrompt('Apply patch', 'warning'));
        if (confirm.toLowerCase() === 'y') {
          fs.writeFileSync(trimmedPath, newContent);
          return `Successfully patched line ${lineNum} of ${trimmedPath}`;
        }
        return 'Patch rejected by user.';
      }

      // --- Exact match (try as-is first, then trimmed) ---
      let matchedOld = oldText;
      let newContent;
      if (content.includes(oldText)) {
        newContent = content.replace(oldText, newText);
      } else if (content.includes(oldText.trim())) {
        // Trimmed fallback — match what's actually in the file
        matchedOld = oldText.trim();
        newContent = content.replace(matchedOld, newText.trim());
        console.log(chalk.gray('  ℹ️  Matched after trimming whitespace'));
      } else {
        // --- Fuzzy fallback: normalize whitespace + strip emoji ---
        const normalize = (s) => s.replace(/[\u{1F000}-\u{1FFFF}]/gu, '').replace(/\s+/g, ' ').trim();
        const normalizedOld = normalize(oldText);
        const lines = content.split('\n');
        let bestMatch = null;
        let bestScore = 0;
        // Sliding window search over lines
        const oldLines = oldText.trim().split('\n');
        for (let i = 0; i <= lines.length - oldLines.length; i++) {
          const window = lines.slice(i, i + oldLines.length).join('\n');
          const normalizedWindow = normalize(window);
          if (normalizedWindow === normalizedOld) {
            bestMatch = { start: i, count: oldLines.length, text: window };
            bestScore = 1;
            break;
          }
          // Simple similarity: shared words ratio
          const oldWords = new Set(normalizedOld.split(' '));
          const winWords = new Set(normalizedWindow.split(' '));
          const shared = [...oldWords].filter(w => winWords.has(w)).length;
          const score = shared / Math.max(oldWords.size, winWords.size);
          if (score > bestScore && score >= 0.7) {
            bestScore = score;
            bestMatch = { start: i, count: oldLines.length, text: window };
          }
        }

        if (bestMatch && bestScore >= 0.7) {
          matchedOld = bestMatch.text;
          newContent = content.replace(matchedOld, newText.trim());
          console.log(chalk.gray(`  ℹ️  Fuzzy match (${(bestScore * 100).toFixed(0)}% similarity) at line ${bestMatch.start + 1}`));
        } else {
          // Show nearby lines to help AI on next attempt
          const keyword = oldText.split('\n')[0].trim().substring(0, 40);
          const nearby = lines.map((l, i) => ({ line: i + 1, text: l }))
            .filter(l => l.text.includes(keyword.substring(0, 15)))
            .slice(0, 3)
            .map(l => `  Line ${l.line}: ${l.text.substring(0, 80)}`)
            .join('\n');
          return `Error: Could not find the text to replace in ${trimmedPath}.\n` +
            (nearby ? `Nearby matches:\n${nearby}\n` : '') +
            `Tip: Use LINE:number mode instead, e.g. [TOOL:PATCH]${trimmedPath}:::LINE:42|||replacement text[/TOOL]`;
        }
      }
      
      // Show diff preview
      console.log();
      const diffContent = 
        `${keyValue('File', chalk.white(trimmedPath), 8)}\n` +
        `${UI.slate('Preview')}\n` +
        chalk.red('- ' + matchedOld.split('\n').join('\n- ')) + '\n' +
        chalk.green('+ ' + (newContent === content.replace(matchedOld, newText.trim()) ? newText.trim() : newText).split('\n').join('\n+ '));
      console.log(box(diffContent, 'Patch Review', 'yellow'));
      
      const confirm = await safeQuestion(confirmPrompt('Apply patch', 'warning'));
      if (confirm.toLowerCase() === 'y') {
        fs.writeFileSync(trimmedPath, newContent);
        return `Successfully patched ${trimmedPath}`;
      }
      return 'Patch rejected by user.';
    } catch (error) { return `Error patching file: ${error.message}`; }
  },
  write: async (path, content) => {
    const trimmedPath = path.trim();
    console.log();
    console.log(box(
      `${keyValue('File', chalk.white(trimmedPath), 8)}\n` +
      `${keyValue('Size', chalk.white((content?.length || 0) + ' chars'), 8)}\n` +
      `${UI.slate('Preview')}\n` +
      chalk.gray(content?.substring(0, 300)?.split('\n').slice(0, 8).join('\n') + (content?.length > 300 ? '\n...' : '')),
      'Write Review', 'yellow'
    ));
    const confirm = await safeQuestion(confirmPrompt('Allow file write', 'warning'));
    if (confirm.toLowerCase() === 'y') {
      try {
        fs.writeFileSync(trimmedPath, content);
        return `Successfully saved changes to ${trimmedPath}`;
      } catch (error) { return `Error writing file: ${error.message}`; }
    }
    return "Write blocked by user.";
  },
  mkdir: (path) => {
    try {
      fs.mkdirSync(path.trim(), { recursive: true });
      return `Directory created: ${path}`;
    } catch (error) { return `Error creating directory: ${error.message}`; }
  },
  shell: async (cmd) => {
    console.log();
    console.log(box(
      `${keyValue('Directory', chalk.white(process.cwd()), 11)}\n` +
      `${UI.slate('Command')}\n${chalk.white.bold(cmd)}`,
      'Shell Approval', 'red'
    ));
    const confirm = await safeQuestion(confirmPrompt('Run shell command', 'error'));
    if (confirm.toLowerCase() === 'y') {
      return new Promise((resolve) => {
        const useShell = cmd.includes('&&') || cmd.includes('|') || cmd.includes('cd ') || cmd.includes('>') || cmd.includes('<');
        console.log(chalk.cyan(`\n[RUNNING] ${cmd}\n`));
        const proc = spawn('sh', ['-c', cmd], { 
          cwd: process.cwd()
        });
        let output = '';
        proc.stdout.on('data', (data) => { 
          const text = data.toString();
          output += text;
          process.stdout.write(text); // Still show to user in real-time
        });
        proc.stderr.on('data', (data) => { 
          const text = data.toString();
          output += text;
          process.stderr.write(text); // Still show errors to user
        });
        proc.on('close', (code) => {
          // Crucial: give control back to Node
          if (process.stdin.isTTY) {
            try { process.stdin.setRawMode(false); } catch (e) {}
          }
          // Delay slightly to let terminal settle
          setTimeout(() => {
            recreateReadline();
            // Return actual output to AI, truncated if too long
            const maxOutput = 10000;
            let result = output.trim();
            if (result.length > maxOutput) {
              result = result.substring(0, maxOutput) + '\n... (output truncated)';
            }
            resolve(result || `Command completed with exit code ${code}`);
          }, 200);
        });
      });
    }
    return "Command blocked by user.";
  },
  list: (path) => {
    try {
      let dir = path.trim() || '.';
      // If AI sends "/" (root), treat as current directory "."
      if (dir === '/') dir = '.';
      const entries = fs.readdirSync(dir);
      // Filter out ignored files/directories (respects .sapperignore)
      const filtered = entries.filter(entry => {
        if (shouldIgnore(entry)) return false;
        // Also skip hidden files/folders (starting with .) except current dir
        if (entry.startsWith('.') && entry !== '.') return false;
        return true;
      });
      return filtered.length > 0 ? filtered.join('\n') : '(empty or all files filtered)';
    } catch (e) { return `Error: ${e.message}`; }
  },
  search: (pattern) => {
    return new Promise((resolve) => {
      // Build exclude dirs from IGNORE_DIRS + .sapperignore directory patterns
      const allIgnoreDirs = new Set(IGNORE_DIRS);
      for (const { pattern: p, negate } of getSapperIgnorePatterns()) {
        if (!negate && p.endsWith('/')) allIgnoreDirs.add(p.replace(/\/+$/, ''));
      }
      const excludeDirs = Array.from(allIgnoreDirs).join(',');
      // Use grep to search for pattern, excluding ignored directories
      const cmd = `grep -rEin "${pattern.replace(/"/g, '\\"')}" . --exclude-dir={${excludeDirs}} --include="*.{js,ts,jsx,tsx,py,java,go,rs,rb,php,c,cpp,h,css,scss,html,json,md,txt,yml,yaml,toml,sh}" 2>/dev/null | head -50`;
      
      const proc = spawn('sh', ['-c', cmd], { cwd: process.cwd() });
      let output = '';
      
      proc.stdout.on('data', (data) => { output += data.toString(); });
      proc.stderr.on('data', (data) => { output += data.toString(); });
      
      proc.on('close', () => {
        if (output.trim()) {
          resolve(`Found matches:\n${output.trim()}`);
        } else {
          resolve(`No matches found for: ${pattern}`);
        }
      });
    });
  }
};

async function checkForUpdates() {
  try {
    const response = await fetch('https://registry.npmjs.org/sapper-iq/latest');
    const data = await response.json();
    const latestVersion = data.version;
    
    if (latestVersion && latestVersion !== CURRENT_VERSION) {
      console.log(UI.gold(`Update available: v${CURRENT_VERSION} -> v${latestVersion}`));
      console.log(UI.slate('Run npm update -g sapper-iq\n'));
    }
  } catch (error) {
    // Silently fail if update check fails
  }
}

async function runSapper() {
  console.clear();
  console.log(BANNER);
  console.log(`${UI.slate(process.cwd())} ${UI.slate('·')} ${UI.slate(`v${CURRENT_VERSION}`)}`);
  console.log(divider());
  console.log(sectionTitle('Quick start', '@file attach · /help commands · /agents modes', 'gray'));
  console.log();
  
  // Check for updates
  await checkForUpdates();
  
  // Ensure .sapperignore exists (create default on first run)
  const sapperIgnoreCreated = ensureSapperIgnore();
  if (sapperIgnoreCreated) {
    console.log(chalk.green('📋 Created .sapperignore') + chalk.gray(' — edit it to customize ignored files'));
  } else {
    // Reload patterns in case file was modified since last run
    reloadSapperIgnore();
  }

  // Ensure config file exists with defaults, or reload user's config
  if (!fs.existsSync(CONFIG_FILE)) {
    saveConfig(sapperConfig);
  } else {
    // Reload in case user edited config.json manually
    sapperConfig = loadConfig();
  }
  
  // Auto-load or build workspace graph
  let workspace = loadWorkspaceGraph();
  if (!workspace.indexed) {
    console.log(chalk.cyan('📊 Building workspace index with AST parsing...'));
    workspace = await buildWorkspaceGraph();
    const totalSymbols = Object.values(workspace.files).reduce((sum, f) => sum + (f.symbols?.length || 0), 0);
    console.log(chalk.green(`✅ Indexed ${Object.keys(workspace.files).length} files, ${totalSymbols} symbols\n`));
  } else {
    const fileCount = Object.keys(workspace.files).length;
    const symbolCount = Object.values(workspace.files).reduce((sum, f) => sum + (f.symbols?.length || 0), 0);
    const indexAge = Math.round((Date.now() - new Date(workspace.indexed).getTime()) / 1000 / 60);
    console.log(chalk.gray(`📊 Workspace: ${fileCount} files, ${symbolCount} symbols (${indexAge}m ago)`));
    if (indexAge > 60) {
      console.log(chalk.yellow(`   Tip: Run /index to refresh`));
    }
  }
  
  // Initialize agents and skills
  const newlyCreated = createDefaultAgentsAndSkills();
  const agents = loadAgents();
  const skills = loadSkills();
  const agentCount = Object.keys(agents).length;
  const skillCount = Object.keys(skills).length;
  const workspaceFileCount = Object.keys(workspace.files).length;
  const workspaceSymbolCount = Object.values(workspace.files).reduce((sum, f) => sum + (f.symbols?.length || 0), 0);
  const workspaceAgeMinutes = workspace.indexed
    ? Math.max(0, Math.round((Date.now() - new Date(workspace.indexed).getTime()) / 1000 / 60))
    : 0;
  const startupLines = [
    `${statusBadge('workspace', 'info')} ${chalk.white(`${workspaceFileCount} files`)} ${UI.slate('·')} ${chalk.white(`${workspaceSymbolCount} symbols`)} ${UI.slate('·')} ${UI.slate(`indexed ${workspaceAgeMinutes}m ago`)}`,
    `${statusBadge('memory', 'neutral')} ${chalk.white('.sapper/')} ${UI.slate('·')} ${UI.slate(`auto-attach ${sapperConfig.autoAttach ? 'on' : 'off'}`)}`,
    `${statusBadge('agents', 'action')} ${chalk.white(`${agentCount}`)} ${UI.slate('·')} ${statusBadge('skills', 'success')} ${chalk.white(`${skillCount}`)}`,
  ];
  if (newlyCreated > 0) {
    startupLines.push(UI.slate(`${newlyCreated} default agents or skills created in .sapper/`));
  }
  console.log(box(startupLines.join('\n'), 'Workspace', 'gray'));
  console.log();
  
  let messages = [];
  if (fs.existsSync(CONTEXT_FILE)) {
    console.log(divider());
    console.log(UI.ink('Previous session found in .sapper/context.json'));
    const resume = await safeQuestion(confirmPrompt('Resume session', 'success'));
    if (resume.toLowerCase() === 'y') {
      messages = JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8'));
      console.log(chalk.green('  ✓ Session restored\n'));
    } else {
      fs.unlinkSync(CONTEXT_FILE);
      console.log(chalk.gray('  ✓ Starting fresh...\n'));
    }
  }
  
  // Migrate old files to new .sapper/ folder
  const oldFiles = ['.sapper_context.json', '.sapper_embeddings.json', '.sapper_workspace.json'];
  for (const oldFile of oldFiles) {
    if (fs.existsSync(oldFile)) {
      ensureSapperDir();
      const newFile = `${SAPPER_DIR}/${oldFile.replace('.sapper_', '').replace('_', '.')}`;
      if (!fs.existsSync(newFile)) {
        fs.renameSync(oldFile, newFile);
        console.log(chalk.gray(`📦 Migrated ${oldFile} → ${newFile}`));
      } else {
        fs.unlinkSync(oldFile);
      }
    }
  }

  let localModels;
  try {
    localModels = await ollama.list();
  } catch (e) {
    console.error(chalk.red('\n❌ Cannot connect to Ollama!'));
    console.log(chalk.yellow('   Make sure Ollama is running: ') + chalk.cyan('ollama serve'));
    console.log(chalk.gray('   Or install from: https://ollama.ai\n'));
    process.exit(1);
  }
  
  if (!localModels.models || localModels.models.length === 0) {
    console.error(chalk.red('\n❌ No models found!'));
    console.log(chalk.yellow('   Pull a model first: ') + chalk.cyan('ollama pull llama3.2'));
    process.exit(1);
  }
  
  const selectedModel = await pickModel(localModels.models) || localModels.models[0].name;

  // ─── Detect model capabilities & context window ───────────────────
  let useNativeTools = false;
  let toolModeLabel = 'tool detection unavailable';
  let contextLabel = '4,096 tokens (fallback)';
  try {
    const modelInfo = await ollama.show({ model: selectedModel });
    if (modelInfo.capabilities && modelInfo.capabilities.includes('tools')) {
      useNativeTools = true;
      toolModeLabel = 'native tool calling';
    } else {
      toolModeLabel = 'text markers';
    }
    // Extract context window size from model_info
    // Different model families use different keys: llama.context_length, qwen2.context_length, etc.
    if (modelInfo.model_info) {
      for (const [key, value] of Object.entries(modelInfo.model_info)) {
        if (key.endsWith('.context_length') && typeof value === 'number') {
          modelContextLength = value;
          break;
        }
      }
    }
    // Fallback: parse from parameters string (e.g. "num_ctx 4096")
    if (!modelContextLength && modelInfo.parameters) {
      const match = modelInfo.parameters.match(/num_ctx\s+(\d+)/);
      if (match) modelContextLength = parseInt(match[1]);
    }
    if (modelContextLength) {
      contextLabel = `${modelContextLength.toLocaleString()} tokens`;
    } else {
      modelContextLength = 4096; // Conservative default
      contextLabel = '4,096 tokens (default)';
    }
  } catch (e) {
    modelContextLength = 4096;
    toolModeLabel = 'default mode';
    contextLabel = '4,096 tokens (fallback)';
  }
  // Show custom limit if set
  const effectiveCtx = effectiveContextLength();
  if (sapperConfig.contextLimit && effectiveCtx !== modelContextLength) {
    contextLabel = `${effectiveCtx.toLocaleString()} tokens (custom limit, model: ${modelContextLength.toLocaleString()})`;
  }
  console.log(box(
    `${statusBadge('model', 'action')} ${chalk.white.bold(selectedModel)}\n` +
    `${statusBadge('tools', useNativeTools ? 'success' : 'neutral')} ${UI.ink(toolModeLabel)}\n` +
    `${statusBadge('context', 'info')} ${UI.ink(contextLabel)}`,
    'Session', 'cyan'
  ));
  console.log();
  _useNativeToolsFlag = useNativeTools; // Set global for buildSystemPrompt

  // Native Ollama tool definitions (used when useNativeTools=true)
  const nativeToolDefs = [
    {
      type: 'function',
      function: {
        name: 'list_directory',
        description: 'List the contents of a directory. Use "." for current directory.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Directory path to list' }
          },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read the full contents of a file',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path to read' }
          },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'search_files',
        description: 'Search for a pattern across project files',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Search pattern (text or regex)' }
          },
          required: ['pattern']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Create or overwrite a file with new content',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path to write' },
            content: { type: 'string', description: 'Content to write to the file' }
          },
          required: ['path', 'content']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'patch_file',
        description: 'Edit an existing file by replacing old text with new text. Prefer line_number mode.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path to patch' },
            old_text: { type: 'string', description: 'Exact text to find and replace, or LINE:<number> for line-number mode' },
            new_text: { type: 'string', description: 'Replacement text' }
          },
          required: ['path', 'old_text', 'new_text']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'create_directory',
        description: 'Create a directory (recursive)',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Directory path to create' }
          },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'run_shell',
        description: 'Execute a shell command in the project directory',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command to execute' }
          },
          required: ['command']
        }
      }
    }
  ];

  if (messages.length === 0) {
    messages = [{
      role: 'system',
      content: buildSystemPrompt()
    }];
  }

  // Log session start
  logEntry('session_start', {
    model: selectedModel,
    resumed: messages.length > 1,
    contextSize: messages.length
  });

  // Main conversation loop - never exits unless user types 'exit'
  while (true) {
    try {
      // Context size check - auto-summarize when approaching effective context limit
      const estimatedTokens = estimateMessagesTokens(messages);
      const ctxLen = effectiveContextLength();
      const tokenThreshold = ctxLen ? Math.floor(ctxLen * 0.75) : 8000;
      if (estimatedTokens > tokenThreshold) {
        messages = await autoSummarizeContext(messages, selectedModel);
      }
      
      // Build prompt label with active agent/skills
      const contextPercent = ctxLen ? Math.round((estimatedTokens / ctxLen) * 100) : null;
      const promptParts = [
        statusBadge(selectedModel.split(':')[0] || selectedModel, 'action'),
        currentAgent ? statusBadge(`/${currentAgent}`, 'info') : statusBadge('default', 'neutral'),
      ];
      if (loadedSkills.length > 0) {
        promptParts.push(statusBadge(`${loadedSkills.length} skill${loadedSkills.length !== 1 ? 's' : ''}`, 'success'));
      }
      if (contextPercent !== null) {
        const tone = contextPercent >= 85 ? 'error' : contextPercent >= 65 ? 'warning' : 'neutral';
        promptParts.push(statusBadge(`${contextPercent}% ctx`, tone));
      }

      const promptDetail = ctxLen
        ? `${meter(estimatedTokens, ctxLen, 24)} ${UI.slate(`${estimatedTokens.toLocaleString()}/${ctxLen.toLocaleString()} tokens`)}`
        : UI.slate(`${estimatedTokens.toLocaleString()} estimated tokens`);

      const input = await safeQuestion(`\n${promptShell(promptParts.join(' '), promptDetail)}`);
      
      // Block empty prompts
      if (!input.trim()) {
        continue;
      }

      // Clear readline echo to prevent duplicate display
      {
        const promptWidth = visibleLength(promptParts.join(' ')) + 4; // account for prompt chars
        const totalLen = promptWidth + input.length;
        const lines = Math.ceil(totalLen / (process.stdout.columns || 80));
        for (let i = 0; i < lines; i++) {
          process.stdout.write('\x1B[1A\x1B[2K');
        }
        // Reprint clean version
        const preview = input.length > 120 ? input.substring(0, 120) + chalk.gray('...') : input;
        console.log(UI.accent('› ') + chalk.white(preview));
      }
      
      if (input.toLowerCase() === 'exit') {
        const stats = getSessionStats();
        logEntry('system', { event: 'Session End', detail: `Duration: ${formatElapsed(stats.totalDuration)}, ${stats.userMessages} messages, ${stats.toolCalls} tools` });
        console.log();
        console.log(box(
          `${chalk.white('Duration:')}   ${chalk.cyan(formatElapsed(stats.totalDuration))}\n` +
          `${chalk.white('Messages:')}   ${chalk.blue(stats.userMessages + '↑')} ${chalk.magenta(stats.aiMessages + '↓')}\n` +
          `${chalk.white('Tools:')}      ${chalk.yellow(stats.toolCalls)} | ${chalk.white('Shells:')} ${chalk.red(stats.shellCalls)}\n` +
          `${chalk.white('Log saved:')} ${chalk.gray(sessionLogFile())}`,
          '👋 Session Summary', 'cyan'
        ));
        console.log();
        process.exit();
      }
      
      // Handle reset command
      if (input.toLowerCase() === '/reset' || input.toLowerCase() === '/clear') {
        if (fs.existsSync(CONTEXT_FILE)) {
          fs.unlinkSync(CONTEXT_FILE);
          console.log(chalk.green('✅ Context cleared! Starting fresh...\n'));
        }
        currentAgent = null;
        currentAgentTools = null;
        loadedSkills = [];
        messages = [{
          role: 'system',
          content: buildSystemPrompt() // Reset to default prompt
        }];
        logEntry('system', { event: 'Context Reset', detail: 'All context cleared, starting fresh' });
        continue;
      }
      
      // Handle prune command - smart AI summary then clear old context
      if (input.toLowerCase() === '/prune') {
        if (messages.length <= 5) {
          console.log(chalk.yellow('Context is already small, nothing to prune.'));
          continue;
        }
        
        messages = await autoSummarizeContext(messages, selectedModel, true);
        continue;
      }
      
      // Handle help command
      if (input.toLowerCase() === '/help') {
        console.log();
        console.log(sectionTitle('Core', 'daily workflow', 'cyan'));
        console.log(commandRow('@ or /attach', 'Pick files to attach interactively'));
        console.log(commandRow('@file', 'Attach a file inline, for example @src/app.js'));
        console.log(commandRow('/scan', 'Scan the codebase into context'));
        console.log(commandRow('/index', 'Rebuild the workspace graph'));
        console.log(commandRow('/graph file', 'Show related files from the graph'));
        console.log(commandRow('/symbol name', 'Search indexed functions and classes'));
        console.log(commandRow('/auto', 'Toggle automatic related-file attach'));
        console.log();
        console.log(sectionTitle('Context', 'memory and visibility', 'cyan'));
        console.log(commandRow('/recall', 'Search memory for relevant context'));
        console.log(commandRow('/fetch <url>', 'Fetch a web page into context'));
        console.log(commandRow('/reset /clear', 'Clear all current context'));
        console.log(commandRow('/prune', 'Summarize long context and store memory'));
        console.log(commandRow('/context', 'Inspect token usage and model window'));
        console.log(commandRow('/ctx <limit>', 'Set context window limit (e.g. /ctx 64k)'));
        console.log(commandRow('/debug', 'Toggle regex and tool debug output'));
        console.log(commandRow('/log', 'Show the session activity timeline'));
        console.log(commandRow('/log stats', 'Show session statistics'));
        console.log(commandRow('/log file', 'Show log file path and history'));
        console.log(commandRow('/help', 'Open this command view again'));
        console.log(commandRow('exit', 'Quit Sapper'));
        console.log();
        console.log(sectionTitle('Agents', 'specialist modes and skills', 'cyan'));
        console.log(commandRow('/agents', 'List available agents'));
        console.log(commandRow('/skills', 'List available skills'));
        console.log(commandRow('/agentname', 'Switch to an agent such as /reviewer'));
        console.log(commandRow('/default', 'Return to the default Sapper role'));
        console.log(commandRow('/use skill', 'Load a skill into the session'));
        console.log(commandRow('/unload skill', 'Unload a previously loaded skill'));
        console.log(commandRow('/newagent', 'Create a new agent'));
        console.log(commandRow('/newskill', 'Create a new skill'));
        console.log(divider());
        console.log();
        continue;
      }
      
      // Handle index command - rebuild workspace graph
      if (input.toLowerCase() === '/index') {
        console.log(chalk.cyan('\n📊 Rebuilding workspace index with AST parsing...'));
        workspace = await buildWorkspaceGraph();
        const totalSymbols = Object.values(workspace.files).reduce((sum, f) => sum + (f.symbols?.length || 0), 0);
        console.log(chalk.green(`✅ Indexed ${Object.keys(workspace.files).length} files`));
        console.log(chalk.gray(`   📦 ${totalSymbols} symbols (functions, classes, variables)`));
        console.log(chalk.gray(`   🔗 ${Object.values(workspace.graph).flat().length} dependencies tracked\n`));
        continue;
      }
      
      // Handle symbol search command
      if (input.toLowerCase().startsWith('/symbol')) {
        const query = input.slice(7).trim();
        if (!query) {
          // Show all symbols summary
          const allSymbols = [];
          for (const [file, info] of Object.entries(workspace.files)) {
            for (const sym of info.symbols || []) {
              allSymbols.push({ ...sym, file });
            }
          }
          
          // Group by type
          const functions = allSymbols.filter(s => s.type === 'function');
          const classes = allSymbols.filter(s => s.type === 'class');
          const methods = allSymbols.filter(s => s.type === 'method');
          
          console.log();
          console.log(box(
            `${chalk.cyan('Functions:')} ${functions.length}\n` +
            `${chalk.cyan('Classes:')} ${classes.length}\n` +
            `${chalk.cyan('Methods:')} ${methods.length}\n` +
            chalk.gray('─'.repeat(30)) + '\n' +
            chalk.gray('Usage: /symbol <name> to search'),
            '📦 Symbol Index', 'cyan'
          ));
          continue;
        }
        
        console.log(chalk.cyan(`\n🔍 Searching for: "${query}"...\n`));
        const results = searchSymbol(query, workspace);
        
        if (results.length === 0) {
          console.log(chalk.yellow(`No symbols found matching "${query}"`));
          console.log(chalk.gray('Tip: Run /index to refresh symbol index'));
          continue;
        }
        
        console.log(chalk.green(`Found ${results.length} symbol${results.length !== 1 ? 's' : ''}:\n`));
        
        for (const sym of results.slice(0, 15)) {
          const typeIcon = sym.type === 'function' ? chalk.yellow('𝑓') : 
                          sym.type === 'class' ? chalk.blue('◆') :
                          sym.type === 'method' ? chalk.cyan('○') : chalk.gray('◇');
          const asyncTag = sym.async ? chalk.magenta('async ') : '';
          const params = sym.params !== undefined ? chalk.gray(`(${sym.params})`) : '';
          
          console.log(`  ${typeIcon} ${asyncTag}${chalk.white.bold(sym.name)}${params}`);
          console.log(`     ${chalk.gray(sym.file)}:${chalk.cyan(sym.line)}`);
        }
        
        if (results.length > 15) {
          console.log(chalk.gray(`\n   ... and ${results.length - 15} more`));
        }
        
        // Offer to add file to context
        if (results.length > 0) {
          console.log();
          const addToCtx = await safeQuestion(chalk.yellow('Add first match file to context? ') + chalk.gray('(y/n): '));
          if (addToCtx.toLowerCase() === 'y') {
            const targetFile = results[0].file;
            try {
              const content = fs.readFileSync(targetFile, 'utf8');
              messages.push({
                role: 'user',
                content: `Here is ${targetFile} (contains ${results[0].type} "${results[0].name}" at line ${results[0].line}):\n\n${content}`
              });
              console.log(chalk.green(`✅ Added ${targetFile} to context`));
            } catch (e) {
              console.log(chalk.red(`Could not read ${targetFile}`));
            }
          }
        }
        continue;
      }
      
      // Handle graph command - show related files
      if (input.toLowerCase().startsWith('/graph')) {
        const targetFile = input.slice(6).trim();
        if (!targetFile) {
          // Show workspace overview
          console.log(formatWorkspaceSummary(workspace));
          continue;
        }
        
        // Find file (support partial match)
        const matchingFile = Object.keys(workspace.files).find(f => 
          f === targetFile || f.endsWith('/' + targetFile) || f.endsWith(targetFile)
        );
        
        if (!matchingFile) {
          console.log(chalk.yellow(`File not found in index: ${targetFile}`));
          console.log(chalk.gray('Tip: Run /index to refresh workspace graph'));
          continue;
        }
        
        const fileInfo = workspace.files[matchingFile];
        const related = getRelatedFiles(matchingFile, workspace);
        
        console.log();
        console.log(box(
          `${chalk.white('File:')} ${chalk.cyan(matchingFile)}\n` +
          `${chalk.white('Size:')} ${Math.round(fileInfo.size/1024)}KB\n` +
          `${chalk.white('Exports:')} ${fileInfo.exports?.join(', ') || 'none'}\n` +
          `${chalk.white('Imports:')} ${fileInfo.imports?.join(', ') || 'none'}\n` +
          chalk.gray('─'.repeat(40)) + '\n' +
          `${chalk.white('Related files:')}\n` +
          (related.length > 0 
            ? related.map(r => `  📄 ${r}`).join('\n')
            : chalk.gray('  (no related files found)')),
          '🔗 File Graph', 'cyan'
        ));
        console.log();
        
        // Offer to add to context
        if (related.length > 0) {
          const addRelated = await safeQuestion(chalk.yellow('Add this file + related to context? ') + chalk.gray('(y/n): '));
          if (addRelated.toLowerCase() === 'y') {
            let contextContent = `\n📄 ${matchingFile}:\n`;
            contextContent += fs.readFileSync(matchingFile, 'utf8');
            
            for (const relFile of related.slice(0, 5)) { // Limit to 5 related
              try {
                contextContent += `\n\n📄 ${relFile} (related):\n`;
                contextContent += fs.readFileSync(relFile, 'utf8');
              } catch (e) {}
            }
            
            messages.push({ 
              role: 'user', 
              content: `Here is ${matchingFile} and its related files:\n${contextContent}\n\nUse this context to help me.`
            });
            console.log(chalk.green(`✅ Added ${matchingFile} + ${Math.min(related.length, 5)} related files to context`));
          }
        }
        continue;
      }
      
      // Handle auto-attach toggle
      if (input.toLowerCase() === '/auto') {
        sapperConfig.autoAttach = !sapperConfig.autoAttach;
        saveConfig(sapperConfig);
        console.log(chalk.cyan(`\n🔗 Auto-attach related files: ${sapperConfig.autoAttach ? chalk.green('ON') : chalk.red('OFF')}`));
        if (sapperConfig.autoAttach) {
          console.log(chalk.gray('   When you @file, related imports will be auto-included.'));
        } else {
          console.log(chalk.gray('   Only explicitly mentioned files will be attached.'));
        }
        continue;
      }
      
      // Handle context size command
      // Handle /ctx command — view or set context window limit
      if (input.toLowerCase().startsWith('/ctx')) {
        const arg = input.substring(4).trim();
        if (arg === 'reset' || arg === 'auto') {
          sapperConfig.contextLimit = null;
          saveConfig(sapperConfig);
          console.log(chalk.green(`✅ Context limit reset to model default (${modelContextLength ? modelContextLength.toLocaleString() : 'auto'} tokens)`));
        } else if (arg) {
          // Parse number with optional k/K suffix (e.g. 64k, 32768)
          let limit = null;
          const kMatch = arg.match(/^(\d+\.?\d*)\s*[kK]$/);
          if (kMatch) {
            limit = Math.round(parseFloat(kMatch[1]) * 1024);
          } else {
            limit = parseInt(arg);
          }
          if (!limit || limit < 1024) {
            console.log(chalk.yellow('Usage: /ctx <tokens>  — e.g. /ctx 64k, /ctx 32768, /ctx reset'));
            console.log(chalk.gray('  Minimum: 1024 tokens'));
          } else {
            sapperConfig.contextLimit = limit;
            saveConfig(sapperConfig);
            const effective = effectiveContextLength();
            console.log(chalk.green(`✅ Context limit set to ${chalk.white.bold(effective.toLocaleString())} tokens`));
            if (modelContextLength && limit < modelContextLength) {
              console.log(chalk.gray(`   Model supports ${modelContextLength.toLocaleString()} but will use ${limit.toLocaleString()} (saves RAM)`));
            } else if (modelContextLength && limit > modelContextLength) {
              console.log(chalk.yellow(`   ⚠ Limit exceeds model's ${modelContextLength.toLocaleString()} context — may cause errors`));
            }
          }
        } else {
          // Show current setting
          const effective = effectiveContextLength();
          const custom = sapperConfig.contextLimit;
          const lines = [
            `model default  ${chalk.white(modelContextLength ? modelContextLength.toLocaleString() : 'unknown')} tokens`,
            `custom limit   ${custom ? chalk.cyan.bold(custom.toLocaleString() + ' tokens') : UI.slate('not set (using model default)')}`,
            `effective      ${chalk.white.bold(effective ? effective.toLocaleString() + ' tokens' : 'unknown')}`,
          ];
          console.log();
          console.log(box(lines.join('\n'), 'Context Limit', 'cyan'));
          console.log(UI.slate('  Set: /ctx 64k  |  /ctx 32768  |  /ctx reset'));
        }
        continue;
      }

      if (input.toLowerCase() === '/context') {
        const contextSize = JSON.stringify(messages).length;
        const estTokens = estimateMessagesTokens(messages);
        const ctxLen = effectiveContextLength();
        const contextLines = [
          `messages ${chalk.white(String(messages.length))} ${UI.slate('·')} raw ${chalk.white(Math.round(contextSize / 1024) + 'KB')} ${UI.slate('·')} tokens ${chalk.white('~' + estTokens.toLocaleString())}`,
        ];
        if (ctxLen) {
          const usagePercent = Math.round((estTokens / ctxLen) * 100);
          const threshold = Math.floor(ctxLen * 0.75);
          const limitLabel = sapperConfig.contextLimit
            ? `${ctxLen.toLocaleString()} tokens ${chalk.cyan('(custom)')}`
            : `${ctxLen.toLocaleString()} tokens`;
          contextLines.push(`limit ${chalk.white(limitLabel)} ${UI.slate('·')} usage ${chalk.white(usagePercent + '%')}`);
          contextLines.push(`${meter(estTokens, ctxLen, 28)} ${UI.slate(`summarize near ${threshold.toLocaleString()} tokens`)}`);
        }
        if (lastPromptTokens > 0) {
          contextLines.push(`last turn ${UI.slate(`${lastPromptTokens.toLocaleString()} prompt • ${lastEvalTokens.toLocaleString()} response`)}`);
        }
        console.log();
        console.log(box(contextLines.join('\n'), 'Context', 'gray'));
        continue;
      }
      
      // Handle debug mode toggle
      if (input.toLowerCase() === '/debug') {
        debugMode = !debugMode;
        console.log(chalk.magenta(`🔧 Debug mode: ${debugMode ? 'ON' : 'OFF'}`));
        if (debugMode) {
          console.log(chalk.gray('   Will show regex matching details after each AI response.'));
        }
        continue;
      }
      
      // Handle /log command - show activity log
      if (input.toLowerCase().startsWith('/log')) {
        const parts = input.split(' ');
        const count = parseInt(parts[1]) || 30;
        
        if (parts[1] === 'file') {
          // Show log file path
          console.log(chalk.cyan(`\n📁 Log file: ${chalk.white(sessionLogFile())}`));
          if (fs.existsSync(sessionLogFile())) {
            const size = fs.statSync(sessionLogFile()).size;
            console.log(chalk.gray(`   Size: ${Math.round(size / 1024)}KB`));
          }
          // List all log files
          try {
            ensureLogsDir();
            const logFiles = fs.readdirSync(LOGS_DIR).filter(f => f.endsWith('.md')).sort().reverse();
            if (logFiles.length > 0) {
              console.log(chalk.cyan(`\n📋 All session logs:`));
              logFiles.slice(0, 10).forEach((f, i) => {
                const stats = fs.statSync(`${LOGS_DIR}/${f}`);
                const isCurrent = f === `session-${sessionId}.md`;
                const label = isCurrent ? chalk.green(' ← current') : '';
                console.log(chalk.gray(`   ${i + 1}. `) + chalk.white(f) + chalk.gray(` (${Math.round(stats.size / 1024)}KB)`) + label);
              });
              if (logFiles.length > 10) {
                console.log(chalk.gray(`   ... and ${logFiles.length - 10} more`));
              }
            }
          } catch (e) {}
          continue;
        }
        
        if (parts[1] === 'stats') {
          // Show session statistics
          const stats = getSessionStats();
          console.log();
          console.log(box(
            `${chalk.white('Session Duration:')} ${chalk.cyan(formatElapsed(stats.totalDuration))}\n` +
            `${chalk.white('User Messages:')}   ${chalk.blue.bold(stats.userMessages)}\n` +
            `${chalk.white('AI Responses:')}    ${chalk.magenta.bold(stats.aiMessages)}\n` +
            `${chalk.white('Tool Calls:')}      ${chalk.yellow.bold(stats.toolCalls)}\n` +
            `${chalk.white('Shell Commands:')}  ${chalk.red.bold(stats.shellCalls)}\n` +
            `${chalk.white('Errors:')}          ${stats.errors > 0 ? chalk.red.bold(stats.errors) : chalk.green.bold(stats.errors)}\n` +
            `${chalk.white('Log Events:')}      ${chalk.gray(activityLog.length + ' total')}`,
            '📊 Session Stats', 'cyan'
          ));
          console.log();
          continue;
        }
        
        if (parts[1] === 'view' && parts[2]) {
          // View a specific log file
          try {
            const logPath = `${LOGS_DIR}/${parts[2]}`;
            if (fs.existsSync(logPath)) {
              const content = fs.readFileSync(logPath, 'utf8');
              console.log(renderMarkdown(content));
            } else {
              console.log(chalk.yellow(`Log file not found: ${parts[2]}`));
            }
          } catch (e) {
            console.log(chalk.red(`Error reading log: ${e.message}`));
          }
          continue;
        }
        
        // Default: show activity timeline
        console.log(renderActivityLog(count));
        continue;
      }
      
      // ═══════════════════════════════════════════════════════════
      // AGENT & SKILL COMMANDS
      // ═══════════════════════════════════════════════════════════
      
      // Handle /agents command - list available agents or create one
      if (input.toLowerCase() === '/agents' || input.toLowerCase() === '/agent') {
        const currentAgents = loadAgents();
        const agentNames = Object.keys(currentAgents);
        if (agentNames.length === 0) {
          console.log(chalk.yellow('\nNo agents found. Create one with /newagent or /agents create <name> <description>'));
        } else {
          console.log();
          let agentList = '';
          for (const [name, agent] of Object.entries(currentAgents)) {
            const active = currentAgent === name ? chalk.green(' ◀ ACTIVE') : '';
            const toolsBadge = agent.tools ? chalk.gray(` [${agent.tools.join(', ')}]`) : chalk.gray(' [all tools]');
            agentList += `${chalk.cyan('/' + name)} ${chalk.gray('─')} ${chalk.white(agent.description)}${toolsBadge}${active}\n`;
            if (agent.argumentHint) {
              agentList += `   ${chalk.gray('💡 ' + agent.argumentHint)}\n`;
            }
          }
          agentList += `\n${chalk.gray('Usage:')} ${chalk.cyan('/agentname prompt')} to switch & chat`;
          agentList += `\n${chalk.gray('Create:')} ${chalk.cyan('/agents create <name> <description>')}`;
          agentList += `\n${chalk.gray('Format:')} Supports YAML frontmatter (name, description, tools, argument-hint)`;
          console.log(box(agentList.trim(), '🤖 Available Agents', 'cyan'));
        }
        console.log();
        continue;
      }
      
      // Handle /agents create <name> <description> - quick agent creation
      if (input.toLowerCase().startsWith('/agents create ')) {
        const rest = input.slice('/agents create '.length).trim();
        const parts = rest.split(/\s+/);
        const agentName = (parts[0] || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
        const description = parts.slice(1).join(' ').trim();
        
        if (!agentName) {
          console.log(chalk.yellow('\nUsage: /agents create <name> <description>'));
          console.log(chalk.gray('Example: /agents create salesmanager handles sales strategies and customer relations'));
          continue;
        }
        
        ensureAgentsDirs();
        const agentFile = join(AGENTS_DIR, `${agentName}.md`);
        if (fs.existsSync(agentFile)) {
          console.log(chalk.yellow(`\nAgent "${agentName}" already exists. Edit it at: ${agentFile}`));
          continue;
        }
        
        const agentTitle = agentName.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        const agentMd = `---\nname: "${agentTitle}"\ndescription: "${description || agentTitle + ' assistant'}"\ntools: [read, edit, write, list, search, shell]\n---\n\n# ${agentTitle}\n\nYou are a ${agentTitle} AI assistant working within Sapper.\n${description ? `Your role: ${description}\n` : ''}\nAdapt your responses to match this role. Use Sapper's tools (file read/write, shell commands, search) when needed to assist the user.\n`;
        
        fs.writeFileSync(agentFile, agentMd);
        console.log(chalk.green(`\n✅ Agent "${agentName}" created!`));
        console.log(chalk.gray(`   File: ${agentFile}`));
        console.log(chalk.cyan(`   Use it: /${agentName} <your prompt>`));
        continue;
      }
      
      // Handle /skills command - list available skills
      if (input.toLowerCase() === '/skills') {
        const currentSkills = loadSkills();
        const skillNames = Object.keys(currentSkills);
        if (skillNames.length === 0) {
          console.log(chalk.yellow('\nNo skills found. Create one with /newskill'));
        } else {
          console.log();
          let skillList = '';
          for (const [name, skill] of Object.entries(currentSkills)) {
            const loaded = loadedSkills.includes(name) ? chalk.green(' ◀ LOADED') : '';
            skillList += `${chalk.cyan(name)} ${chalk.gray('─')} ${chalk.white(skill.description)}${loaded}\n`;
            if (skill.argumentHint) {
              skillList += `   ${chalk.gray('💡 ' + skill.argumentHint)}\n`;
            }
          }
          skillList += `\n${chalk.gray('Usage:')} ${chalk.cyan('/use skillname')} to load a skill`;
          skillList += `\n${chalk.gray('Format:')} Supports YAML frontmatter (name, description, argument-hint)`;
          console.log(box(skillList.trim(), '📘 Available Skills', 'cyan'));
        }
        console.log();
        continue;
      }
      
      // Handle /default command - switch back to default Sapper
      if (input.toLowerCase() === '/default') {
        currentAgent = null;
        currentAgentTools = null;
        // Rebuild system prompt without agent
        const skillContents = loadedSkills.map(s => {
          const allSkills = loadSkills();
          return allSkills[s]?.content || '';
        }).filter(Boolean);
        messages[0] = { role: 'system', content: buildSystemPrompt(null, skillContents) };
        console.log(chalk.green('\n✅ Switched back to default Sapper mode (all tools enabled)'));
        continue;
      }
      
      // Handle /use command - load a skill
      if (input.toLowerCase().startsWith('/use ')) {
        const skillName = input.slice(5).trim().toLowerCase();
        const currentSkills = loadSkills();
        
        if (!currentSkills[skillName]) {
          console.log(chalk.yellow(`\n❌ Skill "${skillName}" not found.`));
          console.log(chalk.gray(`Available: ${Object.keys(currentSkills).join(', ') || 'none (create with /newskill)'}`));
          continue;
        }
        
        if (loadedSkills.includes(skillName)) {
          console.log(chalk.yellow(`\nSkill "${skillName}" is already loaded.`));
          continue;
        }
        
        loadedSkills.push(skillName);
        
        // Rebuild system prompt with current agent + all loaded skills
        const agentContent = currentAgent ? currentSkills[currentAgent]?.content || loadAgents()[currentAgent]?.content : null;
        const skillContents = loadedSkills.map(s => currentSkills[s]?.content || '').filter(Boolean);
        messages[0] = { role: 'system', content: buildSystemPrompt(agentContent, skillContents) };
        
        console.log(chalk.green(`\n✅ Skill "${skillName}" loaded!`));
        console.log(chalk.gray(`   Active skills: ${loadedSkills.join(', ')}`));
        continue;
      }
      
      // Handle /unload command - unload a skill
      if (input.toLowerCase().startsWith('/unload ')) {
        const skillName = input.slice(8).trim().toLowerCase();
        
        if (!loadedSkills.includes(skillName)) {
          console.log(chalk.yellow(`\nSkill "${skillName}" is not loaded.`));
          console.log(chalk.gray(`Loaded skills: ${loadedSkills.join(', ') || 'none'}`));
          continue;
        }
        
        loadedSkills = loadedSkills.filter(s => s !== skillName);
        
        // Rebuild system prompt
        const allSkills = loadSkills();
        const agentContent = currentAgent ? loadAgents()[currentAgent]?.content : null;
        const skillContents = loadedSkills.map(s => allSkills[s]?.content || '').filter(Boolean);
        messages[0] = { role: 'system', content: buildSystemPrompt(agentContent, skillContents) };
        
        console.log(chalk.green(`\n✅ Skill "${skillName}" unloaded.`));
        if (loadedSkills.length > 0) {
          console.log(chalk.gray(`   Remaining skills: ${loadedSkills.join(', ')}`));
        }
        continue;
      }
      
      // Handle /newagent command - create a new agent
      if (input.toLowerCase() === '/newagent') {
        console.log();
        console.log(box(
          `Create a custom agent with its own persona and expertise.\n` +
          `The agent file will be saved in ${chalk.cyan('.sapper/agents/')}`,
          '🤖 New Agent', 'cyan'
        ));
        
        const agentName = await safeQuestion(chalk.cyan('\nAgent name (lowercase, no spaces): '));
        if (!agentName.trim() || !/^[a-z0-9_-]+$/.test(agentName.trim())) {
          console.log(chalk.yellow('Invalid name. Use lowercase letters, numbers, hyphens, underscores only.'));
          continue;
        }
        
        const agentFile = join(AGENTS_DIR, `${agentName.trim()}.md`);
        if (fs.existsSync(agentFile)) {
          console.log(chalk.yellow(`Agent "${agentName}" already exists. Edit it at: ${agentFile}`));
          continue;
        }
        
        const agentTitle = await safeQuestion(chalk.cyan('Agent title/role: '));
        const agentExpertise = await safeQuestion(chalk.cyan('Areas of expertise (comma-separated): '));
        const agentStyle = await safeQuestion(chalk.cyan('Communication style (e.g., professional, casual, technical): '));
        const agentToolsInput = await safeQuestion(chalk.cyan('Allowed tools (comma-sep, or Enter for all): ') + chalk.gray('read,edit,write,list,search,shell: '));
        
        const expertiseList = agentExpertise.split(',').map(e => `- ${e.trim()}`).join('\n');
        const toolsLine = agentToolsInput.trim() ? `tools: [${agentToolsInput.trim()}]` : 'tools: [read, edit, write, list, search, shell]';
        const agentMd = `---\nname: "${agentTitle.trim() || agentName}"\ndescription: "${agentExpertise.trim() || agentTitle.trim() || agentName}"\n${toolsLine}\n---\n\n# ${agentTitle.trim() || agentName}\n\nYou are a ${agentTitle.trim() || agentName} AI assistant working within Sapper.\n\n## Your Expertise\n${expertiseList}\n\n## Communication Style\n${agentStyle.trim() || 'Professional and helpful'}.\n\nWhen the user asks for help, leverage your expertise and Sapper's tools to provide comprehensive assistance.\n`;
        
        fs.writeFileSync(agentFile, agentMd);
        console.log(chalk.green(`\n✅ Agent "${agentName}" created!`));
        console.log(chalk.gray(`   File: ${agentFile}`));
        console.log(chalk.cyan(`   Use it: /${agentName} <your prompt>`));
        continue;
      }
      
      // Handle /newskill command - create a new skill
      if (input.toLowerCase() === '/newskill') {
        console.log();
        console.log(box(
          `Create a custom skill with domain knowledge.\n` +
          `The skill file will be saved in ${chalk.cyan('.sapper/skills/')}`,
          '📘 New Skill', 'cyan'
        ));
        
        const skillName = await safeQuestion(chalk.cyan('\nSkill name (lowercase, no spaces): '));
        if (!skillName.trim() || !/^[a-z0-9_-]+$/.test(skillName.trim())) {
          console.log(chalk.yellow('Invalid name. Use lowercase letters, numbers, hyphens, underscores only.'));
          continue;
        }
        
        const skillFile = join(SKILLS_DIR, `${skillName.trim()}.md`);
        if (fs.existsSync(skillFile)) {
          console.log(chalk.yellow(`Skill "${skillName}" already exists. Edit it at: ${skillFile}`));
          continue;
        }
        
        const skillTitle = await safeQuestion(chalk.cyan('Skill title: '));
        const skillDesc = await safeQuestion(chalk.cyan('Brief description (for /skills listing): '));
        const skillArgHint = await safeQuestion(chalk.cyan('Argument hint (optional, e.g. "Describe what to do"): '));
        const skillBody = await safeQuestion(chalk.cyan('Skill knowledge (or Enter for template): '));
        
        const descLine = skillDesc.trim() || skillTitle.trim() || skillName;
        const argHintLine = skillArgHint.trim() ? `\nargument-hint: "${skillArgHint.trim()}"` : '';
        
        const skillMd = skillBody.trim() 
          ? `---\nname: ${skillTitle.trim() || skillName}\ndescription: "${descLine}"${argHintLine}\n---\n\n# ${skillTitle.trim() || skillName}\n\n${skillBody.trim()}\n`
          : `---\nname: ${skillTitle.trim() || skillName}\ndescription: "${descLine}"${argHintLine}\n---\n\n# ${skillTitle.trim() || skillName}\n\nBest practices and knowledge for ${skillTitle.trim() || skillName}:\n- [Add your knowledge points here]\n- [Add patterns and conventions]\n- [Add common solutions]\n\n## Commands Reference\n| User says | Action |\n|-----------|--------|\n| "example command" | What the AI should do |\n\n## Procedures\n- [Add step-by-step procedures here]\n`;
        
        fs.writeFileSync(skillFile, skillMd);
        console.log(chalk.green(`\n✅ Skill "${skillName}" created!`));
        console.log(chalk.gray(`   File: ${skillFile}`));
        console.log(chalk.cyan(`   Load it: /use ${skillName}`));
        continue;
      }
      
      // Handle /agentname - detect if input matches an agent name
      let agentHandled = false;
      {
        const currentAgents = loadAgents();
        const inputLower = input.toLowerCase();
        
        // Check if input starts with /agentname (e.g., /salesmanager how do I sell?)
        if (inputLower.startsWith('/') && !inputLower.startsWith('//')) {
          const firstSpace = input.indexOf(' ');
          const cmdPart = firstSpace > 0 ? inputLower.slice(1, firstSpace) : inputLower.slice(1);
          
          if (currentAgents[cmdPart]) {
            const agent = currentAgents[cmdPart];
            const prompt = firstSpace > 0 ? input.slice(firstSpace + 1).trim() : '';
            
            // Switch to this agent
            currentAgent = cmdPart;
            currentAgentTools = agent.tools; // null = all tools, or ['READ','WRITE',...]
            
            // Rebuild system prompt with agent + any loaded skills
            const skillContents = loadedSkills.map(s => {
              const allSkills = loadSkills();
              return allSkills[s]?.content || '';
            }).filter(Boolean);
            messages[0] = { role: 'system', content: buildSystemPrompt(agent.content, skillContents) };
            
            console.log();
            console.log(box(
              `${statusBadge('Active Agent', 'action')} ${chalk.white('/' + cmdPart)}\n` +
              `${keyValue('Role', chalk.white(agent.description), 8)}\n` +
              `${keyValue('Tools', agent.tools ? UI.slate(agent.tools.join(', ')) : UI.slate('all tools'), 8)}`,
              'Agent Mode', 'magenta'
            ));
            
            if (!prompt) {
              console.log(UI.slate('Type your prompt to chat with this agent.'));
              continue; // Just switched, no prompt to send
            }
            
            // Has a prompt - inject it as user message and let AI respond
            messages.push({ role: 'user', content: prompt });
            agentHandled = true;
            // Don't continue - fall through to the AI response loop below
          }
        }
      }
      
      // Handle /fetch command - fetch a URL and add to context
      if (input.toLowerCase().startsWith('/fetch')) {
        const url = input.slice(6).trim();
        if (!url || !url.match(/^https?:\/\//)) {
          console.log(chalk.yellow('Usage: /fetch <url>'));
          console.log(chalk.gray('  Example: /fetch https://docs.example.com/api'));
          continue;
        }
        try {
          const fetchSpinner = ora({ text: chalk.cyan(`🌐 Fetching ${url}...`), spinner: 'dots' }).start();
          const rawContent = await fetchUrl(url);
          fetchSpinner.stop();
          
          const isJson = rawContent.trim().startsWith('{') || rawContent.trim().startsWith('[');
          const isHtml = rawContent.trim().startsWith('<') || rawContent.includes('<html');
          let text;
          if (isJson) {
            try { text = JSON.stringify(JSON.parse(rawContent), null, 2); } catch { text = rawContent; }
          } else if (isHtml) {
            text = htmlToText(rawContent);
          } else {
            text = rawContent;
          }
          
          if (text.trim().length > 0) {
            const webContent = `\n\n══════════════════════════════════════\n🌐 WEB PAGE CONTENT\n══════════════════════════════════════\n\nURL: ${url}\n\n${text}\n`;
            messages.push({ role: 'user', content: `I fetched this web page for reference:\n${webContent}\n\nUse this information to help me.` });
            ensureSapperDir();
            fs.writeFileSync(CONTEXT_FILE, JSON.stringify(messages, null, 2));
            console.log(chalk.green(`🌐 Fetched: ${url} (${Math.round(text.length/1024)}KB)`));
            console.log(chalk.gray('📝 Added to context. AI can now reference this page.\n'));
          } else {
            console.log(chalk.yellow('⚠️  No readable content found on that page.'));
          }
        } catch (e) {
          console.log(chalk.yellow(`⚠️  Could not fetch: ${e.message}`));
        }
        continue;
      }
      
      // Handle recall command - search embeddings
      if (input.toLowerCase().startsWith('/recall')) {
        const query = input.slice(7).trim();
        if (!query) {
          console.log(chalk.yellow('Usage: /recall <search query>'));
          continue;
        }
        
        const embeddings = loadEmbeddings();
        if (embeddings.chunks.length === 0) {
          console.log(chalk.yellow('No memories yet. Use /prune to auto-save conversations.'));
          continue;
        }
        
        console.log(chalk.cyan(`\n🔍 Searching memory for: "${query}"...`));
        const relevant = await findRelevantContext(query, embeddings, 3);
        
        if (relevant.length === 0) {
          console.log(chalk.yellow('No relevant memories found (or embedding model not available).'));
          console.log(chalk.gray('Tip: Run "ollama pull nomic-embed-text" for semantic search.'));
        } else {
          console.log(chalk.green(`Found ${relevant.length} relevant memories:\n`));
          relevant.forEach((chunk, i) => {
            console.log(box(
              chalk.gray(chunk.text.substring(0, 300) + '...') + '\n' +
              chalk.cyan(`Similarity: ${(chunk.score * 100).toFixed(1)}%`),
              `Memory ${i + 1}`, 'magenta'
            ));
            console.log();
          });
          
          // Optionally add to context
          const addToContext = await safeQuestion(chalk.yellow('Add to current context? ') + chalk.gray('(y/n): '));
          if (addToContext.toLowerCase() === 'y') {
            const contextAddition = relevant.map(c => c.text).join('\n---\n');
            messages.push({ 
              role: 'user', 
              content: `Here is relevant context from memory:\n${contextAddition}\n\nUse this information to help me.`
            });
            console.log(chalk.green('✅ Added to context!'));
          }
        }
        continue;
      }
      
      // Handle codebase scan command
      if (input.toLowerCase() === '/scan') {
        console.log(chalk.cyan('\n🔍 Scanning codebase...'));
        const scanResult = scanCodebase('.');
        
        if (scanResult.files.length === 0) {
          console.log(chalk.yellow('No code files found in current directory.'));
          continue;
        }
        
        const formattedScan = formatScanResults(scanResult);
        const includedCount = scanResult.files.filter(f => !f.skipped).length;
        const skippedCount = scanResult.files.filter(f => f.skipped).length;
        
        console.log(chalk.green(`✅ Scanned ${includedCount} files (~${Math.round(scanResult.totalSize/1024)}KB)`));
        if (skippedCount > 0) {
          console.log(chalk.yellow(`⏭️  Skipped ${skippedCount} files (too large or limit reached)`));
        }
        
        // Add scan to context
        messages.push({ 
          role: 'user', 
          content: `I've scanned the entire codebase. Here are all the files:\n${formattedScan}\n\nYou now have the full codebase context. Use this information to help me.`
        });
        
        ensureSapperDir();
        fs.writeFileSync(CONTEXT_FILE, JSON.stringify(messages, null, 2));
        console.log(chalk.gray('📝 Codebase added to context. AI now has full picture.\n'));
        continue;
      }
      
      // Skip input processing if agent already handled it
      if (!agentHandled) {
      // Handle @ alone or /attach command - interactive file picker
      if (input.trim() === '@' || input.toLowerCase() === '/attach') {
        const selectedFiles = await pickFiles();
        
        if (selectedFiles.length === 0) continue;
        
        // Read and attach selected files
        const fileAttachments = [];
        for (const filePath of selectedFiles) {
          try {
            // Check .sapperignore
            if (shouldIgnore(filePath)) {
              console.log(chalk.yellow(`⚠️  ${filePath} is in .sapperignore — skipped`));
              continue;
            }
            const stats = fs.statSync(filePath);
            if (stats.size > MAX_FILE_SIZE) {
              console.log(chalk.red.bold(`\n╔══════════════════════════════════════════════════════════╗`));
              console.log(chalk.red.bold(`║  ⛔ FILE TOO LARGE — Cannot attach                       ║`));
              console.log(chalk.red.bold(`╚══════════════════════════════════════════════════════════╝`));
              console.log(chalk.yellow(`   File: ${filePath}`));
              console.log(chalk.yellow(`   Size: ${Math.round(stats.size/1024)}KB (limit: ${Math.round(MAX_FILE_SIZE/1024)}KB)`));
              console.log(chalk.gray(`   Tip: Use a smaller file or increase limit in .sapper/config.json\n`));
              continue;
            }
            const content = fs.readFileSync(filePath, 'utf8');
            fileAttachments.push({ path: filePath, content, size: stats.size });
            console.log(chalk.green(`📎 Attached: ${filePath} (${Math.round(stats.size/1024)}KB)`));
          } catch (e) {
            console.log(chalk.yellow(`⚠️  Could not read ${filePath}`));
          }
        }
        
        if (fileAttachments.length === 0) continue;
        
        // Ask for the prompt to go with these files
        console.log();
        const prompt = await safeQuestion(chalk.cyan('Your prompt for these files: '));
        
        if (!prompt.trim()) {
          console.log(chalk.gray('Cancelled.'));
          continue;
        }
        
        // Build message with attachments
        let attachedContent = '\n\n══════════════════════════════════════\n';
        attachedContent += `📎 ATTACHED FILES (${fileAttachments.length})\n`;
        attachedContent += '══════════════════════════════════════\n\n';
        
        for (const file of fileAttachments) {
          attachedContent += `┌─── ${file.path} ───\n`;
          attachedContent += file.content;
          if (!file.content.endsWith('\n')) attachedContent += '\n';
          attachedContent += `└─── END ${file.path} ───\n\n`;
        }
        
        messages.push({ role: 'user', content: prompt + attachedContent });
        // Continue to AI response (don't use 'continue' here)
      } else {
        // Process @file attachments in prompt (e.g., "analyze @package.json" or "fix @src/index.js")
      let processedInput = input;
      const fileAttachments = [];
      const attachRegex = /@([\w.\/\-_]+)/g;
      let attachMatch;
      
      while ((attachMatch = attachRegex.exec(input)) !== null) {
        const filePath = attachMatch[1];
        try {
          if (fs.existsSync(filePath)) {
            // Check .sapperignore
            if (shouldIgnore(filePath)) {
              console.log(chalk.yellow(`⚠️  @${filePath} is in .sapperignore — skipped`));
              continue;
            }
            const stats = fs.statSync(filePath);
            if (stats.isFile()) {
              if (stats.size > MAX_FILE_SIZE) {
                console.log(chalk.red.bold(`\n╔══════════════════════════════════════════════════════════╗`));
                console.log(chalk.red.bold(`║  ⛔ FILE TOO LARGE — Cannot attach @${filePath.padEnd(22).slice(0, 22)}║`));
                console.log(chalk.red.bold(`╚══════════════════════════════════════════════════════════╝`));
                console.log(chalk.yellow(`   Size: ${Math.round(stats.size/1024)}KB — exceeds ${Math.round(MAX_FILE_SIZE/1024)}KB limit`));
                console.log(chalk.gray(`   Tip: Use a smaller file or increase limit in .sapper/config.json\n`));
              } else {
                const content = fs.readFileSync(filePath, 'utf8');
                fileAttachments.push({ path: filePath, content, size: stats.size });
                console.log(chalk.green(`📎 Attached: ${filePath} (${Math.round(stats.size/1024)}KB)`));
                
                // Auto-include related files from workspace graph (up to 3) - if enabled
                if (sapperConfig.autoAttach) {
                const related = getRelatedFiles(filePath, workspace, 1);
                for (const relFile of related.slice(0, 3)) {
                  try {
                    if (!fileAttachments.some(f => f.path === relFile)) {
                      const relStats = fs.statSync(relFile);
                      if (relStats.size <= MAX_FILE_SIZE) {
                        const relContent = fs.readFileSync(relFile, 'utf8');
                        fileAttachments.push({ path: relFile, content: relContent, size: relStats.size, related: true });
                        console.log(chalk.gray(`   ↳ +${relFile} (related)`));
                      }
                    }
                  } catch (e) {}
                }
                } // end if autoAttach
              }
            }
          } else {
            // Not a file - might be an @mention for something else, ignore
          }
        } catch (e) {
          console.log(chalk.yellow(`⚠️  Could not read @${filePath}: ${e.message}`));
        }
      }
      
      // Build the final message with attachments
      if (fileAttachments.length > 0) {
        let attachedContent = '\n\n══════════════════════════════════════\n';
        attachedContent += `📎 ATTACHED FILES (${fileAttachments.length})\n`;
        attachedContent += '══════════════════════════════════════\n\n';
        
        for (const file of fileAttachments) {
          attachedContent += `┌─── ${file.path} ───\n`;
          attachedContent += file.content;
          if (!file.content.endsWith('\n')) attachedContent += '\n';
          attachedContent += `└─── END ${file.path} ───\n\n`;
        }
        
        processedInput = input + attachedContent;
      }
      
      // ── Detect and fetch URLs in the message ──
      const urlMatches = input.match(URL_REGEX);
      if (urlMatches && urlMatches.length > 0) {
        const uniqueUrls = [...new Set(urlMatches)].slice(0, 5); // Max 5 URLs
        const urlContents = [];
        
        for (const url of uniqueUrls) {
          try {
            const urlSpinner = ora({ text: chalk.cyan(`🌐 Fetching ${url}...`), spinner: 'dots' }).start();
            const rawContent = await fetchUrl(url);
            urlSpinner.stop();
            
            // Detect content type
            const isJson = rawContent.trim().startsWith('{') || rawContent.trim().startsWith('[');
            const isHtml = rawContent.trim().startsWith('<') || rawContent.includes('<html');
            
            let text;
            if (isJson) {
              // Pretty-print JSON
              try { text = JSON.stringify(JSON.parse(rawContent), null, 2); } 
              catch { text = rawContent; }
            } else if (isHtml) {
              text = htmlToText(rawContent);
            } else {
              text = rawContent; // Plain text, markdown, etc.
            }
            
            if (text.trim().length > 0) {
              urlContents.push({ url, content: text, size: text.length });
              console.log(chalk.green(`🌐 Fetched: ${url} (${Math.round(text.length/1024)}KB)`));
            } else {
              console.log(chalk.yellow(`⚠️  ${url} — no readable content`));
            }
          } catch (e) {
            console.log(chalk.yellow(`⚠️  Could not fetch ${url}: ${e.message}`));
          }
        }
        
        if (urlContents.length > 0) {
          let urlAttached = '\n\n══════════════════════════════════════\n';
          urlAttached += `🌐 FETCHED WEB PAGES (${urlContents.length})\n`;
          urlAttached += '══════════════════════════════════════\n\n';
          
          for (const page of urlContents) {
            urlAttached += `┌─── ${page.url} ───\n`;
            urlAttached += page.content;
            if (!page.content.endsWith('\n')) urlAttached += '\n';
            urlAttached += `└─── END ${page.url} ───\n\n`;
          }
          
          processedInput = processedInput + urlAttached;
        }
      }
      
      messages.push({ role: 'user', content: processedInput });

      // Log user input
      logEntry('user', {
        message: processedInput,
        attachments: fileAttachments.map(f => f.path)
      });

      } // End of else block for non-@ input
      } // End of if (!agentHandled)

      let toolRounds = 0; // Prevent infinite loops
      const MAX_TOOL_ROUNDS = 20;
      const patchFailures = {}; // Track consecutive PATCH failures per file: { path: count }
      const MAX_PATCH_RETRIES = 3;
      
      let active = true;
      while (active) {
        if (stepMode) await safeQuestion(chalk.gray('[STEP] Press Enter to let AI think...'));
        
        spinner.start('Thinking...');
        const aiStartTime = Date.now();
        let response;
        try {
          // Build chat options — pass native tools when supported
          const chatOpts = { model: selectedModel, messages, stream: true };
          if (effectiveContextLength()) {
            chatOpts.options = { num_ctx: effectiveContextLength() };
          }
          // Enable thinking for reasoning models (deepseek-r1, qwq, etc.)
          chatOpts.think = true;
          if (useNativeTools) {
            // Filter tool defs by agent restrictions if any
            if (currentAgentTools) {
              const toolNameMap = {
                list_directory: 'LIST', read_file: 'READ', search_files: 'SEARCH',
                write_file: 'WRITE', patch_file: 'PATCH', create_directory: 'MKDIR', run_shell: 'SHELL'
              };
              chatOpts.tools = nativeToolDefs.filter(t => 
                currentAgentTools.includes(toolNameMap[t.function.name])
              );
            } else {
              chatOpts.tools = nativeToolDefs;
            }
          }
          response = await ollama.chat(chatOpts);
        } catch (ollamaError) {
          spinner.stop();
          console.error(chalk.red('\n❌ Ollama error:'), ollamaError.message);
          logEntry('error', { message: `Ollama error: ${ollamaError.message}` });
          active = false;
          continue;
        }
        spinner.stop();

        let msg = '';
        let thinkMsg = ''; // Thinking/reasoning content from thinking models
        const MAX_RESPONSE_LENGTH = 100000; // 100KB - allow long code generation
        let lastChunkTime = Date.now();
        let repetitionCount = 0;
        let lastContent = '';
        let wasInterrupted = false;
        let wasRepetitionStopped = false;
        let nativeToolCalls = []; // Collect native tool_calls from streaming chunks
        abortStream = false; // Reset abort flag before streaming
        let chunkPromptTokens = 0; // Track actual tokens from Ollama
        let chunkEvalTokens = 0;
        let isThinking = false; // Track if we're currently in thinking mode
        const genStartTime = Date.now(); // Track generation elapsed time
        let genTokenCount = 0; // Count response tokens as they stream
        
        console.log(sectionTitle('Sapper', selectedModel, 'cyan'));
        for await (const chunk of response) {
          // Check if user pressed Ctrl+C
          if (abortStream) {
            console.log(UI.slate('\n[response interrupted]'));
            wasInterrupted = true;
            break;
          }
          
          // Handle thinking/reasoning content (deepseek-r1, qwq, etc.)
          const thinking = chunk.message.thinking;
          if (thinking) {
            if (!isThinking) {
              isThinking = true;
              process.stdout.write(`\n${UI.slate.italic('  ◇ Thinking')}\n${UI.slate('  │ ')}`);
            }
            // Live-stream thinking — dim italic, wrap at line breaks
            const lines = thinking.split('\n');
            for (let li = 0; li < lines.length; li++) {
              if (li > 0) process.stdout.write(`\n${UI.slate('  │ ')}`);
              process.stdout.write(UI.slate.italic(lines[li]));
            }
            thinkMsg += thinking;
          }
          
          const content = chunk.message.content;
          if (content) {
            if (isThinking) {
              isThinking = false;
              process.stdout.write(`\n${UI.slate('  └─')}\n\n`);
            }
            msg += content;
            genTokenCount++;
            // Show live progress with timer, tokens, and interrupt hint
            const elapsed = ((Date.now() - genStartTime) / 1000).toFixed(1);
            const tps = genTokenCount / Math.max((Date.now() - genStartTime) / 1000, 0.1);
            process.stdout.write(`\r  ${UI.slate(`Generating... ${genTokenCount} tokens · ${elapsed}s · ${tps.toFixed(1)} t/s`)}  ${UI.slate.italic('Ctrl+C to stop')}`);
          }
          
          // Capture token stats from the final chunk (done: true)
          if (chunk.prompt_eval_count) chunkPromptTokens = chunk.prompt_eval_count;
          if (chunk.eval_count) chunkEvalTokens = chunk.eval_count;
          
          // Collect native tool_calls (arrive in chunks, usually the final one)
          if (chunk.message.tool_calls && chunk.message.tool_calls.length > 0) {
            nativeToolCalls.push(...chunk.message.tool_calls);
          }
          
          // Smart loop detection: check for repetitive content patterns
          if (msg.length > 10000) {
            const recentContent = msg.slice(-500);
            const previousContent = msg.slice(-1000, -500);
            
            // If last 500 chars are very similar to previous 500, might be looping
            if (recentContent === previousContent) {
              repetitionCount++;
              if (repetitionCount > 3) {
                console.log(chalk.red('\n\n⚠️ REPETITIVE OUTPUT DETECTED: Stopping to prevent loop.'));
                wasRepetitionStopped = true;
                break;
              }
            } else {
              repetitionCount = 0;
            }
          }
          
          // Hard limit as final safety net
          if (msg.length > MAX_RESPONSE_LENGTH) {
            console.log(chalk.yellow('\n\n⚠️ Response very long (100KB+). Continuing... (Ctrl+C to stop)'));
            // Don't break - just warn. User can Ctrl+C if needed
          }
        }
        // Clear progress line and render formatted markdown
        process.stdout.write('\r\x1b[K');
        if (msg.trim()) {
          console.log(renderMarkdown(msg));
        } else {
          console.log();
        }

        // Update global token tracking from actual Ollama response
        if (chunkPromptTokens > 0) {
          lastPromptTokens = chunkPromptTokens;
          lastEvalTokens = chunkEvalTokens;
          const totalTokens = chunkPromptTokens + chunkEvalTokens;
          const ctxLenDisplay = effectiveContextLength();
          if (ctxLenDisplay) {
            const usagePercent = Math.round((totalTokens / ctxLenDisplay) * 100);
            const thinkNote = thinkMsg ? ` · ${UI.slate.italic(`${thinkMsg.length.toLocaleString()} chars thinking`)}` : '';
            console.log(`${meter(totalTokens, ctxLenDisplay, 22)} ${UI.slate(`${chunkPromptTokens.toLocaleString()} prompt · ${chunkEvalTokens.toLocaleString()} response · ${usagePercent}% of context`)}${thinkNote}`);
          }
        }
        console.log(divider('─', 'gray', 56));

        const aiDuration = Date.now() - aiStartTime;
        // Build assistant message — include tool_calls and thinking if present
        const assistantMsg = { role: 'assistant', content: msg };
        if (thinkMsg) {
          assistantMsg.thinking = thinkMsg;
        }
        if (nativeToolCalls.length > 0) {
          assistantMsg.tool_calls = nativeToolCalls;
        }
        messages.push(assistantMsg);

        // If interrupted, skip tool processing — go straight back to prompt
        if (wasInterrupted) {
          ensureSapperDir();
          fs.writeFileSync(CONTEXT_FILE, JSON.stringify(messages, null, 2));
          active = false;
          resetTerminal();
          continue;
        }

        // Log AI response
        logEntry('ai', {
          charCount: msg.length,
          duration: aiDuration,
          toolCount: nativeToolCalls.length || 0, // Updated below if text-marker tools found
          interrupted: wasInterrupted,
          repetitionStopped: wasRepetitionStopped,
          preview: msg.replace(/\[TOOL:[^\]]*\][\s\S]*?\[\/TOOL\]/g, '[tool call]')
        });

        // ═══ NATIVE TOOL CALLS HANDLER ═══════════════════════════════════
        if (nativeToolCalls.length > 0) {
          toolRounds++;
          let hitToolLimit = false;
          if (toolRounds >= MAX_TOOL_ROUNDS) {
            console.log(chalk.yellow(`\n⚠️  Tool limit reached (${MAX_TOOL_ROUNDS} rounds). Processing remaining tools then stopping.`));
            hitToolLimit = true;
          }

          // Map native function names to tool executors
          const nativeToolNameMap = {
            list_directory: 'LIST', read_file: 'READ', search_files: 'SEARCH',
            write_file: 'WRITE', patch_file: 'PATCH', create_directory: 'MKDIR', run_shell: 'SHELL'
          };

          for (const tc of nativeToolCalls) {
            const fn = tc.function;
            const toolType = nativeToolNameMap[fn.name] || fn.name.toUpperCase();
            const args = fn.arguments || {};

            // Enforce agent tool restrictions
            if (currentAgentTools && !currentAgentTools.includes(toolType)) {
              console.log(chalk.yellow(`\n⚠️  Tool ${toolType} blocked — not in agent's allowed tools`));
              messages.push({ role: 'tool', content: `Error: Tool ${toolType} is not allowed for the current agent.`, tool_name: fn.name });
              continue;
            }

            const displayPath = args.path || args.pattern || args.command || '';
            console.log();
            console.log(statusBadge(toolType, 'action') + chalk.gray(' → ') + chalk.white(displayPath));

            const toolStart = Date.now();
            let result;
            let toolSuccess = true;

            try {
              switch (fn.name) {
                case 'list_directory':
                  result = tools.list(args.path);
                  logEntry('file', { action: 'list', path: args.path });
                  break;
                case 'read_file':
                  result = tools.read(args.path);
                  logEntry('file', { action: 'read', path: args.path, size: result?.length || 0 });
                  break;
                case 'search_files':
                  result = await tools.search(args.pattern);
                  logEntry('tool', { toolType: 'SEARCH', path: args.pattern, duration: Date.now() - toolStart, success: true, resultSize: result?.length });
                  break;
                case 'write_file':
                  result = await tools.write(args.path, args.content);
                  logEntry('file', { action: 'write', path: args.path, size: args.content?.length || 0, userApproved: result.includes('Successfully') });
                  break;
                case 'patch_file': {
                  const patchKey = args.path?.trim();
                  if (patchFailures[patchKey] >= MAX_PATCH_RETRIES) {
                    result = `Error: PATCH failed ${MAX_PATCH_RETRIES} times on ${patchKey}. Use read_file to see exact content, then try write_file instead.`;
                    toolSuccess = false;
                  } else {
                    result = await tools.patch(args.path, args.old_text, args.new_text);
                    if (result.includes('Successfully')) {
                      patchFailures[patchKey] = 0;
                    } else if (result.startsWith('Error:')) {
                      patchFailures[patchKey] = (patchFailures[patchKey] || 0) + 1;
                      result += `\n(Attempt ${patchFailures[patchKey]}/${MAX_PATCH_RETRIES})`;
                    }
                  }
                  logEntry('file', { action: 'patch', path: args.path, userApproved: result.includes('Successfully') });
                  break;
                }
                case 'create_directory':
                  result = tools.mkdir(args.path);
                  logEntry('file', { action: 'mkdir', path: args.path });
                  break;
                case 'run_shell':
                  result = await tools.shell(args.command);
                  logEntry('shell', { command: args.command, duration: Date.now() - toolStart, userApproved: !result.includes('blocked'), exitCode: result.match(/code (\d+)/)?.[1] ?? null });
                  break;
                default:
                  result = `Unknown tool: ${fn.name}`;
                  toolSuccess = false;
              }
            } catch (toolError) {
              result = `Error executing ${fn.name}: ${toolError.message}`;
              toolSuccess = false;
              logEntry('error', { message: result });
            }

            // Feed result back as tool role message (Ollama native format)
            messages.push({ role: 'tool', content: String(result), tool_name: fn.name });
          }

          // Save context
          ensureSapperDir();
          fs.writeFileSync(CONTEXT_FILE, JSON.stringify(messages, null, 2));

          if (hitToolLimit) {
            resetTerminal();
            messages.push({ role: 'user', content: 'STOP using tools now. Provide your analysis based on what you have.' });
          }
          continue; // Loop back for AI to process tool results
        }

        // ═══ TEXT-MARKER TOOL PARSING (fallback for models without native tool support) ═══
        // Strip markdown code blocks before tool parsing to avoid executing tool examples
        let msgForToolParsing = msg.replace(/```[\s\S]*?```/g, '');

        // Check for unclosed tool calls and auto-close them instead of burning AI rounds
        const hasUnclosedTool = msgForToolParsing.includes('[TOOL:') && !msgForToolParsing.includes('[/TOOL]');
        if (hasUnclosedTool) {
          console.log(chalk.yellow('\n⚠️  Unclosed tool detected — auto-closing with [/TOOL]'));
          msgForToolParsing += '[/TOOL]';
        }

        // Regex: supports both old format (path]content) and new format (path:::content)
        const toolMatches = [...msgForToolParsing.matchAll(/\[TOOL:(\w+)\]([^:\]]*?)(?:(?:::|\])([\s\S]*?))?\[\/TOOL\]/g)];
        
        // Debug mode: show what regex sees
        if (debugMode) {
          console.log(chalk.magenta('\n═══ DEBUG: REGEX ANALYSIS ═══'));
          console.log(chalk.gray(`Response length: ${msg.length} chars`));
          
          // Check for tool-like patterns
          const hasToolStart = msg.includes('[TOOL:');
          const hasToolEnd = msg.includes('[/TOOL]');
          const hasBrokenEnd = msg.includes('[/]') || msg.includes('[/WRITE]') || msg.includes('[/READ]');
          
          console.log(chalk.gray(`Contains [TOOL:: ${hasToolStart ? chalk.green('YES') : chalk.red('NO')}`));
          console.log(chalk.gray(`Contains [/TOOL]: ${hasToolEnd ? chalk.green('YES') : chalk.red('NO')}`));
          if (hasBrokenEnd) {
            console.log(chalk.red(`⚠️  Found broken closing tag: [/] or [/WRITE] etc.`));
          }
          
          console.log(chalk.gray(`Matches found: ${toolMatches.length}`));
          
          if (toolMatches.length > 0) {
            toolMatches.forEach((m, i) => {
              console.log(chalk.cyan(`  Match ${i+1}: type=${m[1]}, path=${m[2]?.substring(0,50)}...`));
            });
          } else if (hasToolStart) {
            // Show the raw tool attempt for debugging
            const toolAttempt = msg.match(/\[TOOL:[^\]]*\][^\[]{0,100}/s);
            if (toolAttempt) {
              console.log(chalk.yellow(`  Raw tool attempt (first 150 chars):`));
              console.log(chalk.gray(`  "${toolAttempt[0].substring(0, 150)}..."`));
            }
          }
          console.log(chalk.magenta('═══════════════════════════════\n'));
        }
        
        if (toolMatches.length > 0) {
          toolRounds++;
          
          // Track if we hit the tool limit — still process this round's tools, then stop
          let hitToolLimit = false;
          if (toolRounds >= MAX_TOOL_ROUNDS) {
            console.log(chalk.yellow(`\n⚠️  Tool limit reached (${MAX_TOOL_ROUNDS} rounds). Processing remaining tools then stopping.`));
            console.log(chalk.gray('💡 Tip: Type /prune after analysis to reduce context size.'));
            hitToolLimit = true;
          }
          
          // Update the AI log entry with tool count
          if (activityLog.length > 0) {
            const lastAiLog = [...activityLog].reverse().find(e => e.type === 'ai');
            if (lastAiLog) lastAiLog.toolCount = toolMatches.length;
          }

          for (const match of toolMatches) {
            const [_, type, path, content] = match;
            
            // Enforce tool restrictions from active agent
            if (currentAgentTools && !currentAgentTools.includes(type.toUpperCase())) {
              console.log();
              console.log(chalk.yellow(`⚠️  Tool ${type.toUpperCase()} blocked — not in agent's allowed tools: [${currentAgentTools.join(', ')}]`));
              const result = `Error: Tool ${type.toUpperCase()} is not allowed for the current agent. Allowed tools: ${currentAgentTools.join(', ')}. Use only the allowed tools.`;
              messages.push({ role: 'user', content: `RESULT (${path}): ${result}` });
              logEntry('tool', { toolType: type.toUpperCase(), path, duration: 0, success: false, error: 'blocked by agent tool restriction' });
              continue;
            }
            
            console.log();
            console.log(statusBadge(type.toUpperCase(), 'action') + chalk.gray(' → ') + chalk.white(path));
            
            const toolStart = Date.now();
            let result;
            let toolSuccess = true;
            if (type.toLowerCase() === 'list') {
              result = tools.list(path);
              logEntry('file', { action: 'list', path });
            }
            else if (type.toLowerCase() === 'read') {
              result = tools.read(path);
              logEntry('file', { action: 'read', path, size: result?.length || 0 });
            }
            else if (type.toLowerCase() === 'mkdir') {
              result = tools.mkdir(path);
              logEntry('file', { action: 'mkdir', path });
            }
            else if (type.toLowerCase() === 'write') {
              if (!content || content.trim() === '') {
                result = 'Error: WRITE requires content. Use [TOOL:WRITE]path]content here[/TOOL]';
                toolSuccess = false;
              } else {
                result = await tools.write(path, content);
                const approved = result.includes('Successfully');
                logEntry('file', { action: 'write', path, size: content.length, userApproved: approved });
              }
            }
            else if (type.toLowerCase() === 'patch') {
              // PATCH format: [TOOL:PATCH]path:::OLD_TEXT|||NEW_TEXT[/TOOL]
              // Also supports line mode: [TOOL:PATCH]path:::LINE:15|||new text[/TOOL]
              const patchKey = path.trim();
              if (patchFailures[patchKey] >= MAX_PATCH_RETRIES) {
                result = `Error: PATCH failed ${MAX_PATCH_RETRIES} times on ${patchKey}. STOP retrying PATCH on this file. Instead, use [TOOL:READ]${patchKey}[/TOOL] to see exact content, then either use LINE:number mode (e.g. [TOOL:PATCH]${patchKey}:::LINE:42|||new text[/TOOL]) or use [TOOL:WRITE] to rewrite the file.`;
                toolSuccess = false;
                logEntry('file', { action: 'patch', path, userApproved: false });
              } else {
                // Accept ||| as primary separator, ||: as fallback (small models sometimes mistype)
                let parts = content?.split('|||');
                if (!parts || parts.length !== 2) {
                  parts = content?.split('||:');
                }
                if (parts && parts.length === 2) {
                  result = await tools.patch(path, parts[0], parts[1]);
                  const approved = result.includes('Successfully');
                  if (!approved && result.startsWith('Error:')) {
                    patchFailures[patchKey] = (patchFailures[patchKey] || 0) + 1;
                    result += `\n(Attempt ${patchFailures[patchKey]}/${MAX_PATCH_RETRIES} — after ${MAX_PATCH_RETRIES} failures, PATCH will be blocked on this file)`;
                  } else if (approved) {
                    patchFailures[patchKey] = 0; // Reset on success
                  }
                  logEntry('file', { action: 'patch', path, userApproved: approved });
                } else {
                  result = 'Error: PATCH requires format [TOOL:PATCH]path:::OLD_TEXT|||NEW_TEXT[/TOOL] or [TOOL:PATCH]path:::LINE:number|||NEW_TEXT[/TOOL]';
                  toolSuccess = false;
                }
              }
            }
            else if (type.toLowerCase() === 'search') {
              result = await tools.search(path);
              logEntry('tool', { toolType: 'SEARCH', path, duration: Date.now() - toolStart, success: true, resultSize: result?.length });
            }
            else if (type.toLowerCase() === 'shell') {
              result = await tools.shell(path);
              const approved = !result.includes('blocked');
              logEntry('shell', { command: path, duration: Date.now() - toolStart, userApproved: approved, exitCode: result.match(/code (\d+)/)?.[1] ?? null });
            }

            // Log tool execution (for non-shell, non-file specific ones)
            if (!['list', 'read', 'mkdir', 'write', 'patch', 'search', 'shell'].includes(type.toLowerCase())) {
              logEntry('tool', { toolType: type.toUpperCase(), path, duration: Date.now() - toolStart, success: toolSuccess, resultSize: result?.length, error: toolSuccess ? undefined : result });
            }

            messages.push({ role: 'user', content: `RESULT (${path}): ${result}` });
          }
          ensureSapperDir();
          fs.writeFileSync(CONTEXT_FILE, JSON.stringify(messages, null, 2));
          
          if (toolMatches.length > 30) {
            console.log(chalk.yellow('\n⚠️  Reading 30+ files! This might take time.'));
          }
          
          // If tool limit was reached, stop after processing this round
          if (hitToolLimit) {
            resetTerminal();
            messages.push({ 
              role: 'user', 
              content: 'STOP using tools now. You have enough information. Please provide your analysis based on what you have read.' 
            });
          }
        } else {
          // No tools found - check if malformed command
          if (msg.includes('[TOOL:') && msg.includes('[/]')) {
            console.log(chalk.red('\n❌ Malformed tool command detected!'));
            messages.push({ 
              role: 'user', 
              content: 'ERROR: Your tool command is malformed. Use [TOOL:TYPE]path]content[/TOOL] or [TOOL:TYPE]path[/TOOL]' 
            });
          } else {
            // Normal response - save and wait for next input
            ensureSapperDir();
            fs.writeFileSync(CONTEXT_FILE, JSON.stringify(messages, null, 2));
            active = false;
            spinner.stop(); // Ensure spinner is dead
            resetTerminal(); // Force terminal back to normal state
            process.stdout.write('\n'); // Force newline to break out of stream mode
          }
        }
      }
    } catch (error) {
      console.error(chalk.red('\n❌ Error:'), error.message);
      logEntry('error', { message: error.message });
      // Loop continues automatically
    }
  }
}

// Keep-alive interval - prevents Node from exiting when event loop is empty
setInterval(() => {}, 1000);

runSapper();
