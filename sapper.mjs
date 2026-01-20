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
    if (resume.toLowerCase() === 'y') messages = JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8'));
  }

  const localModels = await ollama.list();
  localModels.models.forEach((m, i) => console.log(`${i + 1}. ${m.name}`));
  const choice = await safeQuestion(chalk.yellow('\nChoose model: '));
  const selectedModel = localModels.models[parseInt(choice) - 1]?.name || localModels.models[0].name;

  if (messages.length === 0) {
    messages = [{
      role: 'system',
      content: `You are Sapper, a senior engineer working in: ${process.cwd()}

CRITICAL: You are working in the CURRENT DIRECTORY. Always use relative paths!
- Use . or ./ for current directory
- NEVER use / (that's the root directory)
- Use relative paths like ./file.js or subfolder/file.js

STRATEGY:
1. When asked to analyze, use [TOOL:LIST].[/TOOL] first (NOTE: dot, not slash!)
2. Read ONLY 2-3 KEY files in the SAME turn (README, package.json, main entry)
3. DON'T read ALL files at once - read strategically!
4. After reading files, PROVIDE ANALYSIS - don't just list more!
5. Use format: [TOOL:TYPE]path]content[/TOOL]

TOOL FORMAT (CRITICAL - FOLLOW EXACTLY):
✅ CORRECT: [TOOL:LIST].[/TOOL]
✅ CORRECT: [TOOL:READ]./file.js[/TOOL]
❌ WRONG: [TOOL:LIST].[/] - missing TOOL at end!
❌ WRONG: [TOOL:LIST]/[/TOOL] - wrong directory!

WORKFLOW:
1. LIST directory → 2. READ 2-3 key files → 3. ANALYZE and RESPOND
Don't keep executing tools endlessly - provide insights after reading!`
    }];
  }

  const ask = () => {
    safeQuestion(chalk.blue.bold('\nIbrahim ➔ ')).then(async (input) => {
      if (input.toLowerCase() === 'exit') process.exit();
      messages.push({ role: 'user', content: input });

      let active = true;
      while (active) {
        if (stepMode) await safeQuestion(chalk.gray('[STEP] Press Enter to let AI think...'));
        
        spinner.start('Thinking...');
        const response = await ollama.chat({ model: selectedModel, messages, stream: true });
        spinner.stop();

        let msg = '';
        process.stdout.write(chalk.white('Sapper: '));
        for await (const chunk of response) {
          process.stdout.write(chunk.message.content);
          msg += chunk.message.content;
        }
        console.log();
        messages.push({ role: 'assistant', content: msg });

        const toolMatches = [...msg.matchAll(/\[TOOL:(\w+)\]([^\]\n]+)(?:\]([\s\S]*?))?\[\/TOOL\]/g)];
        
        if (toolMatches.length > 0) {
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
          
          // Limit tool executions - if too many, warn and exit
          if (toolMatches.length > 10) {
            console.log(chalk.yellow('\n⚠️  Too many tool calls in one response! AI should analyze, not just read endlessly.'));
            active = false;
          }
        } else {
          // No tools found - check if malformed command
          if (msg.includes('[TOOL:') && msg.includes('[/]')) {
            console.log(chalk.red('\n❌ Malformed tool command detected! Expected format: [TOOL:TYPE]path[/TOOL]'));
            messages.push({ 
              role: 'user', 
              content: 'ERROR: Your tool command is malformed. Use [TOOL:TYPE]path]content[/TOOL] or [TOOL:TYPE]path[/TOOL]' 
            });
          } else {
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
