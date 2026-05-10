#!/usr/bin/env node
import ollama from 'ollama';
import fs from 'fs';
import { spawn } from 'child_process';
import chalk from 'chalk';
import ora from 'ora';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { dirname, join, isAbsolute, resolve as pathResolve } from 'path';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import { highlight as highlightCode } from 'cli-highlight';
import * as acorn from 'acorn';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function safeCwd() {
  try {
    return process.cwd();
  } catch (error) {
    const pwdCandidate = process.env.PWD;
    const homeCandidate = process.env.HOME;
    const fallback = [pwdCandidate, homeCandidate, __dirname].find((value) => value && fs.existsSync(value));

    if (fallback) {
      try {
        process.chdir(fallback);
      } catch (chdirError) {
        // Ignore and continue to final fallback return.
      }
    }

    try {
      return process.cwd();
    } catch (cwdError) {
      return __dirname;
    }
  }
}

const PROJECT_ROOT = safeCwd();

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
  setTimeout(() => { ctrlCCount = 0; }, LIMITS.CTRL_C_RESET_MS);
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
const LONG_MEMORY_FILE = `${SAPPER_DIR}/long-memory.md`;
const WORKSPACE_FILE = `${SAPPER_DIR}/workspace.json`;
const CONFIG_FILE = `${SAPPER_DIR}/config.json`;
const AGENTS_DIR = `${SAPPER_DIR}/agents`;
const SKILLS_DIR = `${SAPPER_DIR}/skills`;
const LOGS_DIR = `${SAPPER_DIR}/logs`;
const SAPPERIGNORE_FILE = '.sapperignore';

// ═══════════════════════════════════════════════════════════════
// CENTRALIZED LIMITS & THRESHOLDS
// ═══════════════════════════════════════════════════════════════
const LIMITS = Object.freeze({
  // Timeouts (milliseconds)
  CTRL_C_RESET_MS:        2000,
  FETCH_URL_TIMEOUT_MS:   15000,

  // Context & summarization
  CONTEXT_BYTE_FALLBACK:  32000,    // Byte threshold when token count unavailable
  SUMMARY_RECENT_MSGS:    4,        // Recent messages preserved during summarization
  MSG_TRUNCATION_CHARS:   1500,     // Max chars per message when building summary text
  SUMMARY_MAX_WORDS:      800,      // Target word count for summary output

  // Embeddings
  EMBEDDINGS_MAX_TEXT:     2000,     // Max chars stored per embedding chunk
  EMBEDDINGS_MAX_CHUNKS:  100,      // Max chunks kept in embeddings file
  EMBEDDING_SIMILARITY:   0.5,      // Cosine similarity threshold for recall
  EMBEDDING_TOP_K:        3,        // Default top-K results from memory search
  EMBEDDING_MIN_TEXT:     50,       // Minimum text length to bother embedding

  // Streaming & response
  MAX_RESPONSE_LENGTH:    100000,   // 100KB hard cap on AI response size
  REPETITION_WINDOW:      500,      // Chars to compare for loop detection
  REPETITION_THRESHOLD:   10000,    // Min response length before checking for loops
  REPETITION_COUNT:       3,        // Repeats before stopping

  // Display
  LOG_PREVIEW_CHARS:      500,      // Max chars in activity log preview
  LOG_AI_PREVIEW_CHARS:   800,      // Max chars in AI response log preview
  INPUT_PREVIEW_CHARS:    120,      // Max chars shown for user input preview
  TERMINAL_WIDTH_MAX:     90,       // Max width for activity log box
  SYMBOL_RESULTS_MAX:     15,       // Max results before "and N more" in /symbol
  LOG_FILES_DISPLAY_MAX:  10,       // Max log files shown in /log list
  MEMORY_PREVIEW_CHARS:   300,      // Chars shown in /recall results
  DEBUG_TOOL_PREVIEW:     150,      // Chars shown in debug tool attempt

  // Content limits
  WEB_CONTENT_MAX_CHARS:  50000,    // Max chars from fetched web content
  TOOL_WARN_THRESHOLD:    30,       // Tool calls per round before warning

  // Shell
  SHELL_MIN_BG_SECONDS:   2,       // Min seconds for background shell config
  SHELL_MAX_BG_SECONDS:   120,     // Max seconds for background shell config
  SHELL_MIN_CHUNK_CHARS:  400,     // Min chars for shell output chunk config
  SHELL_MAX_CHUNK_CHARS:  12000,   // Max chars for shell output chunk config
  SHELL_MAX_BUFFER:       50000,   // Max buffered shell output chars

  // Workspace & scanning
  WORKSPACE_FILES_PER_DIR: 10,     // Files shown per directory in workspace summary
  WORKSPACE_RELATED_DEPTH: 5,      // Max related files from dependency graph
  FILE_SUMMARY_PREVIEW:    150,    // Chars for file content summary
});

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
      line += `**Working Directory:** \`${safeCwd()}\`\n\n`;
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
        line += `\`\`\`\n${entry.message?.substring(0, LIMITS.LOG_PREVIEW_CHARS)}${entry.message?.length > LIMITS.LOG_PREVIEW_CHARS ? '\n...' : ''}\n\`\`\`\n`;
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
        line += `${entry.preview?.substring(0, LIMITS.LOG_AI_PREVIEW_CHARS)}${entry.preview?.length > LIMITS.LOG_AI_PREVIEW_CHARS ? '\n...' : ''}\n`;
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
  'ls': 'LS',
  'search': 'SEARCH',
  'grep': 'GREP',
  'find': 'FIND',
  'shell': 'SHELL',
  'mkdir': 'MKDIR',
  'rmdir': 'RMDIR',
  'cd': 'CD',
  'pwd': 'PWD',
  'cat': 'CAT',
  'head': 'HEAD',
  'tail': 'TAIL',
  'changes': 'CHANGES',
  'diff': 'CHANGES',
  'git_changes': 'CHANGES',
  'fetch': 'FETCH',
  'web': 'FETCH',
  'fetch_web': 'FETCH',
  'memory': 'MEMORY',
  'recall': 'MEMORY',
  'recall_memory': 'MEMORY',
  'save_memory_note': 'MEMORY',
  'search_memory_notes': 'MEMORY',
  'read_memory_notes': 'MEMORY',
  'memory_note_save': 'MEMORY',
  'memory_note_search': 'MEMORY',
  'memory_note_read': 'MEMORY',
  'open': 'OPEN',
  'browser': 'OPEN',
  'open_url': 'OPEN',
  'todo': 'LIST',   // alias — list tasks
};

const TOOL_ALLOWED_BY = {
  READ: ['READ', 'CAT', 'HEAD', 'TAIL'],
  CAT: ['READ', 'CAT', 'HEAD', 'TAIL'],
  HEAD: ['READ', 'CAT', 'HEAD', 'TAIL'],
  TAIL: ['READ', 'CAT', 'HEAD', 'TAIL'],
  LIST: ['LIST', 'LS'],
  LS: ['LIST', 'LS'],
  SEARCH: ['SEARCH', 'GREP'],
  GREP: ['SEARCH', 'GREP'],
  FIND: ['FIND'],
  WRITE: ['WRITE'],
  PATCH: ['PATCH'],
  MKDIR: ['MKDIR'],
  RMDIR: ['RMDIR', 'SHELL'],
  PWD: ['PWD', 'SHELL'],
  CD: ['CD', 'SHELL'],
  CHANGES: ['CHANGES', 'SHELL'],
  FETCH: ['FETCH', 'SHELL'],
  MEMORY: ['MEMORY'],
  OPEN: ['OPEN', 'SHELL'],
  SHELL: ['SHELL'],
};

function normalizeToolName(toolName = '') {
  const normalized = String(toolName ?? '').trim();
  if (!normalized) return '';
  return TOOL_NAME_MAP[normalized.toLowerCase()] || normalized.toUpperCase();
}

function normalizeToolList(toolsValue) {
  if (!toolsValue) return null; // null = all tools allowed
  if (typeof toolsValue === 'string') {
    toolsValue = toolsValue.split(',').map(s => s.trim());
  }
  if (!Array.isArray(toolsValue)) return null;
  return Array.from(new Set(toolsValue.map(normalizeToolName).filter(Boolean)));
}

function isToolAllowedForAgent(allowedTools, toolName) {
  if (!allowedTools || allowedTools.length === 0) return true;
  const normalized = normalizeToolName(toolName);
  const allowedBy = TOOL_ALLOWED_BY[normalized] || [normalized];
  return allowedBy.some(candidate => allowedTools.includes(candidate));
}

// ── Memoized loaders (avoid re-scanning filesystem every prompt turn) ──
const _loaderCache = { agents: null, agentsAt: 0, skills: null, skillsAt: 0 };
const LOADER_CACHE_TTL = 5000; // 5s TTL — balances freshness vs disk I/O

function loadAgents() {
  const now = Date.now();
  if (_loaderCache.agents && now - _loaderCache.agentsAt < LOADER_CACHE_TTL) return _loaderCache.agents;
  const result = _loadAgentsFromDisk();
  _loaderCache.agents = result;
  _loaderCache.agentsAt = now;
  return result;
}

function loadSkills() {
  const now = Date.now();
  if (_loaderCache.skills && now - _loaderCache.skillsAt < LOADER_CACHE_TTL) return _loaderCache.skills;
  const result = _loadSkillsFromDisk();
  _loaderCache.skills = result;
  _loaderCache.skillsAt = now;
  return result;
}

function invalidateLoaderCache(which = 'both') {
  if (which === 'both' || which === 'agents') { _loaderCache.agents = null; _loaderCache.agentsAt = 0; }
  if (which === 'both' || which === 'skills') { _loaderCache.skills = null; _loaderCache.skillsAt = 0; }
}

// Load all agents from .sapper/agents/*.md (with frontmatter support)
function _loadAgentsFromDisk() {
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
function _loadSkillsFromDisk() {
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
description: "General software development agent — implementation, debugging, refactoring, architecture, testing, tooling, automation, and release workflows across languages and stacks. Use for coding or technical problem-solving."
argument-hint: "Describe the feature, bug, refactor, architecture, or development task to work on."
---

# Sapper IT - Development Agent

You are Sapper IT, a senior software development agent working within Sapper.

  You have access to all available Sapper tools unless the session applies a separate restriction.

## Mission

Help users move software projects forward across different languages, frameworks, and codebases.
Do not assume a specific stack, architecture, or workflow before inspecting the repository.

Adapt to the project that exists, not a hard-coded template of technologies.

## What You Handle

- Feature implementation and bug fixing
- Refactoring and code cleanup
- Architecture and system design decisions
- Tooling, build, automation, and developer workflow improvements
- Tests, validation, and release-readiness checks
- Performance, reliability, and maintainability problems
- APIs, data flow, storage, and integration work when the codebase requires it

## Working Style

- Understand the request and inspect the relevant code before proposing or making changes.
- Prefer the smallest change that solves the root problem cleanly.
- Match the repository's existing conventions, abstractions, and naming.
- Use tools proactively: read code, search broadly, edit precisely, and run shell commands when they help verify behavior.
- Verify work proportionally with checks, builds, tests, or direct inspection when feasible.
- Be concise, technical, and practical. Explain tradeoffs only when they matter.

## Decision Rules

- If the task is ambiguous, gather context first instead of guessing.
- If multiple approaches are possible, choose the one with the best balance of correctness, simplicity, and fit for the current codebase.
- If asked for a review, prioritize bugs, risks, regressions, and missing validation ahead of style commentary.
- If a request spans unfamiliar technologies, infer behavior from the actual project files rather than generic assumptions.`,

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
  const promptConfig = getPromptConfig();
  const promptPrepend = promptConfig.prepend.trim();
  const promptAppend = promptConfig.append.trim();
  const corePrompt = promptConfig.coreOverride.trim() || getPromptTemplate('system.core', '', {
    date: dateStr,
    time: timeStr,
  });
  let prompt = promptPrepend
    ? `${wrapPromptCustomizationBlock('CUSTOM PROMPT PREPEND', promptPrepend, false)}\n\n${corePrompt}`
    : corePrompt;

  if (_useNativeToolsFlag) {
    prompt += `\n\n${getPromptTemplate('system.nativeTools')}`;
  } else {
    prompt += `\n\n${getPromptTemplate('system.legacyTools')}`;
  }

  prompt += `\n\n${getPromptTemplate('system.importantContext')}`;

  if (agentContent) {
    prompt += `\n\n${getPromptTemplate('system.activeAgentWrapper', '', { agentContent })}`;
    
    // If the active agent has tool restrictions, inform the AI
    if (currentAgentTools && currentAgentTools.length > 0) {
      const allTools = ['READ', 'WRITE', 'PATCH', 'LIST', 'SEARCH', 'SHELL', 'MKDIR'];
      const forbidden = allTools.filter(t => !currentAgentTools.includes(t));
      prompt += `\n\n${getPromptTemplate('system.agentRestriction', '', {
        allowedTools: currentAgentTools.join(', '),
        forbiddenTools: forbidden.join(', '),
      })}`;
    }
  }

  if (skillContents.length > 0) {
    const skillBlock = skillContents.map(skill => `${skill}\n---`).join('\n');
    prompt += `\n\n${getPromptTemplate('system.loadedSkillsWrapper', '', { skillBlock })}`;
  }

  if (promptAppend) {
    prompt += wrapPromptCustomizationBlock('CUSTOM PROMPT APPEND', promptAppend);
  }

  return prompt;
}

// Track active agent
let currentAgent = null; // null = default Sapper, or agent name string
let currentAgentTools = null; // null = all tools allowed, or array of allowed tool names
let loadedSkills = []; // array of skill names currently loaded

const DEFAULT_CONFIG = Object.freeze({
  defaultModel: null,
  defaultAgent: null,
  autoAttach: true,
  debug: false,
  contextLimit: null,
  toolRoundLimit: 40,
  patchRetries: 3,
  maxFileSize: 100000,
  maxScanSize: 1000000,
  maxUrlSize: 200000,
  summaryPhases: true,
  summarizeTriggerPercent: 65,
  shell: Object.freeze({
    streamToModel: true,
    backgroundMode: 'auto',
    backgroundAfterSeconds: 8,
    outputChunkChars: 4000,
  }),
  streaming: Object.freeze({
    showPhaseStatus: true,
    showHeartbeat: true,
    idleNoticeSeconds: 4,
  }),
  thinking: Object.freeze({
    mode: 'auto',
  }),
  ui: Object.freeze({
    compactMode: 'auto',
    style: 'sapper',
  }),
  prompt: Object.freeze({
    prepend: '',
    append: '',
    coreOverride: '',
    system: Object.freeze({
      core: `You are Sapper, an intelligent AI assistant with access to the local filesystem and shell.
You can help with ANY task - coding, writing, research, planning, analysis, and more.
Adapt your personality and expertise based on the active agent role and loaded skills.

CURRENT DATE AND TIME: {date}, {time}

RULES:
1. EXPLORE FIRST: Use list and read to understand files before making changes.
2. THINK IN STEPS: Explain what you found and what you plan to do before acting.
3. BE PRECISE: When using patch, ensure the 'old_text' matches exactly.
4. VERIFY: After making changes, verify they work (run tests, check output, etc).
5. NO HALLUCINATIONS: If a file doesn't exist, don't guess its content. List the directory instead.`,
      nativeTools: `TOOLS:
You have function-calling tools available. Call them directly — do NOT use [TOOL:...] text markers.
Available tools: list_directory, read_file, search_files, write_file, patch_file, create_directory, ls, cat, head, tail, grep, find, pwd, cd, rmdir, changes, fetch_web, recall_memory, save_memory_note, search_memory_notes, read_memory_notes, open_url, run_shell.

PATCH TIPS:
- For patch_file, set old_text to "LINE:<number>" to replace a specific line by number (most reliable).
- Always read_file first to see exact content before using patch_file.
- If a patch fails, do NOT retry with slight variations. Switch to LINE:number mode or use write_file instead.

EXTRA TOOL TIPS:
- ls lists directory contents using the current tool working directory when path is omitted.
- cat reads a full file, while head and tail read the first or last N lines.
- grep searches file contents, and find searches file or directory names.
- pwd shows the current tool working directory, and cd changes it for later tool calls.
- rmdir removes a directory recursively and always asks for approval.
- changes shows git status and diff output for the current repository or an optional path.
- fetch_web fetches a web page and returns readable text content.
- recall_memory searches Sapper's saved conversation memory.
- save_memory_note appends a durable markdown note for recurring patterns, decisions, or fixes.
- search_memory_notes searches markdown long-memory notes in .sapper/long-memory.md.
- read_memory_notes reads the full markdown long-memory file.
- open_url opens a URL in the default browser and always asks for approval.

SHELL TIPS:
- run_shell may keep long-running commands in a background session depending on config.
- If a shell result returns a session id, inspect more output with run_shell command "__shell_read__ <session_id>".
- Use run_shell command "__shell_list__" to list sessions and "__shell_stop__ <session_id>" to stop one.`,
      legacyTools: `TOOL SYNTAX (use these to interact with files and system):
- [TOOL:LIST]dir[/TOOL] - List directory contents
- [TOOL:LS]dir[/TOOL] - Alias for LIST
- [TOOL:READ]file_path[/TOOL] - Read file contents
- [TOOL:CAT]file_path[/TOOL] - Alias for READ
- [TOOL:HEAD]file_path:::20[/TOOL] - Read the first N lines of a file (default 20)
- [TOOL:TAIL]file_path:::20[/TOOL] - Read the last N lines of a file (default 20)
- [TOOL:SEARCH]pattern[/TOOL] - Search files for pattern
- [TOOL:GREP]pattern[/TOOL] - Alias for SEARCH
- [TOOL:FIND]name_or_fragment[/TOOL] - Find files and directories by name
- [TOOL:WRITE]path:::content[/TOOL] - Create/overwrite file
- [TOOL:PATCH]path:::old|||new[/TOOL] - Edit existing file (exact match, trimmed, or fuzzy)
- [TOOL:PATCH]path:::LINE:number|||new text[/TOOL] - Replace a specific line by number (PREFERRED — more reliable)
- [TOOL:PWD][/TOOL] - Show the current tool working directory
- [TOOL:CD]dir[/TOOL] - Change the tool working directory for later tool calls
- [TOOL:RMDIR]dir[/TOOL] - Remove a directory recursively (asks for approval)
- [TOOL:CHANGES]path[/TOOL] - Show git status and diffs for the repository or a path
- [TOOL:FETCH]https://example.com[/TOOL] - Fetch a web page and return readable content
- [TOOL:MEMORY]query[/TOOL] - Search saved conversation memory
- [TOOL:MEMORY_NOTE_SAVE]title:::note:::tag1,tag2[/TOOL] - Save a durable markdown note
- [TOOL:MEMORY_NOTE_SEARCH]query[/TOOL] - Search markdown long memory notes
- [TOOL:MEMORY_NOTE_READ][/TOOL] - Read markdown long memory file
- [TOOL:OPEN]https://example.com[/TOOL] - Open a URL in the default browser (asks for approval)
- [TOOL:SHELL]command[/TOOL] - Run shell command

PATCH TIPS:
- PREFER the LINE:number mode when you know which line to change. It is much more reliable than text matching.
- Always READ the file first to see exact content before using PATCH.
- If a PATCH fails, do NOT retry with slight variations. Switch to LINE:number mode or use WRITE instead.

SHELL TIPS:
- Long-running commands may be moved to a background shell session depending on config.
- If shell output mentions a session id, inspect more output with [TOOL:SHELL]__shell_read__ <session_id>[/TOOL].
- Use [TOOL:SHELL]__shell_list__[/TOOL] to list sessions and [TOOL:SHELL]__shell_stop__ <session_id>[/TOOL] to stop one.

You MUST use the [TOOL:...][/TOOL] syntax above to perform actions. This is how you interact with the filesystem and shell - there is no other way. When you want to read a file, output [TOOL:READ]path[/TOOL] in your response. When you want to list a directory, output [TOOL:LIST].[/TOOL]. Always actually use the tools - do not just describe what you would do.
Do NOT show tool syntax as examples or documentation to the user. Only use them to perform real actions.`,
      importantContext: `IMPORTANT CONTEXT:
- The current working directory is the user's project folder.
- Sapper has a built-in agent/skill system. Agents are managed via /agents, /agent create, /newagent commands - NOT by you creating files manually.
- Do NOT try to build agent frameworks, projects, or directory structures when the user mentions agents. The agent system is already built into Sapper.
- When the user asks you to do something, work within their current project directory.
- Use "." for the current directory when listing, not "/" or "agent/".

When no agent is active, you are a general-purpose assistant. When an agent role is loaded, fully adopt that role.`,
      activeAgentWrapper: `═══ ACTIVE AGENT ROLE ═══
{agentContent}
═══ END AGENT ROLE ═══

IMPORTANT: You are now operating as the agent described above. Adopt its persona, expertise, and communication style while still having access to Sapper tools.`,
      agentRestriction: `TOOL RESTRICTION: This agent can ONLY use these tools: {allowedTools}.
FORBIDDEN TOOLS (DO NOT USE): {forbiddenTools}. You MUST NOT attempt to use forbidden tools. If you need a forbidden tool, tell the user you cannot perform that action with your current role.`,
      loadedSkillsWrapper: `═══ LOADED SKILLS ═══
{skillBlock}
═══ END SKILLS ═══

Use the knowledge from the loaded skills above when relevant to the user's request.`,
    }),
    ui: Object.freeze({
      bannerTitle: 'Sapper',
      bannerSubtitle: 'terminal coding workspace',
      bannerTagline: 'Model selection, live tools, and focused sessions in one loop',
      quickStartTitle: 'Quick Start',
      quickStartSubtitle: '@file attach · /commands palette · /agents modes',
      cleanFrontendHint: 'clean frontend active  ·  /ui style sapper to switch back',
      ultraFrontendHint: 'ultra frontend active  /ui style sapper to switch back',
      modelPickerUltraTitle: 'models',
      modelPickerCleanTitle: 'model picker',
      modelPickerTitle: 'Model selection',
      modelPickerSectionTitle: 'Model',
      modelPickerSubtitle: 'use ↑↓ or j/k, enter to confirm',
      unknownCommandTitle: 'Unknown Command',
      uiUsage: '  Usage: /ui style [sapper|clean|ultra]  |  /ui compact [auto|on|off]  |  /ui reset',
      fetchStatus: 'Fetching {url}...',
      webPageContentTitle: 'WEB PAGE CONTENT',
      symbolSearchStatus: 'Searching for: "{query}"...',
      memorySearchStatus: 'Searching memory for: "{query}"...',
      scanStatus: 'Scanning codebase...',
    }),
    questions: Object.freeze({
      resumeSession: 'Resume session',
      removeDirectory: 'Remove directory',
      openUrlInBrowser: 'Open URL in browser',
      runShellCommand: 'Run shell command',
      stopBackgroundShellSession: 'Stop background shell session {id}',
      reviewChange: 'Review change [k]eep/[i]gnore/[d]iff/[f]eedback/[e]dit: ',
      feedbackForSapper: 'Feedback for Sapper: ',
      editInstructionForSapper: 'Edit instruction for Sapper: ',
      addFirstMatchFileToContext: 'Add first match file to context? (y/n): ',
      addFileAndRelatedToContext: 'Add this file + related to context? (y/n): ',
      addMemoryToCurrentContext: 'Add to current context? (y/n): ',
      agentName: '\nAgent name (lowercase, no spaces): ',
      agentTitle: 'Agent title/role: ',
      agentExpertise: 'Areas of expertise (comma-separated): ',
      agentStyle: 'Communication style (e.g., professional, casual, technical): ',
      agentTools: 'Allowed tools (comma-sep, or Enter for all): read,edit,write,list,ls,search,grep,find,shell,mkdir,rmdir,pwd,cd,cat,head,tail,changes,fetch,memory,open: ',
      skillName: '\nSkill name (lowercase, no spaces): ',
      skillTitle: 'Skill title: ',
      skillDescription: 'Brief description (for /skills listing): ',
      skillArgumentHint: 'Argument hint (optional, e.g. "Describe what to do"): ',
      skillKnowledge: 'Skill knowledge (or Enter for template): ',
      promptForFiles: 'Your prompt for these files: ',
      stepContinue: '[STEP] Press Enter to let AI think...',
    }),
  }),
});

function normalizePromptTree(inputValue, defaultValue) {
  if (typeof defaultValue === 'string') {
    return normalizePromptText(inputValue === undefined ? defaultValue : inputValue);
  }

  if (!defaultValue || typeof defaultValue !== 'object' || Array.isArray(defaultValue)) {
    return inputValue === undefined ? defaultValue : inputValue;
  }

  const source = inputValue && typeof inputValue === 'object' && !Array.isArray(inputValue) ? inputValue : {};
  const output = {};
  for (const [key, nestedDefault] of Object.entries(defaultValue)) {
    output[key] = normalizePromptTree(source[key], nestedDefault);
  }
  return output;
}

function normalizeBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
}

function normalizeContextLimit(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

function normalizeSummarizeTriggerPercent(value) {
  let parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_CONFIG.summarizeTriggerPercent;
  if (parsed > 0 && parsed <= 1) parsed *= 100;
  return Math.max(40, Math.min(90, Math.round(parsed)));
}

function normalizeToolRoundLimit(value) {
  return normalizeIntegerInRange(value, DEFAULT_CONFIG.toolRoundLimit, 1, 200);
}

function normalizeThinkingMode(value) {
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['on', 'true', '1', 'yes', 'enable', 'enabled', 'always'].includes(normalized)) return 'on';
  if (['off', 'false', '0', 'no', 'disable', 'disabled', 'never'].includes(normalized)) return 'off';
  return 'auto';
}

function normalizeShellBackgroundMode(value) {
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['on', 'true', '1', 'yes', 'enable', 'enabled', 'always'].includes(normalized)) return 'on';
  if (['off', 'false', '0', 'no', 'disable', 'disabled', 'never'].includes(normalized)) return 'off';
  return 'auto';
}

function normalizeThinkingConfig(thinkingConfig = {}) {
  if (typeof thinkingConfig === 'boolean' || typeof thinkingConfig === 'string') {
    return { mode: normalizeThinkingMode(thinkingConfig) };
  }

  if (!thinkingConfig || typeof thinkingConfig !== 'object' || Array.isArray(thinkingConfig)) {
    return { ...DEFAULT_CONFIG.thinking };
  }

  return {
    mode: normalizeThinkingMode(thinkingConfig.mode),
  };
}

function normalizeShellConfig(shellConfig = {}) {
  if (typeof shellConfig === 'boolean' || typeof shellConfig === 'string') {
    return {
      ...DEFAULT_CONFIG.shell,
      backgroundMode: normalizeShellBackgroundMode(shellConfig),
    };
  }

  if (!shellConfig || typeof shellConfig !== 'object' || Array.isArray(shellConfig)) {
    return { ...DEFAULT_CONFIG.shell };
  }

  return {
    streamToModel: normalizeBoolean(shellConfig.streamToModel, DEFAULT_CONFIG.shell.streamToModel),
    backgroundMode: normalizeShellBackgroundMode(shellConfig.backgroundMode),
    backgroundAfterSeconds: normalizeIntegerInRange(shellConfig.backgroundAfterSeconds, DEFAULT_CONFIG.shell.backgroundAfterSeconds, 2, 120),
    outputChunkChars: normalizeIntegerInRange(shellConfig.outputChunkChars, DEFAULT_CONFIG.shell.outputChunkChars, 400, 12000),
  };
}

function normalizeIntegerInRange(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function normalizeStreamingConfig(streamingConfig = {}) {
  if (typeof streamingConfig === 'boolean') {
    return {
      ...DEFAULT_CONFIG.streaming,
      showPhaseStatus: streamingConfig,
      showHeartbeat: streamingConfig,
    };
  }

  if (!streamingConfig || typeof streamingConfig !== 'object' || Array.isArray(streamingConfig)) {
    return { ...DEFAULT_CONFIG.streaming };
  }

  return {
    showPhaseStatus: normalizeBoolean(streamingConfig.showPhaseStatus, DEFAULT_CONFIG.streaming.showPhaseStatus),
    showHeartbeat: normalizeBoolean(streamingConfig.showHeartbeat, DEFAULT_CONFIG.streaming.showHeartbeat),
    idleNoticeSeconds: normalizeIntegerInRange(streamingConfig.idleNoticeSeconds, DEFAULT_CONFIG.streaming.idleNoticeSeconds, 2, 60),
  };
}

function normalizeUICompactMode(value) {
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['on', 'true', '1', 'yes', 'enable', 'enabled', 'always', 'compact'].includes(normalized)) return 'on';
  if (['off', 'false', '0', 'no', 'disable', 'disabled', 'never', 'full'].includes(normalized)) return 'off';
  return 'auto';
}

function normalizeUIStyle(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['ultra', 'minimal', 'min', 'ultra-clean', 'ultraclean'].includes(normalized)) return 'ultra';
  if (['clean', 'minimal', 'codex', 'opencode'].includes(normalized)) return 'clean';
  if (['sapper', 'classic', 'default'].includes(normalized)) return 'sapper';
  return DEFAULT_CONFIG.ui.style;
}

function normalizeUIConfig(uiConfig = {}) {
  if (typeof uiConfig === 'boolean' || typeof uiConfig === 'string') {
    return {
      compactMode: normalizeUICompactMode(uiConfig),
      style: DEFAULT_CONFIG.ui.style,
    };
  }

  if (!uiConfig || typeof uiConfig !== 'object' || Array.isArray(uiConfig)) {
    return { ...DEFAULT_CONFIG.ui };
  }

  return {
    compactMode: normalizeUICompactMode(uiConfig.compactMode),
    style: normalizeUIStyle(uiConfig.style),
  };
}

function normalizePromptText(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

function normalizePromptConfig(promptConfig = {}) {
  if (!promptConfig || typeof promptConfig !== 'object' || Array.isArray(promptConfig)) {
    const normalized = normalizePromptTree({}, DEFAULT_CONFIG.prompt);
    normalized.append = normalizePromptText(promptConfig);
    return normalized;
  }

  const coreOverride = promptConfig.coreOverride !== undefined
    ? promptConfig.coreOverride
    : promptConfig.override;

  const normalized = normalizePromptTree(promptConfig, DEFAULT_CONFIG.prompt);
  normalized.prepend = normalizePromptText(promptConfig.prepend);
  normalized.append = normalizePromptText(promptConfig.append);
  normalized.coreOverride = normalizePromptText(coreOverride);
  return normalized;
}

function normalizeConfig(config = {}) {
  return {
    ...config,
    defaultModel: typeof config.defaultModel === 'string' && config.defaultModel.trim() ? config.defaultModel.trim() : null,
    defaultAgent: typeof config.defaultAgent === 'string' && config.defaultAgent.trim() ? config.defaultAgent.trim() : null,
    autoAttach: normalizeBoolean(config.autoAttach, DEFAULT_CONFIG.autoAttach),
    debug: normalizeBoolean(config.debug, DEFAULT_CONFIG.debug),
    contextLimit: normalizeContextLimit(config.contextLimit),
    toolRoundLimit: normalizeToolRoundLimit(config.toolRoundLimit),
    patchRetries: normalizeIntegerInRange(config.patchRetries, DEFAULT_CONFIG.patchRetries, 1, 20),
    maxFileSize: normalizeIntegerInRange(config.maxFileSize, DEFAULT_CONFIG.maxFileSize, 10000, 10000000),
    maxScanSize: normalizeIntegerInRange(config.maxScanSize, DEFAULT_CONFIG.maxScanSize, 100000, 50000000),
    maxUrlSize: normalizeIntegerInRange(config.maxUrlSize, DEFAULT_CONFIG.maxUrlSize, 10000, 10000000),
    summaryPhases: normalizeBoolean(config.summaryPhases, DEFAULT_CONFIG.summaryPhases),
    summarizeTriggerPercent: normalizeSummarizeTriggerPercent(config.summarizeTriggerPercent),
    shell: normalizeShellConfig(config.shell),
    streaming: normalizeStreamingConfig(config.streaming),
    thinking: normalizeThinkingConfig(config.thinking),
    ui: normalizeUIConfig(config.ui),
    prompt: normalizePromptConfig(config.prompt),
  };
}

function stripJsonComments(text = '') {
  let result = '';
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const next = text[index + 1];

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
        result += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        index++;
      }
      continue;
    }

    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }

    if (char === '/' && next === '/') {
      inLineComment = true;
      index++;
      continue;
    }

    if (char === '/' && next === '*') {
      inBlockComment = true;
      index++;
      continue;
    }

    result += char;
  }

  return result;
}

function appendConfigProperty(lines, name, value, { indent = 2, trailingComma = true } = {}) {
  const pad = ' '.repeat(indent);
  const serialized = JSON.stringify(value, null, 2).split('\n');
  lines.push(`${pad}"${name}": ${serialized[0]}`);
  for (const line of serialized.slice(1)) {
    lines.push(`${pad}${line}`);
  }
  if (trailingComma) {
    lines[lines.length - 1] += ',';
  }
}

function renderConfigFile(config) {
  const lines = [
    '// Sapper configuration file',
    '// This file supports JSON-style comments. Edit values and restart only when a command explicitly says so.',
    '{',
    '  // Core runtime behavior',
  ];

  appendConfigProperty(lines, 'defaultModel', config.defaultModel);
  appendConfigProperty(lines, 'defaultAgent', config.defaultAgent);
  appendConfigProperty(lines, 'autoAttach', config.autoAttach);
  appendConfigProperty(lines, 'debug', config.debug);
  appendConfigProperty(lines, 'contextLimit', config.contextLimit);
  appendConfigProperty(lines, 'toolRoundLimit', config.toolRoundLimit);
  appendConfigProperty(lines, 'patchRetries', config.patchRetries);
  appendConfigProperty(lines, 'maxFileSize', config.maxFileSize);
  appendConfigProperty(lines, 'maxScanSize', config.maxScanSize);
  appendConfigProperty(lines, 'maxUrlSize', config.maxUrlSize);
  appendConfigProperty(lines, 'summaryPhases', config.summaryPhases);
  appendConfigProperty(lines, 'summarizeTriggerPercent', config.summarizeTriggerPercent);

  lines.push('');
  lines.push('  // Shell execution settings');
  appendConfigProperty(lines, 'shell', config.shell);

  lines.push('');
  lines.push('  // Model response visibility');
  appendConfigProperty(lines, 'thinking', config.thinking);
  appendConfigProperty(lines, 'streaming', config.streaming);

  lines.push('');
  lines.push('  // Frontend style and layout');
  appendConfigProperty(lines, 'ui', config.ui);

  lines.push('');
  lines.push('  // Prompt customization');
  lines.push('  // prompt.system.* controls the assistant system prompt blocks');
  lines.push('  // prompt.ui.* controls startup/model-picker/help labels');
  lines.push('  // prompt.questions.* controls interactive questions and confirmations');
  appendConfigProperty(lines, 'prompt', config.prompt, { trailingComma: false });

  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

// Load config (settings like autoAttach and context summarization)
function loadConfig() {
  try {
    ensureSapperDir();
    if (fs.existsSync(CONFIG_FILE)) {
      const fileText = fs.readFileSync(CONFIG_FILE, 'utf8');
      const rawConfig = JSON.parse(stripJsonComments(fileText));
      const normalizedConfig = normalizeConfig(rawConfig);
      if (JSON.stringify(rawConfig) !== JSON.stringify(normalizedConfig)) {
        fs.writeFileSync(CONFIG_FILE, renderConfigFile(normalizedConfig));
      }
      return normalizedConfig;
    }
  } catch (e) {}

  const defaultConfig = normalizeConfig();
  try {
    ensureSapperDir();
    if (!fs.existsSync(CONFIG_FILE)) {
      fs.writeFileSync(CONFIG_FILE, renderConfigFile(defaultConfig));
    }
  } catch (e) {}
  return defaultConfig;
}

function saveConfig(config) {
  ensureSapperDir();
  const normalizedConfig = normalizeConfig(config);
  fs.writeFileSync(CONFIG_FILE, renderConfigFile(normalizedConfig));
  sapperConfig = normalizedConfig;
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

const SUMMARY_PHASES = [
  'Prepare summary request',
  'Summarize older messages',
  'Save compressed context',
  'Resume your prompt',
];

function summaryPhasesEnabled() {
  return sapperConfig.summaryPhases !== false;
}

function toolRoundLimit() {
  return normalizeToolRoundLimit(sapperConfig.toolRoundLimit);
}

function getShellConfig() {
  return normalizeShellConfig(sapperConfig.shell);
}

function shellStreamToModelEnabled() {
  return getShellConfig().streamToModel;
}

function shellBackgroundMode() {
  return getShellConfig().backgroundMode;
}

function shellBackgroundAfterSeconds() {
  return getShellConfig().backgroundAfterSeconds;
}

function shellOutputChunkChars() {
  return getShellConfig().outputChunkChars;
}

function summaryTriggerPercent() {
  return normalizeSummarizeTriggerPercent(sapperConfig.summarizeTriggerPercent);
}

function summaryTokenThreshold(ctxLen) {
  return ctxLen ? Math.floor(ctxLen * (summaryTriggerPercent() / 100)) : 8000;
}

function parseSummaryTriggerInput(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim().replace(/%$/, '');
  if (!normalized) return null;

  let parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  if (parsed > 0 && parsed <= 1) parsed *= 100;

  return Math.max(40, Math.min(90, Math.round(parsed)));
}

function summaryPhaseText(stepNumber, detail = '') {
  const fallback = SUMMARY_PHASES[stepNumber - 1] || 'Context summarization';
  if (!summaryPhasesEnabled()) {
    return detail || fallback;
  }
  return detail
    ? `Step ${stepNumber}/${SUMMARY_PHASES.length} ${detail}`
    : `Step ${stepNumber}/${SUMMARY_PHASES.length} ${fallback}`;
}

function renderSummaryPhaseList(activeStep = null) {
  return SUMMARY_PHASES
    .map((label, index) => {
      const stepNumber = index + 1;
      const line = `Step ${stepNumber}/${SUMMARY_PHASES.length} ${label}`;
      return activeStep === stepNumber ? chalk.cyan(line) : UI.slate(line);
    })
    .join('\n');
}

function getPromptConfig() {
  return normalizePromptConfig(sapperConfig.prompt);
}

function getPromptTemplate(path, fallback = '', variables = {}) {
  const promptConfig = getPromptConfig();
  const value = String(path || '')
    .split('.')
    .filter(Boolean)
    .reduce((current, key) => {
      if (!current || typeof current !== 'object') return undefined;
      return current[key];
    }, promptConfig);

  const template = typeof value === 'string' && value.trim() ? value : fallback;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => {
    const replacement = variables[key];
    return replacement === undefined || replacement === null ? '' : String(replacement);
  });
}

function promptQuestion(path, fallback, variables = {}, tone = 'cyan') {
  const resolved = getPromptTemplate(path, fallback, variables);
  return tone === 'cyan' ? chalk.cyan(resolved) : resolved;
}

function promptLabel(path, fallback, variables = {}) {
  return getPromptTemplate(path, fallback, variables);
}

function getThinkingConfig() {
  return normalizeThinkingConfig(sapperConfig.thinking);
}

function getStreamingConfig() {
  return normalizeStreamingConfig(sapperConfig.streaming);
}

function getUIConfig() {
  return normalizeUIConfig(sapperConfig.ui);
}

function uiCompactMode() {
  const mode = getUIConfig().compactMode;
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  const cols = process.stdout.columns || 100;
  const rows = process.stdout.rows || 30;
  return cols <= 100 || rows <= 28;
}

function uiStyle() {
  return getUIConfig().style;
}

function uiCleanMode() {
  return uiStyle() === 'clean' || uiStyle() === 'ultra';
}

function uiUltraCleanMode() {
  return uiStyle() === 'ultra';
}

function streamPhaseStatusEnabled() {
  return getStreamingConfig().showPhaseStatus;
}

function streamHeartbeatEnabled() {
  return getStreamingConfig().showHeartbeat;
}

function streamIdleNoticeSeconds() {
  return getStreamingConfig().idleNoticeSeconds;
}

function thinkingMode() {
  return getThinkingConfig().mode;
}

function normalizeThinkingInput(input = '') {
  let normalized = String(input ?? '').trim();
  if (normalized.startsWith('/') && normalized.includes(' ')) {
    normalized = normalized.substring(normalized.indexOf(' ') + 1).trim();
  }
  return normalized;
}

function isSimplePrompt(input = '') {
  const normalized = normalizeThinkingInput(input).toLowerCase();
  if (!normalized) return true;
  if (normalized.includes('\n')) return false;
  if (/@|https?:\/\//.test(normalized)) return false;
  if (/[`{}[\]();<>]/.test(normalized)) return false;
  if (/^(hi|hello|hey|thanks|thank you|ok|okay|continue|go on|proceed|yes|no|y|n|cool|nice|bye|good morning|good evening)$/.test(normalized)) {
    return true;
  }
  if (/\b(analyze|debug|fix|implement|refactor|design|plan|optimi[sz]e|architect|investigate|review|build|create|generate|search|find|error|bug|test|compare|explain deeply)\b/.test(normalized)) {
    return false;
  }
  if (normalized.length <= 32) return true;
  return normalized.length <= 60 && normalized.split(/\s+/).length <= 8;
}

function shouldUseThinkingForInput(input = '') {
  const mode = thinkingMode();
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return !isSimplePrompt(input);
}

function isLikelyLongRunningCommand(command = '') {
  const normalized = String(command ?? '').trim().toLowerCase();
  if (!normalized) return false;

  const patterns = [
    /\buvicorn\b/,
    /\bnpm\s+run\s+(dev|start|watch)\b/,
    /\bpnpm\s+(dev|start|watch)\b/,
    /\byarn\s+(dev|start|watch)\b/,
    /\bnext\s+dev\b/,
    /\bvite\b/,
    /\bnodemon\b/,
    /\bdocker\s+compose\s+up\b/,
    /\bwebpack(?:\s+serve|\s+--watch)?\b/,
    /\bpython\s+-m\s+http\.server\b/,
    /\btail\s+-f\b/,
    /\bserve\b/,
    /--reload\b/,
    /--watch\b/
  ];

  return patterns.some(pattern => pattern.test(normalized));
}

function shouldBackgroundShellCommand(command = '') {
  const mode = shellBackgroundMode();
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  return isLikelyLongRunningCommand(command);
}

function hasCustomPromptConfig() {
  const promptConfig = getPromptConfig();
  return Boolean(promptConfig.prepend.trim() || promptConfig.append.trim() || promptConfig.coreOverride.trim());
}

function wrapPromptCustomizationBlock(title, content, leadingNewline = true) {
  const normalized = String(content ?? '').trim();
  if (!normalized) return '';
  const prefix = leadingNewline ? '\n\n' : '';
  return `${prefix}═══ ${title} ═══\n${normalized}\n═══ END ${title} ═══`;
}

function resolveLoadedSkillContents() {
  const allSkills = loadSkills();
  return loadedSkills.map(skillName => allSkills[skillName]?.content || '').filter(Boolean);
}

function resolveActiveAgentContent() {
  if (!currentAgent) return null;
  const allAgents = loadAgents();
  return allAgents[currentAgent]?.content || null;
}

function getActiveAgentMeta() {
  if (!currentAgent) return null;
  const allAgents = loadAgents();
  const agent = allAgents[currentAgent];
  return {
    key: currentAgent,
    name: agent?.name || currentAgent,
    description: agent?.description || '',
    tools: agent?.tools || currentAgentTools,
  };
}

function getLoadedSkillMetaList() {
  const allSkills = loadSkills();
  return loadedSkills.map(skillName => {
    const skill = allSkills[skillName];
    return {
      key: skillName,
      name: skill?.name || skillName,
      description: skill?.description || '',
    };
  });
}

function summarizeModeNames(names = [], maxVisible = 3) {
  const normalized = names.map(name => String(name ?? '').trim()).filter(Boolean);
  if (normalized.length === 0) return '';
  if (normalized.length <= maxVisible) return normalized.join(', ');
  return `${normalized.slice(0, maxVisible).join(', ')}, +${normalized.length - maxVisible} more`;
}

function activeModeSummary({ includeAgent = true, maxSkills = 3 } = {}) {
  const parts = [];
  const activeAgent = getActiveAgentMeta();
  const activeSkills = getLoadedSkillMetaList();

  if (includeAgent && activeAgent) {
    const agentName = activeAgent.name || currentAgent;
    const agentSuffix = currentAgent && agentName !== currentAgent ? ` (/${currentAgent})` : currentAgent ? ` /${currentAgent}` : '';
    parts.push(`agent ${agentName}${agentSuffix}`);
  }

  if (activeSkills.length > 0) {
    parts.push(`skills ${summarizeModeNames(activeSkills.map(skill => skill.name || skill.key), maxSkills)}`);
  }

  return parts.join(' · ');
}

function activeAgentPromptBadge() {
  const activeAgent = getActiveAgentMeta();
  if (!activeAgent) return statusBadge('default', 'neutral');
  return statusBadge(`agent:${ellipsis(activeAgent.name || currentAgent, 20)}`, 'info');
}

function activeSkillsPromptBadge() {
  const activeSkills = getLoadedSkillMetaList();
  if (activeSkills.length === 0) return null;
  const prefix = activeSkills.length === 1 ? 'skill:' : 'skills:';
  return statusBadge(`${prefix}${ellipsis(summarizeModeNames(activeSkills.map(skill => skill.name || skill.key), 2), 22)}`, 'success');
}

function refreshSystemPrompt(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return;
  messages[0] = {
    role: 'system',
    content: buildSystemPrompt(resolveActiveAgentContent(), resolveLoadedSkillContents())
  };
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
    for (const m of namedExports) {
      exports.add(m[1]);
    }
    if (content.includes('export default')) exports.add('default');
  }
  
  return Array.from(exports);
}

// Resolve relative import to actual file path
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
    for (const imported of imports) {
      const secondLevel = workspace.graph[imported] || [];
      secondLevel.forEach(f => related.add(f));
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
    for (const f of files.slice(0, LIMITS.WORKSPACE_FILES_PER_DIR)) { // Limit per directory
      const name = f.path.split('/').pop();
      const exportList = f.exports?.length ? ` [${f.exports.slice(0, 3).join(', ')}${f.exports.length > 3 ? '...' : ''}]` : '';
      output += `   📄 ${name}${exportList}\n`;
    }
    if (files.length > LIMITS.WORKSPACE_FILES_PER_DIR) output += `   ... and ${files.length - LIMITS.WORKSPACE_FILES_PER_DIR} more\n`;
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
      text: text.substring(0, LIMITS.EMBEDDINGS_MAX_TEXT), // Limit stored text
      embedding,
      timestamp: Date.now()
    });
    // Keep only last N chunks
    if (embeddings.chunks.length > LIMITS.EMBEDDINGS_MAX_CHUNKS) {
      embeddings.chunks = embeddings.chunks.slice(-LIMITS.EMBEDDINGS_MAX_CHUNKS);
    }
    saveEmbeddings(embeddings);
  }
}

function longMemoryTemplate() {
  return `# Sapper Long Memory

This file stores durable project notes, patterns, and decisions.
Sapper can write and search this file with /memory commands and memory-note tools.

## Notes

`;
}

function ensureLongMemoryFile() {
  ensureSapperDir();
  if (!fs.existsSync(LONG_MEMORY_FILE)) {
    fs.writeFileSync(LONG_MEMORY_FILE, longMemoryTemplate());
  }
}

function loadLongMemoryText() {
  try {
    ensureLongMemoryFile();
    return fs.readFileSync(LONG_MEMORY_FILE, 'utf8');
  } catch (error) {
    return longMemoryTemplate();
  }
}

function normalizeMemoryTags(tags) {
  const rawTags = Array.isArray(tags)
    ? tags
    : String(tags ?? '').split(',');
  return Array.from(new Set(
    rawTags
      .map(tag => String(tag ?? '').trim().toLowerCase())
      .filter(tag => tag.length > 0)
      .map(tag => tag.replace(/\s+/g, '-'))
  )).slice(0, 8);
}

function inferMemoryTitle(content) {
  const singleLine = String(content ?? '').replace(/\s+/g, ' ').trim();
  if (!singleLine) return 'Untitled note';
  const sentence = singleLine.split(/[.!?]/)[0].trim();
  return (sentence || singleLine).slice(0, 80);
}

function getLongMemorySections() {
  const raw = loadLongMemoryText();
  return raw
    .split(/\n(?=##\s)/g)
    .map(section => section.trim())
    .filter(section => section.startsWith('## '));
}

function appendLongMemoryNote({ title, content, tags = [], source = 'manual' } = {}) {
  const cleanContent = String(content ?? '').trim();
  if (!cleanContent) {
    return { ok: false, error: 'Note content is required.' };
  }

  const cleanTitle = String(title ?? '').trim() || inferMemoryTitle(cleanContent);
  const cleanTags = normalizeMemoryTags(tags);
  const timestamp = new Date().toISOString();
  const lines = [
    `## ${timestamp} | ${cleanTitle}`,
    `- Tags: ${cleanTags.length ? cleanTags.join(', ') : 'general'}`,
    `- Source: ${source}`,
    `- Project: ${PROJECT_ROOT}`,
    '',
    cleanContent,
  ];

  ensureLongMemoryFile();
  const existing = loadLongMemoryText().trimEnd();
  fs.writeFileSync(LONG_MEMORY_FILE, `${existing}\n\n${lines.join('\n')}\n`);

  return {
    ok: true,
    title: cleanTitle,
    tags: cleanTags,
    timestamp,
    path: LONG_MEMORY_FILE,
  };
}

function searchLongMemoryNotes(query, limit = 5) {
  const cleanQuery = String(query ?? '').trim().toLowerCase();
  if (!cleanQuery) return [];

  const words = Array.from(new Set(cleanQuery.split(/[^a-z0-9_]+/i).filter(Boolean)));
  const sections = getLongMemorySections();
  const scored = sections.map((section) => {
    const lowered = section.toLowerCase();
    let score = 0;
    if (lowered.includes(cleanQuery)) score += 5;
    for (const word of words) {
      if (word.length >= 2 && lowered.includes(word)) score += 1;
    }
    return { section, score };
  }).filter(item => item.score > 0);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, limit)).map(item => item.section);
}

function listLongMemoryNotes(limit = 8) {
  return getLongMemorySections()
    .slice(-Math.max(1, limit))
    .reverse()
    .map(section => section.split('\n')[0]?.replace(/^##\s*/, '').trim())
    .filter(Boolean);
}

// ═══════════════════════════════════════════════════════════════
// SMART CONTEXT SUMMARIZATION
// ═══════════════════════════════════════════════════════════════

// Check whether context is large enough to need summarization
function needsSummarize(messages) {
  const estimatedTokens = estimateMessagesTokens(messages);
  const contextSize = JSON.stringify(messages).length;
  const ctxLen = effectiveContextLength();
  const tokenThreshold = summaryTokenThreshold(ctxLen);
  const shouldSummarize = (ctxLen && estimatedTokens > tokenThreshold) || 
                          (!ctxLen && contextSize > LIMITS.CONTEXT_BYTE_FALLBACK);
  return { shouldSummarize, estimatedTokens, contextSize, ctxLen, tokenThreshold };
}

// Save old messages into the embedding store for later recall
async function saveOldMessagesToEmbeddings(oldMessages) {
  const embeddings = loadEmbeddings();
  const textToEmbed = oldMessages
    .filter(m => m.role !== 'system')
    .map(m => m.content.substring(0, LIMITS.LOG_PREVIEW_CHARS))
    .join('\n---\n');

  if (textToEmbed.length > LIMITS.EMBEDDING_MIN_TEXT) {
    try {
      const embedding = await getEmbedding(textToEmbed);
      if (embedding) {
        embeddings.chunks.push({
          text: textToEmbed.substring(0, LIMITS.EMBEDDINGS_MAX_TEXT),
          embedding,
          timestamp: Date.now()
        });
        if (embeddings.chunks.length > LIMITS.EMBEDDINGS_MAX_CHUNKS) {
          embeddings.chunks = embeddings.chunks.slice(-LIMITS.EMBEDDINGS_MAX_CHUNKS);
        }
        saveEmbeddings(embeddings);
      }
    } catch (e) {
      // Silently skip embedding if model not available
    }
  }
  return embeddings;
}

async function autoSummarizeContext(messages, model, force = false) {
  const { shouldSummarize, estimatedTokens, contextSize, ctxLen, tokenThreshold } = needsSummarize(messages);
  
  if ((!force && !shouldSummarize) || messages.length <= 5) return messages;

  const usagePercent = ctxLen 
    ? Math.round((estimatedTokens / ctxLen) * 100)
    : Math.round((contextSize / LIMITS.CONTEXT_BYTE_FALLBACK) * 100);

  console.log();
  const summaryIntroLines = [
    `Context: ~${chalk.red.bold(estimatedTokens.toLocaleString())} tokens / ${chalk.white(ctxLen ? ctxLen.toLocaleString() : '?')} max (${chalk.red.bold(usagePercent + '%')})`,
    chalk.gray(`${messages.length} messages, ${Math.round(contextSize / 1024)}KB raw`),
    chalk.cyan('Auto-summarizing to stay within context window before answering your prompt...'),
    chalk.gray(`Trigger: ${summaryTriggerPercent()}% of the active context window (${tokenThreshold.toLocaleString()} tokens)`),
    chalk.gray('This is an extra model call, so large contexts can pause here for a while.'),
  ];
  if (summaryPhasesEnabled()) {
    summaryIntroLines.push('');
    summaryIntroLines.push(renderSummaryPhaseList(1));
  }
  console.log(box(summaryIntroLines.join('\n'), '🧠 Context Window Management', 'cyan'));

  const summaryStart = Date.now();
  const elapsedSummaryTime = () => `${Math.max(0, Math.round((Date.now() - summaryStart) / 1000))}s`;
  const summarySpinner = ora(summaryPhaseText(1, 'Preparing summary request...')).start();

  // Separate: system prompt, messages to summarize, recent messages to keep
  const systemPrompt = messages[0];
  const recentCount = LIMITS.SUMMARY_RECENT_MSGS;
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
      const text = m.content.length > LIMITS.MSG_TRUNCATION_CHARS
        ? m.content.substring(0, LIMITS.MSG_TRUNCATION_CHARS) + '\n... [truncated]'
        : m.content;
      return `${role}: ${text}`;
    })
    .join('\n\n');

  const conversationTokens = estimateTokens(conversationText);
  const conversationBytes = Buffer.byteLength(conversationText, 'utf8');
  summarySpinner.text = summaryPhaseText(1, `Preparing summary request from ${oldMessages.length} older messages (~${conversationTokens.toLocaleString()} tokens, ${formatBytes(conversationBytes)})`);
  let spinnerInterval = null;

  try {
    const summaryInstruction = `You are a conversation summarizer for an AI coding agent called Sapper. Produce a concise but thorough summary of the conversation below. Include:
- Key topics discussed and decisions made
- Files that were read, created, or modified (with paths)
- Important code changes or bugs found
- Any pending tasks or open questions
- Technical details that would be needed to continue the conversation
- Which tools were used (LIST, READ, WRITE, PATCH, SHELL, SEARCH, CHANGES, FETCH, MEMORY, OPEN) and on what files or URLs
- The active agent role (if any) and loaded skills
- Any tool usage patterns or workflows that were established

CRITICAL: The AI assistant uses tools with syntax like [TOOL:READ]path[/TOOL]. Make sure to note which tools were used so the assistant remembers to keep using them after this summary.

Output ONLY the summary, no preamble. Keep it under 800 words. Use bullet points.`;
    const summaryInputTokens = estimateTokens(summaryInstruction) + estimateTokens(`Summarize this conversation:\n\n${conversationText}`);
    summarySpinner.text = summaryPhaseText(2, `Waiting for ${model} to summarize (~${summaryInputTokens.toLocaleString()} tokens, ${elapsedSummaryTime()} elapsed)`);
    spinnerInterval = setInterval(() => {
      summarySpinner.text = summaryPhaseText(2, `Waiting for ${model} to summarize (~${summaryInputTokens.toLocaleString()} tokens, ${elapsedSummaryTime()} elapsed)`);
    }, 1000);

    const summaryResponse = await ollama.chat({
      model,
      ...(effectiveContextLength() ? { options: { num_ctx: effectiveContextLength() } } : {}),
      messages: [
        {
          role: 'system',
          content: summaryInstruction
        },
        {
          role: 'user',
          content: `Summarize this conversation:\n\n${conversationText}`
        }
      ],
      stream: false
    });
    clearInterval(spinnerInterval);
    spinnerInterval = null;

    const summary = summaryResponse.message.content;

    // Save old messages to embeddings before discarding
    summarySpinner.text = summaryPhaseText(3, `Saving compressed context and memory (${elapsedSummaryTime()} elapsed)`);
    const embeddings = await saveOldMessagesToEmbeddings(oldMessages);

    // Build agent role reminder if an agent is active
    const agentReminder = currentAgent ? `\nNote: You are currently operating as the "${currentAgent}" agent. Stay in character.` : '';
    const skillReminder = loadedSkills.length > 0 ? `\nLoaded skills: ${loadedSkills.join(', ')}. Apply this knowledge when relevant.` : '';

    // Rebuild messages: system prompt + summary + tool reinforcement + recent messages
    const newMessages = [
      systemPrompt,
      {
        role: 'user',
        content: `[CONVERSATION SUMMARY - auto-generated]\n${summary}\n[END SUMMARY]\n\nUse this summary as context for our ongoing conversation. Continue using your tools (LIST, READ, WRITE, PATCH, SHELL, SEARCH, CHANGES, FETCH, MEMORY, OPEN) as needed.${agentReminder}${skillReminder}`
      },
      {
        role: 'assistant',
        content: _useNativeToolsFlag
          ? `Understood. I have the conversation summary and will continue helping you. I'll use my tools (list_directory, read_file, write_file, patch_file, search_files, changes, fetch_web, recall_memory, open_url, run_shell) as needed.\n\nWhat would you like me to do next?`
          : `Understood. I have the conversation summary and will continue helping you. I'll keep using my tools to explore files, inspect changes, fetch references, recall memory, open URLs when needed, make edits, and run commands as needed:\n- [TOOL:LIST] to browse directories\n- [TOOL:READ] to read files\n- [TOOL:WRITE] to create/overwrite files\n- [TOOL:PATCH] to edit existing files\n- [TOOL:SEARCH] to find patterns\n- [TOOL:CHANGES] to inspect git changes\n- [TOOL:FETCH] to read web pages\n- [TOOL:MEMORY] to search saved memory\n- [TOOL:OPEN] to open URLs with approval\n- [TOOL:SHELL] to run commands\n\nWhat would you like me to do next?`
      },
      ...recentMessages
    ];

    // Save immediately
    ensureSapperDir();
    fs.writeFileSync(CONTEXT_FILE, JSON.stringify(newMessages, null, 2));

    const newSize = JSON.stringify(newMessages).length;
    const newTokens = estimateMessagesTokens(newMessages);
    summarySpinner.stop();
    if (summaryPhasesEnabled()) {
      console.log(chalk.gray(`   ${summaryPhaseText(4, 'Context ready. Returning to chat...')}`));
    }
    console.log(chalk.green(`✅ Summarized! ~${chalk.white(estimatedTokens.toLocaleString())} → ~${chalk.white(newTokens.toLocaleString())} tokens (${messages.length} → ${newMessages.length} messages)`));
    if (ctxLen) {
      const newPercent = Math.round((newTokens / ctxLen) * 100);
      console.log(chalk.gray(`   📊 Context window usage: ${newPercent}% of ${ctxLen.toLocaleString()} tokens`));
      if (newPercent >= 80) {
        console.log(chalk.yellow('   ⚠️  Context is still dense, so the next reply may still be slower than usual.'));
      }
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
    if (spinnerInterval) clearInterval(spinnerInterval);
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

function bannerText() {
  return [
    `${chalk.hex('#c8ecff').bold(promptLabel('ui.bannerTitle', 'Sapper'))} ${UI.slate(promptLabel('ui.bannerSubtitle', 'terminal coding workspace'))}`,
    UI.slate(promptLabel('ui.bannerTagline', 'Model selection, live tools, and focused sessions in one loop')),
  ].join('\n');
}

function box(content, title = '', tone = 'cyan', options = {}) {
  const width = Math.max(28, Math.min(options.width || terminalWidth(72), terminalWidth(72)));
  if (uiCleanMode()) {
    const cleanTitle = String(title || '').replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim();
    const line = UI.slate('-'.repeat(Math.max(12, width)));
    const header = cleanTitle ? `${chalk.white(cleanTitle)}\n${line}\n` : '';
    return `${header}${String(content ?? '')}\n${line}`;
  }
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

function piRow(label, value, width = 13) {
  return `${padAnsi(UI.slate(`[${label}]`), width)} ${value}`;
}

function commandRow(command, description, width = 18) {
  return `${padAnsi(UI.accent(command), width)} ${UI.slate('—')} ${UI.ink(description)}`;
}

const COMMAND_GROUPS = Object.freeze([
  {
    title: 'Core',
    subtitle: 'daily workflow',
    tone: 'cyan',
    rows: [
      ['@ or /attach', 'Pick files to attach interactively'],
      ['@file', 'Attach a file inline, for example @src/app.js'],
      ['/scan', 'Scan the codebase into context'],
      ['/index', 'Rebuild the workspace graph'],
      ['/graph file', 'Show related files from the graph'],
      ['/symbol name', 'Search indexed functions and classes'],
      ['/auto', 'Toggle automatic related-file attach'],
    ],
  },
  {
    title: 'Context',
    subtitle: 'memory and visibility',
    tone: 'cyan',
    rows: [
      ['/recall', 'Search memory for relevant context'],
      ['/memory', 'Manage markdown long-memory notes and patterns'],
      ['/memory add title ::: note', 'Save a durable note to .sapper/long-memory.md'],
      ['/fetch <url>', 'Fetch a web page into context'],
      ['/reset /clear', 'Clear all current context'],
      ['/prune', 'Summarize long context and store memory'],
      ['/summary', 'Show or change auto-summary settings'],
      ['/ui', 'Show or change frontend style and compact mode'],
      ['/ui style clean', 'Switch to a clean Codex/OpenCode-like frontend'],
      ['/ui style ultra', 'Switch to an ultra-clean single-line frontend'],
      ['/shell', 'Inspect shell config and background sessions'],
      ['/shell read <id>', 'Read output from a tracked shell session'],
      ['/shell stop <id>', 'Stop a tracked shell session'],
      ['/context', 'Inspect token usage, summary trigger, and model window'],
      ['/ctx <limit>', 'Set context window limit (e.g. /ctx 64k)'],
      ['/debug', 'Toggle regex and tool debug output'],
      ['/log', 'Show the session activity timeline'],
      ['/log stats', 'Show session statistics'],
      ['/log file', 'Show log file path and history'],
      ['/help', 'Open command guide'],
      ['/commands', 'Alias for /help'],
      ['exit', 'Quit Sapper'],
    ],
  },
  {
    title: 'Agents',
    subtitle: 'specialist modes and skills',
    tone: 'cyan',
    rows: [
      ['/agents', 'List available agents'],
      ['/skills', 'List available skills'],
      ['/agentname', 'Switch to an agent such as /reviewer'],
      ['/default', 'Return to the default Sapper role'],
      ['/use skill', 'Load a skill into the session'],
      ['/unload skill', 'Unload a previously loaded skill'],
      ['/newagent', 'Create a new agent'],
      ['/newskill', 'Create a new skill'],
    ],
  },
]);

const COMMAND_LOOKUP = Object.freeze(
  Array.from(new Set(COMMAND_GROUPS.flatMap(group => group.rows.map(([command]) => command))))
);

function renderCommandPalette() {
  const lines = [];
  for (const group of COMMAND_GROUPS) {
    if (lines.length > 0) lines.push('');
    lines.push(sectionTitle(group.title, group.subtitle, group.tone));
    for (const [command, description] of group.rows) {
      lines.push(commandRow(command, description));
    }
  }

  lines.push(divider());
  lines.push(UI.slate('  Summary settings: /summary  |  /summary phases off  |  /summary trigger 60'));
  lines.push(UI.slate('  Tool config: .sapper/config.json -> toolRoundLimit (default 40)'));
  lines.push(UI.slate('  Shell config: .sapper/config.json -> shell.streamToModel, shell.backgroundMode [off|auto|on], shell.backgroundAfterSeconds, shell.outputChunkChars'));
  lines.push(UI.slate('  Want to see all live shell output? Set shell.backgroundMode to off. thinking.mode only controls model reasoning.'));
  lines.push(UI.slate('  Streaming config: .sapper/config.json -> streaming.showPhaseStatus, streaming.showHeartbeat, streaming.idleNoticeSeconds'));
  lines.push(UI.slate('  Thinking config: .sapper/config.json -> thinking.mode [auto|on|off]'));
  lines.push(UI.slate('  UI config: .sapper/config.json -> ui.style [sapper|clean|ultra], ui.compactMode [auto|on|off]'));
  lines.push(UI.slate('  Prompt config: .sapper/config.json -> prompt.prepend, prompt.append, prompt.coreOverride, prompt.system.*, prompt.ui.*, prompt.questions.*'));

  return lines.join('\n');
}

function levenshteinDistance(a = '', b = '') {
  const left = String(a);
  const right = String(b);
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;

  const previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  const current = new Array(right.length + 1);

  for (let i = 1; i <= left.length; i++) {
    current[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + cost
      );
    }
    for (let j = 0; j <= right.length; j++) {
      previous[j] = current[j];
    }
  }

  return previous[right.length];
}

function suggestSlashCommands(inputValue = '', maxSuggestions = 4) {
  const normalized = inputValue.trim().toLowerCase().replace(/^\/+/, '');
  if (!normalized) return [];

  const scored = COMMAND_LOOKUP.map(command => {
    const token = command.toLowerCase().replace(/^\/+/, '').split(/\s+/)[0];
    const score = token.startsWith(normalized)
      ? 0
      : normalized.startsWith(token)
        ? 1
        : levenshteinDistance(normalized, token);
    return { command, score };
  }).sort((a, b) => a.score - b.score || a.command.length - b.command.length);

  return scored
    .filter(item => item.score <= Math.max(2, Math.ceil(normalized.length / 2)))
    .slice(0, maxSuggestions)
    .map(item => item.command);
}

function renderViewport(content, { verticalAlign = 'top', minTopPadding = 0 } = {}) {
  const text = String(content ?? '').replace(/\n+$/, '');
  const rows = Math.max(12, process.stdout.rows || 24);
  const lineCount = text ? text.split('\n').length : 0;
  const centeredPadding = verticalAlign === 'center'
    ? Math.max(0, Math.floor((rows - lineCount) / 2))
    : 0;
  const topPadding = Math.max(minTopPadding, centeredPadding);

  console.clear();
  if (topPadding > 0) {
    process.stdout.write('\n'.repeat(topPadding));
  }
  process.stdout.write(`${text}\n`);
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
  if (uiCleanMode()) {
    const body = detail ? `${UI.slate(label)}\n${UI.slate(detail)}` : UI.slate(label);
    return `${body}\n${UI.accent('› ')} `;
  }
  return `${UI.slate(label)}${detail ? `\n${detail}` : ''}\n${UI.accent('> ')} `;
}

function renderedTerminalLineCount(text = '', width = process.stdout.columns || 80) {
  const terminalColumns = Math.max(1, width || 80);
  return String(text ?? '')
    .split('\n')
    .reduce((count, line) => count + Math.max(1, Math.ceil(Math.max(1, visibleLength(line)) / terminalColumns)), 0);
}

function clearPromptEcho(promptText, inputText = '') {
  const totalLines = renderedTerminalLineCount(`${promptText}${inputText}`);
  for (let index = 0; index < totalLines; index++) {
    process.stdout.write('\x1B[1A\x1B[2K');
  }
  process.stdout.write('\r');
}

function streamPhaseMessage(message, type = 'neutral') {
  const colorFn = BADGE_STYLES[type] || UI.slate;
  return `${colorFn('[status]')} ${UI.slate(message)}`;
}

function showStreamPhase(message, type = 'neutral') {
  if (!streamPhaseStatusEnabled()) return;
  console.log(streamPhaseMessage(message, type));
}

function renderStreamingHeartbeat({
  genTokenCount = 0,
  genStartTime,
  lastVisibleActivityAt,
  stage = 'generating',
}) {
  const elapsedSeconds = Math.max((Date.now() - genStartTime) / 1000, 0.1);
  const elapsed = elapsedSeconds.toFixed(1);
  const idleSeconds = Math.max(0, Math.floor((Date.now() - lastVisibleActivityAt) / 1000));
  const idleThreshold = streamIdleNoticeSeconds();

  if (stage === 'waiting-first') {
    const waitNote = idleSeconds >= idleThreshold ? ` · waiting ${idleSeconds}s` : '';
    process.stdout.write(`\r  ${UI.slate(`Waiting for first model chunk... ${elapsed}s elapsed${waitNote}`)}  ${UI.slate.italic('Ctrl+C to stop')}`);
    return;
  }

  const tps = genTokenCount / elapsedSeconds;
  const waitNote = idleSeconds >= idleThreshold ? ` · waiting ${idleSeconds}s for next chunk` : '';
  process.stdout.write(`\r  ${UI.slate(`Generating... ${genTokenCount} tokens · ${elapsed}s · ${tps.toFixed(1)} t/s${waitNote}`)}  ${UI.slate.italic('Ctrl+C to stop')}`);
}

function confirmPrompt(label, type = 'warning', optionsLabel = '[y/N] ') {
  const colors = {
    info: UI.accent,
    success: UI.mint,
    warning: UI.gold,
    error: UI.coral,
    action: chalk.hex('#8fb6ff'),
    neutral: UI.slate,
  };
  const colorFn = colors[type] || UI.gold;
  return colorFn(`\n${label}? `) + UI.slate(optionsLabel);
}

function parseApprovalShortcut(input = '') {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) return null;

  const match = trimmed.match(/^(f|feedback|e|edit)\b(?:\s*[:=-]?\s*(.*))?$/i);
  if (!match) return null;

  const command = match[1].toLowerCase();
  return {
    type: command.startsWith('e') ? 'edit' : 'feedback',
    detail: String(match[2] ?? '').trim(),
  };
}

async function resolveApprovalInstruction(input, {
  feedbackPrompt = 'Feedback for Sapper: ',
  editPrompt = 'Edit instruction for Sapper: ',
} = {}) {
  const shortcut = parseApprovalShortcut(input);
  if (!shortcut) return null;

  let detail = shortcut.detail;
  if (!detail) {
    const promptLabel = shortcut.type === 'edit' ? editPrompt : feedbackPrompt;
    detail = String(await safeQuestion(chalk.cyan(promptLabel))).trim();
  }

  return {
    type: shortcut.type,
    detail,
  };
}

const shellSessions = new Map();
let shellSessionCounter = 0;
const SHELL_OUTPUT_BUFFER_MAX_CHARS = 50000;

function createShellSession(command, cwd, proc) {
  const id = `shell-${++shellSessionCounter}`;
  const session = {
    id,
    command,
    cwd,
    proc,
    startedAt: Date.now(),
    output: '',
    reportedOffset: 0,
    completed: false,
    backgrounded: false,
    exitCode: null,
    signal: null,
    error: null,
    liveEchoEnabled: true,
  };
  shellSessions.set(id, session);
  return session;
}

// Prune completed shell sessions to prevent memory leaks (keep last 20)
function pruneCompletedShellSessions() {
  const completed = Array.from(shellSessions.entries()).filter(([, s]) => s.completed);
  const MAX_COMPLETED = 20;
  if (completed.length > MAX_COMPLETED) {
    completed
      .sort((a, b) => a[1].startedAt - b[1].startedAt)
      .slice(0, completed.length - MAX_COMPLETED)
      .forEach(([id]) => shellSessions.delete(id));
  }
}

function activeShellSessionCount() {
  return Array.from(shellSessions.values()).filter(session => !session.completed).length;
}

function appendShellSessionOutput(session, text) {
  if (!session || !text) return;
  session.output += text;
  if (session.output.length > SHELL_OUTPUT_BUFFER_MAX_CHARS) {
    const overflow = session.output.length - SHELL_OUTPUT_BUFFER_MAX_CHARS;
    session.output = session.output.slice(overflow);
    session.reportedOffset = Math.max(0, session.reportedOffset - overflow);
  }
}

function formatShellOutputChunk(text = '', emptyLabel = '(no output yet)') {
  const normalized = String(text ?? '').trim();
  if (!normalized) return emptyLabel;
  const maxChars = shellOutputChunkChars();
  if (normalized.length <= maxChars) return normalized;
  return `... (showing last ${maxChars.toLocaleString()} chars)\n${normalized.slice(-maxChars)}`;
}

function shellSessionUsageHint(sessionId) {
  return `Use run_shell with command \"__shell_read__ ${sessionId}\" to inspect more output, \"__shell_list__\" to list sessions, or \"__shell_stop__ ${sessionId}\" to stop it.`;
}

function buildShellSessionResult(session, {
  includeOutput = true,
  onlyNewOutput = false,
  markReported = false,
  backgroundHandoff = false,
} = {}) {
  const relevantOutput = onlyNewOutput
    ? session.output.slice(session.reportedOffset)
    : session.output;

  if (markReported) {
    session.reportedOffset = session.output.length;
  }

  const elapsedSeconds = Math.max(1, Math.round((Date.now() - session.startedAt) / 1000));
  const statusLine = session.completed
    ? `Shell session ${session.id} completed in ${elapsedSeconds}s with exit code ${session.exitCode ?? 'unknown'}.`
    : `Shell session ${session.id} is still running in background after ${elapsedSeconds}s.`;

  const lines = [
    statusLine,
    `Command: ${session.command}`,
    `Directory: ${session.cwd}`,
  ];

  if (session.error) {
    lines.push(`Error: ${session.error}`);
  }

  if (!session.completed || backgroundHandoff) {
    lines.push(shellSessionUsageHint(session.id));
  }

  if (includeOutput) {
    lines.push('');
    lines.push(onlyNewOutput ? 'Output since last check:' : backgroundHandoff ? 'Initial streamed output:' : 'Captured output:');
    lines.push(formatShellOutputChunk(relevantOutput, onlyNewOutput ? '(no new output since last check)' : '(no output yet)'));
  }

  return lines.join('\n');
}

function parseShellSessionCommand(command = '') {
  const trimmed = String(command ?? '').trim();
  if (!trimmed.startsWith('__shell_')) return null;

  const [directive, ...rest] = trimmed.split(/\s+/);
  const sessionId = rest.join(' ').trim();

  if (directive === '__shell_list__') return { action: 'list' };
  if (directive === '__shell_read__') return { action: 'read', sessionId };
  if (directive === '__shell_stop__') return { action: 'stop', sessionId };
  return { action: 'unknown', directive };
}

async function handleShellSessionCommand(command = '') {
  const parsed = parseShellSessionCommand(command);
  if (!parsed) return null;

  if (parsed.action === 'unknown') {
    return `Unknown shell session command: ${parsed.directive}. Use __shell_list__, __shell_read__ <session_id>, or __shell_stop__ <session_id>.`;
  }

  if (parsed.action === 'list') {
    const sessions = Array.from(shellSessions.values());
    if (sessions.length === 0) return 'No shell sessions are currently tracked.';
    return sessions.map(session => {
      const state = session.completed ? `done (exit ${session.exitCode ?? 'unknown'})` : 'running';
      return `${session.id} · ${state} · ${session.command}`;
    }).join('\n');
  }

  if (!parsed.sessionId) {
    return 'Missing shell session id. Use __shell_read__ <session_id> or __shell_stop__ <session_id>.';
  }

  const session = shellSessions.get(parsed.sessionId);
  if (!session) {
    return `Shell session not found: ${parsed.sessionId}. Use __shell_list__ to see available sessions.`;
  }

  if (parsed.action === 'read') {
    return buildShellSessionResult(session, {
      includeOutput: true,
      onlyNewOutput: true,
      markReported: true,
      backgroundHandoff: !session.completed,
    });
  }

  if (parsed.action === 'stop') {
    if (session.completed) {
      return buildShellSessionResult(session, {
        includeOutput: true,
        onlyNewOutput: false,
        markReported: true,
      });
    }

    console.log();
    const confirmation = await safeQuestion(confirmPrompt(promptLabel('questions.stopBackgroundShellSession', 'Stop background shell session {id}', { id: session.id }), 'error', '[y/N] '));
    if (!['y', 'yes'].includes(String(confirmation ?? '').trim().toLowerCase())) {
      return `Stop request cancelled for shell session ${session.id}.`;
    }

    try {
      session.proc.kill('SIGTERM');
      return `Sent SIGTERM to shell session ${session.id}. ${shellSessionUsageHint(session.id)}`;
    } catch (error) {
      return `Could not stop shell session ${session.id}: ${error.message}`;
    }
  }

  return null;
}

function getTrackedShellSessions() {
  return Array.from(shellSessions.values()).sort((left, right) => right.startedAt - left.startedAt);
}

function shellSessionStatusLabel(session) {
  if (!session) return 'unknown';
  if (!session.completed) return 'running';
  if (session.signal) return `stopped (${session.signal})`;
  return `done (${session.exitCode ?? 'unknown'})`;
}

function renderShellSessionsPanel() {
  const sessions = getTrackedShellSessions();
  const activeCount = sessions.filter(session => !session.completed).length;
  const completedCount = sessions.length - activeCount;
  const lines = [
    `config        ${chalk.white(shellStreamToModelEnabled() ? 'stream on' : 'stream off')} ${UI.slate('·')} ${chalk.white(`bg ${shellBackgroundMode()}`)} ${UI.slate('·')} ${chalk.white(`after ${shellBackgroundAfterSeconds()}s`)} ${UI.slate('·')} ${chalk.white(`chunk ${shellOutputChunkChars()}`)}`,
    UI.slate(`visibility    bg off keeps long shell commands fully attached and visible in the terminal`),
    `sessions      ${chalk.white(`${activeCount} active`)} ${UI.slate('·')} ${chalk.white(`${completedCount} completed`)}`,
  ];

  if (sessions.length === 0) {
    lines.push(UI.slate('No background shell sessions are currently tracked.'));
  } else {
    for (const session of sessions.slice(0, 8)) {
      const elapsed = formatElapsed(Date.now() - session.startedAt);
      const lastOutputLine = String(session.output || '').trim().split('\n').filter(Boolean).slice(-1)[0] || '(no output yet)';
      lines.push(`${chalk.white(session.id)} ${UI.slate('·')} ${chalk.white(shellSessionStatusLabel(session))} ${UI.slate('·')} ${UI.slate(elapsed)}`);
      lines.push(`  ${UI.ink(ellipsis(session.command, 90))}`);
      lines.push(`  ${UI.slate(ellipsis(lastOutputLine, 90))}`);
    }
    if (sessions.length > 8) {
      lines.push(UI.slate(`Showing 8 of ${sessions.length} tracked sessions.`));
    }
  }

  return box(lines.join('\n'), 'Shell Sessions', 'cyan');
}

// ─── Markdown terminal rendering ───────────────────────────────────
// Dynamic width helper (recalculated on every render)
function mdWidth() {
  return Math.min(process.stdout.columns || 80, 120);
}

// Base marked-terminal config (tables, emoji, reflow, text styles)
marked.use(markedTerminal({
    code: chalk.cyan,            // fallback when highlight fails
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
    showSectionPrefix: false,
    reflowText: true,
    emoji: true,
    tab: 2,
    width: 120, // overridden dynamically below
}));

// ─── Enhanced renderers (override marked-terminal defaults) ────────
const HEADING_STYLES = [
  chalk.hex('#7cc4ff').bold.underline,   // h1 – bright cyan underline
  chalk.hex('#7cc4ff').bold,             // h2 – bright cyan bold
  chalk.hex('#9bbcff').bold,             // h3 – soft blue bold
  chalk.hex('#b8d9ff'),                  // h4 – light blue
  chalk.hex('#8a95a6').bold,             // h5 – slate bold
  chalk.hex('#8a95a6'),                  // h6 – slate
];
const HEADING_PREFIX = ['◆', '◇', '▸', '▹', '·', '·'];

function syntaxHighlight(code, lang) {
  try {
    if (!lang) return chalk.hex('#e6ebf2')(code);
    return highlightCode(code, { language: lang, ignoreIllegals: true });
  } catch {
    return chalk.hex('#e6ebf2')(code);
  }
}

function framedCodeBlock(code, lang) {
  const width = mdWidth();
  const innerWidth = Math.max(20, width - 6);  // "  │ " prefix = 4, " │" suffix = 2
  const highlighted = syntaxHighlight(code, lang);
  const lines = highlighted.split('\n');

  // Top rule with optional language label
  let topRule;
  if (lang) {
    const label = ` ${chalk.hex('#8a95a6').italic(lang)} `;
    const labelLen = lang.length + 2;  // visible length of " lang "
    const preDashes = 2;
    const postDashes = Math.max(0, innerWidth + 2 - preDashes - labelLen);
    topRule = chalk.hex('#3d4f5f')('  ┌' + '─'.repeat(preDashes)) + label + chalk.hex('#3d4f5f')('─'.repeat(postDashes) + '┐');
  } else {
    topRule = chalk.hex('#3d4f5f')('  ┌' + '─'.repeat(innerWidth + 2) + '┐');
  }

  // Code lines with left+right border
  const framedLines = lines.map(line => {
    const visLen = stripAnsi(line).length;
    const pad = Math.max(0, innerWidth - visLen);
    return chalk.hex('#3d4f5f')('  │ ') + line + ' '.repeat(pad) + chalk.hex('#3d4f5f')(' │');
  });

  // Bottom rule
  const bottomRule = chalk.hex('#3d4f5f')('  └' + '─'.repeat(innerWidth + 2) + '┘');

  return '\n' + topRule + '\n' + framedLines.join('\n') + '\n' + bottomRule + '\n';
}

const LIST_BULLETS = ['●', '○', '◦', '·'];

marked.use({
  renderer: {
    // ── Fenced code blocks: framed box with syntax highlighting ──
    code({ text, lang }) {
      return framedCodeBlock(text, lang || '');
    },

    // ── Headings: level-aware icons + color gradient ──
    heading({ tokens, depth }) {
      const text = this.parser.parseInline(tokens);
      const level = Math.max(0, Math.min(depth - 1, 5));
      const style = HEADING_STYLES[level];
      const prefix = HEADING_PREFIX[level];
      const plain = stripAnsi(text);
      const underChar = level === 0 ? '═' : level === 1 ? '─' : '';
      const underline = underChar ? '\n  ' + chalk.hex('#3d4f5f')(underChar.repeat(Math.min(plain.length + 4, mdWidth() - 4))) : '';
      return `\n  ${chalk.hex('#3d4f5f')(prefix)} ${style(plain)}${underline}\n`;
    },

    // ── Blockquotes: thick left bar with dimmed styling ──
    blockquote({ tokens }) {
      const body = this.parser.parse(tokens);
      const lines = body.split('\n').filter(l => l.trim() !== '');
      const bar = chalk.hex('#5a7a9a')('▌');
      const textStyle = chalk.hex('#9aafcc').italic;
      return '\n' + lines.map(line => {
        const clean = stripAnsi(line).trim();
        return `  ${bar} ${textStyle(clean)}`;
      }).join('\n') + '\n';
    },

    // ── Lists: modern bullets ──
    list({ items, ordered }) {
      const result = items.map((item, i) => {
        // Parse inline tokens to properly render codespan, strong, em, etc.
        let body = '';
        for (const tok of item.tokens) {
          if (tok.tokens) {
            body += this.parser.parseInline(tok.tokens);
          } else if (tok.type === 'space') {
            body += '';
          } else {
            body += tok.text || '';
          }
        }
        body = body.replace(/\n+$/, '');
        const lines = body.split('\n');
        if (ordered) {
          const num = chalk.hex('#7cc4ff')(`${i + 1}.`);
          const prefix = `  ${num} `;
          return lines.map((line, li) => {
            return li === 0 ? `${prefix}${line.trim()}` : `     ${line.trim()}`;
          }).join('\n');
        }
        const bullet = chalk.hex('#5a7a9a')(LIST_BULLETS[Math.min(item.depth || 0, LIST_BULLETS.length - 1)] || '●');
        const prefix = `  ${bullet} `;
        return lines.map((line, li) => {
          return li === 0 ? `${prefix}${line.trim()}` : `    ${line.trim()}`;
        }).join('\n');
      }).join('\n');
      return '\n' + result + '\n';
    },

    // ── Horizontal rules: themed divider ──
    hr() {
      const w = Math.max(20, mdWidth() - 4);
      return '\n  ' + chalk.hex('#3d4f5f')('─'.repeat(w)) + '\n';
    },

    // ── Inline code: highlighted background effect ──
    codespan({ text }) {
      return chalk.bgHex('#1a2733').hex('#7cc4ff')(` ${text} `);
    },

    // ── Links: visible URL with icon ──
    link({ href, tokens }) {
      const text = this.parser.parseInline(tokens);
      const plain = stripAnsi(text);
      if (plain === href) {
        return chalk.hex('#7cc4ff').underline(href);
      }
      return `${chalk.hex('#7cc4ff').underline(plain)} ${chalk.hex('#8a95a6')('→')} ${chalk.hex('#5a7a9a').underline(href)}`;
    },
  }
});

// Render markdown to terminal
function renderMarkdown(text) {
  try {
    return marked(text).trim();
  } catch (e) {
    return text; // Fallback to raw text
  }
}

let stepMode = false;
let debugMode = sapperConfig.debug || false; // Toggle with /debug command, or set in config
let abortStream = false; // Flag to interrupt AI response

// ═══════════════════════════════════════════════════════════════
// REAL CONTEXT WINDOW TRACKING
// ═══════════════════════════════════════════════════════════════
let modelContextLength = null;  // Detected from ollama.show() model_info
let lastPromptTokens = 0;      // prompt_eval_count from last response
let lastEvalTokens = 0;        // eval_count from last response

const SLASH_COMPLETION_COMMANDS = Object.freeze(Array.from(new Set(
  COMMAND_GROUPS
    .flatMap(group => group.rows.map(([command]) => command))
    .flatMap(command => (String(command).match(/\/[a-z0-9-]+/gi) || []).map(token => token.toLowerCase()))
    .concat(['/commands', '/cmd'])
)).sort());

function buildReadlineCompleter() {
  return (line) => {
    const raw = String(line || '');
    const trimmed = raw.trimStart();

    if (!trimmed.startsWith('/')) {
      return [[], line];
    }

    // Complete only the first token (command) to avoid interfering with free-form args.
    const commandToken = trimmed.split(/\s+/)[0].toLowerCase();
    const hits = SLASH_COMPLETION_COMMANDS.filter(cmd => cmd.startsWith(commandToken));
    return [hits.length ? hits : SLASH_COMPLETION_COMMANDS, commandToken];
  };
}

function createReadlineInterface() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    historySize: 100,
    completer: buildReadlineCompleter(),
  });
}

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
let rl = createReadlineInterface();

function recreateReadline() {
  if (rl) rl.close();
  rl = createReadlineInterface();
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

function countLines(text = '') {
  if (!text) return 0;
  return String(text).split('\n').length;
}

function formatPreviewLine(line = '', maxWidth = Math.max(32, terminalWidth(82) - 12)) {
  return ellipsis(String(line).replace(/\t/g, '  '), maxWidth);
}

function buildPreviewBlock(lines, startIdx, endIdx, changeStart, changeEnd, marker, colorFn, maxLines = 14) {
  if (lines.length === 0) {
    return colorFn(`${marker}   | (empty)`);
  }

  const indexes = [];
  for (let index = startIdx; index <= endIdx; index++) {
    indexes.push(index);
  }

  const clipped = indexes.length > maxLines;
  const visibleIndexes = clipped
    ? [
        ...indexes.slice(0, Math.ceil(maxLines / 2)),
        -1,
        ...indexes.slice(-(Math.floor(maxLines / 2)))
      ]
    : indexes;
  const numberWidth = String(Math.max(endIdx + 1, 1)).length;
  const rows = [];

  if (startIdx > 0) {
    rows.push(UI.slate('  ...'));
  }

  for (const index of visibleIndexes) {
    if (index === -1) {
      rows.push(UI.slate('  ...'));
      continue;
    }

    const prefix = index >= changeStart && index <= changeEnd ? marker : ' ';
    const row = `${prefix} ${String(index + 1).padStart(numberWidth)} | ${formatPreviewLine(lines[index])}`;
    rows.push(prefix === marker ? colorFn(row) : UI.slate(row));
  }

  if (clipped || endIdx < lines.length - 1) {
    rows.push(UI.slate('  ...'));
  }

  return rows.join('\n');
}

function buildFileChangePreview(oldContent = '', newContent = '') {
  const before = String(oldContent ?? '');
  const after = String(newContent ?? '');

  if (before === after) {
    return UI.slate('No visible text changes.');
  }

  const oldLines = before ? before.split('\n') : [];
  const newLines = after ? after.split('\n') : [];

  if (oldLines.length === 0) {
    return [
      chalk.green('New file content'),
      buildPreviewBlock(newLines, 0, Math.max(0, Math.min(newLines.length - 1, 13)), 0, Math.max(0, Math.min(newLines.length - 1, 13)), '+', chalk.green)
    ].join('\n');
  }

  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start++;
  }

  let oldEnd = oldLines.length - 1;
  let newEnd = newLines.length - 1;
  while (oldEnd >= start && newEnd >= start && oldLines[oldEnd] === newLines[newEnd]) {
    oldEnd--;
    newEnd--;
  }

  const contextLines = 3;
  const oldStart = Math.max(0, start - contextLines);
  const newStart = Math.max(0, start - contextLines);
  const oldPreviewEnd = Math.min(oldLines.length - 1, Math.max(oldEnd, start - 1) + contextLines);
  const newPreviewEnd = Math.min(newLines.length - 1, Math.max(newEnd, start - 1) + contextLines);

  return [
    chalk.red('Before'),
    buildPreviewBlock(oldLines, oldStart, oldPreviewEnd, start, oldEnd, '-', chalk.red),
    '',
    chalk.green('After'),
    buildPreviewBlock(newLines, newStart, newPreviewEnd, start, newEnd, '+', chalk.green),
  ].join('\n');
}

function ensureParentDirectory(filePath) {
  const parentDir = dirname(filePath);
  if (parentDir && parentDir !== '.' && !fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }
}

function restoreFileSnapshot(filePath, originalContent, existedBefore) {
  if (existedBefore) {
    fs.writeFileSync(filePath, originalContent);
  } else if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

async function reviewCandidateFile({ filePath, originalContent = '', newContent = '', title = 'File Review', successMessage }) {
  const existedBefore = fs.existsSync(filePath);

  ensureParentDirectory(filePath);
  fs.writeFileSync(filePath, newContent);

  while (true) {
    console.log();
    console.log(box(
      `${keyValue('File', chalk.white(filePath), 8)}\n` +
      `${keyValue('Status', chalk.white(existedBefore ? 'modified' : 'new file'), 8)}\n` +
      `${keyValue('Lines', chalk.white(`${countLines(originalContent)} -> ${countLines(newContent)}`), 8)}\n` +
      `${UI.slate('Candidate change written to disk. Review it in your editor now.')}\n` +
      `${UI.slate('Choose keep to accept it, ignore to revert it, diff to inspect, f for feedback, or e for edit instructions.')}`,
      title, 'yellow'
    ));

    const decisionInput = await safeQuestion(chalk.yellow('Review change ') + chalk.gray('[k]eep/[i]gnore/[d]iff/[f]eedback/[e]dit: '));
    const decisionRaw = String(decisionInput ?? '').trim();
    const decision = decisionRaw.toLowerCase();

    if (['k', 'keep', 'y', 'yes'].includes(decision)) {
      return successMessage || `Successfully saved changes to ${filePath}`;
    }

    if (['i', 'ignore', 'n', 'no'].includes(decision)) {
      restoreFileSnapshot(filePath, originalContent, existedBefore);
      return existedBefore
        ? `Ignored change and restored ${filePath}`
        : `Ignored change and removed ${filePath}`;
    }

    if (decision === '' || decision === 'd' || decision === 'diff') {
      console.log();
      console.log(box(buildFileChangePreview(originalContent, newContent), 'Change Diff', 'yellow'));
      continue;
    }

    const approvalInstruction = await resolveApprovalInstruction(decisionRaw, {
      feedbackPrompt: 'Feedback for this change: ',
      editPrompt: 'Edit instruction for this change: ',
    });

    if (approvalInstruction) {
      if (!approvalInstruction.detail) {
        console.log(UI.slate('Enter feedback or edit instructions for Sapper, or choose keep/ignore/diff.'));
        continue;
      }

      restoreFileSnapshot(filePath, originalContent, existedBefore);
      const label = approvalInstruction.type === 'edit' ? 'User edit instruction' : 'User feedback';
      return `Change rejected by user for ${filePath}.\n${label}: ${approvalInstruction.detail}\nThe original file was restored. Revise the change and try again.`;
    }

    if (decisionRaw) {
      restoreFileSnapshot(filePath, originalContent, existedBefore);
      return `Change rejected by user for ${filePath}.\nUser feedback: ${decisionRaw}\nThe original file was restored. Revise the change and try again.`;
    }

    console.log(UI.slate('Type k to keep, i to ignore, d to view the diff, f for feedback, e for edit instructions, or write feedback directly.'));
  }
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
// File limits — configurable via .sapper/config.json
function getMaxFileSize() { return sapperConfig.maxFileSize || DEFAULT_CONFIG.maxFileSize; }
function getMaxScanSize() { return sapperConfig.maxScanSize || DEFAULT_CONFIG.maxScanSize; }
function getMaxUrlSize() { return sapperConfig.maxUrlSize || DEFAULT_CONFIG.maxUrlSize; }
function getPatchRetries() { return sapperConfig.patchRetries || DEFAULT_CONFIG.patchRetries; }

// ═══════════════════════════════════════════════════════════════
// URL FETCHING — Read web pages and learn from them
// ═══════════════════════════════════════════════════════════════
import https from 'https';
import http from 'http';

// Fetch a URL and return extracted text content
function fetchUrl(url, timeout = LIMITS.FETCH_URL_TIMEOUT_MS) {
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
        if (size > getMaxUrlSize()) {
          res.destroy();
          reject(new Error(`Page too large (>${Math.round(getMaxUrlSize()/1024)}KB)`));
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
  if (text.length > LIMITS.WEB_CONTENT_MAX_CHARS) {
    text = text.substring(0, LIMITS.WEB_CONTENT_MAX_CHARS) + '\n\n[... content truncated at 50KB ...]';
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

// Format file attachments into a decorated string block for context messages
function formatFileAttachments(fileAttachments) {
  let s = '\n\n══════════════════════════════════════\n';
  s += `📎 ATTACHED FILES (${fileAttachments.length})\n`;
  s += '══════════════════════════════════════\n\n';
  for (const file of fileAttachments) {
    s += `┌─── ${file.path} ───\n`;
    s += file.content;
    if (!file.content.endsWith('\n')) s += '\n';
    s += `└─── END ${file.path} ───\n\n`;
  }
  return s;
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
          if (stats.size > getMaxFileSize()) {
            files.push({ path: fullPath, size: stats.size, skipped: true, reason: 'too large' });
            continue;
          }
          if (totalSize + stats.size > getMaxScanSize()) {
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
  const compact = uiCompactMode();
  const clean = uiCleanMode();
  const ultra = uiUltraCleanMode();
  const pageSize = compact
    ? Math.max(4, Math.min(7, (process.stdout.rows || 24) - 16))
    : Math.max(5, Math.min(8, (process.stdout.rows || 24) - 14));

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();

  const render = () => {
    const current = models[cursor];
    const lines = ultra
      ? [
          `${chalk.white(promptLabel('ui.bannerTitle', 'Sapper'))} ${UI.slate(promptLabel('ui.modelPickerUltraTitle', 'models'))}`,
          `${UI.slate(safeCwd())}`,
          ''
        ]
      : clean
      ? [
          `${chalk.white(promptLabel('ui.bannerTitle', 'Sapper'))} ${UI.slate(promptLabel('ui.modelPickerCleanTitle', 'model picker'))}`,
          `${UI.slate(safeCwd())} ${UI.slate('·')} ${UI.slate(`v${CURRENT_VERSION}`)}`,
          divider('─', 'gray', terminalWidth(70)),
          sectionTitle(promptLabel('ui.modelPickerSectionTitle', 'Model'), promptLabel('ui.modelPickerSubtitle', 'use ↑↓ or j/k, enter to confirm'), 'gray'),
          ''
        ]
      : [
          bannerText(),
          `${UI.slate(safeCwd())} ${UI.slate('·')} ${UI.slate(`v${CURRENT_VERSION}`)}`,
          divider(),
          sectionTitle(promptLabel('ui.modelPickerTitle', 'Model selection'), promptLabel('ui.modelPickerSubtitle', 'use ↑↓ or j/k, enter to confirm'), 'cyan'),
          ''
        ];

    const startIdx = Math.max(0, Math.min(cursor - Math.floor(pageSize / 2), models.length - pageSize));
    const endIdx = Math.min(startIdx + pageSize, models.length);

    if (startIdx > 0) {
      lines.push(UI.slate('  ↑ more models'));
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

      lines.push(`${marker} ${index}  ${name}`);
      if (meta) {
        lines.push(`     ${UI.slate(meta)}`);
      }
    }

    if (endIdx < models.length) {
      lines.push(UI.slate('  ↓ more models'));
    }

    const family = current.details?.family || current.details?.format || current.details?.parameter_size || 'local model';
    const quant = current.details?.quantization_level || current.details?.quantization || 'default';
    lines.push('');
    if (ultra) {
      lines.push(
        `${UI.slate('selected')} ${chalk.white.bold(current.name)} ${UI.slate('·')} ` +
        `${UI.slate(current.size ? formatBytes(current.size) : 'unknown')} ${UI.slate('·')} ` +
        `${UI.slate(current.modified_at ? formatRelativeTime(current.modified_at) : 'unknown')}`
      );
      lines.push(UI.slate('enter confirm  ·  q cancel'));
    } else if (clean) {
      lines.push(
        `${UI.slate('selected')} ${chalk.white.bold(current.name)} ${UI.slate('·')} ` +
        `${UI.slate('size')} ${UI.ink(current.size ? formatBytes(current.size) : 'unknown')} ${UI.slate('·')} ` +
        `${UI.slate('updated')} ${UI.ink(current.modified_at ? formatRelativeTime(current.modified_at) : 'unknown')} ${UI.slate('·')} ` +
        `${UI.slate('profile')} ${UI.ink(family)} ${UI.slate('·')} ${UI.slate('quant')} ${UI.ink(quant)}`
      );
    } else {
      lines.push(box(
        `${keyValue('Selected', chalk.white.bold(current.name), 10)}\n` +
        `${keyValue('Footprint', UI.ink(current.size ? formatBytes(current.size) : 'unknown'), 10)}\n` +
        `${keyValue('Updated', UI.ink(current.modified_at ? formatRelativeTime(current.modified_at) : 'unknown'), 10)}\n` +
        `${keyValue('Profile', UI.ink(family), 10)}\n` +
        `${keyValue('Quant', UI.ink(quant), 10)}`,
        'Preview', 'gray'
      ));
    }

    renderViewport(lines.join('\n'), { verticalAlign: 'center' });
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
        console.clear();
        resolve(models[cursor].name);
      } else if (key.name === 'escape' || key.name === 'q' || (key.ctrl && key.name === 'c')) {
        cleanup();
        console.clear();
        resolve(models[cursor].name);
      }
    };

    process.stdin.on('data', onKeypress);
  });
}

let toolWorkingDirectory = PROJECT_ROOT;

function getToolWorkingDirectory() {
  return toolWorkingDirectory || PROJECT_ROOT;
}

function resolveToolPath(pathValue = '.', { allowEmpty = false } = {}) {
  let rawPath = typeof pathValue === 'string' ? pathValue.trim() : '';
  // Strip surrounding quotes that models sometimes add
  if ((rawPath.startsWith('"') && rawPath.endsWith('"')) || (rawPath.startsWith("'") && rawPath.endsWith("'"))) {
    rawPath = rawPath.slice(1, -1).trim();
  }
  if (!rawPath) {
    return allowEmpty ? '' : getToolWorkingDirectory();
  }
  if (rawPath === '/') {
    return getToolWorkingDirectory();
  }
  const resolved = isAbsolute(rawPath) ? rawPath : pathResolve(getToolWorkingDirectory(), rawPath);
  // Prevent path traversal outside the project directory
  const projectRoot = PROJECT_ROOT;
  if (!resolved.startsWith(projectRoot + '/') && resolved !== projectRoot) {
    return projectRoot; // Fall back to project root for paths that escape sandbox
  }
  return resolved;
}

function resolveLineWindowCount(value, fallback = 20) {
  return normalizeIntegerInRange(value, fallback, 1, 400);
}

function readFileLineWindow(pathValue, mode = 'head', countValue = 20) {
  const trimmedPath = typeof pathValue === 'string' ? pathValue.trim() : '';
  if (!trimmedPath) return 'Error reading file: missing file path';

  try {
    const resolvedPath = resolveToolPath(trimmedPath);
    const rawContent = fs.readFileSync(resolvedPath, 'utf8');
    const lines = rawContent === '' ? [] : rawContent.split('\n');
    const requestedCount = resolveLineWindowCount(countValue, 20);

    if (lines.length === 0) {
      return `${mode === 'tail' ? 'Last' : 'First'} 0 lines of ${trimmedPath}:\n(empty file)`;
    }

    const slice = mode === 'tail'
      ? lines.slice(-requestedCount)
      : lines.slice(0, requestedCount);
    const shownCount = slice.length;
    const lineLabel = shownCount === 1 ? 'line' : 'lines';
    const descriptor = mode === 'tail' ? 'last' : 'first';

    return `Showing the ${descriptor} ${shownCount} ${lineLabel} of ${trimmedPath}:\n${slice.join('\n')}`;
  } catch (error) {
    return `Error reading file: ${error.message}`;
  }
}

function findPathsByName(patternValue, startPathValue = '.') {
  const pattern = String(patternValue ?? '').trim();
  const startPath = typeof startPathValue === 'string' ? startPathValue.trim() : '';
  if (!pattern) return 'Error finding files: missing search pattern';

  const resolvedStartPath = resolveToolPath(startPath || '.');
  if (!fs.existsSync(resolvedStartPath)) {
    return `Error finding files: ${startPath || '.'} does not exist`;
  }

  let startStats;
  try {
    startStats = fs.statSync(resolvedStartPath);
  } catch (error) {
    return `Error finding files: ${error.message}`;
  }

  if (!startStats.isDirectory()) {
    return `Error finding files: ${startPath || '.'} is not a directory`;
  }

  const matches = [];
  const maxResults = 100;
  const patternLower = pattern.toLowerCase();

  const visit = (dirPath, displayPrefix = '') => {
    if (matches.length >= maxResults) return;

    let entries = [];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (matches.length >= maxResults) return;
      if (entry.name.startsWith('.')) continue;
      if (shouldIgnore(entry.name)) continue;

      const fullPath = join(dirPath, entry.name);
      const relativePath = displayPrefix ? `${displayPrefix}/${entry.name}` : entry.name;
      if (shouldIgnore(relativePath) || shouldIgnore(fullPath)) continue;

      const displayPath = entry.isDirectory() ? `${relativePath}/` : relativePath;
      if (entry.name.toLowerCase().includes(patternLower) || relativePath.toLowerCase().includes(patternLower)) {
        matches.push(displayPath);
      }

      if (entry.isDirectory()) {
        visit(fullPath, relativePath);
      }
    }
  };

  visit(resolvedStartPath);

  if (matches.length === 0) {
    return `No files or directories found matching: ${pattern}`;
  }

  const header = `Found ${matches.length} matching path${matches.length === 1 ? '' : 's'} for: ${pattern}`;
  const body = matches.join('\n');
  const truncated = matches.length >= maxResults ? '\n... (results truncated)' : '';
  return `${header}\n${body}${truncated}`;
}

function truncateToolText(textValue = '', maxChars = 24000) {
  const text = String(textValue ?? '').trim();
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... (output truncated at ${maxChars.toLocaleString()} chars)`;
}

function shellQuote(value = '') {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}

function runCapturedCommand(command, { cwd = getToolWorkingDirectory(), timeoutMs = 12000, maxOutput = 24000 } = {}) {
  return new Promise((resolve) => {
    const proc = spawn('sh', ['-c', command], { cwd });
    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let finished = false;

    const appendLimited = (existing, chunkText, maxChars, setTruncated) => {
      if (existing.length >= maxChars) {
        setTruncated(true);
        return existing;
      }
      const remaining = maxChars - existing.length;
      if (chunkText.length > remaining) {
        setTruncated(true);
        return existing + chunkText.slice(0, remaining);
      }
      return existing + chunkText;
    };

    const finish = (result) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      const finalStdout = stdoutTruncated
        ? `${stdout}\n... (stdout truncated at ${maxOutput.toLocaleString()} chars)`
        : stdout;
      const finalStderr = stderrTruncated
        ? `${stderr}\n... (stderr truncated at ${maxOutput.toLocaleString()} chars)`
        : stderr;
      resolve({ ...result, stdout: finalStdout, stderr: finalStderr });
    };

    const timer = timeoutMs > 0
      ? setTimeout(() => {
          try { proc.kill('SIGTERM'); } catch (e) {}
          finish({ exitCode: 124, stdout, stderr: `${stderr}\nCommand timed out after ${timeoutMs}ms`.trim(), timedOut: true });
        }, timeoutMs)
      : null;

    proc.stdout.on('data', (data) => {
      stdout = appendLimited(stdout, data.toString(), maxOutput, (value) => { stdoutTruncated = value; });
    });
    proc.stderr.on('data', (data) => {
      stderr = appendLimited(stderr, data.toString(), maxOutput, (value) => { stderrTruncated = value; });
    });

    proc.on('error', (error) => {
      finish({ exitCode: 1, stdout, stderr: `${stderr}\n${error.message}`.trim(), timedOut: false });
    });
    proc.on('close', (code) => {
      finish({ exitCode: code ?? 0, stdout, stderr, timedOut: false });
    });
  });
}

function normalizeFetchedWebContent(rawContent = '') {
  const trimmed = String(rawContent ?? '').trim();
  if (!trimmed) return '';

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch (error) {
      return trimmed;
    }
  }

  if (trimmed.startsWith('<') || trimmed.toLowerCase().includes('<html')) {
    return htmlToText(trimmed);
  }

  return trimmed;
}

function keywordRecallMemory(query, embeddings, topK = 3) {
  const queryText = String(query ?? '').trim().toLowerCase();
  if (!queryText || !embeddings?.chunks?.length) return [];

  const queryWords = Array.from(new Set(
    queryText.split(/[^a-z0-9_]+/i).map(word => word.trim()).filter(word => word.length >= 2)
  ));
  const maxScore = Math.max(1, 4 + queryWords.length);

  return embeddings.chunks
    .map((chunk) => {
      const text = String(chunk?.text ?? '');
      const lowered = text.toLowerCase();
      let score = 0;
      if (lowered.includes(queryText)) score += 4;
      for (const word of queryWords) {
        if (lowered.includes(word)) score += 1;
      }
      return { ...chunk, score: Math.min(1, score / maxScore) };
    })
    .filter(chunk => chunk.score > 0)
    .sort((a, b) => b.score - a.score || (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, topK);
}

const tools = {
  read: (path) => {
    const trimmedPath = typeof path === 'string' ? path.trim() : '';
    if (!trimmedPath) return 'Error reading file: missing file path';
    try { return fs.readFileSync(resolveToolPath(trimmedPath), 'utf8'); } 
    catch (error) { return `Error reading file: ${error.message}`; }
  },
  patch: async (path, oldText, newText) => {
    const trimmedPath = typeof path === 'string' ? path.trim() : '';
    if (!trimmedPath) return 'Error patching file: missing file path';
    if (typeof oldText !== 'string' || typeof newText !== 'string') {
      return 'Error patching file: missing old_text or new_text';
    }
    try {
      const resolvedPath = resolveToolPath(trimmedPath);
      const content = fs.readFileSync(resolvedPath, 'utf8');

      // --- Line-number mode: LINE:15|||new text ---
      const lineMatch = oldText.match(/^LINE:(\d+)$/);
      if (lineMatch) {
        const lineNum = parseInt(lineMatch[1], 10);
        const lines = content.split('\n');
        if (lineNum < 1 || lineNum > lines.length) {
          return `Error: Line ${lineNum} out of range (file has ${lines.length} lines) in ${trimmedPath}`;
        }
        lines[lineNum - 1] = newText;
        const newContent = lines.join('\n');
        if (newContent === content) {
          return `No changes needed in ${trimmedPath}`;
        }

        return reviewCandidateFile({
          filePath: resolvedPath,
          originalContent: content,
          newContent,
          title: 'Patch Review',
          successMessage: `Successfully patched line ${lineNum} of ${trimmedPath}`,
        });
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

      if (newContent === content) {
        return `No changes needed in ${trimmedPath}`;
      }

      return reviewCandidateFile({
        filePath: resolvedPath,
        originalContent: content,
        newContent,
        title: 'Patch Review',
        successMessage: `Successfully patched ${trimmedPath}`,
      });
    } catch (error) { return `Error patching file: ${error.message}`; }
  },
  write: async (path, content) => {
    const trimmedPath = typeof path === 'string' ? path.trim() : '';
    if (!trimmedPath) return 'Error writing file: missing file path';
    try {
      const resolvedPath = resolveToolPath(trimmedPath);
      const fileExists = fs.existsSync(resolvedPath);
      const existingContent = fileExists ? fs.readFileSync(resolvedPath, 'utf8') : '';
      const nextContent = String(content ?? '');

      if (fileExists && existingContent === nextContent) {
        return `No changes needed in ${trimmedPath}`;
      }

      return reviewCandidateFile({
        filePath: resolvedPath,
        originalContent: existingContent,
        newContent: nextContent,
        title: 'Write Review',
        successMessage: `Successfully saved changes to ${trimmedPath}`,
      });
    } catch (error) { return `Error writing file: ${error.message}`; }
  },
  mkdir: (path) => {
    const trimmedPath = typeof path === 'string' ? path.trim() : '';
    if (!trimmedPath) return 'Error creating directory: missing directory path';
    try {
      fs.mkdirSync(resolveToolPath(trimmedPath), { recursive: true });
      return `Directory created: ${trimmedPath}`;
    } catch (error) { return `Error creating directory: ${error.message}`; }
  },
  pwd: () => getToolWorkingDirectory(),
  cd: (path) => {
    const trimmedPath = typeof path === 'string' ? path.trim() : '';
    if (!trimmedPath) return 'Error changing directory: missing directory path';
    try {
      const resolvedPath = resolveToolPath(trimmedPath);
      const stats = fs.statSync(resolvedPath);
      if (!stats.isDirectory()) {
        return `Error changing directory: ${trimmedPath} is not a directory`;
      }
      toolWorkingDirectory = resolvedPath;
      return `Working directory changed to ${toolWorkingDirectory}`;
    } catch (error) {
      return `Error changing directory: ${error.message}`;
    }
  },
  rmdir: async (path) => {
    const trimmedPath = typeof path === 'string' ? path.trim() : '';
    if (!trimmedPath) return 'Error removing directory: missing directory path';
    if (['.', '..', '/'].includes(trimmedPath)) {
      return `Error removing directory: refusing to remove ${trimmedPath}`;
    }

    try {
      const resolvedPath = resolveToolPath(trimmedPath);
      if (!fs.existsSync(resolvedPath)) {
        return `Error removing directory: ${trimmedPath} does not exist`;
      }
      const stats = fs.statSync(resolvedPath);
      if (!stats.isDirectory()) {
        return `Error removing directory: ${trimmedPath} is not a directory`;
      }

      console.log();
      console.log(box(
        `${keyValue('Directory', chalk.white(trimmedPath), 11)}\n` +
        `${keyValue('Action', chalk.white('remove recursively'), 11)}\n` +
        `${UI.slate('This will permanently delete the directory and its contents.')}`,
        'Directory Removal', 'red'
      ));
      const confirm = await safeQuestion(confirmPrompt(promptLabel('questions.removeDirectory', 'Remove directory'), 'error'));
      if (!['y', 'yes'].includes(String(confirm ?? '').trim().toLowerCase())) {
        return 'Directory removal blocked by user.';
      }

      fs.rmSync(resolvedPath, { recursive: true, force: false });
      return `Directory removed: ${trimmedPath}`;
    } catch (error) {
      return `Error removing directory: ${error.message}`;
    }
  },
  ls: (path) => tools.list(path),
  cat: (path) => tools.read(path),
  head: (path, lines) => readFileLineWindow(path, 'head', lines),
  tail: (path, lines) => readFileLineWindow(path, 'tail', lines),
  grep: (pattern) => tools.search(pattern),
  find: (pattern, startPath) => findPathsByName(pattern, startPath),
  changes: async (path) => {
    const trimmedPath = typeof path === 'string' ? path.trim() : '';
    const cwd = getToolWorkingDirectory();
    const quotedPath = trimmedPath ? ` -- ${shellQuote(trimmedPath)}` : '';

    const repoCheck = await runCapturedCommand('git rev-parse --show-toplevel', {
      cwd,
      timeoutMs: 5000,
      maxOutput: 4000,
    });
    if (repoCheck.exitCode !== 0) {
      return 'Error: current tool working directory is not inside a git repository';
    }

    const statusCmd = trimmedPath
      ? `git --no-pager status --short ${quotedPath}`
      : 'git --no-pager status --short --branch';
    const [statusResult, unstagedResult, stagedResult] = await Promise.all([
      runCapturedCommand(statusCmd, { cwd, timeoutMs: 8000, maxOutput: 12000 }),
      runCapturedCommand(`git --no-pager diff --no-ext-diff --minimal${quotedPath}`, { cwd, timeoutMs: 8000, maxOutput: 20000 }),
      runCapturedCommand(`git --no-pager diff --cached --no-ext-diff --minimal${quotedPath}`, { cwd, timeoutMs: 8000, maxOutput: 20000 }),
    ]);

    if (statusResult.exitCode !== 0) {
      return `Error reading git changes: ${statusResult.stderr.trim() || 'git status failed'}`;
    }

    const parts = [];
    const scopeLabel = trimmedPath ? ` for ${trimmedPath}` : '';
    parts.push(`Git changes${scopeLabel}:`);
    parts.push(statusResult.stdout.trim() || 'No changed files in working tree.');

    const unstagedDiff = unstagedResult.stdout.trim();
    const stagedDiff = stagedResult.stdout.trim();

    if (unstagedDiff) {
      parts.push(`Unstaged diff:\n${unstagedDiff}`);
    }
    if (stagedDiff) {
      parts.push(`Staged diff:\n${stagedDiff}`);
    }
    if (!unstagedDiff && !stagedDiff) {
      parts.push('No staged or unstaged diff output.');
    }

    return truncateToolText(parts.join('\n\n'), 28000);
  },
  fetch_web: async (url) => {
    const trimmedUrl = String(url ?? '').trim();
    if (!trimmedUrl) return 'Error fetching web page: missing URL';
    if (!/^https?:\/\//i.test(trimmedUrl)) {
      return 'Error fetching web page: URL must start with http:// or https://';
    }

    try {
      const rawContent = await fetchUrl(trimmedUrl);
      const text = normalizeFetchedWebContent(rawContent);
      if (!text) return `No readable content found at ${trimmedUrl}`;
      return `Fetched ${trimmedUrl}:\n\n${truncateToolText(text, 28000)}`;
    } catch (error) {
      return `Error fetching web page: ${error.message}`;
    }
  },
  recall_memory: async (query) => {
    const trimmedQuery = String(query ?? '').trim();
    if (!trimmedQuery) return 'Error searching memory: missing query';

    const embeddings = loadEmbeddings();
    if (!embeddings.chunks.length) {
      return 'No saved memory yet. Use /prune or continue working so Sapper can store conversation memory.';
    }

    let relevant = await findRelevantContext(trimmedQuery, embeddings, 3);
    if (!relevant.length) {
      relevant = keywordRecallMemory(trimmedQuery, embeddings, 3);
    }
    if (!relevant.length) {
      return `No relevant memories found for: ${trimmedQuery}`;
    }

    const formatted = relevant.map((chunk, index) => {
      const timestamp = chunk.timestamp ? new Date(chunk.timestamp).toISOString() : 'unknown time';
      const score = typeof chunk.score === 'number'
        ? `${Math.round(chunk.score * 100)}%`
        : 'n/a';
      const text = truncateToolText(chunk.text || '', 1200);
      return `[${index + 1}] ${timestamp} · relevance ${score}\n${text}`;
    }).join('\n\n');

    return `Found ${relevant.length} memory match${relevant.length === 1 ? '' : 'es'} for: ${trimmedQuery}\n\n${formatted}`;
  },
  save_memory_note: async (title, content, tags) => {
    const result = appendLongMemoryNote({
      title,
      content,
      tags,
      source: 'assistant-tool',
    });
    if (!result.ok) {
      return `Error saving memory note: ${result.error}`;
    }
    const tagText = result.tags.length ? ` [${result.tags.join(', ')}]` : '';
    return `Saved memory note: ${result.title}${tagText} (${result.timestamp}) in ${result.path}`;
  },
  search_memory_notes: async (query) => {
    const cleanQuery = String(query ?? '').trim();
    if (!cleanQuery) return 'Error searching memory notes: missing query';

    const matches = searchLongMemoryNotes(cleanQuery, 5);
    if (!matches.length) {
      return `No markdown long-memory notes found for: ${cleanQuery}`;
    }

    const formatted = matches.map((note, index) => {
      const preview = truncateToolText(note, 900);
      return `[${index + 1}]\n${preview}`;
    }).join('\n\n');

    return `Found ${matches.length} markdown note match${matches.length === 1 ? '' : 'es'} for: ${cleanQuery}\n\n${formatted}`;
  },
  read_memory_notes: async () => {
    const text = loadLongMemoryText();
    return truncateToolText(text, 28000);
  },
  open_url: async (url) => {
    const trimmedUrl = String(url ?? '').trim();
    if (!trimmedUrl) return 'Error opening URL: missing URL';
    if (!/^(https?:|file:)/i.test(trimmedUrl)) {
      return 'Error opening URL: URL must start with http://, https://, or file:';
    }

    console.log();
    console.log(box(
      `${keyValue('URL', chalk.white(trimmedUrl), 11)}\n` +
      `${UI.slate('This will open the URL in your default browser.')}`,
      'Open URL', 'red'
    ));
    const confirm = await safeQuestion(confirmPrompt(promptLabel('questions.openUrlInBrowser', 'Open URL in browser'), 'error'));
    if (!['y', 'yes'].includes(String(confirm ?? '').trim().toLowerCase())) {
      return 'Open URL blocked by user.';
    }

    try {
      let command = 'open';
      let args = [trimmedUrl];
      if (process.platform === 'win32') {
        command = 'cmd';
        args = ['/c', 'start', '', trimmedUrl];
      } else if (process.platform !== 'darwin') {
        command = 'xdg-open';
        args = [trimmedUrl];
      }

      const proc = spawn(command, args, {
        detached: true,
        stdio: 'ignore'
      });
      proc.unref();
      return `Opened URL in default browser: ${trimmedUrl}`;
    } catch (error) {
      return `Error opening URL: ${error.message}`;
    }
  },
  shell: async (cmd) => {
    const trimmedCmd = String(cmd ?? '').trim();
    if (!trimmedCmd) return 'Error executing shell: missing command';

    const sessionCommandResult = await handleShellSessionCommand(trimmedCmd);
    if (sessionCommandResult !== null) {
      return sessionCommandResult;
    }

    const backgroundEligible = shouldBackgroundShellCommand(trimmedCmd);
    console.log();
    console.log(box(
      `${keyValue('Directory', chalk.white(getToolWorkingDirectory()), 11)}\n` +
      `${UI.slate('Command')}\n${chalk.white.bold(trimmedCmd)}\n` +
      `${UI.slate('Type y to run, n to block, f for feedback, e for edit instructions, or write feedback directly.')}\n` +
      `${UI.slate(backgroundEligible ? `Background handoff ${shellBackgroundMode()} after ${shellBackgroundAfterSeconds()}s if still running.` : 'This command will stay attached unless it exits quickly.')}`,
      'Shell Approval', 'red'
    ));
    while (true) {
      const confirmInput = await safeQuestion(confirmPrompt(promptLabel('questions.runShellCommand', 'Run shell command'), 'error', '[y/N/f/e or text] '));
      const confirmRaw = String(confirmInput ?? '').trim();
      const confirm = confirmRaw.toLowerCase();

      if (['y', 'yes'].includes(confirm)) {
        return new Promise((resolve) => {
          console.log(chalk.cyan(`\n[RUNNING] ${trimmedCmd}\n`));
          const proc = spawn('sh', ['-c', trimmedCmd], {
            cwd: getToolWorkingDirectory()
          });
          const session = createShellSession(trimmedCmd, getToolWorkingDirectory(), proc);
          let resolved = false;
          let backgroundTimer = null;

          const finish = (result) => {
            if (resolved) return;
            resolved = true;
            if (backgroundTimer) {
              clearTimeout(backgroundTimer);
              backgroundTimer = null;
            }
            resolve(result);
          };

          if (backgroundEligible) {
            backgroundTimer = setTimeout(() => {
              if (resolved || session.completed) return;
              session.backgrounded = true;
              session.liveEchoEnabled = false;
              showStreamPhase(`Shell command still running. Background session ${session.id} is active...`, 'warning');
              finish(buildShellSessionResult(session, {
                includeOutput: shellStreamToModelEnabled(),
                onlyNewOutput: false,
                markReported: shellStreamToModelEnabled(),
                backgroundHandoff: true,
              }));
            }, shellBackgroundAfterSeconds() * 1000);
          }

          proc.stdout.on('data', (data) => { 
            const text = data.toString();
            appendShellSessionOutput(session, text);
            if (session.liveEchoEnabled) {
              process.stdout.write(text);
            }
          });
          proc.stderr.on('data', (data) => { 
            const text = data.toString();
            appendShellSessionOutput(session, text);
            if (session.liveEchoEnabled) {
              process.stderr.write(text);
            }
          });
          proc.on('error', (error) => {
            session.completed = true;
            session.error = error.message;
            session.exitCode = 1;
            pruneCompletedShellSessions();
            finish(`Shell command failed to start: ${error.message}`);
          });
          proc.on('close', (code, signal) => {
            session.completed = true;
            session.exitCode = code;
            session.signal = signal;
            pruneCompletedShellSessions();

            if (resolved) {
              return;
            }

            if (process.stdin.isTTY) {
              try { process.stdin.setRawMode(false); } catch (e) {}
            }

            setTimeout(() => {
              recreateReadline();
              const maxOutput = 10000;
              let result = session.output.trim();
              if (result.length > maxOutput) {
                result = result.substring(0, maxOutput) + '\n... (output truncated)';
              }
              finish(result || `Command completed with exit code ${code}`);
            }, 200);
          });
        });
      }

      if (['', 'n', 'no'].includes(confirm)) {
        return "Command blocked by user.";
      }

      const approvalInstruction = await resolveApprovalInstruction(confirmRaw, {
        feedbackPrompt: promptLabel('questions.feedbackForSapper', 'Feedback for Sapper: '),
        editPrompt: promptLabel('questions.editInstructionForSapper', 'Edit instruction for Sapper: '),
      });

      if (approvalInstruction) {
        if (!approvalInstruction.detail) {
          console.log(UI.slate('Enter feedback or edit instructions for Sapper, or choose y/n.'));
          continue;
        }

        const label = approvalInstruction.type === 'edit' ? 'User edit instruction' : 'User feedback';
        return `Command blocked by user.\n${label}: ${approvalInstruction.detail}\nNo command was executed. Revise the command and ask again if needed.`;
      }

      return `Command blocked by user.\nUser feedback: ${confirmRaw}\nNo command was executed. Revise the command and ask again if needed.`;
    }
  },
  list: (path) => {
    try {
      let dir = typeof path === 'string' ? path.trim() : '';
      if (!dir) dir = '.';
      // If AI sends "/" (root), treat as current directory "."
      if (dir === '/') dir = '.';
      const entries = fs.readdirSync(resolveToolPath(dir));
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
      // Use grep with args array to avoid command injection
      const args = ['-rEin', pattern, '.'];
      for (const dir of allIgnoreDirs) {
        args.push(`--exclude-dir=${dir}`);
      }
      args.push('--include=*.js', '--include=*.ts', '--include=*.jsx', '--include=*.tsx',
        '--include=*.py', '--include=*.java', '--include=*.go', '--include=*.rs',
        '--include=*.rb', '--include=*.php', '--include=*.c', '--include=*.cpp',
        '--include=*.h', '--include=*.css', '--include=*.scss', '--include=*.html',
        '--include=*.json', '--include=*.md', '--include=*.txt', '--include=*.yml',
        '--include=*.yaml', '--include=*.toml', '--include=*.sh');
      
      const proc = spawn('grep', args, { cwd: getToolWorkingDirectory() });
      let output = '';
      let lineCount = 0;
      
      proc.stdout.on('data', (data) => {
        const text = data.toString();
        const lines = text.split('\n');
        for (const line of lines) {
          if (lineCount >= 50) { proc.kill(); return; }
          if (line) { output += line + '\n'; lineCount++; }
        }
      });
      proc.stderr.on('data', () => {}); // ignore stderr
      
      proc.on('error', (err) => {
        resolve(`Error searching: ${err.message}`);
      });
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
  const clean = uiCleanMode();
  const ultra = uiUltraCleanMode();
  if (ultra) {
    console.log(`${chalk.white(promptLabel('ui.bannerTitle', 'Sapper'))} ${UI.slate(`v${CURRENT_VERSION}`)} ${UI.slate(safeCwd())}`);
    console.log(UI.slate(promptLabel('ui.ultraFrontendHint', 'ultra frontend active  /ui style sapper to switch back')));
  } else if (clean) {
    console.log(`${chalk.white(promptLabel('ui.bannerTitle', 'Sapper'))} ${UI.slate(`v${CURRENT_VERSION}`)} ${UI.slate('·')} ${UI.slate(safeCwd())}`);
    console.log(UI.slate(promptLabel('ui.cleanFrontendHint', 'clean frontend active  ·  /ui style sapper to switch back')));
    console.log(divider('─', 'gray', terminalWidth(70)));
  } else {
    console.log(bannerText());
    console.log(`${UI.slate(safeCwd())} ${UI.slate('·')} ${UI.slate(`v${CURRENT_VERSION}`)}`);
    console.log(divider());
    console.log(sectionTitle(
      promptLabel('ui.quickStartTitle', 'Quick Start'),
      promptLabel('ui.quickStartSubtitle', '@file attach · /commands palette · /agents modes'),
      'gray'
    ));
  }
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
    piRow('workspace', `${chalk.white(`${workspaceFileCount} files`)} ${UI.slate('·')} ${chalk.white(`${workspaceSymbolCount} symbols`)} ${UI.slate('·')} ${UI.slate(`indexed ${workspaceAgeMinutes}m ago`)}`),
    piRow('memory', `${chalk.white('.sapper/')} ${UI.slate('·')} ${UI.slate(`auto-attach ${sapperConfig.autoAttach ? 'on' : 'off'}`)}`),
    piRow('prompt', UI.slate(hasCustomPromptConfig() ? 'custom prompt on' : 'default prompt')),
    piRow('thinking', UI.slate(`mode ${thinkingMode()}`)),
    piRow('tools', UI.slate(`limit ${toolRoundLimit()} rounds`)),
    piRow('shell', `${UI.slate(`stream ${shellStreamToModelEnabled() ? 'on' : 'off'}`)} ${UI.slate('·')} ${UI.slate(`bg ${shellBackgroundMode()}`)} ${UI.slate('·')} ${UI.slate(`${activeShellSessionCount()} active`)}`),
    piRow('stream', `${UI.slate(`heartbeat ${streamHeartbeatEnabled() ? 'on' : 'off'}`)} ${UI.slate('·')} ${UI.slate(`phases ${streamPhaseStatusEnabled() ? 'on' : 'off'}`)}`),
    piRow('summary', `${UI.slate(`phases ${summaryPhasesEnabled() ? 'on' : 'off'}`)} ${UI.slate('·')} ${UI.slate(`trigger ${summaryTriggerPercent()}%`)}`),
    piRow('modes', `${chalk.white(`agents ${agentCount}`)} ${UI.slate('·')} ${chalk.white(`skills ${skillCount}`)}`),
  ];
  if (newlyCreated > 0) {
    startupLines.push(UI.slate(`${newlyCreated} default agents or skills created in .sapper/`));
  }
  if (ultra) {
    const condensed = [
      `${chalk.white(`${workspaceFileCount} files`)} ${UI.slate(`${workspaceSymbolCount} symbols`)}`,
      `${UI.slate('agents')} ${chalk.white(agentCount)} ${UI.slate('skills')} ${chalk.white(skillCount)} ${UI.slate('summary')} ${chalk.white(`${summaryTriggerPercent()}%`)}`,
    ];
    if (newlyCreated > 0) condensed.push(UI.slate(`${newlyCreated} defaults created in .sapper/`));
    console.log(condensed.join('\n'));
  } else if (clean) {
    const condensed = [
      `${chalk.white(`${workspaceFileCount} files`)} ${UI.slate('·')} ${chalk.white(`${workspaceSymbolCount} symbols`)} ${UI.slate('·')} ${UI.slate(`indexed ${workspaceAgeMinutes}m ago`)}`,
      `${UI.slate('tools')} ${chalk.white(`limit ${toolRoundLimit()}`)} ${UI.slate('·')} ${UI.slate('summary')} ${chalk.white(`${summaryTriggerPercent()}%`)}`,
      `${UI.slate('modes')} ${chalk.white(`agents ${agentCount}`)} ${UI.slate('·')} ${chalk.white(`skills ${skillCount}`)} ${UI.slate('·')} ${UI.slate('shell')} ${chalk.white(shellBackgroundMode())}`,
    ];
    if (newlyCreated > 0) {
      condensed.push(UI.slate(`${newlyCreated} default agents or skills created in .sapper/`));
    }
    console.log(box(condensed.join('\n'), 'Session', 'gray'));
  } else {
    console.log(box(startupLines.join('\n'), 'Session Dashboard', 'gray'));
  }
  console.log();
  
  let messages = [];
  if (fs.existsSync(CONTEXT_FILE)) {
    console.log(divider());
    console.log(UI.ink('Previous session found in .sapper/context.json'));
    const resume = await safeQuestion(confirmPrompt(promptLabel('questions.resumeSession', 'Resume session'), 'success'));
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
  
  // Use defaultModel from config if available and exists in local models
  let selectedModel;
  const configModel = sapperConfig.defaultModel;
  if (configModel && localModels.models.some(m => m.name === configModel)) {
    selectedModel = configModel;
    console.log(UI.slate(`  Using configured model: ${configModel}`));
  } else {
    selectedModel = await pickModel(localModels.models) || localModels.models[0].name;
  }

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
    `${piRow('model', chalk.white.bold(selectedModel))}\n` +
    `${piRow('tools', UI.ink(toolModeLabel))}\n` +
    `${piRow('context', UI.ink(contextLabel))}`,
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
        description: 'List the contents of a directory. If path is omitted, use the current directory ".".',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Directory path to list' }
          }
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
        name: 'ls',
        description: 'List directory contents. If path is omitted, use the current tool working directory.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Directory path to list' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'cat',
        description: 'Read the full contents of a file.',
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
        name: 'head',
        description: 'Read the first lines of a file.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path to read' },
            lines: { type: 'number', description: 'How many lines to show (default 20)' }
          },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'tail',
        description: 'Read the last lines of a file.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path to read' },
            lines: { type: 'number', description: 'How many lines to show (default 20)' }
          },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'grep',
        description: 'Search for matching text across project files.',
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
        name: 'find',
        description: 'Find files or directories by name.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Name fragment to search for' },
            path: { type: 'string', description: 'Directory to search from (default current tool working directory)' }
          },
          required: ['pattern']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'pwd',
        description: 'Show the current tool working directory.',
        parameters: {
          type: 'object',
          properties: {}
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'cd',
        description: 'Change the tool working directory for later tool calls.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Directory path to switch to' }
          },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'rmdir',
        description: 'Remove a directory recursively after approval.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Directory path to remove' }
          },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'changes',
        description: 'Show git status and diffs for the current repository or an optional file/directory path.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Optional file or directory path to scope the diff output' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'fetch_web',
        description: 'Fetch a web page and return readable text content.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL to fetch, starting with http:// or https://' }
          },
          required: ['url']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'recall_memory',
        description: 'Search Sapper\'s saved conversation memory for relevant prior context.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Memory search query' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'save_memory_note',
        description: 'Save a durable markdown note in .sapper/long-memory.md for reusable project patterns, decisions, or fixes.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short title for the note' },
            content: { type: 'string', description: 'Main note content to store' },
            tags: { type: 'string', description: 'Optional comma-separated tags like bugfix,cli,pattern' }
          },
          required: ['content']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'search_memory_notes',
        description: 'Search markdown long-memory notes in .sapper/long-memory.md.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query for notes' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_memory_notes',
        description: 'Read the markdown long-memory file at .sapper/long-memory.md.',
        parameters: {
          type: 'object',
          properties: {}
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'open_url',
        description: 'Open a URL in the default browser after approval.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL to open, usually http://, https://, or file:' }
          },
          required: ['url']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'run_shell',
        description: 'Execute a shell command in the project directory. Special commands: __shell_list__, __shell_read__ <session_id>, __shell_stop__ <session_id>.',
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

  // Auto-load defaultAgent from config if set
  if (!currentAgent && sapperConfig.defaultAgent) {
    const agents = loadAgents();
    const agentKey = sapperConfig.defaultAgent.toLowerCase();
    if (agents[agentKey]) {
      currentAgent = agentKey;
      currentAgentTools = agents[agentKey].tools || null;
      if (messages.length > 0 && messages[0]?.role === 'system') {
        messages[0].content = buildSystemPrompt(agents[agentKey].content);
      }
      console.log(UI.slate(`  Using configured agent: ${agents[agentKey].name}`));
    }
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
      const previousConfig = JSON.stringify(sapperConfig);
      const reloadedConfig = loadConfig();
      if (JSON.stringify(reloadedConfig) !== previousConfig) {
        sapperConfig = reloadedConfig;
        if (messages.length > 0 && messages[0]?.role === 'system') {
          refreshSystemPrompt(messages);
        }
        console.log(chalk.gray(`↻ Reloaded ${CONFIG_FILE}`));
        console.log(chalk.gray('   System prompt and runtime settings refreshed from config.'));
      }

      // Context size check - auto-summarize when approaching effective context limit
      let estimatedTokens = estimateMessagesTokens(messages);
      const ctxLen = effectiveContextLength();
      const tokenThreshold = summaryTokenThreshold(ctxLen);
      if (estimatedTokens > tokenThreshold) {
        messages = await autoSummarizeContext(messages, selectedModel);
        estimatedTokens = estimateMessagesTokens(messages);
      }
      
      // Build prompt label with active agent/skills
      const contextPercent = ctxLen ? Math.round((estimatedTokens / ctxLen) * 100) : null;
      const cleanPrompt = uiCleanMode();
      const ultraPrompt = uiUltraCleanMode();
      let promptText;

      if (ultraPrompt) {
        const modelShort = selectedModel.split(':')[0] || selectedModel;
        const modeBits = [chalk.white(modelShort)];
        if (currentAgent) modeBits.push(UI.slate(currentAgent));
        if (contextPercent !== null) modeBits.push(UI.slate(`${contextPercent}%`));
        promptText = `\n${modeBits.join(' ')} ${UI.accent('> ' )}`;
      } else if (cleanPrompt) {
        const modelShort = selectedModel.split(':')[0] || selectedModel;
        const modeLineParts = [chalk.white(modelShort)];
        if (currentAgent) {
          modeLineParts.push(UI.slate(`agent:${currentAgent}`));
        } else {
          modeLineParts.push(UI.slate('default'));
        }
        if (contextPercent !== null) {
          modeLineParts.push(UI.slate(`${contextPercent}% ctx`));
        }

        const detail = ctxLen
          ? `${meter(estimatedTokens, ctxLen, 16)} ${UI.slate(`${estimatedTokens.toLocaleString()}/${ctxLen.toLocaleString()} tokens`)}`
          : UI.slate(`${estimatedTokens.toLocaleString()} estimated tokens`);
        promptText = `\n${UI.slate(modeLineParts.join(' · '))}\n${detail}\n${UI.accent('› ')} `;
      } else {
        const promptParts = [
          statusBadge(selectedModel.split(':')[0] || selectedModel, 'action'),
          activeAgentPromptBadge(),
        ];
        const skillsBadge = activeSkillsPromptBadge();
        if (skillsBadge) {
          promptParts.push(skillsBadge);
        }
        if (contextPercent !== null) {
          const tone = contextPercent >= 85 ? 'error' : contextPercent >= 65 ? 'warning' : 'neutral';
          promptParts.push(statusBadge(`${contextPercent}% ctx`, tone));
        }

        const promptDetailLines = [ctxLen
          ? `${meter(estimatedTokens, ctxLen, 24)} ${UI.slate(`${estimatedTokens.toLocaleString()}/${ctxLen.toLocaleString()} tokens`)}`
          : UI.slate(`${estimatedTokens.toLocaleString()} estimated tokens`)
        ];
        const modeSummary = activeModeSummary({ includeAgent: true, maxSkills: 3 });
        if (modeSummary) {
          promptDetailLines.push(UI.slate(modeSummary));
        }
        const promptDetail = promptDetailLines.join('\n');
        promptText = `\n${promptShell(promptParts.join(' '), promptDetail)}`;
      }

      const input = await safeQuestion(promptText);
      clearPromptEcho(promptText, input);
      
      // Block empty prompts
      if (!input.trim()) {
        continue;
      }

      const preview = input.length > LIMITS.INPUT_PREVIEW_CHARS ? input.substring(0, LIMITS.INPUT_PREVIEW_CHARS) + chalk.gray('...') : input;
      console.log(UI.accent('› ') + chalk.white(preview));
      
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
      if (input.toLowerCase() === '/help' || input.toLowerCase() === '/commands' || input.toLowerCase() === '/cmd') {
        console.log();
        console.log(renderCommandPalette());
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
            uiCleanMode() ? 'Symbol Index' : '📦 Symbol Index', 'cyan'
          ));
          continue;
        }
        
        console.log(uiCleanMode()
          ? chalk.cyan(`\nSearching for: "${query}"...\n`)
          : chalk.cyan(`\n🔍 Searching for: "${query}"...\n`));
        const results = searchSymbol(query, workspace);
        
        if (results.length === 0) {
          console.log(chalk.yellow(`No symbols found matching "${query}"`));
          console.log(chalk.gray('Tip: Run /index to refresh symbol index'));
          continue;
        }
        
        console.log(chalk.green(`Found ${results.length} symbol${results.length !== 1 ? 's' : ''}:\n`));
        
        for (const sym of results.slice(0, 15)) {
          const clean = uiCleanMode();
          const typeIcon = sym.type === 'function'
            ? (clean ? chalk.yellow('f') : chalk.yellow('𝑓'))
            : sym.type === 'class'
              ? (clean ? chalk.blue('C') : chalk.blue('◆'))
              : sym.type === 'method'
                ? (clean ? chalk.cyan('m') : chalk.cyan('○'))
                : (clean ? chalk.gray('-') : chalk.gray('◇'));
          const asyncTag = sym.async ? chalk.magenta('async ') : '';
          const params = sym.params !== undefined ? chalk.gray(`(${sym.params})`) : '';
          
          console.log(`  ${typeIcon} ${asyncTag}${chalk.white.bold(sym.name)}${params}`);
          console.log(`     ${chalk.gray(sym.file)}:${chalk.cyan(sym.line)}`);
        }
        
        if (results.length > LIMITS.SYMBOL_RESULTS_MAX) {
          console.log(chalk.gray(`\n   ... and ${results.length - LIMITS.SYMBOL_RESULTS_MAX} more`));
        }
        
        // Offer to add file to context
        if (results.length > 0) {
          console.log();
          const addToCtx = await safeQuestion(chalk.yellow(promptLabel('questions.addFirstMatchFileToContext', 'Add first match file to context? (y/n): ')));
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
            ? related.map(r => uiCleanMode() ? `  - ${r}` : `  📄 ${r}`).join('\n')
            : chalk.gray('  (no related files found)')),
          uiCleanMode() ? 'File Graph' : '🔗 File Graph', 'cyan'
        ));
        console.log();
        
        // Offer to add to context
        if (related.length > 0) {
          const addRelated = await safeQuestion(chalk.yellow(promptLabel('questions.addFileAndRelatedToContext', 'Add this file + related to context? (y/n): ')));
          if (addRelated.toLowerCase() === 'y') {
            let contextContent = `\n📄 ${matchingFile}:\n`;
            contextContent += fs.readFileSync(matchingFile, 'utf8');
            
            for (const relFile of related.slice(0, LIMITS.WORKSPACE_RELATED_DEPTH)) { // Limit to N related
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
        console.log(uiCleanMode()
          ? chalk.cyan(`\nAuto-attach related files: ${sapperConfig.autoAttach ? chalk.green('ON') : chalk.red('OFF')}`)
          : chalk.cyan(`\n🔗 Auto-attach related files: ${sapperConfig.autoAttach ? chalk.green('ON') : chalk.red('OFF')}`));
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

      if (input.toLowerCase().startsWith('/summary')) {
        const arg = input.substring(8).trim();

        if (!arg) {
          const effective = effectiveContextLength();
          const threshold = summaryTokenThreshold(effective);
          const lines = [
            `phases        ${summaryPhasesEnabled() ? chalk.green('ON') : chalk.red('OFF')}`,
            `trigger       ${chalk.white.bold(summaryTriggerPercent() + '%')} ${UI.slate(`(~${threshold.toLocaleString()} tokens)`)}`,
            `config file   ${chalk.white(CONFIG_FILE)}`,
          ];
          console.log();
          console.log(box(lines.join('\n'), 'Summary Settings', 'cyan'));
          console.log(UI.slate('  Usage: /summary phases [on|off]  |  /summary trigger <percent>  |  /summary reset'));
          continue;
        }

        const [subcommandRaw, ...rest] = arg.split(/\s+/);
        const subcommand = subcommandRaw.toLowerCase();
        const value = rest.join(' ').trim();

        if (subcommand === 'reset' || subcommand === 'default') {
          sapperConfig.summaryPhases = DEFAULT_CONFIG.summaryPhases;
          sapperConfig.summarizeTriggerPercent = DEFAULT_CONFIG.summarizeTriggerPercent;
          saveConfig(sapperConfig);
          console.log(chalk.green(`✅ Summary settings reset: phases ${summaryPhasesEnabled() ? 'ON' : 'OFF'}, trigger ${summaryTriggerPercent()}%`));
          continue;
        }

        if (subcommand === 'phases' || subcommand === 'phase') {
          let nextValue = null;

          if (!value) {
            nextValue = !summaryPhasesEnabled();
          } else {
            const normalized = value.toLowerCase();
            if (['on', 'true', 'yes', '1', 'enable', 'enabled'].includes(normalized)) {
              nextValue = true;
            } else if (['off', 'false', 'no', '0', 'disable', 'disabled'].includes(normalized)) {
              nextValue = false;
            } else if (['toggle', 'flip'].includes(normalized)) {
              nextValue = !summaryPhasesEnabled();
            }
          }

          if (nextValue === null) {
            console.log(chalk.yellow('Usage: /summary phases [on|off]'));
            continue;
          }

          sapperConfig.summaryPhases = nextValue;
          saveConfig(sapperConfig);
          console.log(chalk.green(`✅ Summary phases: ${summaryPhasesEnabled() ? chalk.green('ON') : chalk.red('OFF')}`));
          continue;
        }

        if (subcommand === 'trigger' || subcommand === 'percent' || subcommand === 'threshold') {
          if (!value) {
            console.log(chalk.yellow('Usage: /summary trigger <percent>'));
            console.log(chalk.gray('  Examples: /summary trigger 65, /summary trigger 70%, /summary trigger 0.6'));
            continue;
          }

          const parsedTrigger = parseSummaryTriggerInput(value);
          if (parsedTrigger === null) {
            console.log(chalk.yellow(`Invalid summary trigger: ${value}`));
            console.log(chalk.gray('  Examples: /summary trigger 65, /summary trigger 70%, /summary trigger 0.6'));
            continue;
          }

          sapperConfig.summarizeTriggerPercent = parsedTrigger;
          saveConfig(sapperConfig);
          const effective = effectiveContextLength();
          const threshold = summaryTokenThreshold(effective);
          console.log(chalk.green(`✅ Summary trigger set to ${chalk.white.bold(summaryTriggerPercent() + '%')}`));
          console.log(chalk.gray(`   Auto-summary will start near ${threshold.toLocaleString()} tokens.`));
          continue;
        }

        console.log(chalk.yellow(`Unknown summary option: ${subcommand}`));
        console.log(chalk.gray('  Usage: /summary  |  /summary phases [on|off]  |  /summary trigger <percent>  |  /summary reset'));
        continue;
      }

      if (input.toLowerCase().startsWith('/ui')) {
        const arg = input.substring(3).trim();
        const currentUI = getUIConfig();

        if (!arg || ['status', 'show'].includes(arg.toLowerCase())) {
          const lines = [
            `style         ${chalk.white(currentUI.style)}`,
            `compact       ${chalk.white(currentUI.compactMode)}`,
            `render mode   ${chalk.white(uiStyle())}`,
          ];
          console.log();
          console.log(box(lines.join('\n'), 'UI Settings', 'cyan'));
          console.log(UI.slate('  Usage: /ui style [sapper|clean|ultra]  |  /ui compact [auto|on|off]  |  /ui reset'));
          continue;
        }

        const [subcommandRaw, ...rest] = arg.split(/\s+/);
        const subcommand = subcommandRaw.toLowerCase();
        const value = rest.join(' ').trim();

        if (subcommand === 'reset') {
          saveConfig({
            ...sapperConfig,
            ui: { ...DEFAULT_CONFIG.ui },
          });
          console.log(chalk.green('✅ UI settings reset to defaults (style=sapper, compact=auto).'));
          continue;
        }

        if (subcommand === 'style') {
          if (!value) {
            console.log(chalk.yellow('Usage: /ui style [sapper|clean|ultra]'));
            continue;
          }

          const nextStyle = normalizeUIStyle(value);
          saveConfig({
            ...sapperConfig,
            ui: {
              ...currentUI,
              style: nextStyle,
            },
          });
          console.log(chalk.green(`✅ UI style set to ${chalk.white(nextStyle)}.`));
          console.log(chalk.gray('   Restart Sapper to refresh startup screens. Prompt style updates immediately.'));
          continue;
        }

        if (subcommand === 'compact') {
          if (!value) {
            console.log(chalk.yellow('Usage: /ui compact [auto|on|off]'));
            continue;
          }

          const nextCompact = normalizeUICompactMode(value);
          saveConfig({
            ...sapperConfig,
            ui: {
              ...currentUI,
              compactMode: nextCompact,
            },
          });
          console.log(chalk.green(`✅ UI compact mode set to ${chalk.white(nextCompact)}.`));
          continue;
        }

        console.log(chalk.yellow('Usage: /ui style [sapper|clean|ultra]  |  /ui compact [auto|on|off]  |  /ui reset'));
        continue;
      }

      if (input.toLowerCase() === '/context') {
        const contextSize = JSON.stringify(messages).length;
        const estTokens = estimateMessagesTokens(messages);
        const ctxLen = effectiveContextLength();
        const triggerPercent = summaryTriggerPercent();
        const promptConfig = getPromptConfig();
        const contextLines = [
          `messages ${chalk.white(String(messages.length))} ${UI.slate('·')} raw ${chalk.white(Math.round(contextSize / 1024) + 'KB')} ${UI.slate('·')} tokens ${chalk.white('~' + estTokens.toLocaleString())}`,
        ];
        contextLines.push(`prompt ${chalk.white(hasCustomPromptConfig() ? 'customized' : 'default')} ${UI.slate('·')} ${chalk.white(`prepend ${promptConfig.prepend.trim() ? 'yes' : 'no'}`)} ${UI.slate('·')} ${chalk.white(`append ${promptConfig.append.trim() ? 'yes' : 'no'}`)}`);
        contextLines.push(`thinking ${chalk.white(thinkingMode())} ${UI.slate('·')} ${UI.slate(thinkingMode() === 'auto' ? 'simple prompts skip reasoning' : thinkingMode() === 'off' ? 'reasoning hidden for all prompts' : 'reasoning enabled for all prompts')}`);
        contextLines.push(`tools ${chalk.white(`limit ${toolRoundLimit()} rounds`)} ${UI.slate('·')} ${UI.slate('per prompt turn')}`);
        contextLines.push(`shell ${chalk.white(shellStreamToModelEnabled() ? 'stream on' : 'stream off')} ${UI.slate('·')} ${chalk.white(`bg ${shellBackgroundMode()}`)} ${UI.slate('·')} ${chalk.white(`after ${shellBackgroundAfterSeconds()}s`)} ${UI.slate('·')} ${chalk.white(`${activeShellSessionCount()} active`)}`);
        contextLines.push(`stream ${chalk.white(streamHeartbeatEnabled() ? 'heartbeat on' : 'heartbeat off')} ${UI.slate('·')} ${chalk.white(streamPhaseStatusEnabled() ? 'phase status on' : 'phase status off')} ${UI.slate('·')} ${chalk.white(`idle ${streamIdleNoticeSeconds()}s`)}`);
        if (ctxLen) {
          const usagePercent = Math.round((estTokens / ctxLen) * 100);
          const threshold = summaryTokenThreshold(ctxLen);
          const limitLabel = sapperConfig.contextLimit
            ? `${ctxLen.toLocaleString()} tokens ${chalk.cyan('(custom)')}`
            : `${ctxLen.toLocaleString()} tokens`;
          contextLines.push(`limit ${chalk.white(limitLabel)} ${UI.slate('·')} usage ${chalk.white(usagePercent + '%')}`);
          contextLines.push(`summary ${chalk.white(`trigger ${triggerPercent}%`)} ${UI.slate('·')} ${chalk.white(summaryPhasesEnabled() ? 'phases on' : 'phases off')}`);
          contextLines.push(`${meter(estTokens, ctxLen, 28)} ${UI.slate(`summarize near ${threshold.toLocaleString()} tokens`)}`);
        }
        if (lastPromptTokens > 0) {
          contextLines.push(`last turn ${UI.slate(`${lastPromptTokens.toLocaleString()} prompt • ${lastEvalTokens.toLocaleString()} response`)}`);
        }
        console.log();
        console.log(box(contextLines.join('\n'), 'Context', 'gray'));
        continue;
      }

      if (input.toLowerCase().startsWith('/shell')) {
        const arg = input.substring(6).trim();

        if (!arg || ['sessions', 'session', 'list', 'ls', 'status'].includes(arg.toLowerCase())) {
          console.log();
          console.log(renderShellSessionsPanel());
          console.log(UI.slate('  Usage: /shell  |  /shell sessions  |  /shell read <session_id>  |  /shell stop <session_id>'));
          continue;
        }

        const [subcommandRaw, ...rest] = arg.split(/\s+/);
        const subcommand = subcommandRaw.toLowerCase();
        const sessionId = rest.join(' ').trim();

        if (['read', 'show', 'tail'].includes(subcommand)) {
          const result = await handleShellSessionCommand(`__shell_read__ ${sessionId}`);
          console.log();
          console.log(box(String(result), sessionId ? `Shell ${sessionId}` : 'Shell Read', 'cyan'));
          continue;
        }

        if (['stop', 'kill', 'end'].includes(subcommand)) {
          const result = await handleShellSessionCommand(`__shell_stop__ ${sessionId}`);
          console.log();
          console.log(box(String(result), sessionId ? `Shell ${sessionId}` : 'Shell Stop', 'red'));
          continue;
        }

        console.log(chalk.yellow('Usage: /shell  |  /shell sessions  |  /shell read <session_id>  |  /shell stop <session_id>'));
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
              logFiles.slice(0, LIMITS.LOG_FILES_DISPLAY_MAX).forEach((f, i) => {
                const stats = fs.statSync(`${LOGS_DIR}/${f}`);
                const isCurrent = f === `session-${sessionId}.md`;
                const label = isCurrent ? chalk.green(' ← current') : '';
                console.log(chalk.gray(`   ${i + 1}. `) + chalk.white(f) + chalk.gray(` (${Math.round(stats.size / 1024)}KB)`) + label);
              });
              if (logFiles.length > LIMITS.LOG_FILES_DISPLAY_MAX) {
                console.log(chalk.gray(`   ... and ${logFiles.length - LIMITS.LOG_FILES_DISPLAY_MAX} more`));
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
        invalidateLoaderCache('agents');
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
        
        const agentName = await safeQuestion(promptQuestion('questions.agentName', '\nAgent name (lowercase, no spaces): '));
        if (!agentName.trim() || !/^[a-z0-9_-]+$/.test(agentName.trim())) {
          console.log(chalk.yellow('Invalid name. Use lowercase letters, numbers, hyphens, underscores only.'));
          continue;
        }
        
        const agentFile = join(AGENTS_DIR, `${agentName.trim()}.md`);
        if (fs.existsSync(agentFile)) {
          console.log(chalk.yellow(`Agent "${agentName}" already exists. Edit it at: ${agentFile}`));
          continue;
        }
        
        const agentTitle = await safeQuestion(promptQuestion('questions.agentTitle', 'Agent title/role: '));
        const agentExpertise = await safeQuestion(promptQuestion('questions.agentExpertise', 'Areas of expertise (comma-separated): '));
        const agentStyle = await safeQuestion(promptQuestion('questions.agentStyle', 'Communication style (e.g., professional, casual, technical): '));
        const agentToolsInput = await safeQuestion(promptQuestion('questions.agentTools', 'Allowed tools (comma-sep, or Enter for all): read,edit,write,list,ls,search,grep,find,shell,mkdir,rmdir,pwd,cd,cat,head,tail,changes,fetch,memory,open: '));
        
        const expertiseList = agentExpertise.split(',').map(e => `- ${e.trim()}`).join('\n');
        const toolsLine = agentToolsInput.trim() ? `tools: [${agentToolsInput.trim()}]` : 'tools: [read, edit, write, list, search, shell]';
        const agentMd = `---\nname: "${agentTitle.trim() || agentName}"\ndescription: "${agentExpertise.trim() || agentTitle.trim() || agentName}"\n${toolsLine}\n---\n\n# ${agentTitle.trim() || agentName}\n\nYou are a ${agentTitle.trim() || agentName} AI assistant working within Sapper.\n\n## Your Expertise\n${expertiseList}\n\n## Communication Style\n${agentStyle.trim() || 'Professional and helpful'}.\n\nWhen the user asks for help, leverage your expertise and Sapper's tools to provide comprehensive assistance.\n`;
        
        fs.writeFileSync(agentFile, agentMd);
        invalidateLoaderCache('agents');
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
        
        const skillName = await safeQuestion(promptQuestion('questions.skillName', '\nSkill name (lowercase, no spaces): '));
        if (!skillName.trim() || !/^[a-z0-9_-]+$/.test(skillName.trim())) {
          console.log(chalk.yellow('Invalid name. Use lowercase letters, numbers, hyphens, underscores only.'));
          continue;
        }
        
        const skillFile = join(SKILLS_DIR, `${skillName.trim()}.md`);
        if (fs.existsSync(skillFile)) {
          console.log(chalk.yellow(`Skill "${skillName}" already exists. Edit it at: ${skillFile}`));
          continue;
        }
        
        const skillTitle = await safeQuestion(promptQuestion('questions.skillTitle', 'Skill title: '));
        const skillDesc = await safeQuestion(promptQuestion('questions.skillDescription', 'Brief description (for /skills listing): '));
        const skillArgHint = await safeQuestion(promptQuestion('questions.skillArgumentHint', 'Argument hint (optional, e.g. "Describe what to do"): '));
        const skillBody = await safeQuestion(promptQuestion('questions.skillKnowledge', 'Skill knowledge (or Enter for template): '));
        
        const descLine = skillDesc.trim() || skillTitle.trim() || skillName;
        const argHintLine = skillArgHint.trim() ? `\nargument-hint: "${skillArgHint.trim()}"` : '';
        
        const skillMd = skillBody.trim() 
          ? `---\nname: ${skillTitle.trim() || skillName}\ndescription: "${descLine}"${argHintLine}\n---\n\n# ${skillTitle.trim() || skillName}\n\n${skillBody.trim()}\n`
          : `---\nname: ${skillTitle.trim() || skillName}\ndescription: "${descLine}"${argHintLine}\n---\n\n# ${skillTitle.trim() || skillName}\n\nBest practices and knowledge for ${skillTitle.trim() || skillName}:\n- [Add your knowledge points here]\n- [Add patterns and conventions]\n- [Add common solutions]\n\n## Commands Reference\n| User says | Action |\n|-----------|--------|\n| "example command" | What the AI should do |\n\n## Procedures\n- [Add step-by-step procedures here]\n`;
        
        fs.writeFileSync(skillFile, skillMd);
        invalidateLoaderCache('skills');
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
          const fetchSpinner = ora({ text: chalk.cyan(`${uiCleanMode() ? 'Fetching' : '🌐 Fetching'} ${url}...`), spinner: 'dots' }).start();
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
            const webTitle = uiCleanMode() ? 'WEB PAGE CONTENT' : '🌐 WEB PAGE CONTENT';
            const webContent = `\n\n══════════════════════════════════════\n${webTitle}\n══════════════════════════════════════\n\nURL: ${url}\n\n${text}\n`;
            messages.push({ role: 'user', content: `I fetched this web page for reference:\n${webContent}\n\nUse this information to help me.` });
            ensureSapperDir();
            fs.writeFileSync(CONTEXT_FILE, JSON.stringify(messages, null, 2));
            console.log(uiCleanMode()
              ? chalk.green(`Fetched: ${url} (${Math.round(text.length/1024)}KB)`)
              : chalk.green(`🌐 Fetched: ${url} (${Math.round(text.length/1024)}KB)`));
            console.log(uiCleanMode()
              ? chalk.gray('Added to context. AI can now reference this page.\n')
              : chalk.gray('📝 Added to context. AI can now reference this page.\n'));
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
        
        console.log(uiCleanMode()
          ? chalk.cyan(`\nSearching memory for: "${query}"...`)
          : chalk.cyan(`\n🔍 Searching memory for: "${query}"...`));
        const relevant = await findRelevantContext(query, embeddings, 3);
        
        if (relevant.length === 0) {
          console.log(chalk.yellow('No relevant memories found (or embedding model not available).'));
          console.log(chalk.gray('Tip: Run "ollama pull nomic-embed-text" for semantic search.'));
        } else {
          console.log(chalk.green(`Found ${relevant.length} relevant memories:\n`));
          relevant.forEach((chunk, i) => {
            console.log(box(
              chalk.gray(chunk.text.substring(0, LIMITS.MEMORY_PREVIEW_CHARS) + '...') + '\n' +
              chalk.cyan(`Similarity: ${(chunk.score * 100).toFixed(1)}%`),
              `Memory ${i + 1}`, 'magenta'
            ));
            console.log();
          });
          
          // Optionally add to context
          const addToContext = await safeQuestion(chalk.yellow(promptLabel('questions.addMemoryToCurrentContext', 'Add to current context? (y/n): ')));
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

      if (input.toLowerCase().startsWith('/memory')) {
        const rawArgs = input.slice('/memory'.length).trim();

        if (!rawArgs) {
          const latestNotes = listLongMemoryNotes(6);
          console.log(chalk.cyan('\nMarkdown Long Memory'));
          console.log(chalk.gray(`File: ${LONG_MEMORY_FILE}`));
          if (latestNotes.length) {
            console.log(chalk.green(`Recent notes (${latestNotes.length}):`));
            for (const note of latestNotes) {
              console.log(`  - ${note}`);
            }
          } else {
            console.log(chalk.gray('No notes yet. Save one with /memory add title ::: note'));
          }
          console.log(chalk.gray('Commands: /memory add title ::: note ::: tags | /memory save note | /memory search query | /memory show'));
          continue;
        }

        const lowerArgs = rawArgs.toLowerCase();
        if (lowerArgs === 'show' || lowerArgs === 'read') {
          const text = loadLongMemoryText();
          console.log();
          console.log(box(truncateToolText(text, 16000), 'Long Memory (.md)', 'magenta'));
          console.log();
          continue;
        }

        if (lowerArgs.startsWith('search ')) {
          const query = rawArgs.slice(7).trim();
          if (!query) {
            console.log(chalk.yellow('Usage: /memory search <query>'));
            continue;
          }
          const matches = searchLongMemoryNotes(query, 5);
          if (!matches.length) {
            console.log(chalk.yellow(`No markdown notes found for: ${query}`));
            continue;
          }

          console.log(chalk.green(`Found ${matches.length} note match${matches.length === 1 ? '' : 'es'}:\n`));
          matches.forEach((match, index) => {
            console.log(box(truncateToolText(match, 1200), `Note ${index + 1}`, 'magenta'));
            console.log();
          });
          continue;
        }

        if (lowerArgs.startsWith('save ')) {
          const note = rawArgs.slice(5).trim();
          if (!note) {
            console.log(chalk.yellow('Usage: /memory save <note>'));
            continue;
          }
          const saved = appendLongMemoryNote({ content: note, source: 'manual-save' });
          if (!saved.ok) {
            console.log(chalk.red(`Failed to save note: ${saved.error}`));
            continue;
          }
          console.log(chalk.green(`Saved note: ${saved.title}`));
          continue;
        }

        if (lowerArgs.startsWith('add ')) {
          const payload = rawArgs.slice(4).trim();
          const parts = payload.split(':::').map(part => part.trim());
          if (parts.length < 2 || !parts[0] || !parts[1]) {
            console.log(chalk.yellow('Usage: /memory add <title> ::: <note> ::: <optional tags>'));
            continue;
          }
          const saved = appendLongMemoryNote({
            title: parts[0],
            content: parts[1],
            tags: parts[2] || '',
            source: 'manual-add',
          });
          if (!saved.ok) {
            console.log(chalk.red(`Failed to save note: ${saved.error}`));
            continue;
          }
          const tagPart = saved.tags.length ? ` [${saved.tags.join(', ')}]` : '';
          console.log(chalk.green(`Saved note: ${saved.title}${tagPart}`));
          continue;
        }

        console.log(chalk.yellow('Usage: /memory | /memory show | /memory search <query> | /memory save <note> | /memory add <title> ::: <note> ::: <optional tags>'));
        continue;
      }
      
      // Handle codebase scan command
      if (input.toLowerCase() === '/scan') {
        console.log(uiCleanMode() ? chalk.cyan('\nScanning codebase...') : chalk.cyan('\n🔍 Scanning codebase...'));
        const scanResult = scanCodebase('.');
        
        if (scanResult.files.length === 0) {
          console.log(chalk.yellow('No code files found in current directory.'));
          continue;
        }
        
        const formattedScan = formatScanResults(scanResult);
        const includedCount = scanResult.files.filter(f => !f.skipped).length;
        const skippedCount = scanResult.files.filter(f => f.skipped).length;
        
        console.log(uiCleanMode()
          ? chalk.green(`Scanned ${includedCount} files (~${Math.round(scanResult.totalSize/1024)}KB)`)
          : chalk.green(`✅ Scanned ${includedCount} files (~${Math.round(scanResult.totalSize/1024)}KB)`));
        if (skippedCount > 0) {
          console.log(uiCleanMode()
            ? chalk.yellow(`Skipped ${skippedCount} files (too large or limit reached)`)
            : chalk.yellow(`⏭️  Skipped ${skippedCount} files (too large or limit reached)`));
        }
        
        // Add scan to context
        messages.push({ 
          role: 'user', 
          content: `I've scanned the entire codebase. Here are all the files:\n${formattedScan}\n\nYou now have the full codebase context. Use this information to help me.`
        });
        
        ensureSapperDir();
        fs.writeFileSync(CONTEXT_FILE, JSON.stringify(messages, null, 2));
        console.log(uiCleanMode()
          ? chalk.gray('Codebase added to context. AI now has full picture.\n')
          : chalk.gray('📝 Codebase added to context. AI now has full picture.\n'));
        continue;
      }

      if (input.startsWith('/') && !input.startsWith('//') && !agentHandled) {
        const commandToken = input.slice(1).trim().split(/\s+/)[0] || '';
        const suggestions = suggestSlashCommands(commandToken, 5);
        if (uiCleanMode()) {
          const lines = [
            `${chalk.white(input)}`,
            suggestions.length > 0 ? UI.slate(`did you mean: ${suggestions.join(', ')}`) : UI.slate('no close command suggestions'),
            UI.slate('use /commands to view the full command palette'),
            UI.slate('for literal text starting with /, prefix with //'),
          ];
          console.log();
          console.log(box(lines.join('\n'), 'Unknown Command', 'yellow'));
        } else {
          console.log(chalk.yellow(`Unknown command: ${input}`));
          if (suggestions.length > 0) {
            console.log(UI.slate(`Did you mean: ${suggestions.join(', ')}`));
          }
          console.log(UI.slate('Use /commands to view the full command palette.'));
          console.log(UI.slate('If you meant literal text that starts with /, prefix it with //'));
        }
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
            if (stats.size > getMaxFileSize()) {
              console.log(chalk.red.bold(`\n╔══════════════════════════════════════════════════════════╗`));
              console.log(chalk.red.bold(`║  ⛔ FILE TOO LARGE — Cannot attach                       ║`));
              console.log(chalk.red.bold(`╚══════════════════════════════════════════════════════════╝`));
              console.log(chalk.yellow(`   File: ${filePath}`));
              console.log(chalk.yellow(`   Size: ${Math.round(stats.size/1024)}KB (limit: ${Math.round(getMaxFileSize()/1024)}KB)`));
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
        const prompt = await safeQuestion(promptQuestion('questions.promptForFiles', 'Your prompt for these files: '));
        
        if (!prompt.trim()) {
          console.log(chalk.gray('Cancelled.'));
          continue;
        }
        
        // Build message with attachments
        const attachedContent = formatFileAttachments(fileAttachments);
        
        messages.push({ role: 'user', content: prompt + attachedContent });
        // Continue to AI response (don't use 'continue' here)
      } else {
        // Process @file attachments in prompt (e.g., "analyze @package.json" or "fix @src/index.js")
      let processedInput = input.startsWith('//') ? input.slice(1) : input;
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
              if (stats.size > getMaxFileSize()) {
                console.log(chalk.red.bold(`\n╔══════════════════════════════════════════════════════════╗`));
                console.log(chalk.red.bold(`║  ⛔ FILE TOO LARGE — Cannot attach @${filePath.padEnd(22).slice(0, 22)}║`));
                console.log(chalk.red.bold(`╚══════════════════════════════════════════════════════════╝`));
                console.log(chalk.yellow(`   Size: ${Math.round(stats.size/1024)}KB — exceeds ${Math.round(getMaxFileSize()/1024)}KB limit`));
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
                      if (relStats.size <= getMaxFileSize()) {
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
        const attachedContent = formatFileAttachments(fileAttachments);
        
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
      const MAX_TOOL_ROUNDS = toolRoundLimit();
      const patchFailures = {}; // Track consecutive PATCH failures per file: { path: count }
      const MAX_PATCH_RETRIES = getPatchRetries();

      // Unified patch-with-retry logic used by both native and text-marker tool handlers
      async function patchWithRetry(filePath, oldText, newText) {
        const key = filePath.trim();
        if (patchFailures[key] >= MAX_PATCH_RETRIES) {
          return { result: `Error: PATCH failed ${MAX_PATCH_RETRIES} times on ${key}. STOP retrying PATCH on this file. Instead, READ the file to see exact content, then use LINE:number mode or WRITE to rewrite the file.`, success: false };
        }
        const result = await tools.patch(filePath, oldText, newText);
        if (result.includes('Successfully')) {
          patchFailures[key] = 0;
          return { result, success: true };
        }
        if (result.startsWith('Error:')) {
          patchFailures[key] = (patchFailures[key] || 0) + 1;
          return { result: result + `\n(Attempt ${patchFailures[key]}/${MAX_PATCH_RETRIES})`, success: false };
        }
        return { result, success: true };
      }
      const turnThinkingEnabled = shouldUseThinkingForInput(input);
      
      let active = true;
      while (active) {
        if (stepMode) await safeQuestion(chalk.gray(promptLabel('questions.stepContinue', '[STEP] Press Enter to let AI think...')));
        
        spinner.start('Thinking...');
        const aiStartTime = Date.now();
        let response;
        try {
          // Build chat options — pass native tools when supported
          const chatOpts = { model: selectedModel, messages, stream: true };
          if (effectiveContextLength()) {
            chatOpts.options = { num_ctx: effectiveContextLength() };
          }
          // Thinking can be forced on, forced off, or auto-disabled for simple prompts.
          chatOpts.think = turnThinkingEnabled;
          if (useNativeTools) {
            // Filter tool defs by agent restrictions if any
            if (currentAgentTools) {
              const toolNameMap = {
                list_directory: 'LIST', read_file: 'READ', search_files: 'SEARCH',
                write_file: 'WRITE', patch_file: 'PATCH', create_directory: 'MKDIR',
                ls: 'LS', cat: 'CAT', head: 'HEAD', tail: 'TAIL', grep: 'GREP', find: 'FIND',
                pwd: 'PWD', cd: 'CD', rmdir: 'RMDIR', changes: 'CHANGES',
                fetch_web: 'FETCH', recall_memory: 'MEMORY', open_url: 'OPEN', run_shell: 'SHELL'
              };
              chatOpts.tools = nativeToolDefs.filter(t => 
                isToolAllowedForAgent(currentAgentTools, toolNameMap[t.function.name])
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
        const MAX_RESPONSE_LENGTH = LIMITS.MAX_RESPONSE_LENGTH;
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
        let thinkingContinuationNeedsPrefix = false;
        let lastThinkingIdleNoticeAt = 0;
        const genStartTime = Date.now(); // Track generation elapsed time
        let genTokenCount = 0; // Count response tokens as they stream
        let lastVisibleActivityAt = Date.now();
        let heartbeatInterval = null;
        
        const activeAgent = getActiveAgentMeta();
        const responseTitle = activeAgent ? activeAgent.name || currentAgent : 'Sapper';
        const responseSubtitleParts = [selectedModel];
        if (activeAgent && currentAgent) {
          responseSubtitleParts.push(`/${currentAgent}`);
        }
        console.log(sectionTitle(responseTitle, responseSubtitleParts.join(' · '), activeAgent ? 'magenta' : 'cyan'));
        const responseModeSummary = activeModeSummary({ includeAgent: !activeAgent, maxSkills: 4 });
        if (responseModeSummary) {
          console.log(UI.slate(responseModeSummary));
        }
        const MAX_THINKING_IDLE_SECONDS = 300; // Abort if model stalls in thinking >5min
        if (streamHeartbeatEnabled()) {
          heartbeatInterval = setInterval(() => {
            if (abortStream) return;

            if (isThinking) {
              const idleSeconds = Math.max(0, Math.floor((Date.now() - lastVisibleActivityAt) / 1000));
              const idleThreshold = streamIdleNoticeSeconds();
              if (idleSeconds >= MAX_THINKING_IDLE_SECONDS) {
                process.stdout.write(`\n${UI.slate('  │ ')}${chalk.yellow(`⚠ thinking stalled ${idleSeconds}s — aborting stream`)}\n`);
                abortStream = true;
                return;
              }
              if (idleSeconds >= idleThreshold && Date.now() - lastThinkingIdleNoticeAt >= 5000) {
                process.stdout.write(`\n${UI.slate('  │ ')}${UI.slate.italic(`... waiting ${idleSeconds}s for more reasoning`)}\n`);
                thinkingContinuationNeedsPrefix = true;
                lastThinkingIdleNoticeAt = Date.now();
              }
              return;
            }

            renderStreamingHeartbeat({
              genTokenCount,
              genStartTime,
              lastVisibleActivityAt,
              stage: genTokenCount > 0 ? 'generating' : 'waiting-first',
            });
          }, 1000);
        }
        let streamErrored = null;
        try {
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
              if (li > 0 || thinkingContinuationNeedsPrefix) process.stdout.write(`\n${UI.slate('  │ ')}`);
              thinkingContinuationNeedsPrefix = false;
              process.stdout.write(UI.slate.italic(lines[li]));
            }
            thinkMsg += thinking;
            lastVisibleActivityAt = Date.now();
            lastThinkingIdleNoticeAt = 0;
          }
          
          const content = chunk.message.content;
          if (content) {
            if (isThinking) {
              isThinking = false;
              process.stdout.write(`\n${UI.slate('  └─')}\n\n`);
            }
            msg += content;
            genTokenCount++;
            lastVisibleActivityAt = Date.now();
            renderStreamingHeartbeat({
              genTokenCount,
              genStartTime,
              lastVisibleActivityAt,
              stage: 'generating',
            });
          }
          
          // Capture token stats from the final chunk (done: true)
          if (chunk.prompt_eval_count) chunkPromptTokens = chunk.prompt_eval_count;
          if (chunk.eval_count) chunkEvalTokens = chunk.eval_count;
          
          // Collect native tool_calls (arrive in chunks, usually the final one)
          if (chunk.message.tool_calls && chunk.message.tool_calls.length > 0) {
            nativeToolCalls.push(...chunk.message.tool_calls);
          }
          
          // Smart loop detection: check for repetitive content patterns
          if (msg.length > LIMITS.REPETITION_THRESHOLD) {
            const recentContent = msg.slice(-LIMITS.REPETITION_WINDOW);
            const previousContent = msg.slice(-LIMITS.REPETITION_WINDOW * 2, -LIMITS.REPETITION_WINDOW);
            
            // If last 500 chars are very similar to previous 500, might be looping
            if (recentContent === previousContent) {
              repetitionCount++;
              if (repetitionCount > LIMITS.REPETITION_COUNT) {
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
        } catch (streamErr) {
          streamErrored = streamErr;
        } finally {
          if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
          }
        }
        if (streamErrored) {
          if (isThinking) {
            isThinking = false;
            process.stdout.write(`\n${UI.slate('  └─')}\n`);
          }
          process.stdout.write('\r\x1b[K');
          console.error(chalk.red(`\n❌ Stream error: ${streamErrored.message || streamErrored}`));
          logEntry('error', { message: `Stream error: ${streamErrored.message || streamErrored}` });
          active = false;
          continue;
        }
        if (isThinking) {
          isThinking = false;
          process.stdout.write(`\n${UI.slate('  └─')}\n`);
        }
        // Clear progress line and render formatted markdown
        process.stdout.write('\r\x1b[K');
        showStreamPhase('Finalizing streamed response...');
        if (msg.trim()) {
          showStreamPhase('Rendering markdown output...');
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
            write_file: 'WRITE', patch_file: 'PATCH', create_directory: 'MKDIR',
            ls: 'LS', cat: 'CAT', head: 'HEAD', tail: 'TAIL', grep: 'GREP', find: 'FIND',
            pwd: 'PWD', cd: 'CD', rmdir: 'RMDIR', changes: 'CHANGES',
            fetch_web: 'FETCH', recall_memory: 'MEMORY', open_url: 'OPEN', run_shell: 'SHELL'
          };

          showStreamPhase(`Running ${nativeToolCalls.length} native tool call${nativeToolCalls.length === 1 ? '' : 's'}...`);

          for (const tc of nativeToolCalls) {
            const fn = tc.function;
            const toolType = nativeToolNameMap[fn.name] || fn.name.toUpperCase();
            const args = fn.arguments || {};

            // Enforce agent tool restrictions
            if (currentAgentTools && !isToolAllowedForAgent(currentAgentTools, toolType)) {
              console.log(chalk.yellow(`\n⚠️  Tool ${toolType} blocked — not in agent's allowed tools`));
              messages.push({ role: 'tool', content: `Error: Tool ${toolType} is not allowed for the current agent.`, tool_name: fn.name });
              continue;
            }

            const displayPath = args.path || args.pattern || args.url || args.query || args.command || '';
            console.log();
            console.log(statusBadge(toolType, 'action') + chalk.gray(' → ') + chalk.white(displayPath));

            const toolStart = Date.now();
            let result;
            let toolSuccess = true;

            try {
              switch (fn.name) {
                case 'list_directory':
                  result = tools.list(args.path ?? '.');
                  logEntry('file', { action: 'list', path: args.path ?? '.' });
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
                  const pr = await patchWithRetry(args.path, args.old_text, args.new_text);
                  result = pr.result;
                  toolSuccess = pr.success;
                  logEntry('file', { action: 'patch', path: args.path, userApproved: pr.success });
                  break;
                }
                case 'create_directory':
                  result = tools.mkdir(args.path);
                  logEntry('file', { action: 'mkdir', path: args.path });
                  break;
                case 'ls':
                  result = tools.ls(args.path ?? '.');
                  logEntry('file', { action: 'list', path: args.path ?? '.' });
                  break;
                case 'cat':
                  result = tools.cat(args.path);
                  logEntry('file', { action: 'read', path: args.path, size: result?.length || 0 });
                  break;
                case 'head':
                  result = tools.head(args.path, args.lines);
                  logEntry('file', { action: 'read', path: args.path, size: result?.length || 0 });
                  break;
                case 'tail':
                  result = tools.tail(args.path, args.lines);
                  logEntry('file', { action: 'read', path: args.path, size: result?.length || 0 });
                  break;
                case 'grep':
                  result = await tools.grep(args.pattern);
                  logEntry('tool', { toolType: 'GREP', path: args.pattern, duration: Date.now() - toolStart, success: true, resultSize: result?.length });
                  break;
                case 'find':
                  result = tools.find(args.pattern, args.path ?? '.');
                  logEntry('tool', { toolType: 'FIND', path: args.pattern, duration: Date.now() - toolStart, success: !String(result).startsWith('Error:'), resultSize: result?.length });
                  break;
                case 'pwd':
                  result = tools.pwd();
                  break;
                case 'cd':
                  result = tools.cd(args.path);
                  break;
                case 'rmdir':
                  result = await tools.rmdir(args.path);
                  logEntry('file', { action: 'rmdir', path: args.path, userApproved: !String(result).includes('blocked') });
                  break;
                case 'changes':
                  result = await tools.changes(args.path);
                  logEntry('tool', { toolType: 'CHANGES', path: args.path ?? '.', duration: Date.now() - toolStart, success: !String(result).startsWith('Error:'), resultSize: result?.length });
                  break;
                case 'fetch_web':
                  result = await tools.fetch_web(args.url);
                  logEntry('tool', { toolType: 'FETCH', path: args.url, duration: Date.now() - toolStart, success: !String(result).startsWith('Error:'), resultSize: result?.length });
                  break;
                case 'recall_memory':
                  result = await tools.recall_memory(args.query);
                  logEntry('tool', { toolType: 'MEMORY', path: args.query, duration: Date.now() - toolStart, success: !String(result).startsWith('Error:'), resultSize: result?.length });
                  break;
                case 'save_memory_note':
                  result = await tools.save_memory_note(args.title, args.content, args.tags);
                  logEntry('tool', { toolType: 'MEMORY', path: args.title || 'memory-note', duration: Date.now() - toolStart, success: !String(result).startsWith('Error:'), resultSize: result?.length });
                  break;
                case 'search_memory_notes':
                  result = await tools.search_memory_notes(args.query);
                  logEntry('tool', { toolType: 'MEMORY', path: args.query, duration: Date.now() - toolStart, success: !String(result).startsWith('Error:'), resultSize: result?.length });
                  break;
                case 'read_memory_notes':
                  result = await tools.read_memory_notes();
                  logEntry('tool', { toolType: 'MEMORY', path: LONG_MEMORY_FILE, duration: Date.now() - toolStart, success: !String(result).startsWith('Error:'), resultSize: result?.length });
                  break;
                case 'open_url':
                  result = await tools.open_url(args.url);
                  logEntry('tool', { toolType: 'OPEN', path: args.url, duration: Date.now() - toolStart, success: String(result).startsWith('Opened URL'), resultSize: result?.length });
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
            showStreamPhase('Tool limit reached. Requesting final answer...');
            resetTerminal();
            messages.push({ role: 'user', content: 'STOP using tools now. Provide your analysis based on what you have.' });
          } else {
            showStreamPhase('Tool results ready. Continuing response generation...');
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
              console.log(chalk.gray(`  "${toolAttempt[0].substring(0, LIMITS.DEBUG_TOOL_PREVIEW)}..."`));
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

          showStreamPhase(`Running ${toolMatches.length} parsed tool call${toolMatches.length === 1 ? '' : 's'}...`);

          for (const match of toolMatches) {
            const [_, type, path, content] = match;
            
            // Enforce tool restrictions from active agent
            if (currentAgentTools && !isToolAllowedForAgent(currentAgentTools, type)) {
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
            else if (type.toLowerCase() === 'ls') {
              result = tools.ls(path);
              logEntry('file', { action: 'list', path: path || '.' });
            }
            else if (type.toLowerCase() === 'read') {
              result = tools.read(path);
              logEntry('file', { action: 'read', path, size: result?.length || 0 });
            }
            else if (type.toLowerCase() === 'cat') {
              result = tools.cat(path);
              logEntry('file', { action: 'read', path, size: result?.length || 0 });
            }
            else if (type.toLowerCase() === 'head') {
              result = tools.head(path, content);
              logEntry('file', { action: 'read', path, size: result?.length || 0 });
            }
            else if (type.toLowerCase() === 'tail') {
              result = tools.tail(path, content);
              logEntry('file', { action: 'read', path, size: result?.length || 0 });
            }
            else if (type.toLowerCase() === 'mkdir') {
              result = tools.mkdir(path);
              logEntry('file', { action: 'mkdir', path });
            }
            else if (type.toLowerCase() === 'rmdir') {
              result = await tools.rmdir(path);
              logEntry('file', { action: 'rmdir', path, userApproved: !String(result).includes('blocked') });
            }
            else if (type.toLowerCase() === 'pwd') {
              result = tools.pwd();
            }
            else if (type.toLowerCase() === 'cd') {
              result = tools.cd(path);
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
              // Accept ||| as primary separator, ||: as fallback (small models sometimes mistype)
              let parts = null;
              const sepIdx = content?.indexOf('|||');
              if (sepIdx > -1) {
                parts = [content.substring(0, sepIdx), content.substring(sepIdx + 3)];
              } else {
                const sepIdx2 = content?.indexOf('||:');
                if (sepIdx2 > -1) {
                  parts = [content.substring(0, sepIdx2), content.substring(sepIdx2 + 3)];
                }
              }
              if (parts && parts.length === 2) {
                const pr = await patchWithRetry(path, parts[0], parts[1]);
                result = pr.result;
                toolSuccess = pr.success;
                logEntry('file', { action: 'patch', path, userApproved: pr.success });
              } else {
                result = 'Error: PATCH requires format [TOOL:PATCH]path:::OLD_TEXT|||NEW_TEXT[/TOOL] or [TOOL:PATCH]path:::LINE:number|||NEW_TEXT[/TOOL]';
                toolSuccess = false;
              }
            }
            else if (type.toLowerCase() === 'search') {
              result = await tools.search(path);
              logEntry('tool', { toolType: 'SEARCH', path, duration: Date.now() - toolStart, success: true, resultSize: result?.length });
            }
            else if (type.toLowerCase() === 'grep') {
              result = await tools.grep(path);
              logEntry('tool', { toolType: 'GREP', path, duration: Date.now() - toolStart, success: true, resultSize: result?.length });
            }
            else if (type.toLowerCase() === 'find') {
              result = tools.find(path, content);
              logEntry('tool', { toolType: 'FIND', path, duration: Date.now() - toolStart, success: !String(result).startsWith('Error:'), resultSize: result?.length });
            }
            else if (type.toLowerCase() === 'changes') {
              result = await tools.changes(path);
              logEntry('tool', { toolType: 'CHANGES', path: path || '.', duration: Date.now() - toolStart, success: !String(result).startsWith('Error:'), resultSize: result?.length });
            }
            else if (type.toLowerCase() === 'fetch') {
              result = await tools.fetch_web(path);
              logEntry('tool', { toolType: 'FETCH', path, duration: Date.now() - toolStart, success: !String(result).startsWith('Error:'), resultSize: result?.length });
            }
            else if (type.toLowerCase() === 'memory') {
              result = await tools.recall_memory(path);
              logEntry('tool', { toolType: 'MEMORY', path, duration: Date.now() - toolStart, success: !String(result).startsWith('Error:'), resultSize: result?.length });
            }
            else if (type.toLowerCase() === 'memory_note_save') {
              const [noteContent = '', tagText = ''] = String(content ?? '').split(':::');
              result = await tools.save_memory_note(path, noteContent, tagText);
              logEntry('tool', { toolType: 'MEMORY', path, duration: Date.now() - toolStart, success: !String(result).startsWith('Error:'), resultSize: result?.length });
            }
            else if (type.toLowerCase() === 'memory_note_search') {
              result = await tools.search_memory_notes(path);
              logEntry('tool', { toolType: 'MEMORY', path, duration: Date.now() - toolStart, success: !String(result).startsWith('Error:'), resultSize: result?.length });
            }
            else if (type.toLowerCase() === 'memory_note_read') {
              result = await tools.read_memory_notes();
              logEntry('tool', { toolType: 'MEMORY', path: LONG_MEMORY_FILE, duration: Date.now() - toolStart, success: !String(result).startsWith('Error:'), resultSize: result?.length });
            }
            else if (type.toLowerCase() === 'open') {
              result = await tools.open_url(path);
              logEntry('tool', { toolType: 'OPEN', path, duration: Date.now() - toolStart, success: String(result).startsWith('Opened URL'), resultSize: result?.length });
            }
            else if (type.toLowerCase() === 'shell') {
              result = await tools.shell(path);
              const approved = !result.includes('blocked');
              logEntry('shell', { command: path, duration: Date.now() - toolStart, userApproved: approved, exitCode: result.match(/code (\d+)/)?.[1] ?? null });
            }

            // Log tool execution (for non-shell, non-file specific ones)
            if (!['list', 'ls', 'read', 'cat', 'head', 'tail', 'mkdir', 'rmdir', 'pwd', 'cd', 'write', 'patch', 'search', 'grep', 'find', 'changes', 'fetch', 'memory', 'memory_note_save', 'memory_note_search', 'memory_note_read', 'open', 'shell'].includes(type.toLowerCase())) {
              logEntry('tool', { toolType: type.toUpperCase(), path, duration: Date.now() - toolStart, success: toolSuccess, resultSize: result?.length, error: toolSuccess ? undefined : result });
            }

            messages.push({ role: 'user', content: `RESULT (${path}): ${result}` });
          }
          ensureSapperDir();
          fs.writeFileSync(CONTEXT_FILE, JSON.stringify(messages, null, 2));
          
          if (toolMatches.length > LIMITS.TOOL_WARN_THRESHOLD) {
            console.log(chalk.yellow('\n⚠️  Reading 30+ files! This might take time.'));
          }
          
          // If tool limit was reached, stop after processing this round
          if (hitToolLimit) {
            showStreamPhase('Tool limit reached. Requesting final answer...');
            resetTerminal();
            messages.push({ 
              role: 'user', 
              content: 'STOP using tools now. You have enough information. Please provide your analysis based on what you have read.' 
            });
          } else {
            showStreamPhase('Tool results ready. Continuing response generation...');
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
