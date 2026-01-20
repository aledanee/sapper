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
  read: (path) => {
    try {
      return fs.readFileSync(path.trim(), 'utf8');
    } catch (error) {
      return `Error reading file: ${error.message}`;
    }
  },
  write: (path, content) => {
    try {
      fs.writeFileSync(path.trim(), content);
      return `Successfully saved changes to ${path}`;
    } catch (error) {
      return `Error writing file: ${error.message}`;
    }
  },
  mkdir: (path) => {
    try {
      fs.mkdirSync(path.trim(), { recursive: true });
      return `Directory created: ${path}`;
    } catch (error) {
      return `Error creating directory: ${error.message}`;
    }
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
  list: (path) => {
    try {
      return fs.readdirSync(path || '.').join('\n');
    } catch (error) {
      return `Error listing directory: ${error.message}`;
    }
  },
  search: (pattern) => {
    try {
      const { execSync } = require('child_process');
      const cmd = `grep -rnEi "${pattern.trim()}" . --exclude-dir=node_modules --exclude-dir=.git`;
      return execSync(cmd, { encoding: 'utf8' }) || "No matches found.";
    } catch (e) { 
      return "No matches found."; 
    }
  }
};

async function selectModel() {
  try {
    const localModels = await ollama.list();
    if (localModels.models.length === 0) {
      console.log(chalk.red('❌ No Ollama models found!'));
      console.log(chalk.yellow('Please install at least one model:'));
      console.log(chalk.gray('  ollama pull llama2'));
      console.log(chalk.gray('  ollama pull codellama'));
      process.exit(1);
    }
    console.log(chalk.magenta.bold("\nAvailable Models:"));
    localModels.models.forEach((m, i) => console.log(`${i + 1}. ${chalk.white(m.name)}`));
    const choice = await safeQuestion(chalk.yellow('\nChoose model: '));
    const index = parseInt(choice) - 1;
    return localModels.models[index]?.name || localModels.models[0].name;
  } catch (error) {
    console.log(chalk.red('❌ Failed to connect to Ollama!'));
    console.log(chalk.yellow('Please make sure Ollama is running:'));
    console.log(chalk.gray('  1. Install Ollama: https://ollama.ai'));
    console.log(chalk.gray('  2. Start Ollama: ollama serve'));
    console.log(chalk.gray('  3. Install a model: ollama pull llama2'));
    console.log(chalk.red(`\nError details: ${error.message}`));
    process.exit(1);
  }
}

async function runSapper() {
  console.clear();
  console.log(chalk.cyan.bold(` SAPPER v${CURRENT_VERSION} | Multi-Tool Execution Mode`));
  console.log(chalk.gray("Commands: /reset, /session-info, /step, /version, /update, /help, exit\n"));

  // Check for updates on startup
  await checkForUpdates();

  // Early Ollama connectivity check
  console.log(chalk.gray('🔍 Checking Ollama connection...'));
  
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
      content: `You are Sapper, a senior software engineer AI assistant. Your PRIMARY function is to EXECUTE ACTIONS, not explain them.

**CRITICAL INSTRUCTION: EXECUTE TOOLS IMMEDIATELY**
When the user asks you to do something, DO IT using tools - don't explain how to do it.
- ❌ WRONG: "To analyze the files, you would use [TOOL:LIST]..."
- ✅ CORRECT: Immediately execute [TOOL:LIST]./[/TOOL] and analyze results

**TOOL FORMAT (Version 1.0.5+):**
[TOOL:TYPE]path]content[/TOOL]

**Available Tools:**
- SHELL: Execute commands
- READ: Read file contents  
- WRITE: Create/update files
- MKDIR: Create directories
- LIST: List directory contents
- SEARCH: Search for patterns

**FORMAT EXAMPLES:**
[TOOL:SHELL]npm install[/TOOL]
[TOOL:READ]./package.json[/TOOL]
[TOOL:WRITE]./app.js]console.log('hello')[/TOOL]
[TOOL:MKDIR]./src/components[/TOOL]
[TOOL:LIST]./src[/TOOL]
[TOOL:SEARCH]function myFunction[/TOOL]

**Multi-line content:**
[TOOL:WRITE]./README.md]
# Title
- [ ] checkbox
- [x] done
Arrays: [1, 2, 3]
[/TOOL]

**CRITICAL: Notice the bracket placement!**
- Path comes AFTER the colon
- Close bracket ] after path
- Then content
- Then [/TOOL]

**Shell Commands:**
- Change directory with cd: [TOOL:SHELL]cd /path/to/project && npm install[/TOOL]
- Chain commands: cd /path && npm install && npm run dev
- Use non-interactive flags: npx create-next-app --typescript --no-git

**ACTION-FIRST WORKFLOW:**
1. User asks → You EXECUTE tools immediately
2. For complex tasks: [PLAN:description] then execute each step
3. Multiple tools allowed per response
4. End with [SUMMARY:what was completed]

**DO NOT:**
- Explain tool syntax to the user
- Show examples of what "could" be done
- Use JSON format or markdown code blocks for tools
- Wait for permission - execute the tools

**REMEMBER:** You are an executor, not an advisor. When asked to "analyze files", immediately use [TOOL:LIST] and [TOOL:READ]. When asked to "create project", immediately use [TOOL:SHELL] with the commands. Execute first, explain after if needed.

Working directory: ${process.cwd()}`
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
        
        let response;
        try {
          response = await ollama.chat({ 
            model: selectedModel, 
            messages, 
            stream: true,
            options: { num_ctx: 16384 } 
          });
        } catch (error) {
          console.log(chalk.red('\n❌ Failed to communicate with Ollama!'));
          console.log(chalk.yellow('Possible issues:'));
          console.log(chalk.gray('  - Ollama service stopped'));
          console.log(chalk.gray('  - Model was removed'));
          console.log(chalk.gray('  - Network connection issue'));
          console.log(chalk.red(`Error: ${error.message}`));
          console.log(chalk.cyan('\n💡 Try restarting Sapper or check Ollama status'));
          active = false;
          ask();
          return;
        }
        
        let msg = '';
        process.stdout.write(chalk.white('Sapper: '));
        
        try {
          for await (const chunk of response) {
            if (chunk.message && chunk.message.content) {
              process.stdout.write(chunk.message.content);
              msg += chunk.message.content;
            }
          }
        } catch (error) {
          console.log(chalk.red('\n\n❌ Connection interrupted while streaming response!'));
          console.log(chalk.yellow(`Error: ${error.message}`));
          console.log(chalk.cyan('💡 The conversation will continue, but you may want to restart Sapper'));
          msg += `\n[ERROR: Response interrupted - ${error.message}]`;
        }
        console.log();
        
        messages.push({ role: 'assistant', content: msg });

        const summaryMatch = msg.match(/\[SUMMARY:(.*?)\]/s);
        
        // Primary format: [TOOL:TYPE:path]content[/TOOL]
        const toolMatches = [...msg.matchAll(/\[TOOL:(\w+)\]([^\[]+?)\]([\s\S]*?)\[\/TOOL\]/g)];

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
          const planMatch = msg.match(/\[PLAN:([\s\S]*?)\]/) || msg.match(/\[PLAN\]([\s\S]*?)\[\/PLAN\]/);
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