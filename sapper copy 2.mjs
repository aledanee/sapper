#!/usr/bin/env node
import ollama from 'ollama';
import fs from 'fs';
import { spawn } from 'child_process';
import chalk from 'chalk';
import ora from 'ora';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

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
  if (ctrlCCount >= 2) {
    console.log(chalk.red('\nForce quitting...'));
    process.exit(1);
  }
  // Clear current line and move to new one - stops ghost output
  process.stdout.clearLine(0);
  process.stdout.cursorTo(0);
  console.log(chalk.yellow('\nStopping AI stream... (Ctrl+C again to force quit)'));
  
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
const CONTEXT_FILE = '.sapper_context.json';

let stepMode = false;
let debugMode = false; // Toggle with /debug command
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

// Scan entire codebase and return summary
function scanCodebase(dir = '.', depth = 0, maxDepth = 5) {
  if (depth > maxDepth) return { files: [], totalSize: 0 };
  
  let files = [];
  let totalSize = 0;
  
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = dir === '.' ? entry.name : `${dir}/${entry.name}`;
      
      // Skip ignored directories
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        const subResult = scanCodebase(fullPath, depth + 1, maxDepth);
        files = files.concat(subResult.files);
        totalSize += subResult.totalSize;
      } else {
        // Check if file should be included
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

const tools = {
  read: (path) => {
    try { return fs.readFileSync(path.trim(), 'utf8'); } 
    catch (error) { return `Error reading file: ${error.message}`; }
  },
  patch: async (path, oldText, newText) => {
    const trimmedPath = path.trim();
    try {
      const content = fs.readFileSync(trimmedPath, 'utf8');
      if (!content.includes(oldText)) {
        return `Error: Could not find the text to replace in ${trimmedPath}. Make sure oldText matches exactly (including whitespace).`;
      }
      const newContent = content.replace(oldText, newText);
      
      // Show diff preview
      console.log(chalk.yellow.bold(`\n[PATCH] ${trimmedPath}`));
      console.log(chalk.red('- ' + oldText.split('\n').join('\n- ')));
      console.log(chalk.green('+ ' + newText.split('\n').join('\n+ ')));
      
      const confirm = await safeQuestion(chalk.yellow('Apply this patch? (y/n): '));
      if (confirm.toLowerCase() === 'y') {
        fs.writeFileSync(trimmedPath, newContent);
        return `Successfully patched ${trimmedPath}`;
      }
      return 'Patch rejected by user.';
    } catch (error) { return `Error patching file: ${error.message}`; }
  },
  write: async (path, content) => {
    const trimmedPath = path.trim();
    console.log(chalk.yellow.bold(`\n[WRITE] Sapper wants to write to: `) + chalk.white(trimmedPath));
    console.log(chalk.gray(`Content preview (first 200 chars):\n${content?.substring(0, 200)}${content?.length > 200 ? '...' : ''}`));
    const confirm = await safeQuestion(chalk.yellow('Allow write? (y/n): '));
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
    console.log(chalk.red.bold(`\n[SECURITY] Sapper wants to execute: `) + chalk.white(cmd));
    const confirm = await safeQuestion(chalk.yellow('Allow? (y/n): '));
    if (confirm.toLowerCase() === 'y') {
      return new Promise((resolve) => {
        const useShell = cmd.includes('&&') || cmd.includes('|') || cmd.includes('cd ');
        console.log(chalk.cyan(`\n[RUNNING] ${cmd}\n`));
        const proc = spawn(useShell ? 'sh' : cmd.split(' ')[0], useShell ? ['-c', cmd] : cmd.split(' ').slice(1), { 
          stdio: 'inherit', shell: useShell 
        });
        proc.on('close', (code) => {
          // Crucial: give control back to Node
          if (process.stdin.isTTY) {
            try { process.stdin.setRawMode(false); } catch (e) {}
          }
          // Delay slightly to let terminal settle
          setTimeout(() => {
            recreateReadline();
            resolve(`Command completed with code ${code}`);
          }, 200);
        });
      });
    }
    return "Command blocked by user.";
  },
  list: (path) => {
    try {
      const dir = path.trim() || '.';
      const entries = fs.readdirSync(dir);
      // Filter out ignored directories
      const filtered = entries.filter(entry => {
        if (IGNORE_DIRS.has(entry)) return false;
        // Also skip hidden files/folders (starting with .) except current dir
        if (entry.startsWith('.') && entry !== '.') return false;
        return true;
      });
      return filtered.length > 0 ? filtered.join('\n') : '(empty or all files filtered)';
    } catch (e) { return `Error: ${e.message}`; }
  },
  search: (pattern) => {
    return new Promise((resolve) => {
      const excludeDirs = Array.from(IGNORE_DIRS).join(',');
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
      console.log(chalk.yellow('🔄 UPDATE AVAILABLE!'));
      console.log(chalk.gray(`   Current: v${CURRENT_VERSION}`));
      console.log(chalk.green(`   Latest:  v${latestVersion}`));
      console.log(chalk.cyan('   Run: npm update -g sapper-iq\n'));
    }
  } catch (error) {
    // Silently fail if update check fails
  }
}

async function runSapper() {
  console.clear();
  console.log(chalk.cyan.bold(` SAPPER v${CURRENT_VERSION} | Autonomous "OpenCode" Mode`));
  console.log(chalk.gray(`📁 Working Directory: ${process.cwd()}\n`));
  
  // Check for updates
  await checkForUpdates();
  
  let messages = [];
  if (fs.existsSync(CONTEXT_FILE)) {
    const resume = await safeQuestion(chalk.green('Resume previous session? (y/n): '));
    if (resume.toLowerCase() === 'y') {
      messages = JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8'));
    } else {
      // User said no - delete the old context file
      fs.unlinkSync(CONTEXT_FILE);
      console.log(chalk.gray('Starting fresh session...\n'));
    }
  }

  const localModels = await ollama.list();
  localModels.models.forEach((m, i) => console.log(`${i + 1}. ${m.name}`));
  const choice = await safeQuestion(chalk.yellow('\nChoose model: '));
  const selectedModel = localModels.models[parseInt(choice) - 1]?.name || localModels.models[0].name;

  if (messages.length === 0) {
    messages = [{
      role: 'system',
      content: `You are Sapper, a coding assistant that ONLY does what the user asks.

GOLDEN RULE: Do EXACTLY what the user asks. Nothing more, nothing less.
- NEVER add features the user didn't ask for.
- ALWAYS confirm with the user before writing/patching files or running shell commands.
- KEEP responses concise and to the point.
TOOLS (use these to interact with files):

[TOOL:LIST]path[/TOOL]
→ List files in a directory
→ Example: [TOOL:LIST].[/TOOL]

[TOOL:READ]path[/TOOL]
→ Read a file's contents
→ Example: [TOOL:READ]./package.json[/TOOL]

[TOOL:WRITE]path]content[/TOOL]
→ Create or overwrite a file (needs user confirmation)
→ Example: [TOOL:WRITE]./index.js]console.log("hello")[/TOOL]

[TOOL:PATCH]path]old_text|||new_text[/TOOL]
→ Replace specific text in a file (needs user confirmation)
→ Example: [TOOL:PATCH]./app.js]old code|||new code[/TOOL]

[TOOL:SEARCH]pattern[/TOOL]
→ Search for text across all files
→ Example: [TOOL:SEARCH]function login[/TOOL]

[TOOL:SHELL]command[/TOOL]
→ Run a terminal command (needs user confirmation)
→ Example: [TOOL:SHELL]npm install express[/TOOL]

PATH RULES:
- Always use relative paths: ./file.js, ./src/app.js
- NEVER use absolute paths like /file.js
- Use . for current directory

WORKFLOW:
1. Understand exactly what user wants
2. Use LIST to see existing files if needed
3. Use READ to check existing code if needed
4. Use WRITE/PATCH to make changes
5. Be concise in explanations

CRITICAL: Stay focused. If user asks for X, deliver X only.`
    }];
  }

  // Main conversation loop - never exits unless user types 'exit'
  while (true) {
    try {
      // Context size warning - large context causes hangs
      const contextSize = JSON.stringify(messages).length;
      if (contextSize > 32000) {
        console.log(chalk.red.bold('\n⚠️  WARNING: Context is very large (~' + Math.round(contextSize/1024) + 'KB). Sapper might hang.'));
        console.log(chalk.yellow('👉 Suggestion: Type /prune to keep only the latest analysis.'));
      }
      
      const input = await safeQuestion(chalk.blue.bold('\nIbrahim ➔ '));
      
      if (input.toLowerCase() === 'exit') process.exit();
      
      // Handle reset command
      if (input.toLowerCase() === '/reset' || input.toLowerCase() === '/clear') {
        if (fs.existsSync(CONTEXT_FILE)) {
          fs.unlinkSync(CONTEXT_FILE);
          console.log(chalk.green('✅ Context cleared! Starting fresh...\n'));
        }
        messages = [{
          role: 'system',
          content: messages[0].content // Keep system prompt
        }];
        continue;
      }
      
      // Handle prune command - summarize and clear old context
      if (input.toLowerCase() === '/prune') {
        if (messages.length <= 5) {
          console.log(chalk.yellow('Context is already small, nothing to prune.'));
          continue;
        }
        
        // 1. Capture the ORIGINAL detailed system prompt from the very first message
        const originalSystemPrompt = messages[0];
        
        // 2. Capture the last 4 messages (the most recent conversation)
        const recentMessages = messages.slice(-4);
        
        // 3. Rebuild the messages array starting with the ORIGINAL prompt
        messages = [originalSystemPrompt, ...recentMessages];
        
        // 4. Add reminder to stay in Agent Mode (not chatbot mode)
        messages.push({ 
          role: 'system', 
          content: `CONTEXT PRUNED. REMINDER: You are an AGENT, not a chatbot. You MUST use tools to take action:
- [TOOL:LIST]path[/TOOL] - List directory
- [TOOL:READ]path[/TOOL] - Read file
- [TOOL:SEARCH]pattern[/TOOL] - Search codebase
- [TOOL:WRITE]path]content[/TOOL] - Create/overwrite file
- [TOOL:PATCH]path]old|||new[/TOOL] - Edit file
- [TOOL:SHELL]command[/TOOL] - Run terminal command
Do NOT just display content. Actually WRITE files using the tool.`
        });
        
        // 5. Save to context file so it persists
        fs.writeFileSync(CONTEXT_FILE, JSON.stringify(messages));
        
        console.log(chalk.green(`✅ Pruned context. Sapper reminded to stay in Agent Mode.`));
        console.log(chalk.gray(`Context size: ${messages.length} messages\n`));
        continue;
      }
      
      // Handle help command
      if (input.toLowerCase() === '/help') {
        console.log(chalk.cyan('\n📚 SAPPER COMMANDS:'));
        console.log(chalk.white('  /scan') + chalk.gray('          - Scan entire codebase and add to context'));
        console.log(chalk.white('  /reset, /clear') + chalk.gray(' - Clear all context and start fresh'));
        console.log(chalk.white('  /prune') + chalk.gray('         - Remove old messages, keep last 4'));
        console.log(chalk.white('  /context') + chalk.gray('       - Show current context size'));
        console.log(chalk.white('  /debug') + chalk.gray('         - Toggle debug mode (shows regex analysis)'));
        console.log(chalk.white('  /help') + chalk.gray('          - Show this help message'));
        console.log(chalk.white('  exit') + chalk.gray('           - Exit Sapper\n'));
        continue;
      }
      
      // Handle context size command
      if (input.toLowerCase() === '/context') {
        const contextSize = JSON.stringify(messages).length;
        console.log(chalk.cyan(`\n📊 Context: ${messages.length} messages, ~${Math.round(contextSize/1024)}KB`));
        if (contextSize > 50000) {
          console.log(chalk.yellow('⚠️  Context is large! Consider using /prune'));
        }
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
        
        fs.writeFileSync(CONTEXT_FILE, JSON.stringify(messages));
        console.log(chalk.gray('📝 Codebase added to context. AI now has full picture.\n'));
        continue;
      }
      
      messages.push({ role: 'user', content: input });

      let toolRounds = 0; // Prevent infinite loops
      const MAX_TOOL_ROUNDS = 20;
      
      let active = true;
      while (active) {
        if (stepMode) await safeQuestion(chalk.gray('[STEP] Press Enter to let AI think...'));
        
        spinner.start('Thinking...');
        let response;
        try {
          response = await ollama.chat({ model: selectedModel, messages, stream: true });
        } catch (ollamaError) {
          spinner.stop();
          console.error(chalk.red('\n❌ Ollama error:'), ollamaError.message);
          active = false;
          continue;
        }
        spinner.stop();

        let msg = '';
        const MAX_RESPONSE_LENGTH = 29000; // Guard against infinite loops (increased for multi-file reads)
        
        process.stdout.write(chalk.white('Sapper: '));
        for await (const chunk of response) {
          const content = chunk.message.content;
          process.stdout.write(content);
          msg += content;
          
          if (msg.length > MAX_RESPONSE_LENGTH) {
            console.log(chalk.red('\n\n⚠️ RESPONSE TOO LONG: Forcing stop to prevent infinite loop.'));
            break;
          }
        }
        console.log();
        messages.push({ role: 'assistant', content: msg });

        // Fixed regex: .+? (non-greedy) stops correctly before [/TOOL]
        const toolMatches = [...msg.matchAll(/\[TOOL:(\w+)\](.+?)(?:\]([\s\S]*?))?\[\/TOOL\]/g)];
        
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
          
          // Prevent infinite tool loops
          if (toolRounds >= MAX_TOOL_ROUNDS) {
            console.log(chalk.yellow(`\n⚠️  Tool limit reached (${MAX_TOOL_ROUNDS} rounds). Stopping auto-execution.`));
            console.log(chalk.gray('💡 Tip: Type /prune after analysis to reduce context size.'));
            resetTerminal(); // Ensure terminal is responsive
            messages.push({ 
              role: 'user', 
              content: 'STOP using tools now. You have enough information. Please provide your analysis based on what you have read.' 
            });
            continue; // Let AI respond without tools
          }
          
          for (const match of toolMatches) {
            const [_, type, path, content] = match;
            console.log(chalk.cyan(`\n[ACTION] ${type} -> ${path}`));
            
            let result;
            if (type.toLowerCase() === 'list') result = tools.list(path);
            else if (type.toLowerCase() === 'read') result = tools.read(path);
            else if (type.toLowerCase() === 'mkdir') result = tools.mkdir(path);
            else if (type.toLowerCase() === 'write') result = await tools.write(path, content);
            else if (type.toLowerCase() === 'patch') {
              // PATCH format: [TOOL:PATCH]path]OLD_TEXT|||NEW_TEXT[/TOOL]
              const parts = content?.split('|||');
              if (parts && parts.length === 2) {
                result = await tools.patch(path, parts[0], parts[1]);
              } else {
                result = 'Error: PATCH requires format [TOOL:PATCH]path]OLD_TEXT|||NEW_TEXT[/TOOL]';
              }
            }
            else if (type.toLowerCase() === 'search') result = await tools.search(path);
            else if (type.toLowerCase() === 'shell') result = await tools.shell(path);

            messages.push({ role: 'user', content: `RESULT (${path}): ${result}` });
          }
          fs.writeFileSync(CONTEXT_FILE, JSON.stringify(messages));
          
          if (toolMatches.length > 30) {
            console.log(chalk.yellow('\n⚠️  Reading 30+ files! This might take time.'));
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
            fs.writeFileSync(CONTEXT_FILE, JSON.stringify(messages));
            active = false;
            spinner.stop(); // Ensure spinner is dead
            resetTerminal(); // Force terminal back to normal state
            process.stdout.write('\n'); // Force newline to break out of stream mode
          }
        }
      }
    } catch (error) {
      console.error(chalk.red('\n❌ Error:'), error.message);
      // Loop continues automatically
    }
  }
}

// Keep-alive interval - prevents Node from exiting when event loop is empty
setInterval(() => {}, 1000);

runSapper();
