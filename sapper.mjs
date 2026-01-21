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
import TerminalRenderer from 'marked-terminal';

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
  // Set flag to abort current stream
  abortStream = true;
  
  // Clear current line and move to new one - stops ghost output
  process.stdout.clearLine(0);
  process.stdout.cursorTo(0);
  console.log(chalk.yellow('\n⏹️  Stopping response... (Ctrl+C again to force quit)'));
  
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

// Ensure .sapper directory exists
function ensureSapperDir() {
  if (!fs.existsSync(SAPPER_DIR)) {
    fs.mkdirSync(SAPPER_DIR, { recursive: true });
  }
}

// Load config (settings like autoAttach)
function loadConfig() {
  try {
    ensureSapperDir();
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (e) {}
  return { autoAttach: true }; // Default: auto-attach related files is ON
}

function saveConfig(config) {
  ensureSapperDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// Global config
let sapperConfig = loadConfig();

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
          if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
          scanDir(fullPath, depth + 1);
        } else {
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
// FANCY UI HELPERS
// ═══════════════════════════════════════════════════════════════

const BANNER = `
${chalk.cyan('  ███████╗ █████╗ ██████╗ ██████╗ ███████╗██████╗ ')}
${chalk.cyan('  ██╔════╝██╔══██╗██╔══██╗██╔══██╗██╔════╝██╔══██╗')}
${chalk.cyan('  ███████╗███████║██████╔╝██████╔╝█████╗  ██████╔╝')}
${chalk.cyan('  ╚════██║██╔══██║██╔═══╝ ██╔═══╝ ██╔══╝  ██╔══██╗')}
${chalk.cyan('  ███████║██║  ██║██║     ██║     ███████╗██║  ██║')}
${chalk.cyan('  ╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝     ╚══════╝╚═╝  ╚═╝')}
`;

function box(content, title = '', color = 'cyan') {
  const lines = content.split('\n');
  const maxLen = Math.max(...lines.map(l => l.length), title.length + 4);
  const colorFn = chalk[color] || chalk.cyan;
  
  let result = colorFn('╭' + (title ? `─ ${title} ` : '') + '─'.repeat(maxLen - title.length - (title ? 3 : 0)) + '╮') + '\n';
  for (const line of lines) {
    result += colorFn('│') + ' ' + line.padEnd(maxLen) + ' ' + colorFn('│') + '\n';
  }
  result += colorFn('╰' + '─'.repeat(maxLen + 2) + '╯');
  return result;
}

function divider(char = '─', color = 'gray') {
  const width = process.stdout.columns || 60;
  return chalk[color](char.repeat(Math.min(width, 60)));
}

function statusBadge(text, type = 'info') {
  const badges = {
    info: chalk.bgCyan.black(` ${text} `),
    success: chalk.bgGreen.black(` ${text} `),
    warning: chalk.bgYellow.black(` ${text} `),
    error: chalk.bgRed.white(` ${text} `),
    action: chalk.bgMagenta.white(` ${text} `)
  };
  return badges[type] || badges.info;
}

// Configure marked with terminal renderer
marked.setOptions({
  renderer: new TerminalRenderer({
    code: chalk.cyan,
    blockquote: chalk.gray.italic,
    html: chalk.gray,
    heading: chalk.bold.cyan,
    firstHeading: chalk.bold.cyan,
    hr: chalk.gray('─'.repeat(40)),
    listitem: chalk.yellow('• ') + '%s',
    table: chalk.white,
    paragraph: chalk.white,
    strong: chalk.bold.white,
    em: chalk.italic,
    codespan: chalk.cyan,
    del: chalk.strikethrough,
    link: chalk.underline.blue,
    href: chalk.gray
  })
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
let debugMode = false; // Toggle with /debug command
let abortStream = false; // Flag to interrupt AI response
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

// Scan directory for files (for @ file picker)
function getFilesForPicker(dir = '.', prefix = '', maxFiles = 50) {
  let files = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      
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
      `${chalk.cyan('↑↓')} Navigate  ${chalk.cyan('Space')} Toggle  ${chalk.cyan('a')} All  ${chalk.cyan('Enter')} Confirm  ${chalk.cyan('q/Esc')} Cancel`,
      '📎 Select Files', 'cyan'
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
    console.log(chalk.gray(`  Selected: ${selected.size} file${selected.size !== 1 ? 's' : ''}`));
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
      console.log();
      const diffContent = 
        `${chalk.white('File:')} ${chalk.cyan(trimmedPath)}\n` +
        chalk.gray('─'.repeat(40)) + '\n' +
        chalk.red('- ' + oldText.split('\n').join('\n- ')) + '\n' +
        chalk.green('+ ' + newText.split('\n').join('\n+ '));
      console.log(box(diffContent, '🔧 Patch', 'yellow'));
      
      const confirm = await safeQuestion(chalk.yellow('\n↪ Apply patch? ') + chalk.gray('(y/n): '));
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
      `${chalk.white('File:')} ${chalk.cyan(trimmedPath)}\n` +
      `${chalk.white('Size:')} ${content?.length || 0} chars\n` +
      chalk.gray('─'.repeat(40)) + '\n' +
      chalk.gray(content?.substring(0, 300)?.split('\n').slice(0, 8).join('\n') + (content?.length > 300 ? '\n...' : '')),
      '✏️  Write File', 'yellow'
    ));
    const confirm = await safeQuestion(chalk.yellow('\n↪ Allow write? ') + chalk.gray('(y/n): '));
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
      chalk.white.bold(cmd),
      '🔐 Shell Command', 'red'
    ));
    const confirm = await safeQuestion(chalk.red('\n↪ Execute? ') + chalk.gray('(y/n): '));
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
      let dir = path.trim() || '.';
      // If AI sends "/" (root), treat as current directory "."
      if (dir === '/') dir = '.';
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
  console.log(BANNER);
  console.log(chalk.gray.dim('  ') + chalk.white.bold(`v${CURRENT_VERSION}`) + chalk.gray(' │ ') + chalk.cyan('Autonomous AI Coding Agent'));
  console.log(chalk.gray.dim('  ') + chalk.gray('📁 ') + chalk.white(process.cwd()));
  console.log();
  
  // Quick tips box
  console.log(box(
    `${chalk.yellow('💡')} Use ${chalk.cyan('@file')} to attach files (e.g., "fix @app.js")\n` +
    `${chalk.yellow('💡')} Type ${chalk.cyan('/scan')} to load entire codebase\n` +
    `${chalk.yellow('💡')} Type ${chalk.cyan('/help')} for all commands`,
    'Quick Tips', 'gray'
  ));
  console.log();
  
  // Check for updates
  await checkForUpdates();
  
  // Auto-load or build workspace graph
  let workspace = loadWorkspaceGraph();
  if (!workspace.indexed) {
    console.log(chalk.cyan('📊 Building workspace index...'));
    workspace = await buildWorkspaceGraph();
    console.log(chalk.green(`✅ Indexed ${Object.keys(workspace.files).length} files\n`));
  } else {
    const fileCount = Object.keys(workspace.files).length;
    const indexAge = Math.round((Date.now() - new Date(workspace.indexed).getTime()) / 1000 / 60);
    console.log(chalk.gray(`📊 Workspace: ${fileCount} files indexed (${indexAge}m ago)`));
    if (indexAge > 60) {
      console.log(chalk.yellow(`   Tip: Run /index to refresh`));
    }
  }
  
  // Show memory status
  console.log(chalk.gray(`📁 Memory: .sapper/ folder`));
  console.log(chalk.gray(`🔗 Auto-attach: ${sapperConfig.autoAttach ? 'ON' : 'OFF'} (toggle with /auto)\n`));
  
  let messages = [];
  if (fs.existsSync(CONTEXT_FILE)) {
    console.log();
    console.log(box('Previous session found! Resume where you left off?', '📂 Session', 'green'));
    const resume = await safeQuestion(chalk.green('\n↪ Resume? ') + chalk.gray('(y/n): '));
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
  
  console.log(divider());
  console.log(statusBadge('MODELS', 'info') + chalk.gray(' Available Ollama models:\n'));
  localModels.models.forEach((m, i) => {
    const num = chalk.cyan.bold(`[${i + 1}]`);
    const name = chalk.white(m.name);
    console.log(`  ${num} ${name}`);
  });
  console.log(divider());
  const choice = await safeQuestion(chalk.cyan('\n⚡ Select model: '));
  const selectedModel = localModels.models[parseInt(choice) - 1]?.name || localModels.models[0].name;

  if (messages.length === 0) {
    messages = [{
      role: 'system',
      content: `You are Sapper, a high-level Autonomous Software Engineer.
Your goal is to solve the user's request by interacting with the filesystem and shell.

RULES:
1. EXPLORE FIRST: Use LIST and READ to understand the codebase before making changes.
2. THINK IN STEPS: Explain what you found and what you plan to do before executing tools.
3. BE PRECISE: When using PATCH, ensure the 'oldText' matches exactly.
4. VERIFY: After writing code, use the SHELL tool to run tests or linting.
5. NO HALLUCINATIONS: If a file doesn't exist, don't guess its content. List the directory instead.

TOOL SYNTAX:
- [TOOL:LIST]dir[/TOOL] - List directory contents
- [TOOL:READ]file_path[/TOOL] - Read file contents
- [TOOL:SEARCH]pattern[/TOOL] - Search codebase for pattern
- [TOOL:WRITE]path:::content[/TOOL] - Create/overwrite file
- [TOOL:PATCH]path:::old|||new[/TOOL] - Edit existing file
- [TOOL:SHELL]command[/TOOL] - Run shell command`
    }];
  }

  // Main conversation loop - never exits unless user types 'exit'
  while (true) {
    try {
      // Context size warning - large context causes hangs
      const contextSize = JSON.stringify(messages).length;
      if (contextSize > 32000) {
        console.log();
        console.log(box(
          `Context is ${chalk.red.bold(Math.round(contextSize/1024) + 'KB')} - this may cause slowdowns!\n` +
          `${chalk.yellow('Tip:')} Type ${chalk.cyan('/prune')} to reduce context size`,
          '⚠️  Warning', 'yellow'
        ));
      }
      
      const input = await safeQuestion(chalk.cyan('\n┌─[') + chalk.white.bold('You') + chalk.cyan(']\n└─➤ '));
      
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
      
      // Handle prune command - AUTO-EMBED then clear old context
      if (input.toLowerCase() === '/prune') {
        if (messages.length <= 5) {
          console.log(chalk.yellow('Context is already small, nothing to prune.'));
          continue;
        }
        
        // 1. AUTO-EMBED: Save conversation to memory BEFORE pruning (silently skip if no model)
        const embeddings = loadEmbeddings();
        
        // Get messages that will be pruned (all except system and last 4)
        const messagesToEmbed = messages.slice(1, -4)
          .filter(m => m.role !== 'system')
          .map(m => m.content.substring(0, 500))
          .join('\n---\n');
        
        if (messagesToEmbed.length > 50) {
          try {
            const embedding = await getEmbedding(messagesToEmbed);
            if (embedding) {
              embeddings.chunks.push({
                text: messagesToEmbed.substring(0, 2000),
                embedding,
                timestamp: Date.now()
              });
              if (embeddings.chunks.length > 100) {
                embeddings.chunks = embeddings.chunks.slice(-100);
              }
              saveEmbeddings(embeddings);
              console.log(chalk.green(`🧠 Saved to memory! (${embeddings.chunks.length} memories)`));
            }
          } catch (e) {
            // Silently skip embedding if model not available - prune still works
          }
        }
        
        // 2. Capture the ORIGINAL detailed system prompt from the very first message
        const originalSystemPrompt = messages[0];
        
        // 3. Capture the last 4 messages (the most recent conversation)
        const recentMessages = messages.slice(-4);
        
        // 4. Rebuild the messages array starting with the ORIGINAL prompt
        messages = [originalSystemPrompt, ...recentMessages];
        
        // 4. Add reminder to stay in Agent Mode (not chatbot mode)
        messages.push({ 
          role: 'system', 
          content: `CONTEXT PRUNED. REMINDER: You are Sapper, an Autonomous Software Engineer.

RULES:
1. EXPLORE FIRST: Use LIST and READ before making changes.
2. THINK IN STEPS: Explain your plan before executing tools.
3. BE PRECISE: When using PATCH, ensure 'oldText' matches exactly.
4. VERIFY: Run tests or linting after writing code.
5. NO HALLUCINATIONS: Don't guess file contents.

TOOL SYNTAX:
- [TOOL:LIST]dir[/TOOL]
- [TOOL:READ]file_path[/TOOL]
- [TOOL:SEARCH]pattern[/TOOL]
- [TOOL:WRITE]path:::content[/TOOL]
- [TOOL:PATCH]path:::old|||new[/TOOL]
- [TOOL:SHELL]command[/TOOL]`
        });
        
        // 5. Save to context file so it persists
        ensureSapperDir();
        fs.writeFileSync(CONTEXT_FILE, JSON.stringify(messages, null, 2));
        
        console.log(chalk.green(`✅ Pruned context. Sapper reminded to stay in Agent Mode.`));
        console.log(chalk.gray(`Context size: ${messages.length} messages\n`));
        continue;
      }
      
      // Handle help command
      if (input.toLowerCase() === '/help') {
        console.log();
        const helpContent = 
          `${chalk.cyan('@')} or ${chalk.cyan('/attach')}  ${chalk.gray('│')} Pick files to attach (interactive)\n` +
          `${chalk.cyan('@file')}          ${chalk.gray('│')} Attach file inline (e.g., @src/app.js)\n` +
          `${chalk.cyan('/scan')}          ${chalk.gray('│')} Scan codebase into context\n` +
          `${chalk.cyan('/index')}         ${chalk.gray('│')} Rebuild workspace graph\n` +
          `${chalk.cyan('/graph file')}    ${chalk.gray('│')} Show related files\n` +
          `${chalk.cyan('/auto')}          ${chalk.gray('│')} Toggle auto-attach related files\n` +
          `${chalk.cyan('/recall')}        ${chalk.gray('│')} Search memory for relevant context\n` +
          `${chalk.cyan('/reset /clear')}  ${chalk.gray('│')} Clear all context\n` +
          `${chalk.cyan('/prune')}         ${chalk.gray('│')} Save to memory + keep last 4 msgs\n` +
          `${chalk.cyan('/context')}       ${chalk.gray('│')} Show context size\n` +
          `${chalk.cyan('/debug')}         ${chalk.gray('│')} Toggle debug mode\n` +
          `${chalk.cyan('/help')}          ${chalk.gray('│')} Show this help\n` +
          `${chalk.cyan('exit')}           ${chalk.gray('│')} Quit Sapper`;
        console.log(box(helpContent, '📚 Commands', 'cyan'));
        console.log();
        continue;
      }
      
      // Handle index command - rebuild workspace graph
      if (input.toLowerCase() === '/index') {
        console.log(chalk.cyan('\n📊 Rebuilding workspace index...'));
        workspace = await buildWorkspaceGraph();
        console.log(chalk.green(`✅ Indexed ${Object.keys(workspace.files).length} files`));
        console.log(chalk.gray(`   Graph: ${Object.values(workspace.graph).flat().length} dependencies tracked\n`));
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
      
      // Handle @ alone or /attach command - interactive file picker
      if (input.trim() === '@' || input.toLowerCase() === '/attach') {
        const selectedFiles = await pickFiles();
        
        if (selectedFiles.length === 0) continue;
        
        // Read and attach selected files
        const fileAttachments = [];
        for (const filePath of selectedFiles) {
          try {
            const stats = fs.statSync(filePath);
            if (stats.size > MAX_FILE_SIZE) {
              console.log(chalk.yellow(`⚠️  ${filePath} is too large, skipping`));
              continue;
            }
            const content = fs.readFileSync(filePath, 'utf8');
            fileAttachments.push({ path: filePath, content, size: stats.size });
            console.log(chalk.green(`📎 Attached: ${filePath}`));
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
            const stats = fs.statSync(filePath);
            if (stats.isFile()) {
              if (stats.size > MAX_FILE_SIZE) {
                console.log(chalk.yellow(`⚠️  @${filePath} is too large (${Math.round(stats.size/1024)}KB), skipping`));
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
      
      messages.push({ role: 'user', content: processedInput });
      } // End of else block for non-@ input

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
        const MAX_RESPONSE_LENGTH = 100000; // 100KB - allow long code generation
        let lastChunkTime = Date.now();
        let repetitionCount = 0;
        let lastContent = '';
        abortStream = false; // Reset abort flag before streaming
        
        console.log(chalk.magenta('┌─[') + chalk.white.bold('Sapper') + chalk.magenta(']'));
        process.stdout.write(chalk.magenta('│ '));
        for await (const chunk of response) {
          // Check if user pressed Ctrl+C
          if (abortStream) {
            console.log(chalk.yellow('\n│ [Response interrupted]'));
            break;
          }
          
          const content = chunk.message.content;
          process.stdout.write(content);
          msg += content;
          
          // Smart loop detection: check for repetitive content patterns
          if (msg.length > 10000) {
            const recentContent = msg.slice(-500);
            const previousContent = msg.slice(-1000, -500);
            
            // If last 500 chars are very similar to previous 500, might be looping
            if (recentContent === previousContent) {
              repetitionCount++;
              if (repetitionCount > 3) {
                console.log(chalk.red('\n\n⚠️ REPETITIVE OUTPUT DETECTED: Stopping to prevent loop.'));
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
        console.log(chalk.magenta('└─────────────────────────────────────'));
        
        messages.push({ role: 'assistant', content: msg });

        // Regex: supports both old format (path]content) and new format (path:::content)
        const toolMatches = [...msg.matchAll(/\[TOOL:(\w+)\]([^:\]]*?)(?:(?:::|\])([\s\S]*?))?\[\/TOOL\]/g)];
        
        // Check for unclosed tool calls (AI started a tool but didn't close it)
        const hasUnclosedTool = msg.includes('[TOOL:') && !msg.includes('[/TOOL]');
        if (hasUnclosedTool) {
          console.log(chalk.yellow('\n⚠️  Unclosed tool detected! AI forgot [/TOOL] closing tag.'));
          console.log(chalk.gray('   Asking AI to complete the tool call...\n'));
          
          messages.push({ 
            role: 'user', 
            content: 'ERROR: Your tool call is incomplete - you forgot to add [/TOOL] at the end. Please complete the tool call by providing the closing [/TOOL] tag. If you were writing a file, just output [/TOOL] to close it.'
          });
          continue; // Let AI respond with the closing tag
        }
        
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
            console.log();
            console.log(statusBadge(type.toUpperCase(), 'action') + chalk.gray(' → ') + chalk.white(path));
            
            let result;
            if (type.toLowerCase() === 'list') result = tools.list(path);
            else if (type.toLowerCase() === 'read') result = tools.read(path);
            else if (type.toLowerCase() === 'mkdir') result = tools.mkdir(path);
            else if (type.toLowerCase() === 'write') {
              if (!content || content.trim() === '') {
                result = 'Error: WRITE requires content. Use [TOOL:WRITE]path]content here[/TOOL]';
              } else {
                result = await tools.write(path, content);
              }
            }
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
          ensureSapperDir();
          fs.writeFileSync(CONTEXT_FILE, JSON.stringify(messages, null, 2));
          
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
      // Loop continues automatically
    }
  }
}

// Keep-alive interval - prevents Node from exiting when event loop is empty
setInterval(() => {}, 1000);

runSapper();
