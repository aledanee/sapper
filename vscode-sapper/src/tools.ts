import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import { recallMemory, appendLongMemory } from './memory';

const IGNORE_DIRS = new Set(['node_modules', '.git', '.sapper', '__pycache__', '.next', 'dist', 'build', '.cache']);

// ── Ignore pattern helpers ──────────────────────────────────────

interface IgnoreEntry { pattern: string; negate: boolean }

function loadIgnorePatterns(workingDir: string): IgnoreEntry[] {
  const patterns: IgnoreEntry[] = [];
  const ignorePath = path.join(workingDir, '.sapperignore');
  try {
    if (fs.existsSync(ignorePath)) {
      for (const rawLine of fs.readFileSync(ignorePath, 'utf8').split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) { continue; }
        const negate = line.startsWith('!');
        patterns.push({ pattern: negate ? line.slice(1) : line, negate });
      }
    }
  } catch (_) { /* silent */ }
  return patterns;
}

function patternToRegex(pattern: string): RegExp {
  let p = pattern.replace(/\/+$/, '');
  p = p.replace(/([.+^${}()|[\]\\])/g, '\\$1');
  p = p.replace(/\*\*/g, '<<<G>>>');
  p = p.replace(/\*/g, '[^/]*');
  p = p.replace(/<<<G>>>/g, '.*');
  p = p.replace(/\?/g, '[^/]');
  return new RegExp(`(^|/)${p}($|/)`, 'i');
}

function shouldIgnore(nameOrPath: string, patterns: IgnoreEntry[]): boolean {
  const base = nameOrPath.includes('/') ? nameOrPath.split('/').pop()! : nameOrPath;
  if (IGNORE_DIRS.has(base)) { return true; }
  let ignored = false;
  for (const { pattern, negate } of patterns) {
    const re = patternToRegex(pattern);
    if (re.test(nameOrPath) || re.test(base)) { ignored = !negate; }
  }
  return ignored;
}

function safePath(workingDir: string, p: string): string | null {
  const resolved = path.resolve(workingDir, p || '.');
  return resolved.startsWith(workingDir) ? resolved : null;
}

// ── Tool implementations ────────────────────────────────────────

export function toolList(workingDir: string, p: string): string {
  try {
    const patterns = loadIgnorePatterns(workingDir);
    let dir = path.resolve(workingDir, p.trim() || '.');
    if (dir === '/') { dir = workingDir; }
    const entries = fs.readdirSync(dir);
    return entries.filter((e) => !shouldIgnore(e, patterns) && !e.startsWith('.')).join('\n') || '(empty)';
  } catch (e: any) { return `Error: ${e.message}`; }
}

export function toolLs(workingDir: string, p: string): string {
  try {
    const patterns = loadIgnorePatterns(workingDir);
    const dir = path.resolve(workingDir, p.trim() || '.');
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries.filter((e) => !shouldIgnore(e.name, patterns)).map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join('\n') || '(empty)';
  } catch (e: any) { return `Error: ${e.message}`; }
}

export function toolRead(workingDir: string, p: string, maxSize = 100000): string {
  try {
    const resolved = safePath(workingDir, p.trim());
    if (!resolved) { return 'Error: Path outside working directory.'; }
    const stat = fs.statSync(resolved);
    if (stat.size > maxSize) { return `Error: File too large (${stat.size} bytes > ${maxSize} limit). Use HEAD to preview.`; }
    return fs.readFileSync(resolved, 'utf8');
  } catch (e: any) { return `Error: ${e.message}`; }
}

export function toolCat(workingDir: string, p: string): string {
  return toolRead(workingDir, p);
}

export function toolHead(workingDir: string, p: string, lines = 50): string {
  try {
    const resolved = safePath(workingDir, p.trim());
    if (!resolved) { return 'Error: Path outside working directory.'; }
    const content = fs.readFileSync(resolved, 'utf8');
    return content.split('\n').slice(0, lines).join('\n');
  } catch (e: any) { return `Error: ${e.message}`; }
}

export function toolTail(workingDir: string, p: string, lines = 50): string {
  try {
    const resolved = safePath(workingDir, p.trim());
    if (!resolved) { return 'Error: Path outside working directory.'; }
    const content = fs.readFileSync(resolved, 'utf8');
    return content.split('\n').slice(-lines).join('\n');
  } catch (e: any) { return `Error: ${e.message}`; }
}

export async function toolWrite(workingDir: string, p: string, content: string): Promise<string> {
  try {
    const resolved = safePath(workingDir, p.trim());
    if (!resolved) { return 'Error: Path outside working directory.'; }
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content);
    return `Successfully saved ${p.trim()}`;
  } catch (e: any) { return `Error: ${e.message}`; }
}

export async function toolPatch(workingDir: string, p: string, oldText: string, newText: string): Promise<string> {
  const resolved = safePath(workingDir, p.trim());
  if (!resolved) { return 'Error: Path outside working directory.'; }
  try {
    const content = fs.readFileSync(resolved, 'utf8');
    const lineMatch = oldText.match(/^LINE:(\d+)$/);
    if (lineMatch) {
      const n = parseInt(lineMatch[1], 10);
      const lines = content.split('\n');
      if (n < 1 || n > lines.length) { return `Error: Line ${n} out of range (${lines.length} lines)`; }
      lines[n - 1] = newText;
      fs.writeFileSync(resolved, lines.join('\n'));
      return `Patched line ${n}`;
    }
    if (content.includes(oldText)) {
      fs.writeFileSync(resolved, content.replace(oldText, newText));
      return `Successfully patched ${p.trim()}`;
    }
    if (content.includes(oldText.trim())) {
      fs.writeFileSync(resolved, content.replace(oldText.trim(), newText.trim()));
      return `Successfully patched ${p.trim()} (trimmed match)`;
    }
    const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
    const normOld = normalize(oldText);
    const fileLines = content.split('\n');
    const oldLines = oldText.trim().split('\n');
    for (let i = 0; i <= fileLines.length - oldLines.length; i++) {
      const win = fileLines.slice(i, i + oldLines.length).join('\n');
      if (normalize(win) === normOld) {
        fs.writeFileSync(resolved, content.replace(win, newText.trim()));
        return `Successfully patched ${p.trim()} (fuzzy match at line ${i + 1})`;
      }
    }
    return `Error: Text not found in ${p.trim()}. Use LINE:number mode.`;
  } catch (e: any) { return `Error: ${e.message}`; }
}

export function toolMkdir(workingDir: string, p: string): string {
  try {
    const resolved = safePath(workingDir, p.trim());
    if (!resolved) { return 'Error: Path outside working directory.'; }
    fs.mkdirSync(resolved, { recursive: true });
    return `Created ${p}`;
  } catch (e: any) { return `Error: ${e.message}`; }
}

export async function toolRmdir(workingDir: string, p: string): Promise<string> {
  try {
    const resolved = safePath(workingDir, p.trim());
    if (!resolved) { return 'Error: Path outside working directory.'; }
    fs.rmSync(resolved, { recursive: true, force: true });
    return `Removed ${p}`;
  } catch (e: any) { return `Error: ${e.message}`; }
}

export function toolPwd(workingDir: string): string {
  return workingDir;
}

export function toolFind(workingDir: string, pattern: string, dirPath?: string): string {
  const patterns = loadIgnorePatterns(workingDir);
  const results: string[] = [];
  const base = safePath(workingDir, dirPath?.trim() || '.') || workingDir;
  const re = new RegExp(pattern.replace(/\*/g, '.*').replace(/\?/g, '.'), 'i');

  function walk(dir: string, depth: number): void {
    if (depth > 8) { return; }
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = path.relative(workingDir, path.join(dir, entry.name));
        if (shouldIgnore(rel, patterns)) { continue; }
        if (re.test(entry.name)) { results.push(rel); }
        if (entry.isDirectory()) { walk(path.join(dir, entry.name), depth + 1); }
        if (results.length >= 100) { return; }
      }
    } catch (_) { /* skip unreadable */ }
  }
  walk(base, 0);
  return results.length > 0 ? results.join('\n') : `No matches for: ${pattern}`;
}

export function toolSearch(workingDir: string, pattern: string): Promise<string> {
  return new Promise((resolve) => {
    const patterns = loadIgnorePatterns(workingDir);
    const allIgnoreDirs = new Set(IGNORE_DIRS);
    for (const { pattern: p, negate } of patterns) {
      if (!negate && p.endsWith('/')) { allIgnoreDirs.add(p.replace(/\/+$/, '')); }
    }
    const args = ['-rEin', '--max-count=3', pattern, '.'];
    for (const dir of allIgnoreDirs) { args.push(`--exclude-dir=${dir}`); }
    args.push('--include=*.{js,ts,jsx,tsx,py,java,go,rs,rb,php,c,cpp,h,css,scss,html,json,md,txt,yml,yaml,toml,sh}');
    const proc = child_process.spawn('grep', args, { cwd: workingDir });
    let out = '';
    let lineCount = 0;
    proc.stdout.on('data', (d: Buffer) => {
      const text = d.toString();
      for (const line of text.split('\n')) {
        if (lineCount >= 50) { proc.kill(); return; }
        if (line) { out += line + '\n'; lineCount++; }
      }
    });
    proc.stderr.on('data', () => { /* silent */ });
    proc.on('error', (err) => resolve(`Error searching: ${err.message}`));
    proc.on('close', () => resolve(out.trim() || `No matches for: ${pattern}`));
  });
}

export function toolGrep(workingDir: string, pattern: string): Promise<string> {
  return toolSearch(workingDir, pattern);
}

export function toolChanges(workingDir: string): Promise<string> {
  return new Promise((resolve) => {
    const proc = child_process.spawn('git', ['status', '--short', '--branch'], { cwd: workingDir });
    let out = '';
    proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { out += d.toString(); });
    proc.on('error', (e) => resolve(`Error: ${e.message}`));
    proc.on('close', () => {
      if (!out.trim()) { resolve('No git changes.'); return; }
      const diffProc = child_process.spawn('git', ['diff', '--stat'], { cwd: workingDir });
      let diff = '';
      diffProc.stdout.on('data', (d: Buffer) => { diff += d.toString(); });
      diffProc.on('close', () => resolve(`${out.trim()}\n\n${diff.trim()}`.trim()));
      diffProc.on('error', () => resolve(out.trim()));
    });
  });
}

export function toolShell(
  workingDir: string,
  cmd: string,
  onChunk?: (chunk: string) => void,
  timeout = 60000,
): Promise<string> {
  return new Promise((resolve) => {
    const proc = child_process.spawn('sh', ['-c', cmd], { cwd: workingDir });
    let out = '';
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve(out.trim() + '\n[Process timed out]');
    }, timeout);
    proc.stdout.on('data', (d: Buffer) => {
      const text = d.toString();
      out += text;
      if (onChunk) { onChunk(text); }
      if (out.length > 50000) { proc.kill('SIGTERM'); }
    });
    proc.stderr.on('data', (d: Buffer) => {
      const text = d.toString();
      out += text;
      if (onChunk) { onChunk(text); }
    });
    proc.on('error', (e) => { clearTimeout(timer); resolve(`Error: ${e.message}`); });
    proc.on('close', (code) => { clearTimeout(timer); resolve(`${out.trim()}\n[Exit code: ${code ?? '?'}]`); });
  });
}

export async function toolFetchWeb(url: string, maxChars = 50000): Promise<string> {
  try {
    const https = url.startsWith('https') ? await import('https') : await import('http');
    return new Promise((resolve) => {
      const req = (https as any).get(url, { headers: { 'User-Agent': 'Sapper/1.0' } }, (res: any) => {
        let data = '';
        res.on('data', (d: Buffer) => { data += d.toString(); if (data.length > maxChars) { req.destroy(); } });
        res.on('end', () => {
          const text = data.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          resolve(text.substring(0, maxChars) || '(empty response)');
        });
      });
      req.on('error', (e: any) => resolve(`Error fetching ${url}: ${e.message}`));
      req.setTimeout(15000, () => { req.destroy(); resolve(`Error: Request timed out for ${url}`); });
    });
  } catch (e: any) { return `Error: ${e.message}`; }
}

export function toolMemoryRecall(sapperDir: string, query: string): string {
  return recallMemory(sapperDir, query);
}

export function toolMemoryNote(sapperDir: string, note: string): string {
  appendLongMemory(sapperDir, note);
  return 'Memory note saved.';
}
