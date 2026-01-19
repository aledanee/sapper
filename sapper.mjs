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
const packageJson = JSON.parse(fs.readFileSync(join(__dirname, 'package.json'), 'utf8'));
const CURRENT_VERSION = packageJson.version;

const spinner = ora();
const CONTEXT_FILE = '.sapper_context.json';

let stepMode = false;
let rl = readline.createInterface({ 
  input: process.stdin, 
  output: process.stdout,
  terminal: true,
  historySize: 100
});

// Helper function to safely prompt for input
async function safeQuestion(query) {
  return new Promise((resolve) => {
    process.stdout.write(query);
    rl.once('line', (answer) => {
      resolve(answer.trim());
    });
  });
}

// Helper function to check for updates
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

// Helper function to update sapper
async function updateSapper() {
  console.log(chalk.cyan('🔄 Updating Sapper...'));
  const confirm = await safeQuestion(chalk.yellow('Continue with update? (y/n): '));
  if (confirm.toLowerCase() === 'y') {
    return new Promise((resolve) => {
      const proc = spawn('npm', ['update', '-g', 'sapper-iq'], { 
        stdio: 'inherit' 
      });
      
      proc.on('close', (code) => {
        recreateReadline();
        if (code === 0) {
          console.log(chalk.green('\n✅ Sapper updated successfully!'));
          console.log(chalk.gray('Please restart Sapper to use the new version.\n'));
        } else {
          console.log(chalk.red('\n❌ Update failed. Try manually: npm update -g sapper-iq\n'));
        }
        resolve();
      });
      
      proc.on('error', (err) => {
        recreateReadline();
        console.log(chalk.red(`\n❌ Update error: ${err.message}\n`));
        resolve();
      });
    });
  }
}

// Helper function to recreate readline after shell commands
function recreateReadline() {
  rl.close();
  rl = readline.createInterface({ 
    input: process.stdin, 
    output: process.stdout,
    terminal: true,
    historySize: 100
  });
}

// --- Tool Logic ---
const tools = {
  read: (path) => fs.readFileSync(path.trim(), 'utf8'),
  write: (path, content) => {
    fs.writeFileSync(path.trim(), content);
    return `Successfully saved changes to ${path}`;
  },
  mkdir: (path) => {
    fs.mkdirSync(path.trim(), { recursive: true });
    return `Directory created: ${path}`;
  },
  shell: async (cmd) => {
    console.log(chalk.red.bold(`\n[SECURITY] Sapper wants to execute: `) + chalk.white(cmd));
    const confirm = await safeQuestion(chalk.yellow('Allow? (y/n): '));
    if (confirm.toLowerCase() === 'y') {
      return new Promise((resolve) => {
        // Use shell for complex commands with pipes, redirects, cd, &&, ||, etc
        const useShell = cmd.includes('&&') || cmd.includes('||') || cmd.includes('|') || cmd.includes('cd ') || cmd.includes('>');
        
        console.log(chalk.cyan(`\n[RUNNING] ${cmd}\n`));
        
        let proc;
        if (useShell) {
          // For complex commands, use shell
          proc = spawn('sh', ['-c', cmd], { 
            stdio: 'inherit',
            shell: true 
          });
        } else {
          // For simple commands, parse and use direct execution
          const parts = cmd.trim().split(/\s+/);
          const executable = parts[0];
          const args = parts.slice(1);
          proc = spawn(executable, args, { 
            stdio: 'inherit',
            shell: false 
          });
        }
        
        proc.on('close', (code) => {
          // Recreate readline after shell command completes
          recreateReadline();
          console.log(chalk.green(`\n[✓] Command completed with exit code ${code}\n`));
          resolve(`Command completed with exit code ${code}.`);
        });
        
        proc.on('error', (err) => {
          recreateReadline();
          console.log(chalk.red(`\n[✗] Command error: ${err.message}\n`));
          resolve(`Execution Error: ${err.message}`);
        });
      });
    }
    return "Command blocked by user.";
  },
  list: (path) => fs.readdirSync(path || '.').join('\n'),
  search: (pattern) => {
    try {
      const { execSync } = require('child_process');
      const cmd = `grep -rnEi "${pattern.trim()}" . --exclude-dir=node_modules --exclude-dir=.git`;
      return execSync(cmd, { encoding: 'utf8' }) || "No matches found.";
    } catch (e) { return "No matches found."; }
  }
};

async function selectModel() {
  const localModels = await ollama.list();
  if (localModels.models.length === 0) process.exit(1);
  console.log(chalk.magenta.bold("\nAvailable Models:"));
  localModels.models.forEach((m, i) => console.log(`${i + 1}. ${chalk.white(m.name)}`));
  const choice = await safeQuestion(chalk.yellow('\nChoose model: '));
  const index = parseInt(choice) - 1;
  return localModels.models[index]?.name || localModels.models[0].name;
}

async function runSapper() {
  console.clear();
  console.log(chalk.cyan.bold(` SAPPER v${CURRENT_VERSION} | Multi-Tool Execution Mode`));
  console.log(chalk.gray("Commands: /reset, /session-info, /step, /version, /update, /help, exit\n"));

  // Check for updates on startup
  await checkForUpdates();

  let messages = [];
  if (fs.existsSync(CONTEXT_FILE)) {
    const resume = await safeQuestion(chalk.green('Resume previous session? (y/n): '));
    if (resume.toLowerCase() === 'y') {
      messages = JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8'));
    }
  }

  const selectedModel = await selectModel();

  if (messages.length === 0) {
    messages = [{
      role: 'system',
      content: `You are Sapper, a senior software engineer AI assistant.

**CRITICAL - Tool Format Rules:**
- NEVER use JSON format
- ONLY use this EXACT format for tools: [TOOL:TYPE:path:content]
- Types: SHELL, READ, WRITE, MKDIR, LIST, SEARCH

**Examples:**
[TOOL:SHELL:npm install]
[TOOL:READ:./package.json]
[TOOL:WRITE:./app.js:console.log('hello')]
[TOOL:MKDIR:./src/components]
[TOOL:LIST:./src]
[TOOL:SEARCH:function myFunction]

**Shell Command Rules:**
- For operations in a specific directory, chain with cd: cd /path/to/project && npm install
- Use && to chain commands that depend on each other
- Use | for pipes and > for redirects
- Use relative paths after cd into a directory
- Chain multiple commands: cd /path && npm install && npm run dev
- User will specify which directory to work in - always use that path

**Critical for npm/npx commands:**
- ALWAYS use non-interactive flags (--typescript, --tailwind, --eslint, --no-git, etc)
- Create projects with non-interactive flags
- Install dependencies with: cd /path && npm install
- Run apps with: cd /path && npm run dev

**Workflow:**
1. For complex tasks, start with [PLAN:step1,step2,step3]
2. Execute tools immediately using the exact format above
3. You can provide MULTIPLE tools in one message
4. Always end with [SUMMARY:description of what was completed]

**Important:**
- No JSON responses
- No markdown code blocks for tools
- Only the exact bracket format: [TOOL:TYPE:path:content]
- User will see live command output in terminal
- Execute all tools needed to complete the task
- Work flexibly with ANY directory the user specifies
- Always chain cd with your command when working in a specific directory`
    }];
  }

  // Display working directory awareness
  console.log(chalk.yellow(`Working Directory: ${process.cwd()}\n`));

  const ask = () => {
    safeQuestion(chalk.blue.bold('\nIbrahim ➔ ')).then(async (input) => {
      if (input.toLowerCase() === 'exit') process.exit();
      if (input.toLowerCase() === '/reset' || input.toLowerCase() === '/clear-session') {
        if (fs.existsSync(CONTEXT_FILE)) {
          const fileSize = fs.statSync(CONTEXT_FILE).size;
          console.log(chalk.yellow(`\n🗑️  Clearing session (${(fileSize / 1024).toFixed(2)}KB)...`));
          fs.unlinkSync(CONTEXT_FILE);
          console.log(chalk.green('✅ Session cleared! Starting fresh...\n'));
        } else {
          console.log(chalk.yellow('\nℹ️  No session to clear.\n'));
        }
        return runSapper();
      }
      if (input.toLowerCase() === '/session-info') {
        if (fs.existsSync(CONTEXT_FILE)) {
          const data = JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8'));
          const fileSize = fs.statSync(CONTEXT_FILE).size;
          console.log(chalk.cyan(`\n📊 Session Info:`));
          console.log(chalk.gray(`  Messages: ${data.length}`));
          console.log(chalk.gray(`  File Size: ${(fileSize / 1024).toFixed(2)}KB`));
          console.log(chalk.gray(`  Last Message: ${data[data.length - 1]?.role || 'N/A'}`));
        } else {
          console.log(chalk.yellow('\nℹ️  No active session.\n'));
        }
        return ask();
      }
      if (input.toLowerCase() === '/version') {
        console.log(chalk.cyan(`\n📦 Sapper Version: v${CURRENT_VERSION}`));
        console.log(chalk.gray(`   Node.js: ${process.version}`));
        console.log(chalk.gray(`   Platform: ${process.platform}\n`));
        // Check for updates
        await checkForUpdates();
        return ask();
      }
      if (input.toLowerCase() === '/update') {
        await updateSapper();
        return ask();
      }
      if (input.toLowerCase() === '/step') {
        stepMode = !stepMode;
        console.log(chalk.yellow(`Step Mode is ${stepMode ? 'ON' : 'OFF'}`));
        return ask();
      }
      if (input.toLowerCase() === '/help') {
        console.log(chalk.cyan(`\n📚 Sapper Commands:`));
        console.log(chalk.gray(`  /reset or /clear-session  - Start a new session`));
        console.log(chalk.gray(`  /session-info            - Show current session details`));
        console.log(chalk.gray(`  /version                 - Show version and check for updates`));
        console.log(chalk.gray(`  /update                  - Update Sapper to latest version`));
        console.log(chalk.gray(`  /step                    - Toggle step-by-step mode`));
        console.log(chalk.gray(`  /help                    - Show this help menu`));
        console.log(chalk.gray(`  exit                     - Exit Sapper\n`));
        return ask();
      }

      // Check if user mentioned a directory and provide context
      const dirMatch = input.match(/\/Users\/[^\s]+|\/[a-zA-Z0-9_\/-]+/g);
      let contextMsg = input;
      
      if (dirMatch && dirMatch[0]) {
        const mentionedDir = dirMatch[0];
        try {
          if (fs.existsSync(mentionedDir) && fs.statSync(mentionedDir).isDirectory()) {
            const files = fs.readdirSync(mentionedDir).slice(0, 10).join(', ');
            contextMsg = `${input}\n\n[CONTEXT: Directory "${mentionedDir}" contains: ${files}${fs.readdirSync(mentionedDir).length > 10 ? '...' : ''}]`;
          }
        } catch (e) {
          // Silently ignore if directory doesn't exist
        }
      }

      messages.push({ role: 'user', content: contextMsg });

      let active = true;
      let iterations = 0;
      while (active && iterations < 30) {
        iterations++;

        if (stepMode) {
          const proceed = await safeQuestion(chalk.gray('\n[STEP-MODE] Press Enter to continue (or type "/stop"): '));
          if (proceed.toLowerCase() === '/stop') break;
        }

        spinner.stop();
        console.log(chalk.blue(`\n${selectedModel} is thinking...`));
        
        const response = await ollama.chat({ 
          model: selectedModel, 
          messages, 
          stream: true,
          options: { num_ctx: 16384 } 
        });
        
        let msg = '';
        process.stdout.write(chalk.white('Sapper: '));
        
        for await (const chunk of response) {
          if (chunk.message && chunk.message.content) {
            process.stdout.write(chunk.message.content);
            msg += chunk.message.content;
          }
        }
        console.log();
        
        messages.push({ role: 'assistant', content: msg });

        const summaryMatch = msg.match(/\[SUMMARY:(.*?)\]/s);
        const toolMatches = [...msg.matchAll(/\[TOOL:(\w+):([^:\]]+):?([\s\S]*?)\]/g)];

        if (summaryMatch) {
          console.log(chalk.green.bold("\n✅ MISSION COMPLETE:"));
          console.log(chalk.white(summaryMatch[1].trim()));
          active = false;
          continue;
        }

        if (toolMatches.length > 0) {
          for (const match of toolMatches) {
            const [_, name, path, content] = match;
            const toolName = name.toLowerCase();
            console.log(chalk.cyan(`\n[ACTION] Executing ${toolName} on: ${path}`));
            
            let result;
            try {
              if (toolName === 'shell') result = await tools.shell(path);
              else if (toolName === 'write') result = tools.write(path, content);
              else if (toolName === 'mkdir') result = tools.mkdir(path);
              else if (toolName === 'read') result = tools.read(path);
              else if (toolName === 'list') result = tools.list(path);
              else if (toolName === 'search') result = tools.search(path);
              else result = `Unknown tool: ${name}`;
            } catch (e) {
              result = `Error: ${e.message}`;
            }
            
            console.log(chalk.gray(`> Result: ${result.substring(0, 60)}...`));
            messages.push({ role: 'user', content: `TOOL_RESULT for ${path}: ${result}` });
          }
          fs.writeFileSync(CONTEXT_FILE, JSON.stringify(messages));
          
          // Add interrupt check after tool execution
          console.log(chalk.gray('\n[Press Enter to continue or type "/stop" to halt execution]'));
          const userChoice = await safeQuestion('');
          if (userChoice.toLowerCase() === '/stop') {
            console.log(chalk.yellow('\n⏹️  Execution halted by user'));
            active = false;
            break;
          }
        } else {
          const planMatch = msg.match(/\[PLAN:(.*?)\]/);
          if (planMatch) {
            const feedback = await safeQuestion(chalk.yellow('\nModify plan or type "go": '));
            if (feedback.toLowerCase() === '/stop') { active = false; break; }
            messages.push({ role: 'user', content: feedback.toLowerCase() === 'go' ? "Plan approved. Proceed with all steps." : feedback });
          } else {
            active = false;
          }
        }

        // Safety check: if model is repeating itself, break the loop
        if (iterations > 5) {
          const recentMessages = messages.slice(-4);
          const isRepeating = recentMessages.every(m => 
            m.role === 'assistant' && 
            recentMessages[0].content && 
            m.content === recentMessages[0].content
          );
          if (isRepeating) {
            console.log(chalk.yellow('\n⚠️  Detected repetitive behavior, stopping execution'));
            active = false;
          }
        }
      }
      ask();
    });
  };
  ask();
}

runSapper();