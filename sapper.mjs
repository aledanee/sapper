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
  console.log(chalk.yellow('\n\nUse "exit" to close Sapper safely, or Ctrl+C again to force quit.'));
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
      content: `You are Sapper, a senior engineer.

CRITICAL: You are working in the CURRENT DIRECTORY. Always use relative paths!
- Use . or ./ for current directory
- NEVER use / (that's the root directory)
- Use relative paths like ./file.js or subfolder/file.js

STRATEGY FOR FILE READING:
1. Start with [TOOL:LIST].[/TOOL] to see what exists
2. READ FILES BASED ON TASK:
   - Quick overview: Read 2-3 key files (README, package.json, main entry)
   - Deep analysis: Read ALL relevant files (entire src/ folder, all components)
   - User asks "read all": Read ALL files they mention
3. Use format: [TOOL:TYPE]path]content[/TOOL]
4. After reading, PROVIDE ANALYSIS - don't just list more!

READING GUIDELINES:
- If user says "analyze src folder" → Read ALL files in src/
- If user says "read everything" → List directory, then read all files
- If < 20 files total: Read them all
- If > 20 files: Ask user which area to focus on

TOOL FORMAT (CRITICAL - FOLLOW EXACTLY):
✅ CORRECT: [TOOL:LIST].[/TOOL]
✅ CORRECT: [TOOL:READ]./file.js[/TOOL]
✅ CORRECT: [TOOL:SEARCH]functionName[/TOOL]
✅ CORRECT: [TOOL:WRITE]./file.js]full content here[/TOOL]
✅ CORRECT: [TOOL:PATCH]./file.js]old code|||new code[/TOOL]
❌ WRONG: [TOOL:LIST].[/] - missing TOOL at end!

AVAILABLE TOOLS:
- LIST: List directory contents
- READ: Read file contents
- SEARCH: Find text/code across all files (grep-like, returns file:line:match)
- WRITE: Create or overwrite entire file (requires confirmation)
- PATCH: Make small edits to existing file (requires confirmation)
- MKDIR: Create directory
- SHELL: Run terminal command (requires confirmation)

SMART WORKFLOW:
1. For unknown codebases: [TOOL:SEARCH]main|index|app[/TOOL] to find entry points
2. To find where something is defined: [TOOL:SEARCH]function myFunc[/TOOL]
3. SEARCH returns file paths + line numbers - then READ specific files

PATCH vs WRITE:
- Use PATCH for small changes (1-10 lines): [TOOL:PATCH]path]old|||new[/TOOL]
- Use WRITE only for new files or complete rewrites

WORKFLOW:
1. LIST or SEARCH → 2. READ relevant files → 3. ANALYZE and RESPOND`
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
        
        // Keep system prompt + last 4 messages
        const systemPrompt = messages[0];
        const recentMessages = messages.slice(-4);
        
        // Count what we're removing
        const removedCount = messages.length - 5;
        
        messages = [systemPrompt, ...recentMessages];
        fs.writeFileSync(CONTEXT_FILE, JSON.stringify(messages));
        console.log(chalk.green(`✅ Pruned ${removedCount} old messages. Kept system prompt + last 4 messages.`));
        console.log(chalk.gray(`Context size: ${messages.length} messages\n`));
        continue;
      }
      
      // Handle help command
      if (input.toLowerCase() === '/help') {
        console.log(chalk.cyan('\n📚 SAPPER COMMANDS:'));
        console.log(chalk.white('  /reset, /clear') + chalk.gray(' - Clear all context and start fresh'));
        console.log(chalk.white('  /prune') + chalk.gray('         - Remove old messages, keep last 4'));
        console.log(chalk.white('  /context') + chalk.gray('       - Show current context size'));
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
      
      messages.push({ role: 'user', content: input });

      let toolRounds = 0; // Prevent infinite loops
      const MAX_TOOL_ROUNDS = 5;
      
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
        process.stdout.write(chalk.white('Sapper: '));
        for await (const chunk of response) {
          process.stdout.write(chunk.message.content);
          msg += chunk.message.content;
        }
        console.log();
        messages.push({ role: 'assistant', content: msg });

        // Fixed regex: .+? (non-greedy) stops correctly before [/TOOL]
        const toolMatches = [...msg.matchAll(/\[TOOL:(\w+)\](.+?)(?:\]([\s\S]*?))?\[\/TOOL\]/g)];
        
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
