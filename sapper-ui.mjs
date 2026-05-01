#!/usr/bin/env node
/**
 * Sapper Desktop UI v2 — Full-featured web frontend for Sapper
 * Features: Agents/Skills CRUD, Sessions, File Browser/Editor,
 *           Thinking model display, Tool action cards, Quick Actions
 */

import http from 'http';
import fs from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join, resolve, basename } from 'path';
import ollama from 'ollama';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = 3777;
const SAPPER_DIR = '.sapper';
const AGENTS_DIR = join(SAPPER_DIR, 'agents');
const SKILLS_DIR = join(SAPPER_DIR, 'skills');
const SESSIONS_DIR = join(SAPPER_DIR, 'sessions');

let workingDir = process.cwd();

// ─── Helpers ───────────────────────────────────────────────

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function parseFrontmatter(raw) {
  const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!fmMatch) return { meta: {}, body: raw };
  const meta = {};
  for (const line of fmMatch[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    let key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      value = value.slice(1, -1);
    if (value.startsWith('[') && value.endsWith(']'))
      value = value.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    meta[key] = value;
  }
  if (!meta.name) {
    const heading = fmMatch[2].match(/^#\s+(.+)/m);
    meta.name = heading ? heading[1].trim() : 'Unnamed';
  }
  return { meta, body: fmMatch[2] };
}

function loadAgents() {
  ensureDir(AGENTS_DIR);
  const agents = {};
  try {
    for (const file of fs.readdirSync(AGENTS_DIR)) {
      if (!file.endsWith('.md')) continue;
      const name = file.replace('.md', '').toLowerCase();
      const raw = fs.readFileSync(join(AGENTS_DIR, file), 'utf8');
      const { meta, body } = parseFrontmatter(raw);
      agents[name] = {
        name: meta.name || name,
        description: meta.description || name,
        tools: meta.tools || null,
        content: body,
      };
    }
  } catch (e) {}
  return agents;
}

function loadSkills() {
  ensureDir(SKILLS_DIR);
  const skills = {};
  try {
    for (const file of fs.readdirSync(SKILLS_DIR)) {
      if (!file.endsWith('.md')) continue;
      const name = file.replace('.md', '').toLowerCase();
      const raw = fs.readFileSync(join(SKILLS_DIR, file), 'utf8');
      const { meta, body } = parseFrontmatter(raw);
      skills[name] = { name: meta.name || name, description: meta.description || name, content: body };
    }
  } catch (e) {}
  return skills;
}

const IGNORE_DIRS = new Set(['node_modules', '.git', '.sapper', '__pycache__', '.next', 'dist', 'build', '.cache']);

// ─── .sapperignore Support ─────────────────────────────────
const SAPPERIGNORE_FILE = '.sapperignore';

function loadSapperIgnorePatterns() {
  const patterns = [];
  try {
    const ignorePath = join(workingDir, SAPPERIGNORE_FILE);
    if (fs.existsSync(ignorePath)) {
      const lines = fs.readFileSync(ignorePath, 'utf8').split('\n');
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const negate = line.startsWith('!');
        const pattern = negate ? line.slice(1) : line;
        patterns.push({ pattern, negate });
      }
    }
  } catch (e) {}
  return patterns;
}

let _sapperIgnorePatterns = null;
function getSapperIgnorePatterns() {
  if (_sapperIgnorePatterns === null) _sapperIgnorePatterns = loadSapperIgnorePatterns();
  return _sapperIgnorePatterns;
}

function ignorePatternToRegex(pattern) {
  try {
    let p = pattern.replace(/\/+$/, '');
    p = p.replace(/([.+^${}()|[\]\\])/g, '\\$1');
    p = p.replace(/\*\*/g, '<<<GLOBSTAR>>>');
    p = p.replace(/\*/g, '[^/]*');
    p = p.replace(/<<<GLOBSTAR>>>/g, '.*');
    p = p.replace(/\?/g, '[^/]');
    return new RegExp(`(^|/)${p}($|/)`, 'i');
  } catch (e) {
    return /^$/; // Return a regex that never matches on error
  }
}

function shouldIgnore(nameOrPath) {
  const baseName = nameOrPath.includes('/') ? nameOrPath.split('/').pop() : nameOrPath;
  if (IGNORE_DIRS.has(baseName)) return true;
  const patterns = getSapperIgnorePatterns();
  if (patterns.length === 0) return false;
  let ignored = false;
  for (const { pattern, negate } of patterns) {
    const regex = ignorePatternToRegex(pattern);
    if (regex.test(nameOrPath) || regex.test(baseName)) ignored = !negate;
  }
  return ignored;
}

function safePath(p) {
  const resolved = resolve(workingDir, p || '.');
  if (!resolved.startsWith(workingDir)) return null;
  return resolved;
}

function buildSystemPrompt(agentContent = null, agentTools = null, skillContents = []) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  let prompt = `You are Sapper, an intelligent AI assistant with access to the local filesystem and shell.
You can help with ANY task - coding, writing, research, planning, analysis, and more.

CURRENT DATE AND TIME: ${dateStr}, ${timeStr}
WORKING DIRECTORY: ${workingDir}

RULES:
1. EXPLORE FIRST: Use LIST and READ to understand files before making changes.
2. THINK IN STEPS: Explain what you found and what you plan to do before acting.
3. BE PRECISE: When using PATCH, prefer LINE:number mode.
4. VERIFY: After making changes, verify they work.
5. NO HALLUCINATIONS: If a file doesn't exist, don't guess its content.

TOOL SYNTAX:
- [TOOL:LIST]dir[/TOOL] - List directory contents
- [TOOL:READ]file_path[/TOOL] - Read file contents
- [TOOL:SEARCH]pattern[/TOOL] - Search files for pattern
- [TOOL:WRITE]path:::content[/TOOL] - Create/overwrite file
- [TOOL:PATCH]path:::old|||new[/TOOL] - Edit file (exact/fuzzy match)
- [TOOL:PATCH]path:::LINE:number|||new text[/TOOL] - Replace line by number (PREFERRED)
- [TOOL:SHELL]command[/TOOL] - Run shell command
- [TOOL:MKDIR]path[/TOOL] - Create directory

PATCH TIPS:
- PREFER LINE:number mode. Always READ first.
- If PATCH fails, switch to LINE:number or WRITE.

You MUST use [TOOL:...][/TOOL] syntax to perform actions.
Do NOT show tool syntax as examples to the user — only use them to perform real actions.`;

  if (agentContent) {
    prompt += `\n\n═══ ACTIVE AGENT ═══\n${agentContent}\n═══ END AGENT ═══`;
    if (agentTools && agentTools.length > 0) {
      const allTools = ['READ', 'WRITE', 'PATCH', 'LIST', 'SEARCH', 'SHELL', 'MKDIR'];
      const forbidden = allTools.filter(t => !agentTools.includes(t));
      prompt += `\nTOOL RESTRICTION: ONLY use: ${agentTools.join(', ')}. FORBIDDEN: ${forbidden.join(', ')}.`;
    }
  }
  if (skillContents.length > 0) {
    prompt += `\n\n═══ SKILLS ═══\n${skillContents.join('\n---\n')}\n═══ END SKILLS ═══`;
  }
  return prompt;
}

// ─── Tool Execution ────────────────────────────────────────

const tools = {
  list: (path) => {
    try {
      let dir = resolve(workingDir, path.trim() || '.');
      if (dir === '/') dir = workingDir;
      const entries = fs.readdirSync(dir);
      return entries.filter(e => !shouldIgnore(e) && !e.startsWith('.')).join('\n') || '(empty)';
    } catch (e) { return `Error: ${e.message}`; }
  },
  read: (path) => {
    try { return fs.readFileSync(resolve(workingDir, path.trim()), 'utf8'); }
    catch (e) { return `Error: ${e.message}`; }
  },
  write: (path, content) => {
    try {
      const p = resolve(workingDir, path.trim());
      fs.mkdirSync(dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
      return `Successfully saved ${path.trim()}`;
    } catch (e) { return `Error: ${e.message}`; }
  },
  mkdir: (path) => {
    try { fs.mkdirSync(resolve(workingDir, path.trim()), { recursive: true }); return `Created ${path}`; }
    catch (e) { return `Error: ${e.message}`; }
  },
  patch: (path, oldText, newText) => {
    const p = resolve(workingDir, path.trim());
    try {
      const content = fs.readFileSync(p, 'utf8');
      const lineMatch = oldText.match(/^LINE:(\d+)$/);
      if (lineMatch) {
        const n = parseInt(lineMatch[1], 10);
        const lines = content.split('\n');
        if (n < 1 || n > lines.length) return `Error: Line ${n} out of range (${lines.length} lines)`;
        const old = lines[n - 1];
        lines[n - 1] = newText;
        fs.writeFileSync(p, lines.join('\n'));
        return `Patched line ${n}: "${old}" → "${newText}"`;
      }
      if (content.includes(oldText)) {
        fs.writeFileSync(p, content.replace(oldText, newText));
        return `Successfully patched ${path.trim()}`;
      }
      if (content.includes(oldText.trim())) {
        fs.writeFileSync(p, content.replace(oldText.trim(), newText.trim()));
        return `Successfully patched ${path.trim()} (trimmed match)`;
      }
      const normalize = s => s.replace(/[\u{1F000}-\u{1FFFF}]/gu, '').replace(/\s+/g, ' ').trim();
      const normOld = normalize(oldText);
      const lines = content.split('\n');
      const oldLines = oldText.trim().split('\n');
      for (let i = 0; i <= lines.length - oldLines.length; i++) {
        const win = lines.slice(i, i + oldLines.length).join('\n');
        if (normalize(win) === normOld) {
          const newContent = content.replace(win, newText.trim());
          fs.writeFileSync(p, newContent);
          return `Successfully patched ${path.trim()} (fuzzy match at line ${i + 1})`;
        }
      }
      return `Error: Text not found in ${path.trim()}. Use LINE:number mode instead.`;
    } catch (e) { return `Error: ${e.message}`; }
  },
  search: (pattern) => {
    return new Promise((res) => {
      const allIgnoreDirs = new Set(IGNORE_DIRS);
      for (const { pattern: p, negate } of getSapperIgnorePatterns()) {
        if (!negate && p.endsWith('/')) allIgnoreDirs.add(p.replace(/\/+$/, ''));
      }
      // Use args array to avoid command injection
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
      const proc = spawn('grep', args, { cwd: workingDir });
      let out = '';
      let lineCount = 0;
      proc.stdout.on('data', d => {
        const text = d.toString();
        const lines = text.split('\n');
        for (const line of lines) {
          if (lineCount >= 50) { proc.kill(); return; }
          if (line) { out += line + '\n'; lineCount++; }
        }
      });
      proc.stderr.on('data', () => {});
      proc.on('error', (err) => res(`Error searching: ${err.message}`));
      proc.on('close', () => res(out.trim() || `No matches for: ${pattern}`));
    });
  },
  shell: (cmd) => {
    return new Promise((res) => {
      const proc = spawn('sh', ['-c', cmd], { cwd: workingDir });
      let out = '';
      proc.stdout.on('data', d => out += d);
      proc.stderr.on('data', d => out += d);
      proc.on('error', (err) => {
        res(`Shell error: ${err.message}`);
      });
      proc.on('close', code => {
        let result = out.trim();
        if (result.length > 10000) result = result.substring(0, 10000) + '\n...(truncated)';
        res(result || `Completed (exit ${code})`);
      });
    });
  },
};

async function executeTool(type, path, content, agentTools) {
  if (agentTools && !agentTools.includes(type.toUpperCase())) {
    return { result: `Error: Tool ${type.toUpperCase()} not allowed. Allowed: ${agentTools.join(', ')}`, blocked: true };
  }
  const t = type.toLowerCase();
  let result;
  if (t === 'list') result = tools.list(path);
  else if (t === 'read') result = tools.read(path);
  else if (t === 'mkdir') result = tools.mkdir(path);
  else if (t === 'write') result = tools.write(path, content || '');
  else if (t === 'patch') {
    // Use indexOf to split into exactly 2 parts, preserving ||| in content
    const sepIdx = content?.indexOf('|||');
    let parts = null;
    if (sepIdx > -1) {
      parts = [content.substring(0, sepIdx), content.substring(sepIdx + 3)];
    }
    if (parts && parts.length === 2) result = tools.patch(path, parts[0], parts[1]);
    else result = 'Error: PATCH needs OLD_TEXT|||NEW_TEXT';
  }
  else if (t === 'search') result = await tools.search(path);
  else if (t === 'shell') result = await tools.shell(path);
  else result = `Unknown tool: ${type}`;
  return { result, blocked: false };
}

// ─── Chat Engine ───────────────────────────────────────────

let abortFlag = false;

async function* chatStream(messages, model, agentTools) {
  const MAX_TOOL_ROUNDS = 15;
  let rounds = 0;
  const patchFails = {};

  while (true) {
    if (abortFlag) { abortFlag = false; yield { type: 'system', data: 'Generation stopped' }; break; }

    let fullMsg = '';
    const response = await ollama.chat({ model, messages, stream: true });
    for await (const chunk of response) {
      if (abortFlag) { abortFlag = false; yield { type: 'system', data: 'Generation stopped' }; messages.push({ role: 'assistant', content: fullMsg }); return; }
      const token = chunk.message?.content || '';
      fullMsg += token;
      yield { type: 'token', data: token };
    }
    messages.push({ role: 'assistant', content: fullMsg });

    const clean = fullMsg.replace(/```[\s\S]*?```/g, '');
    const toolMatches = [...clean.matchAll(/\[TOOL:(\w+)\]([^:\]]*?)(?:(?:::|\])([\s\S]*?))?\[\/TOOL\]/g)];

    if (toolMatches.length === 0) break;

    rounds++;
    if (rounds >= MAX_TOOL_ROUNDS) {
      messages.push({ role: 'user', content: 'STOP using tools. Provide your answer now with what you have.' });
      yield { type: 'system', data: `Tool limit reached (${MAX_TOOL_ROUNDS} rounds)` };
      continue;
    }

    for (const match of toolMatches) {
      if (abortFlag) break;
      const [, type, path, content] = match;
      yield { type: 'tool_start', data: { tool: type.toUpperCase(), path } };

      if (type.toLowerCase() === 'patch') {
        const key = path.trim();
        if ((patchFails[key] || 0) >= 3) {
          const err = `Error: PATCH failed 3 times on ${key}. Use READ + LINE:number mode or WRITE instead.`;
          messages.push({ role: 'user', content: `RESULT (${path}): ${err}` });
          yield { type: 'tool_result', data: { tool: 'PATCH', path, result: err, blocked: true } };
          continue;
        }
      }

      const { result, blocked } = await executeTool(type, path, content, agentTools);

      if (type.toLowerCase() === 'patch' && result.startsWith('Error:')) {
        const key = path.trim();
        patchFails[key] = (patchFails[key] || 0) + 1;
      }

      messages.push({ role: 'user', content: `RESULT (${path}): ${result}` });
      yield { type: 'tool_result', data: { tool: type.toUpperCase(), path, result: result.substring(0, 3000), blocked } };
    }
  }
}

// ─── Session Management ────────────────────────────────────

function listSessions() {
  ensureDir(SESSIONS_DIR);
  try {
    return fs.readdirSync(SESSIONS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const data = JSON.parse(fs.readFileSync(join(SESSIONS_DIR, f), 'utf8'));
          return { id: f.replace('.json', ''), name: data.name || 'Unnamed', created: data.created, msgCount: (data.messages || []).filter(m => m.role === 'user').length };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.created) - new Date(a.created));
  } catch { return []; }
}

function saveSession(id, name, messages, model, agentKey) {
  ensureDir(SESSIONS_DIR);
  const data = { name, created: new Date().toISOString(), model, agent: agentKey, messages };
  fs.writeFileSync(join(SESSIONS_DIR, `${id}.json`), JSON.stringify(data));
}

function loadSessionData(id) {
  try { return JSON.parse(fs.readFileSync(join(SESSIONS_DIR, `${id}.json`), 'utf8')); }
  catch { return null; }
}

function deleteSessionFile(id) {
  try { fs.unlinkSync(join(SESSIONS_DIR, `${id}.json`)); return true; }
  catch { return false; }
}

function renameSession(id, newName) {
  try {
    const data = JSON.parse(fs.readFileSync(join(SESSIONS_DIR, `${id}.json`), 'utf8'));
    data.name = newName;
    fs.writeFileSync(join(SESSIONS_DIR, `${id}.json`), JSON.stringify(data));
    return true;
  } catch { return false; }
}

// ─── Agent/Skill CRUD ─────────────────────────────────────

function createAgentFile(name, description, agentTools, content) {
  ensureDir(AGENTS_DIR);
  const filename = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.md';
  let fm = '---\n';
  fm += `name: "${name}"\n`;
  fm += `description: "${description}"\n`;
  if (agentTools && agentTools.length > 0) {
    fm += `tools: [${agentTools.map(t => '"' + t + '"').join(', ')}]\n`;
  }
  fm += '---\n\n';
  fs.writeFileSync(join(AGENTS_DIR, filename), fm + content);
  return filename;
}

function deleteAgentFile(key) {
  try { fs.unlinkSync(join(AGENTS_DIR, key + '.md')); return true; }
  catch { return false; }
}

function createSkillFile(name, description, content) {
  ensureDir(SKILLS_DIR);
  const filename = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.md';
  let fm = '---\n';
  fm += `name: "${name}"\n`;
  fm += `description: "${description}"\n`;
  fm += '---\n\n';
  fs.writeFileSync(join(SKILLS_DIR, filename), fm + content);
  return filename;
}

function deleteSkillFile(key) {
  try { fs.unlinkSync(join(SKILLS_DIR, key + '.md')); return true; }
  catch { return false; }
}

// ─── Directory Tree ────────────────────────────────────────

function getTreeEntries(dirPath) {
  const safe = safePath(dirPath);
  if (!safe) return [];
  try {
    const entries = fs.readdirSync(safe);
    return entries
      .filter(e => !shouldIgnore(e) && !e.startsWith('.'))
      .map(e => {
        try {
          const stat = fs.statSync(join(safe, e));
          return { name: e, isDir: stat.isDirectory(), size: stat.size, modified: stat.mtime.toISOString() };
        } catch { return { name: e, isDir: false, size: 0 }; }
      })
      .sort((a, b) => {
        if (a.isDir && !b.isDir) return -1;
        if (!a.isDir && b.isDir) return 1;
        return a.name.localeCompare(b.name);
      });
  } catch { return []; }
}

// ─── Server State ──────────────────────────────────────────

let serverMessages = [];
let serverModel = '';
let serverAgent = null;
let serverAgentKey = null;
let serverAgentTools = null;
let currentSessionId = null;

function resetChat() {
  const skills = loadSkills();
  const skillContents = Object.values(skills).map(s => s.content);
  serverMessages = [{
    role: 'system',
    content: buildSystemPrompt(serverAgent?.content || null, serverAgentTools, skillContents)
  }];
}

function getVersion() {
  try { return JSON.parse(fs.readFileSync(join(__dirname, 'package.json'), 'utf8')).version; }
  catch { return '0.0.0'; }
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  const MAX_BODY_SIZE = 5 * 1024 * 1024; // 5MB limit
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        resolve({ _error: 'Request body too large' });
        return;
      }
      body += c;
    });
    req.on('error', () => resolve({}));
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
  });
}

// ─── HTML Builder ──────────────────────────────────────────

function buildHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sapper</title>
<style>
:root {
  --bg0: #0a0e14; --bg1: #0d1117; --bg2: #161b22; --bg3: #21262d; --bg4: #30363d; --bg5: #3d444d;
  --fg0: #f0f6fc; --fg1: #e6edf3; --fg2: #8b949e; --fg3: #484f58;
  --accent: #58a6ff; --accent2: #1f6feb; --green: #3fb950; --red: #f85149;
  --orange: #d29922; --purple: #bc8cff; --cyan: #39d2c0; --pink: #f778ba;
  --radius: 10px; --radius-sm: 6px;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif; background: var(--bg1); color: var(--fg1); height: 100vh; display: flex; overflow: hidden; }

/* ── Sidebar ── */
.sidebar { width: 270px; background: var(--bg2); border-right: 1px solid var(--bg4); display: flex; flex-direction: column; flex-shrink: 0; }
.sidebar-header { padding: 16px 18px; border-bottom: 1px solid var(--bg4); display: flex; align-items: center; gap: 10px; }
.sidebar-header h1 { font-size: 18px; font-weight: 700; }
.sidebar-header h1 span { color: var(--accent); }
.sidebar-tabs { display: flex; border-bottom: 1px solid var(--bg4); }
.sidebar-tabs button { flex: 1; padding: 10px 4px; background: none; border: none; border-bottom: 2px solid transparent; color: var(--fg3); font-size: 11px; font-weight: 600; cursor: pointer; text-transform: uppercase; letter-spacing: .5px; transition: all .15s; }
.sidebar-tabs button:hover { color: var(--fg2); }
.sidebar-tabs button.active { color: var(--accent); border-bottom-color: var(--accent); }
.tab-panel { display: none; flex: 1; overflow-y: auto; padding: 8px; }
.tab-panel.active { display: flex; flex-direction: column; }
.tab-panel::-webkit-scrollbar { width: 5px; }
.tab-panel::-webkit-scrollbar-thumb { background: var(--bg4); border-radius: 3px; }
.tab-create-btn { display: flex; align-items: center; gap: 6px; padding: 8px 12px; margin: 4px; background: var(--bg3); border: 1px dashed var(--bg5); border-radius: var(--radius-sm); color: var(--fg2); font-size: 12px; cursor: pointer; transition: all .15s; }
.tab-create-btn:hover { border-color: var(--accent); color: var(--accent); background: rgba(88,166,255,.08); }
.s-item { padding: 10px 12px; margin: 2px 4px; cursor: pointer; display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--fg2); transition: all .12s; border-radius: var(--radius-sm); border: 1px solid transparent; }
.s-item:hover { background: var(--bg3); color: var(--fg1); }
.s-item.active { background: rgba(88,166,255,.1); color: var(--accent); border-color: rgba(88,166,255,.2); }
.s-item .s-icon { width: 18px; text-align: center; flex-shrink: 0; font-size: 14px; }
.s-item .s-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.s-item .s-meta { font-size: 10px; color: var(--fg3); }
.s-item .s-del { display: none; background: none; border: none; color: var(--fg3); cursor: pointer; font-size: 14px; padding: 2px 4px; border-radius: 4px; }
.s-item:hover .s-del { display: block; }
.s-item .s-del:hover { color: var(--red); background: rgba(248,81,73,.15); }

/* ── Quick Actions ── */
.qa-section { padding: 4px 8px; margin-top: auto; border-top: 1px solid var(--bg4); }
.qa-title { font-size: 10px; font-weight: 600; color: var(--fg3); text-transform: uppercase; letter-spacing: .8px; padding: 8px 8px 4px; }
.qa-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; padding: 4px; }
.qa-btn { padding: 7px 6px; background: var(--bg3); border: 1px solid transparent; border-radius: var(--radius-sm); color: var(--fg2); font-size: 11px; cursor: pointer; transition: all .12s; display: flex; align-items: center; gap: 4px; white-space: nowrap; overflow: hidden; }
.qa-btn:hover { border-color: var(--accent); color: var(--accent); background: rgba(88,166,255,.06); }
.qa-btn .qa-icon { font-size: 12px; flex-shrink: 0; }

/* ── Sidebar Footer ── */
.sidebar-footer { padding: 12px; border-top: 1px solid var(--bg4); }
.sidebar-footer select { width: 100%; background: var(--bg3); color: var(--fg1); border: 1px solid var(--bg4); border-radius: var(--radius-sm); padding: 6px 8px; font-size: 12px; cursor: pointer; outline: none; }
.sidebar-footer select:focus { border-color: var(--accent); }
.sidebar-footer .sf-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; font-size: 11px; color: var(--fg3); }
.sidebar-footer .sf-model { background: var(--bg3); padding: 3px 8px; border-radius: 12px; font-size: 10px; color: var(--accent); }

/* ── Main ── */
.main { flex: 1; display: flex; flex-direction: column; min-width: 0; }

/* ── Topbar ── */
.topbar { height: 48px; background: var(--bg2); border-bottom: 1px solid var(--bg4); display: flex; align-items: center; padding: 0 16px; gap: 10px; flex-shrink: 0; }
.topbar .status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); flex-shrink: 0; }
.topbar .agent-badge { background: linear-gradient(135deg, var(--accent2), var(--purple)); color: #fff; padding: 3px 10px; border-radius: 14px; font-size: 11px; font-weight: 600; }
.topbar .session-name { color: var(--fg2); font-size: 12px; cursor: pointer; padding: 2px 6px; border-radius: 4px; }
.topbar .session-name:hover { background: var(--bg3); }
.topbar .spacer { flex: 1; }
.topbar .tb-btn { background: var(--bg3); border: 1px solid var(--bg4); border-radius: var(--radius-sm); color: var(--fg2); padding: 5px 10px; font-size: 11px; cursor: pointer; display: flex; align-items: center; gap: 5px; transition: all .12s; }
.topbar .tb-btn:hover { border-color: var(--accent); color: var(--accent); }
.topbar .cwd { color: var(--fg3); font-size: 11px; font-family: 'SF Mono', 'Fira Code', monospace; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ── Chat ── */
.chat { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 6px; scroll-behavior: smooth; }
.chat::-webkit-scrollbar { width: 6px; }
.chat::-webkit-scrollbar-thumb { background: var(--bg4); border-radius: 3px; }
.msg { max-width: 82%; padding: 12px 16px; border-radius: var(--radius); font-size: 14px; line-height: 1.6; word-break: break-word; animation: fadeIn .2s; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
.msg.user { background: var(--accent2); color: #fff; align-self: flex-end; border-bottom-right-radius: 3px; }
.msg.ai { background: var(--bg2); border: 1px solid var(--bg4); align-self: flex-start; border-bottom-left-radius: 3px; }
.msg.ai pre { background: var(--bg0); border: 1px solid var(--bg4); border-radius: var(--radius-sm); padding: 10px 12px; overflow-x: auto; margin: 8px 0; font-size: 13px; }
.msg.ai code { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 13px; }
.msg.ai :not(pre) > code { background: var(--bg3); padding: 1px 5px; border-radius: 3px; font-size: 12px; }
.msg.ai h1, .msg.ai h2, .msg.ai h3, .msg.ai h4 { margin: 10px 0 4px; color: var(--accent); }
.msg.ai ul, .msg.ai ol { padding-left: 20px; margin: 4px 0; }
.msg.ai li { margin: 2px 0; }
.msg.ai blockquote { border-left: 3px solid var(--accent); padding-left: 12px; color: var(--fg2); margin: 6px 0; }
.msg.ai a { color: var(--accent); }
.msg.ai p { margin: 4px 0; }
.msg.ai hr { border: none; border-top: 1px solid var(--bg4); margin: 8px 0; }
.msg.ai table { border-collapse: collapse; margin: 8px 0; width: 100%; }
.msg.ai th, .msg.ai td { border: 1px solid var(--bg4); padding: 5px 8px; text-align: left; font-size: 13px; }
.msg.ai th { background: var(--bg3); }
.msg.system { background: transparent; color: var(--fg3); font-size: 12px; align-self: center; padding: 3px 10px; }

/* ── Thinking Block ── */
.think-block { background: rgba(188,140,255,.07); border: 1px solid rgba(188,140,255,.18); border-radius: 8px; margin: 8px 0; overflow: hidden; }
.think-header { padding: 7px 12px; cursor: pointer; display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--purple); user-select: none; }
.think-header:hover { background: rgba(188,140,255,.05); }
.think-chevron { font-size: 10px; transition: transform .15s; }
.think-block.open .think-chevron { transform: rotate(90deg); }
.think-content { padding: 8px 12px; font-size: 13px; color: var(--fg2); line-height: 1.5; border-top: 1px solid rgba(188,140,255,.12); max-height: 250px; overflow-y: auto; display: none; }
.think-block.open .think-content { display: block; }
.think-block.streaming .think-header .think-label { animation: pulse 1.5s infinite; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .5; } }

/* ── AI Exchange Container ── */
.ai-exchange { display: flex; flex-direction: column; gap: 4px; width: 100%; }

/* ── Tool Card ── */
.tool-card { background: var(--bg3); border: 1px solid var(--bg4); border-radius: 8px; margin: 4px 0; overflow: hidden; font-size: 13px; align-self: flex-start; max-width: 82%; }
.tool-card.done .tc-spinner { display: none; }
.tool-card-header { padding: 8px 12px; display: flex; align-items: center; gap: 8px; cursor: pointer; transition: background .12s; }
.tool-card-header:hover { background: var(--bg4); }
.tc-icon { font-size: 13px; flex-shrink: 0; }
.tc-name { color: var(--orange); font-weight: 600; font-family: 'SF Mono', monospace; font-size: 12px; }
.tc-path { color: var(--fg2); font-family: 'SF Mono', monospace; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.tc-status { margin-left: auto; font-size: 12px; flex-shrink: 0; }
.tc-chevron { font-size: 10px; color: var(--fg3); transition: transform .15s; flex-shrink: 0; }
.tool-card.expanded .tc-chevron { transform: rotate(90deg); }
.tool-card-body { display: none; padding: 8px 12px; border-top: 1px solid var(--bg4); }
.tool-card.expanded .tool-card-body { display: block; }
.tool-card-body pre { background: var(--bg1); padding: 8px; border-radius: 4px; white-space: pre-wrap; word-break: break-all; font-size: 11px; max-height: 200px; overflow-y: auto; margin: 0; color: var(--fg2); }
.tool-card.error { border-color: rgba(248,81,73,.3); }
.tool-card.error .tc-name { color: var(--red); }

/* ── Thinking Dots ── */
.thinking-dots { align-self: flex-start; display: flex; gap: 4px; padding: 14px 16px; }
.thinking-dots span { width: 7px; height: 7px; background: var(--fg3); border-radius: 50%; animation: bounce .6s ease-in-out infinite; }
.thinking-dots span:nth-child(2) { animation-delay: .1s; }
.thinking-dots span:nth-child(3) { animation-delay: .2s; }
@keyframes bounce { 0%,80%,100% { transform: scale(.7); opacity: .4; } 40% { transform: scale(1); opacity: 1; } }

/* ── Input ── */
.input-area { background: var(--bg2); border-top: 1px solid var(--bg4); padding: 12px 16px; flex-shrink: 0; }
.input-row { display: flex; gap: 8px; align-items: flex-end; }
.input-row textarea { flex: 1; background: var(--bg1); border: 1px solid var(--bg4); border-radius: var(--radius); padding: 10px 14px; color: var(--fg1); font-size: 14px; font-family: inherit; resize: none; outline: none; min-height: 44px; max-height: 150px; line-height: 1.5; transition: border-color .15s; }
.input-row textarea:focus { border-color: var(--accent); }
.input-row textarea::placeholder { color: var(--fg3); }
.in-btn { width: 42px; height: 42px; border-radius: var(--radius); border: none; color: #fff; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all .12s; flex-shrink: 0; }
.in-btn.send { background: var(--accent2); }
.in-btn.send:hover { background: var(--accent); }
.in-btn.send:disabled { opacity: .3; cursor: default; }
.in-btn.stop { background: var(--red); display: none; }
.in-btn.stop:hover { background: #da3633; }
.in-btn.stop.visible { display: flex; }
.input-hint { display: flex; gap: 14px; margin-top: 6px; font-size: 10px; color: var(--fg3); }
.input-hint kbd { background: var(--bg3); padding: 1px 4px; border-radius: 3px; font-family: monospace; font-size: 9px; }

/* ── Welcome ── */
.welcome { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--fg3); gap: 10px; padding: 40px; text-align: center; }
.welcome .logo { font-size: 44px; margin-bottom: 6px; }
.welcome h2 { color: var(--fg1); font-size: 20px; }
.welcome p { max-width: 380px; line-height: 1.5; font-size: 14px; }
.welcome .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; justify-content: center; }
.welcome .chip { background: var(--bg3); border: 1px solid var(--bg4); border-radius: 18px; padding: 7px 14px; font-size: 12px; color: var(--fg2); cursor: pointer; transition: all .12s; }
.welcome .chip:hover { border-color: var(--accent); color: var(--accent); }

/* ── Right Panel ── */
.right-panel { width: 0; background: var(--bg2); border-left: 1px solid var(--bg4); display: flex; flex-direction: column; flex-shrink: 0; transition: width .2s; overflow: hidden; }
.right-panel.open { width: 380px; }
.rp-header { padding: 12px 16px; border-bottom: 1px solid var(--bg4); display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.rp-header h3 { font-size: 13px; flex: 1; }
.rp-close { background: none; border: none; color: var(--fg2); cursor: pointer; font-size: 16px; padding: 2px 6px; border-radius: 4px; }
.rp-close:hover { background: var(--bg3); color: var(--fg1); }
.rp-tabs { display: flex; border-bottom: 1px solid var(--bg4); flex-shrink: 0; }
.rp-tabs button { flex: 1; padding: 8px; background: none; border: none; border-bottom: 2px solid transparent; color: var(--fg3); font-size: 11px; cursor: pointer; }
.rp-tabs button.active { color: var(--accent); border-bottom-color: var(--accent); }
.file-tree { flex: 1; overflow-y: auto; padding: 6px; font-size: 13px; }
.file-tree::-webkit-scrollbar { width: 5px; }
.file-tree::-webkit-scrollbar-thumb { background: var(--bg4); border-radius: 3px; }
.ft-item { padding: 5px 8px; cursor: pointer; border-radius: 4px; color: var(--fg2); display: flex; align-items: center; gap: 6px; font-family: 'SF Mono', monospace; font-size: 12px; }
.ft-item:hover { background: var(--bg3); color: var(--fg1); }
.ft-item.dir { color: var(--accent); }
.ft-item.active { background: rgba(88,166,255,.1); color: var(--accent); }
.ft-indent { padding-left: 16px; }
.ft-icon { flex-shrink: 0; font-size: 13px; }
.ft-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ── File Editor ── */
.file-editor { display: none; flex-direction: column; border-top: 1px solid var(--bg4); }
.file-editor.open { display: flex; flex: 1; min-height: 200px; }
.fe-header { padding: 8px 12px; display: flex; align-items: center; gap: 6px; border-bottom: 1px solid var(--bg4); background: var(--bg3); flex-shrink: 0; }
.fe-path { font-family: 'SF Mono', monospace; font-size: 11px; color: var(--fg2); flex: 1; overflow: hidden; text-overflow: ellipsis; }
.fe-btn { padding: 4px 10px; border: 1px solid var(--bg4); border-radius: 4px; background: var(--bg3); color: var(--fg2); font-size: 11px; cursor: pointer; }
.fe-btn:hover { border-color: var(--accent); color: var(--accent); }
.fe-btn.save { background: var(--accent2); border-color: var(--accent2); color: #fff; }
.fe-btn.save:hover { background: var(--accent); }
.fe-content { flex: 1; overflow: auto; }
.fe-content pre { padding: 10px 12px; margin: 0; font-family: 'SF Mono', monospace; font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; color: var(--fg1); min-height: 100%; }
.fe-content textarea { width: 100%; height: 100%; padding: 10px 12px; background: var(--bg1); border: none; color: var(--fg1); font-family: 'SF Mono', monospace; font-size: 12px; line-height: 1.5; resize: none; outline: none; }

/* ── Modal ── */
.modal-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.6); z-index: 200; align-items: center; justify-content: center; }
.modal-overlay.visible { display: flex; }
.modal { background: var(--bg2); border: 1px solid var(--bg4); border-radius: 12px; width: 480px; max-width: 90vw; max-height: 85vh; display: flex; flex-direction: column; box-shadow: 0 8px 32px rgba(0,0,0,.5); }
.modal-header { padding: 16px 20px; border-bottom: 1px solid var(--bg4); display: flex; align-items: center; }
.modal-header h3 { flex: 1; font-size: 15px; }
.modal-close { background: none; border: none; color: var(--fg2); cursor: pointer; font-size: 18px; padding: 2px 6px; border-radius: 4px; }
.modal-close:hover { background: var(--bg3); }
.modal-body { padding: 16px 20px; overflow-y: auto; flex: 1; }
.modal-footer { padding: 12px 20px; border-top: 1px solid var(--bg4); display: flex; justify-content: flex-end; gap: 8px; }
.m-field { margin-bottom: 14px; }
.m-field label { display: block; font-size: 12px; color: var(--fg2); margin-bottom: 5px; font-weight: 500; }
.m-field input, .m-field textarea { width: 100%; background: var(--bg1); border: 1px solid var(--bg4); border-radius: var(--radius-sm); padding: 8px 10px; color: var(--fg1); font-size: 13px; outline: none; font-family: inherit; }
.m-field input:focus, .m-field textarea:focus { border-color: var(--accent); }
.m-field textarea { min-height: 120px; resize: vertical; font-family: 'SF Mono', monospace; font-size: 12px; }
.m-field .checkbox-group { display: flex; flex-wrap: wrap; gap: 8px; }
.m-field .checkbox-group label { display: flex; align-items: center; gap: 4px; background: var(--bg3); padding: 4px 10px; border-radius: 14px; font-size: 12px; cursor: pointer; color: var(--fg2); border: 1px solid var(--bg4); }
.m-field .checkbox-group label:has(input:checked) { background: rgba(88,166,255,.12); border-color: var(--accent); color: var(--accent); }
.m-field .checkbox-group input { display: none; }
.m-btn { padding: 8px 18px; border-radius: var(--radius-sm); border: 1px solid var(--bg4); font-size: 13px; cursor: pointer; font-weight: 500; }
.m-btn.primary { background: var(--accent2); border-color: var(--accent2); color: #fff; }
.m-btn.primary:hover { background: var(--accent); }
.m-btn.secondary { background: var(--bg3); color: var(--fg2); }
.m-btn.secondary:hover { background: var(--bg4); color: var(--fg1); }
</style>
</head>
<body>

<!-- Sidebar -->
<div class="sidebar">
  <div class="sidebar-header">
    <h1>&#9889; <span>Sapper</span></h1>
  </div>
  <div class="sidebar-tabs">
    <button class="active" onclick="switchTab('sessions')">Sessions</button>
    <button onclick="switchTab('agents')">Agents</button>
    <button onclick="switchTab('skills')">Skills</button>
  </div>
  <div class="tab-panel active" id="sessionsPanel">
    <div class="tab-create-btn" onclick="createNewChat()">&#10010; New Chat</div>
    <div id="sessionList"></div>
  </div>
  <div class="tab-panel" id="agentsPanel">
    <div class="tab-create-btn" onclick="openCreateAgent()">&#10010; Create Agent</div>
    <div id="agentList"></div>
  </div>
  <div class="tab-panel" id="skillsPanel">
    <div class="tab-create-btn" onclick="openCreateSkill()">&#10010; Create Skill</div>
    <div id="skillList"></div>
  </div>
  <div class="qa-section">
    <div class="qa-title">Quick Actions</div>
    <div class="qa-grid">
      <div class="qa-btn" onclick="qaAction('list')"><span class="qa-icon">&#128194;</span> Browse Dir</div>
      <div class="qa-btn" onclick="qaAction('read')"><span class="qa-icon">&#128196;</span> Read File</div>
      <div class="qa-btn" onclick="qaAction('write')"><span class="qa-icon">&#9998;</span> Create File</div>
      <div class="qa-btn" onclick="qaAction('search')"><span class="qa-icon">&#128269;</span> Search</div>
      <div class="qa-btn" onclick="qaAction('shell')"><span class="qa-icon">&#9654;</span> Terminal</div>
      <div class="qa-btn" onclick="qaAction('mkdir')"><span class="qa-icon">&#128193;</span> New Dir</div>
      <div class="qa-btn" onclick="qaAction('review')"><span class="qa-icon">&#128270;</span> Review</div>
      <div class="qa-btn" onclick="qaAction('scan')"><span class="qa-icon">&#128202;</span> Scan</div>
    </div>
  </div>
  <div class="sidebar-footer">
    <div class="sf-row"><span>Model</span><span class="sf-model" id="modelTag">loading...</span></div>
    <select id="modelSelect" onchange="selectModel()"></select>
  </div>
</div>

<!-- Main -->
<div class="main">
  <div class="topbar">
    <div class="status-dot" id="statusDot"></div>
    <div class="agent-badge" id="agentBadge">Sapper</div>
    <div class="session-name" id="sessionName" onclick="renameCurrentSession()" title="Click to rename">New Chat</div>
    <div class="spacer"></div>
    <div class="cwd" id="cwdDisplay"></div>
    <button class="tb-btn" onclick="toggleFilePanel()">&#128194; Files</button>
  </div>
  <div class="chat" id="chat">
    <div class="welcome" id="welcome">
      <div class="logo">&#9889;</div>
      <h2>Sapper</h2>
      <p>AI assistant with full filesystem access. Ask anything &mdash; code, write, analyze, build.</p>
      <div class="chips">
        <div class="chip" onclick="sendQuick('What files are in this project?')">&#128193; Explore project</div>
        <div class="chip" onclick="sendQuick('Help me fix bugs in the codebase')">&#128027; Find bugs</div>
        <div class="chip" onclick="sendQuick('Write a README for this project')">&#128221; Write docs</div>
        <div class="chip" onclick="sendQuick('What are my tasks for today?')">&#128203; Today tasks</div>
      </div>
    </div>
  </div>
  <div class="input-area">
    <div class="input-row">
      <textarea id="input" placeholder="Message Sapper..." rows="1" onkeydown="handleKey(event)" oninput="autoResize(this)"></textarea>
      <button class="in-btn send" id="sendBtn" onclick="send()" title="Send">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
      </button>
      <button class="in-btn stop" id="stopBtn" onclick="stopGeneration()" title="Stop">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
      </button>
    </div>
    <div class="input-hint">
      <span><kbd>Enter</kbd> send</span>
      <span><kbd>Shift+Enter</kbd> new line</span>
    </div>
  </div>
</div>

<!-- Right Panel -->
<div class="right-panel" id="rightPanel">
  <div class="rp-header">
    <h3>&#128194; Files</h3>
    <button class="rp-close" onclick="toggleFilePanel()">&#10005;</button>
  </div>
  <div class="file-tree" id="fileTree"></div>
  <div class="file-editor" id="fileEditor">
    <div class="fe-header">
      <span class="fe-path" id="fePath"></span>
      <button class="fe-btn" id="feEditBtn" onclick="startEditing()">Edit</button>
      <button class="fe-btn save" id="feSaveBtn" onclick="saveFileEdit()" style="display:none">Save</button>
      <button class="fe-btn" id="feCancelBtn" onclick="cancelEdit()" style="display:none">Cancel</button>
    </div>
    <div class="fe-content" id="feContent"></div>
  </div>
</div>

<!-- Modal -->
<div class="modal-overlay" id="modalOverlay">
  <div class="modal">
    <div class="modal-header">
      <h3 id="modalTitle">Modal</h3>
      <button class="modal-close" onclick="closeModal()">&#10005;</button>
    </div>
    <div class="modal-body" id="modalBody"></div>
    <div class="modal-footer" id="modalFooter"></div>
  </div>
</div>

<script>
// ─── State ─────────────────────────────────────────────────
var currentModel = '';
var currentAgent = null;
var currentAgentKey = null;
var currentSessionId = null;
var currentSessionName = 'New Chat';
var isStreaming = false;
var editingFilePath = null;
var editMode = false;
var BT = String.fromCharCode(96);
var NL = String.fromCharCode(10);
var chatEl = document.getElementById('chat');
var inputEl = document.getElementById('input');
var welcomeEl = document.getElementById('welcome');

// ─── Init ──────────────────────────────────────────────────
function init() {
  Promise.all([
    fetch('/api/models').then(function(r){return r.json();}),
    fetch('/api/agents').then(function(r){return r.json();}),
    fetch('/api/info').then(function(r){return r.json();}),
    fetch('/api/sessions').then(function(r){return r.json();}),
    fetch('/api/skills').then(function(r){return r.json();})
  ]).then(function(results) {
    var modelsRes = results[0], agentsRes = results[1], infoRes = results[2], sessionsRes = results[3], skillsRes = results[4];
    var sel = document.getElementById('modelSelect');
    sel.innerHTML = '';
    for (var i = 0; i < modelsRes.models.length; i++) {
      var opt = document.createElement('option');
      opt.value = modelsRes.models[i]; opt.textContent = modelsRes.models[i];
      sel.appendChild(opt);
    }
    if (modelsRes.models.length > 0) {
      currentModel = modelsRes.models[0];
      document.getElementById('modelTag').textContent = shortModel(currentModel);
    }
    renderAgentList(agentsRes.agents);
    renderSkillList(skillsRes.skills);
    renderSessionList(sessionsRes.sessions);
    document.getElementById('cwdDisplay').textContent = infoRes.cwd;
    inputEl.focus();
  });
}

function shortModel(m) { return m.split(':')[0].substring(0, 18); }

// ─── Tab Switching ─────────────────────────────────────────
function switchTab(name) {
  var tabs = document.querySelectorAll('.sidebar-tabs button');
  var panels = document.querySelectorAll('.tab-panel');
  for (var i = 0; i < tabs.length; i++) { tabs[i].classList.remove('active'); }
  for (var i = 0; i < panels.length; i++) { panels[i].classList.remove('active'); }
  document.getElementById(name + 'Panel').classList.add('active');
  var tabNames = ['sessions', 'agents', 'skills'];
  for (var i = 0; i < tabNames.length; i++) {
    if (tabNames[i] === name) tabs[i].classList.add('active');
  }
  if (name === 'sessions') refreshSessions();
  if (name === 'agents') refreshAgents();
  if (name === 'skills') refreshSkills();
}

// ─── Sessions ──────────────────────────────────────────────
function renderSessionList(sessions) {
  var el = document.getElementById('sessionList');
  el.innerHTML = '';
  for (var i = 0; i < sessions.length; i++) {
    var s = sessions[i];
    var item = document.createElement('div');
    item.className = 's-item' + (s.id === currentSessionId ? ' active' : '');
    item.innerHTML = '<span class="s-icon">&#128172;</span>' +
      '<span class="s-label">' + esc(s.name) + '</span>' +
      '<span class="s-meta">' + s.msgCount + '</span>' +
      '<button class="s-del" onclick="event.stopPropagation(); deleteSession(&apos;' + esc(s.id) + '&apos;)" title="Delete">&#10005;</button>';
    item.setAttribute('data-id', s.id);
    item.onclick = (function(sid) { return function() { loadSessionById(sid); }; })(s.id);
    el.appendChild(item);
  }
}
function refreshSessions() {
  fetch('/api/sessions').then(function(r){return r.json();}).then(function(d){renderSessionList(d.sessions);});
}
function createNewChat() {
  currentSessionId = null;
  currentSessionName = 'New Chat';
  document.getElementById('sessionName').textContent = 'New Chat';
  chatEl.innerHTML = '';
  chatEl.appendChild(welcomeEl);
  welcomeEl.style.display = 'flex';
  fetch('/api/clear', {method: 'POST'});
  refreshSessions();
}
function loadSessionById(id) {
  fetch('/api/sessions/load', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({id:id})})
  .then(function(r){return r.json();}).then(function(d) {
    if (!d.session) return;
    currentSessionId = id;
    currentSessionName = d.session.name || 'Chat';
    document.getElementById('sessionName').textContent = currentSessionName;
    if (d.session.model) {
      currentModel = d.session.model;
      document.getElementById('modelSelect').value = currentModel;
      document.getElementById('modelTag').textContent = shortModel(currentModel);
    }
    chatEl.innerHTML = '';
    chatEl.appendChild(welcomeEl);
    welcomeEl.style.display = 'none';
    var msgs = d.session.messages || [];
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      if (m.role === 'system') continue;
      if (m.role === 'user' && m.content.indexOf('RESULT (') === 0) continue;
      if (m.role === 'user' && m.content === 'STOP using tools. Provide your answer now with what you have.') continue;
      if (m.role === 'user') addMsg('user', m.content);
      else if (m.role === 'assistant') {
        var el = addMsg('ai', '');
        el.innerHTML = renderFullMessage(stripToolSyntax(m.content));
      }
    }
    scrollDown();
    refreshSessions();
  });
}
function deleteSession(id) {
  fetch('/api/sessions/delete', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({id:id})})
  .then(function() {
    if (currentSessionId === id) createNewChat();
    refreshSessions();
  });
}
function autoSaveSession() {
  if (!currentSessionId) currentSessionId = 'session_' + Date.now();
  if (currentSessionName === 'New Chat') {
    var firstUser = null;
    var msgs = chatEl.querySelectorAll('.msg.user');
    if (msgs.length > 0) firstUser = msgs[0].textContent;
    if (firstUser) currentSessionName = firstUser.substring(0, 50);
    document.getElementById('sessionName').textContent = currentSessionName;
  }
  fetch('/api/sessions/save', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({id: currentSessionId, name: currentSessionName})});
}
function renameCurrentSession() {
  if (!currentSessionId) return;
  showPromptModal('Rename Session', 'Session name', currentSessionName, function(val) {
    if (!val) return;
    currentSessionName = val;
    document.getElementById('sessionName').textContent = val;
    fetch('/api/sessions/rename', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({id: currentSessionId, name: val})})
    .then(function() { refreshSessions(); });
  });
}

// ─── Agents ────────────────────────────────────────────────
function renderAgentList(agents) {
  var el = document.getElementById('agentList');
  el.innerHTML = '';
  var defItem = document.createElement('div');
  defItem.className = 's-item' + (!currentAgentKey ? ' active' : '');
  defItem.innerHTML = '<span class="s-icon">&#9889;</span><span class="s-label">Sapper</span><span class="s-meta">default</span>';
  defItem.onclick = function() { switchAgent(null, 'Sapper'); };
  el.appendChild(defItem);
  var keys = Object.keys(agents);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i], a = agents[k];
    var item = document.createElement('div');
    item.className = 's-item' + (currentAgentKey === k ? ' active' : '');
    item.innerHTML = '<span class="s-icon">&#129302;</span>' +
      '<span class="s-label">' + esc(a.name) + '</span>' +
      '<button class="s-del" onclick="event.stopPropagation(); deleteAgent(&apos;' + esc(k) + '&apos;)" title="Delete">&#10005;</button>';
    item.title = a.description || '';
    item.onclick = (function(key, name) { return function() { switchAgent(key, name); }; })(k, a.name);
    el.appendChild(item);
  }
}
function refreshAgents() {
  fetch('/api/agents').then(function(r){return r.json();}).then(function(d){renderAgentList(d.agents);});
}
function switchAgent(key, name) {
  currentAgentKey = key;
  currentAgent = key;
  document.getElementById('agentBadge').textContent = name;
  fetch('/api/agent', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({agent: key})});
  addSystem('Switched to ' + name);
  refreshAgents();
}
function deleteAgent(key) {
  if (!confirm('Delete agent "' + key + '"?')) return;
  fetch('/api/agents/delete', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({key: key})})
  .then(function() {
    if (currentAgentKey === key) switchAgent(null, 'Sapper');
    refreshAgents();
  });
}
function openCreateAgent() {
  var allTools = ['read', 'write', 'patch', 'list', 'search', 'shell', 'mkdir'];
  var body = '<div class="m-field"><label>Agent Name</label><input id="maName" placeholder="e.g. Code Reviewer"></div>' +
    '<div class="m-field"><label>Description</label><input id="maDesc" placeholder="What does this agent do?"></div>' +
    '<div class="m-field"><label>Allowed Tools</label><div class="checkbox-group" id="maTools">';
  for (var i = 0; i < allTools.length; i++) {
    body += '<label><input type="checkbox" value="' + allTools[i] + '" checked> ' + allTools[i].toUpperCase() + '</label>';
  }
  body += '</div></div>' +
    '<div class="m-field"><label>Agent Instructions (Markdown)</label><textarea id="maContent" placeholder="# Agent Name' + NL + NL + 'Instructions for the agent..."></textarea></div>';
  showModal('Create Agent', body,
    '<button class="m-btn secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="m-btn primary" onclick="submitCreateAgent()">Create</button>');
}
function submitCreateAgent() {
  var name = document.getElementById('maName').value.trim();
  var desc = document.getElementById('maDesc').value.trim();
  var content = document.getElementById('maContent').value;
  if (!name) { alert('Name is required'); return; }
  var checkboxes = document.querySelectorAll('#maTools input:checked');
  var tools = [];
  for (var i = 0; i < checkboxes.length; i++) tools.push(checkboxes[i].value);
  fetch('/api/agents/create', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name:name, description:desc, tools:tools, content:content})})
  .then(function(r){return r.json();}).then(function() { closeModal(); refreshAgents(); });
}

// ─── Skills ────────────────────────────────────────────────
function renderSkillList(skills) {
  var el = document.getElementById('skillList');
  el.innerHTML = '';
  var keys = Object.keys(skills);
  if (keys.length === 0) {
    el.innerHTML = '<div style="padding:12px;color:var(--fg3);font-size:12px;">No skills yet</div>';
    return;
  }
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i], s = skills[k];
    var item = document.createElement('div');
    item.className = 's-item';
    item.innerHTML = '<span class="s-icon">&#128218;</span>' +
      '<span class="s-label">' + esc(s.name) + '</span>' +
      '<button class="s-del" onclick="event.stopPropagation(); deleteSkill(&apos;' + esc(k) + '&apos;)" title="Delete">&#10005;</button>';
    item.title = s.description || '';
    el.appendChild(item);
  }
}
function refreshSkills() {
  fetch('/api/skills').then(function(r){return r.json();}).then(function(d){renderSkillList(d.skills);});
}
function deleteSkill(key) {
  if (!confirm('Delete skill "' + key + '"?')) return;
  fetch('/api/skills/delete', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({key: key})})
  .then(function() { refreshSkills(); });
}
function openCreateSkill() {
  var body = '<div class="m-field"><label>Skill Name</label><input id="msName" placeholder="e.g. Testing"></div>' +
    '<div class="m-field"><label>Description</label><input id="msDesc" placeholder="What does this skill teach?"></div>' +
    '<div class="m-field"><label>Skill Content (Markdown)</label><textarea id="msContent" placeholder="# Skill Name' + NL + NL + 'Knowledge and instructions..."></textarea></div>';
  showModal('Create Skill', body,
    '<button class="m-btn secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="m-btn primary" onclick="submitCreateSkill()">Create</button>');
}
function submitCreateSkill() {
  var name = document.getElementById('msName').value.trim();
  var desc = document.getElementById('msDesc').value.trim();
  var content = document.getElementById('msContent').value;
  if (!name) { alert('Name is required'); return; }
  fetch('/api/skills/create', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name:name, description:desc, content:content})})
  .then(function(r){return r.json();}).then(function() { closeModal(); refreshSkills(); });
}

// ─── Model ─────────────────────────────────────────────────
function selectModel() {
  currentModel = document.getElementById('modelSelect').value;
  document.getElementById('modelTag').textContent = shortModel(currentModel);
  fetch('/api/model', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({model: currentModel})});
  addSystem('Model: ' + currentModel);
}

// ─── Chat ──────────────────────────────────────────────────
function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
}
function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 150) + 'px';
}
function send(text) {
  var msg = text || inputEl.value.trim();
  if (!msg || isStreaming) return;
  inputEl.value = ''; inputEl.style.height = 'auto';
  welcomeEl.style.display = 'none';
  addMsg('user', msg);
  isStreaming = true;
  document.getElementById('sendBtn').disabled = true;
  document.getElementById('stopBtn').classList.add('visible');
  document.getElementById('statusDot').style.background = 'var(--orange)';

  // Container holds all AI rounds + tool cards for this exchange
  var container = document.createElement('div');
  container.className = 'ai-exchange';
  chatEl.appendChild(container);

  var dots = document.createElement('div');
  dots.className = 'thinking-dots';
  dots.innerHTML = '<span></span><span></span><span></span>';
  container.appendChild(dots);

  fetch('/api/chat', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({message: msg})
  }).then(function(res) {
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    var removedDots = false;

    // Track current AI text segment
    var currentTextEl = null;
    var currentText = '';
    var renderTimer = null;
    var thinkEl = null;
    var thinkTextEl = null;
    var inThink = false;
    var thinkContent = '';
    var doneThinkContent = '';
    var lastRenderTime = 0;

    function ensureTextEl() {
      if (!currentTextEl) {
        currentTextEl = document.createElement('div');
        currentTextEl.className = 'msg ai';
        container.appendChild(currentTextEl);
        currentText = '';
      }
    }

    function renderCurrentText() {
      if (!currentTextEl) return;
      var cleaned = stripToolSyntax(doneThinkContent + currentText);
      if (cleaned) currentTextEl.innerHTML = renderMarkdown(cleaned);
      lastRenderTime = Date.now();
    }

    function scheduleRender() {
      var now = Date.now();
      if (now - lastRenderTime > 80) {
        renderCurrentText();
      } else if (!renderTimer) {
        renderTimer = setTimeout(function() { renderTimer = null; renderCurrentText(); }, 80);
      }
    }

    function startThinkBlock() {
      if (thinkEl) return;
      inThink = true;
      thinkContent = '';
      thinkEl = document.createElement('div');
      thinkEl.className = 'think-block open streaming';
      thinkEl.innerHTML = '<div class="think-header" onclick="this.parentElement.classList.toggle(&apos;open&apos;)">' +
        '<span class="think-chevron">&#9654;</span>' +
        '<span class="think-label">&#129504; Thinking...</span></div>' +
        '<div class="think-content"></div>';
      container.appendChild(thinkEl);
      thinkTextEl = thinkEl.querySelector('.think-content');
    }

    function updateThinkBlock(text) {
      if (thinkTextEl) thinkTextEl.innerHTML = renderMarkdown(text);
    }

    function endThinkBlock() {
      if (thinkEl) {
        thinkEl.classList.remove('streaming', 'open');
        thinkEl.querySelector('.think-label').innerHTML = '&#129504; Thinking (done)';
        updateThinkBlock(thinkContent);
      }
      inThink = false;
      thinkEl = null;
      thinkTextEl = null;
    }

    function processToken(token) {
      // Handle <think> and </think> tags that may come split across tokens
      var remaining = token;
      while (remaining.length > 0) {
        if (inThink) {
          var closeIdx = remaining.indexOf('</think>');
          if (closeIdx !== -1) {
            thinkContent += remaining.substring(0, closeIdx);
            endThinkBlock();
            remaining = remaining.substring(closeIdx + 8);
            // Reset text element for content after thinking
            currentTextEl = null;
          } else {
            // Check for partial </think> at end
            var partial = false;
            for (var pLen = 1; pLen < 8 && pLen <= remaining.length; pLen++) {
              if ('</think>'.indexOf(remaining.substring(remaining.length - pLen)) === 0) {
                thinkContent += remaining.substring(0, remaining.length - pLen);
                remaining = remaining.substring(remaining.length - pLen);
                partial = true;
                break;
              }
            }
            if (!partial) {
              thinkContent += remaining;
              remaining = '';
            } else {
              // Buffer partial tag, will resolve on next token
              thinkContent += remaining;
              remaining = '';
            }
            if (thinkContent.length > 0 && Date.now() - lastRenderTime > 120) {
              updateThinkBlock(thinkContent);
              lastRenderTime = Date.now();
            }
          }
        } else {
          var openIdx = remaining.indexOf('<think>');
          if (openIdx !== -1) {
            var before = remaining.substring(0, openIdx);
            if (before.length > 0) {
              ensureTextEl();
              currentText += before;
              scheduleRender();
            }
            // Save what we have so far as done text
            if (currentText.length > 0) {
              renderCurrentText();
              doneThinkContent += currentText;
              currentText = '';
              currentTextEl = null;
            }
            startThinkBlock();
            remaining = remaining.substring(openIdx + 7);
          } else {
            ensureTextEl();
            currentText += remaining;
            scheduleRender();
            remaining = '';
          }
        }
      }
    }

    function processStream() {
      reader.read().then(function(result) {
        if (result.done) { finishStream(); return; }
        buffer += decoder.decode(result.value, {stream: true});
        var lines = buffer.split(NL);
        buffer = lines.pop();
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (line.indexOf('data: ') !== 0) continue;
          var raw = line.slice(6);
          if (raw === '[DONE]') continue;
          var evt;
          try { evt = JSON.parse(raw); } catch(e) { continue; }
          if (!removedDots) { dots.remove(); removedDots = true; }
          if (evt.type === 'token') {
            processToken(evt.data);
            scrollDown();
          } else if (evt.type === 'tool_start') {
            // Finish current text segment before showing tool
            if (currentText) { renderCurrentText(); doneThinkContent += currentText; currentText = ''; }
            currentTextEl = null;
            if (inThink) endThinkBlock();

            var card = document.createElement('div');
            card.className = 'tool-card';
            card.setAttribute('data-tool', evt.data.tool);
            card.setAttribute('data-path', evt.data.path);
            card.innerHTML = '<div class="tool-card-header" onclick="this.parentElement.classList.toggle(&apos;expanded&apos;)">' +
              '<span class="tc-icon">&#9881;</span>' +
              '<span class="tc-name">' + esc(evt.data.tool) + '</span>' +
              '<span class="tc-path">' + esc(evt.data.path) + '</span>' +
              '<span class="tc-status tc-spinner">&#8987;</span>' +
              '<span class="tc-chevron">&#9654;</span></div>' +
              '<div class="tool-card-body"><pre>Running...</pre></div>';
            container.appendChild(card);
            scrollDown();
          } else if (evt.type === 'tool_result') {
            // Try to update the last pending tool card
            var pendingCards = container.querySelectorAll('.tool-card:not(.done)');
            var isErr = (evt.data.result && evt.data.result.indexOf('Error') !== -1) || evt.data.blocked;
            if (pendingCards.length > 0) {
              var lastCard = pendingCards[pendingCards.length - 1];
              lastCard.classList.add('done');
              if (isErr) lastCard.classList.add('error');
              var hdr = lastCard.querySelector('.tool-card-header');
              var statusSpan = lastCard.querySelector('.tc-status');
              if (statusSpan) statusSpan.innerHTML = isErr ? '&#10060;' : '&#9989;';
              var body = lastCard.querySelector('.tool-card-body pre');
              if (body) body.textContent = evt.data.result || '(no output)';
            } else {
              // Fallback: create result card
              var card = document.createElement('div');
              card.className = 'tool-card done' + (isErr ? ' error' : '');
              card.innerHTML = '<div class="tool-card-header" onclick="this.parentElement.classList.toggle(&apos;expanded&apos;)">' +
                '<span class="tc-icon">' + (isErr ? '&#10060;' : '&#9989;') + '</span>' +
                '<span class="tc-name">' + esc(evt.data.tool) + '</span>' +
                '<span class="tc-path">' + esc(evt.data.path) + '</span>' +
                '<span class="tc-chevron">&#9654;</span></div>' +
                '<div class="tool-card-body"><pre>' + esc(evt.data.result || '') + '</pre></div>';
              container.appendChild(card);
            }
            scrollDown();
          } else if (evt.type === 'system') {
            addSystem(evt.data);
          }
        }
        processStream();
      }).catch(function(e) {
        if (!removedDots) dots.remove();
        ensureTextEl();
        currentTextEl.innerHTML = '<span style="color:var(--red)">Stream error: ' + esc(e.message) + '</span>';
        finishStream();
      });
    }

    function finishStream() {
      if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
      if (inThink) endThinkBlock();
      if (currentText) {
        renderCurrentText();
      }
      if (!removedDots) { dots.remove(); }
      // If nothing was rendered at all
      if (!container.querySelector('.msg.ai') && !container.querySelector('.tool-card') && !container.querySelector('.think-block')) {
        var empty = document.createElement('div');
        empty.className = 'msg ai';
        empty.innerHTML = '<em style="color:var(--fg3)">No response</em>';
        container.appendChild(empty);
      }
      isStreaming = false;
      document.getElementById('sendBtn').disabled = false;
      document.getElementById('stopBtn').classList.remove('visible');
      document.getElementById('statusDot').style.background = 'var(--green)';
      scrollDown();
      inputEl.focus();
      autoSaveSession();
    }

    processStream();
  }).catch(function(e) {
    if (dots.parentNode) dots.remove();
    var errEl = document.createElement('div');
    errEl.className = 'msg ai';
    errEl.innerHTML = '<span style="color:var(--red)">Error: ' + esc(e.message) + '</span>';
    container.appendChild(errEl);
    isStreaming = false;
    document.getElementById('sendBtn').disabled = false;
    document.getElementById('stopBtn').classList.remove('visible');
    document.getElementById('statusDot').style.background = 'var(--green)';
  });
}
function sendQuick(text) { inputEl.value = text; send(); }
function stopGeneration() {
  fetch('/api/stop', {method: 'POST'});
}
function addMsg(role, text) {
  welcomeEl.style.display = 'none';
  var el = document.createElement('div');
  el.className = 'msg ' + role;
  if (role === 'user') el.textContent = text;
  else el.innerHTML = renderFullMessage(text);
  chatEl.appendChild(el);
  scrollDown();
  return el;
}
function addSystem(text) {
  var el = document.createElement('div');
  el.className = 'msg system';
  el.textContent = text;
  chatEl.appendChild(el);
  scrollDown();
}
function scrollDown() { chatEl.scrollTop = chatEl.scrollHeight; }

// ─── Rendering ─────────────────────────────────────────────
function stripToolSyntax(text) {
  var result = text;
  while (true) {
    var start = result.indexOf('[TOOL:');
    if (start === -1) break;
    var end = result.indexOf('[/TOOL]', start);
    if (end === -1) break;
    result = result.substring(0, start) + result.substring(end + 7);
  }
  return result.trim();
}

function renderFullMessage(text) {
  if (!text) return '';
  var parts = parseThinkBlocks(text);
  var html = '';
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    if (p.type === 'thinking') {
      var cls = p.done ? 'think-block' : 'think-block open streaming';
      html += '<div class="' + cls + '">';
      html += '<div class="think-header" onclick="this.parentElement.classList.toggle(&apos;open&apos;)">';
      html += '<span class="think-chevron">&#9654;</span>';
      html += '<span class="think-label">&#129504; Thinking' + (p.done ? '' : '...') + '</span></div>';
      html += '<div class="think-content">' + renderMarkdown(p.content) + '</div></div>';
    } else {
      html += renderMarkdown(p.content);
    }
  }
  return html;
}

function parseThinkBlocks(text) {
  var parts = [];
  var remaining = text;
  while (true) {
    var s = remaining.indexOf('<think>');
    if (s === -1) {
      if (remaining.length > 0) parts.push({type: 'text', content: remaining});
      break;
    }
    if (s > 0) parts.push({type: 'text', content: remaining.substring(0, s)});
    var e = remaining.indexOf('</think>', s + 7);
    if (e === -1) {
      parts.push({type: 'thinking', content: remaining.substring(s + 7), done: false});
      break;
    }
    parts.push({type: 'thinking', content: remaining.substring(s + 7, e), done: true});
    remaining = remaining.substring(e + 8);
  }
  return parts;
}

function renderMarkdown(text) {
  if (!text) return '';
  var lines = text.split(NL);
  var html = '';
  var inCode = false;
  var codeLang = '';
  var codeLines = [];
  var inList = false;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var trimmed = line.trim();

    if (trimmed.indexOf(BT+BT+BT) === 0) {
      if (!inCode) {
        if (inList) { html += '</ul>'; inList = false; }
        inCode = true;
        codeLang = trimmed.slice(3).trim();
        codeLines = [];
      } else {
        html += '<pre><code class="lang-' + esc(codeLang) + '">' + esc(codeLines.join(NL)) + '</code></pre>';
        inCode = false;
      }
      continue;
    }
    if (inCode) { codeLines.push(line); continue; }

    if (trimmed === '') {
      if (inList) { html += '</ul>'; inList = false; }
      html += '<br>';
      continue;
    }

    var isLi = trimmed.length > 2 && (trimmed.charAt(0) === '-' || trimmed.charAt(0) === '*') && trimmed.charAt(1) === ' ';
    var isOl = false;
    var olMatch = trimmed.match(/^(\d+)\.\s/);
    if (olMatch) isOl = true;

    if (!isLi && !isOl && inList) { html += '</ul>'; inList = false; }

    if (trimmed.indexOf('### ') === 0) { html += '<h3>' + inlineFmt(esc(trimmed.slice(4))) + '</h3>'; continue; }
    if (trimmed.indexOf('## ') === 0) { html += '<h2>' + inlineFmt(esc(trimmed.slice(3))) + '</h2>'; continue; }
    if (trimmed.indexOf('# ') === 0) { html += '<h1>' + inlineFmt(esc(trimmed.slice(2))) + '</h1>'; continue; }
    if (trimmed.indexOf('> ') === 0) { html += '<blockquote>' + inlineFmt(esc(trimmed.slice(2))) + '</blockquote>'; continue; }
    if (trimmed === '---' || trimmed === '***' || trimmed === '___') { html += '<hr>'; continue; }

    if (isLi) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += '<li>' + inlineFmt(esc(trimmed.slice(2))) + '</li>';
      continue;
    }
    if (isOl) {
      if (!inList) { html += '<ul>'; inList = true; }
      var olText = trimmed.replace(/^\d+\.\s/, '');
      html += '<li>' + inlineFmt(esc(olText)) + '</li>';
      continue;
    }

    html += '<p>' + inlineFmt(esc(line)) + '</p>';
  }
  if (inCode) html += '<pre><code>' + esc(codeLines.join(NL)) + '</code></pre>';
  if (inList) html += '</ul>';
  return html;
}

function inlineFmt(text) {
  var parts = text.split(BT);
  var result = '';
  for (var i = 0; i < parts.length; i++) {
    if (i % 2 === 1) { result += '<code>' + parts[i] + '</code>'; }
    else {
      var s = parts[i];
      s = replacePairs(s, '**', '<strong>', '</strong>');
      s = replacePairs(s, '*', '<em>', '</em>');
      result += s;
    }
  }
  return result;
}

function replacePairs(text, marker, open, close) {
  var r = '';
  var idx = 0;
  while (idx < text.length) {
    var s = text.indexOf(marker, idx);
    if (s === -1) { r += text.substring(idx); break; }
    var e = text.indexOf(marker, s + marker.length);
    if (e === -1) { r += text.substring(idx); break; }
    r += text.substring(idx, s) + open + text.substring(s + marker.length, e) + close;
    idx = e + marker.length;
  }
  return r;
}

function esc(s) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ─── File Panel ────────────────────────────────────────────
function toggleFilePanel() {
  var rp = document.getElementById('rightPanel');
  if (rp.classList.contains('open')) { rp.classList.remove('open'); }
  else { rp.classList.add('open'); loadFileTree('.'); }
}
function closeFilePanel() { document.getElementById('rightPanel').classList.remove('open'); }

function loadFileTree(dirPath) {
  fetch('/api/tree?path=' + encodeURIComponent(dirPath)).then(function(r){return r.json();}).then(function(d) {
    var el = document.getElementById('fileTree');
    el.innerHTML = '';
    if (dirPath !== '.') {
      var up = document.createElement('div');
      up.className = 'ft-item';
      up.innerHTML = '<span class="ft-icon">&#11013;</span><span class="ft-name">..</span>';
      var parent = dirPath.split('/').slice(0, -1).join('/') || '.';
      up.onclick = function() { loadFileTree(parent); };
      el.appendChild(up);
    }
    for (var i = 0; i < d.entries.length; i++) {
      var entry = d.entries[i];
      var item = document.createElement('div');
      item.className = 'ft-item' + (entry.isDir ? ' dir' : '');
      var icon = entry.isDir ? '&#128194;' : '&#128196;';
      item.innerHTML = '<span class="ft-icon">' + icon + '</span><span class="ft-name">' + esc(entry.name) + '</span>';
      if (entry.isDir) {
        var subPath = (dirPath === '.' ? '' : dirPath + '/') + entry.name;
        item.onclick = (function(p) { return function() { loadFileTree(p); }; })(subPath);
      } else {
        var filePath = (dirPath === '.' ? '' : dirPath + '/') + entry.name;
        item.onclick = (function(p) { return function() { viewFile(p); }; })(filePath);
      }
      el.appendChild(item);
    }
  });
}

function viewFile(path) {
  editMode = false;
  editingFilePath = path;
  fetch('/api/file/read?path=' + encodeURIComponent(path)).then(function(r){return r.json();}).then(function(d) {
    var editor = document.getElementById('fileEditor');
    editor.classList.add('open');
    document.getElementById('fePath').textContent = path;
    var content = document.getElementById('feContent');
    content.innerHTML = '<pre>' + esc(d.content || '') + '</pre>';
    document.getElementById('feEditBtn').style.display = '';
    document.getElementById('feSaveBtn').style.display = 'none';
    document.getElementById('feCancelBtn').style.display = 'none';
  });
}

function startEditing() {
  if (!editingFilePath) return;
  editMode = true;
  var content = document.getElementById('feContent');
  var pre = content.querySelector('pre');
  var text = pre ? pre.textContent : '';
  content.innerHTML = '';
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.id = 'feTextarea';
  content.appendChild(ta);
  document.getElementById('feEditBtn').style.display = 'none';
  document.getElementById('feSaveBtn').style.display = '';
  document.getElementById('feCancelBtn').style.display = '';
}

function saveFileEdit() {
  var ta = document.getElementById('feTextarea');
  if (!ta || !editingFilePath) return;
  fetch('/api/file/write', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({path: editingFilePath, content: ta.value})})
  .then(function(r){return r.json();}).then(function(d) {
    if (d.ok) { viewFile(editingFilePath); addSystem('Saved ' + editingFilePath); }
    else addSystem('Error saving: ' + (d.error || 'unknown'));
  });
}

function cancelEdit() { if (editingFilePath) viewFile(editingFilePath); }

// ─── Quick Actions ─────────────────────────────────────────
function qaAction(type) {
  if (type === 'list') {
    showPromptModal('Browse Directory', 'Directory path (e.g. src)', '.', function(v) {
      sendQuick('List the contents of the directory: ' + v);
    });
  } else if (type === 'read') {
    showPromptModal('Read File', 'File path (e.g. src/index.js)', '', function(v) {
      if (v) sendQuick('Read and show me the file: ' + v);
    });
  } else if (type === 'write') {
    showPromptModal('Create File', 'File path to create', '', function(v) {
      if (v) sendQuick('Create a new file at ' + v + ' with appropriate starter content');
    });
  } else if (type === 'search') {
    showPromptModal('Search Files', 'Search pattern', '', function(v) {
      if (v) sendQuick('Search the codebase for: ' + v);
    });
  } else if (type === 'shell') {
    showPromptModal('Run Command', 'Shell command', '', function(v) {
      if (v) sendQuick('Run this command: ' + v);
    });
  } else if (type === 'mkdir') {
    showPromptModal('Create Directory', 'Directory path', '', function(v) {
      if (v) sendQuick('Create directory: ' + v);
    });
  } else if (type === 'review') {
    sendQuick('Review the codebase for bugs, issues, and improvements');
  } else if (type === 'scan') {
    sendQuick('List the project files and give me a complete overview of the project structure and purpose');
  }
}

// ─── Modal ─────────────────────────────────────────────────
function showModal(title, bodyHtml, footerHtml) {
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalBody').innerHTML = bodyHtml;
  document.getElementById('modalFooter').innerHTML = footerHtml;
  document.getElementById('modalOverlay').classList.add('visible');
}
function closeModal() {
  document.getElementById('modalOverlay').classList.remove('visible');
}
function showPromptModal(title, placeholder, defaultVal, callback) {
  var body = '<div class="m-field"><label>' + esc(placeholder) + '</label><input id="promptInput" value="' + esc(defaultVal || '') + '"></div>';
  showModal(title, body,
    '<button class="m-btn secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="m-btn primary" id="promptOk">OK</button>');
  var inp = document.getElementById('promptInput');
  inp.focus();
  inp.select();
  document.getElementById('promptOk').onclick = function() { closeModal(); callback(inp.value); };
  inp.onkeydown = function(e) { if (e.key === 'Enter') { closeModal(); callback(inp.value); } };
}

// ─── Escape modal on Escape key ────────────────────────────
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') closeModal();
});

init();
</script>
</body>
</html>`;
}

// ─── HTTP Server ───────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  req.socket.setNoDelay(true);
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // ── Serve frontend ──
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buildHTML());
    return;
  }

  // ── API: models ──
  if (req.method === 'GET' && url.pathname === '/api/models') {
    try {
      const list = await ollama.list();
      const names = (list.models || []).map(m => m.name);
      if (names.length > 0 && !serverModel) serverModel = names[0];
      json(res, { models: names });
    } catch (e) { json(res, { models: [], error: e.message }, 500); }
    return;
  }

  // ── API: agents ──
  if (req.method === 'GET' && url.pathname === '/api/agents') {
    json(res, { agents: loadAgents() });
    return;
  }

  // ── API: skills ──
  if (req.method === 'GET' && url.pathname === '/api/skills') {
    json(res, { skills: loadSkills() });
    return;
  }

  // ── API: info ──
  if (req.method === 'GET' && url.pathname === '/api/info') {
    json(res, { cwd: workingDir, version: getVersion() });
    return;
  }

  // ── API: sessions list ──
  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    json(res, { sessions: listSessions() });
    return;
  }

  // ── API: session save ──
  if (req.method === 'POST' && url.pathname === '/api/sessions/save') {
    const body = await readBody(req);
    if (body.id) {
      currentSessionId = body.id;
      saveSession(body.id, body.name || 'Chat', serverMessages, serverModel, serverAgentKey);
    }
    json(res, { ok: true });
    return;
  }

  // ── API: session load ──
  if (req.method === 'POST' && url.pathname === '/api/sessions/load') {
    const body = await readBody(req);
    const session = loadSessionData(body.id);
    if (session) {
      serverMessages = session.messages || [];
      if (session.model) serverModel = session.model;
      currentSessionId = body.id;
      if (session.agent) {
        const agents = loadAgents();
        if (agents[session.agent]) {
          serverAgent = agents[session.agent];
          serverAgentKey = session.agent;
        }
      }
    }
    json(res, { session });
    return;
  }

  // ── API: session delete ──
  if (req.method === 'POST' && url.pathname === '/api/sessions/delete') {
    const body = await readBody(req);
    deleteSessionFile(body.id);
    json(res, { ok: true });
    return;
  }

  // ── API: session rename ──
  if (req.method === 'POST' && url.pathname === '/api/sessions/rename') {
    const body = await readBody(req);
    renameSession(body.id, body.name);
    json(res, { ok: true });
    return;
  }

  // ── API: create agent ──
  if (req.method === 'POST' && url.pathname === '/api/agents/create') {
    const body = await readBody(req);
    const file = createAgentFile(body.name, body.description, body.tools, body.content || '');
    json(res, { ok: true, file });
    return;
  }

  // ── API: delete agent ──
  if (req.method === 'POST' && url.pathname === '/api/agents/delete') {
    const body = await readBody(req);
    deleteAgentFile(body.key);
    json(res, { ok: true });
    return;
  }

  // ── API: create skill ──
  if (req.method === 'POST' && url.pathname === '/api/skills/create') {
    const body = await readBody(req);
    const file = createSkillFile(body.name, body.description, body.content || '');
    json(res, { ok: true, file });
    return;
  }

  // ── API: delete skill ──
  if (req.method === 'POST' && url.pathname === '/api/skills/delete') {
    const body = await readBody(req);
    deleteSkillFile(body.key);
    json(res, { ok: true });
    return;
  }

  // ── API: file tree ──
  if (req.method === 'GET' && url.pathname === '/api/tree') {
    const dirPath = url.searchParams.get('path') || '.';
    json(res, { entries: getTreeEntries(dirPath) });
    return;
  }

  // ── API: file read ──
  if (req.method === 'GET' && url.pathname === '/api/file/read') {
    const filePath = url.searchParams.get('path');
    const safe = safePath(filePath);
    if (!safe) { json(res, { error: 'Invalid path' }, 400); return; }
    try {
      const content = fs.readFileSync(safe, 'utf8');
      json(res, { content, path: filePath });
    } catch (e) { json(res, { error: e.message }, 500); }
    return;
  }

  // ── API: file write ──
  if (req.method === 'POST' && url.pathname === '/api/file/write') {
    const body = await readBody(req);
    const safe = safePath(body.path);
    if (!safe) { json(res, { error: 'Invalid path' }, 400); return; }
    try {
      fs.mkdirSync(dirname(safe), { recursive: true });
      fs.writeFileSync(safe, body.content);
      json(res, { ok: true });
    } catch (e) { json(res, { error: e.message }, 500); }
    return;
  }

  // ── API: select model ──
  if (req.method === 'POST' && url.pathname === '/api/model') {
    const body = await readBody(req);
    serverModel = body.model || serverModel;
    json(res, { ok: true, model: serverModel });
    return;
  }

  // ── API: select agent ──
  if (req.method === 'POST' && url.pathname === '/api/agent') {
    const body = await readBody(req);
    const agentKey = body.agent;
    if (agentKey === null) {
      serverAgent = null;
      serverAgentKey = null;
      serverAgentTools = null;
    } else {
      const agents = loadAgents();
      if (agents[agentKey]) {
        serverAgent = agents[agentKey];
        serverAgentKey = agentKey;
        const toolMap = { read: 'READ', write: 'WRITE', edit: 'PATCH', patch: 'PATCH', list: 'LIST', search: 'SEARCH', shell: 'SHELL', mkdir: 'MKDIR' };
        serverAgentTools = serverAgent.tools
          ? (Array.isArray(serverAgent.tools) ? serverAgent.tools : [serverAgent.tools])
              .map(t => toolMap[t.toLowerCase()] || t.toUpperCase()).filter(Boolean)
          : null;
      }
    }
    resetChat();
    json(res, { ok: true });
    return;
  }

  // ── API: clear chat ──
  if (req.method === 'POST' && url.pathname === '/api/clear') {
    resetChat();
    currentSessionId = null;
    json(res, { ok: true });
    return;
  }

  // ── API: stop generation ──
  if (req.method === 'POST' && url.pathname === '/api/stop') {
    abortFlag = true;
    json(res, { ok: true });
    return;
  }

  // ── API: chat (SSE streaming) ──
  if (req.method === 'POST' && url.pathname === '/api/chat') {
    const body = await readBody(req);
    const userMsg = body.message;
    if (!userMsg) { json(res, { error: 'No message' }, 400); return; }
    if (!serverModel) { json(res, { error: 'No model selected' }, 400); return; }

    if (serverMessages.length === 0) resetChat();
    serverMessages.push({ role: 'user', content: userMsg });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    try {
      const stream = chatStream(serverMessages, serverModel, serverAgentTools);
      let clientClosed = false;
      res.on('close', () => { clientClosed = true; });
      for await (const evt of stream) {
        if (clientClosed) break;
        const ok = res.write(`data: ${JSON.stringify(evt)}\n\n`);
        if (!ok && !clientClosed) await new Promise(r => {
          res.once('drain', r);
          res.once('close', r);
        });
      }
    } catch (e) {
      try { res.write(`data: ${JSON.stringify({ type: 'system', data: 'Error: ' + e.message })}\n\n`); } catch {}
    }
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  // ── 404 ──
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

// ─── Launch ────────────────────────────────────────────────

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  ⚡ Sapper UI running at ${url}\n`);

  const browsers = [
    ['open', ['-na', 'Google Chrome', '--args', `--app=${url}`, '--new-window']],
    ['open', ['-na', 'Microsoft Edge', '--args', `--app=${url}`]],
    ['open', ['-na', 'Brave Browser', '--args', `--app=${url}`]],
    ['open', [url]],
  ];

  let opened = false;
  for (const [cmd, args] of browsers) {
    if (opened) break;
    try {
      const proc = spawn(cmd, args, { stdio: 'ignore', detached: true });
      proc.unref();
      proc.on('error', () => {});
      opened = true;
    } catch {}
  }
  if (!opened) console.log(`  Open manually: ${url}`);
});
