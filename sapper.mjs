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

async function safeQuestion(query) {
  return new Promise((resolve) => {
    process.stdout.write(query);
    rl.once('line', (answer) => { resolve(answer.trim()); });
  });
}

function recreateReadline() {
  rl.close();
  rl = readline.createInterface({ 
    input: process.stdin, 
    output: process.stdout,
    terminal: true,
    historySize: 100
  });
}

const tools = {
  read: (path) => {
    try { return fs.readFileSync(path.trim(), 'utf8'); } 
    catch (error) { return `Error reading file: ${error.message}`; }
  },
  write: (path, content) => {
    try {
      fs.writeFileSync(path.trim(), content);
      return `Successfully saved changes to ${path}`;
    } catch (error) { return `Error writing file: ${error.message}`; }
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
          recreateReadline();
          resolve(`Command completed with code ${code}`);
        });
      });
    }
    return "Command blocked by user.";
  },
  list: (path) => {
    try { return fs.readdirSync(path.trim() || '.').join('\n'); } 
    catch (e) { return `Error: ${e.message}`; }
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
✅ CORRECT: [TOOL:LIST]./src[/TOOL] then read all files found
❌ WRONG: [TOOL:LIST].[/] - missing TOOL at end!
❌ WRONG: [TOOL:LIST]/[/TOOL] - wrong directory!

WORKFLOW:
1. LIST directory → 2. READ files (as many as needed) → 3. ANALYZE and RESPOND`
    }];
  }

  const ask = async () => {
    try {
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
        return await ask();
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
          return await ask();
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
            else if (type.toLowerCase() === 'write') result = tools.write(path, content);
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
          }
        }
      }
    } catch (error) {
      console.error(chalk.red('\n❌ Error:'), error.message);
    }
    // ALWAYS call ask() again with await - keep the conversation going
    await ask();
  };
  await ask();
}

runSapper();
