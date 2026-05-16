"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.toolList = toolList;
exports.toolLs = toolLs;
exports.toolRead = toolRead;
exports.toolCat = toolCat;
exports.toolHead = toolHead;
exports.toolTail = toolTail;
exports.toolWrite = toolWrite;
exports.toolPatch = toolPatch;
exports.toolMkdir = toolMkdir;
exports.toolRmdir = toolRmdir;
exports.toolPwd = toolPwd;
exports.toolFind = toolFind;
exports.toolSearch = toolSearch;
exports.toolGrep = toolGrep;
exports.toolChanges = toolChanges;
exports.toolShell = toolShell;
exports.toolFetchWeb = toolFetchWeb;
exports.toolMemoryRecall = toolMemoryRecall;
exports.toolMemoryNote = toolMemoryNote;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const child_process = __importStar(require("child_process"));
const memory_1 = require("./memory");
const IGNORE_DIRS = new Set(['node_modules', '.git', '.sapper', '__pycache__', '.next', 'dist', 'build', '.cache']);
function loadIgnorePatterns(workingDir) {
    const patterns = [];
    const ignorePath = path.join(workingDir, '.sapperignore');
    try {
        if (fs.existsSync(ignorePath)) {
            for (const rawLine of fs.readFileSync(ignorePath, 'utf8').split('\n')) {
                const line = rawLine.trim();
                if (!line || line.startsWith('#')) {
                    continue;
                }
                const negate = line.startsWith('!');
                patterns.push({ pattern: negate ? line.slice(1) : line, negate });
            }
        }
    }
    catch (_) { /* silent */ }
    return patterns;
}
function patternToRegex(pattern) {
    let p = pattern.replace(/\/+$/, '');
    p = p.replace(/([.+^${}()|[\]\\])/g, '\\$1');
    p = p.replace(/\*\*/g, '<<<G>>>');
    p = p.replace(/\*/g, '[^/]*');
    p = p.replace(/<<<G>>>/g, '.*');
    p = p.replace(/\?/g, '[^/]');
    return new RegExp(`(^|/)${p}($|/)`, 'i');
}
function shouldIgnore(nameOrPath, patterns) {
    const base = nameOrPath.includes('/') ? nameOrPath.split('/').pop() : nameOrPath;
    if (IGNORE_DIRS.has(base)) {
        return true;
    }
    let ignored = false;
    for (const { pattern, negate } of patterns) {
        const re = patternToRegex(pattern);
        if (re.test(nameOrPath) || re.test(base)) {
            ignored = !negate;
        }
    }
    return ignored;
}
function safePath(workingDir, p) {
    const resolved = path.resolve(workingDir, p || '.');
    return resolved.startsWith(workingDir) ? resolved : null;
}
// ── Tool implementations ────────────────────────────────────────
function toolList(workingDir, p) {
    try {
        const patterns = loadIgnorePatterns(workingDir);
        let dir = path.resolve(workingDir, p.trim() || '.');
        if (dir === '/') {
            dir = workingDir;
        }
        const entries = fs.readdirSync(dir);
        return entries.filter((e) => !shouldIgnore(e, patterns) && !e.startsWith('.')).join('\n') || '(empty)';
    }
    catch (e) {
        return `Error: ${e.message}`;
    }
}
function toolLs(workingDir, p) {
    try {
        const patterns = loadIgnorePatterns(workingDir);
        const dir = path.resolve(workingDir, p.trim() || '.');
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        return entries.filter((e) => !shouldIgnore(e.name, patterns)).map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join('\n') || '(empty)';
    }
    catch (e) {
        return `Error: ${e.message}`;
    }
}
function toolRead(workingDir, p, maxSize = 100000) {
    try {
        const resolved = safePath(workingDir, p.trim());
        if (!resolved) {
            return 'Error: Path outside working directory.';
        }
        const stat = fs.statSync(resolved);
        if (stat.size > maxSize) {
            return `Error: File too large (${stat.size} bytes > ${maxSize} limit). Use HEAD to preview.`;
        }
        return fs.readFileSync(resolved, 'utf8');
    }
    catch (e) {
        return `Error: ${e.message}`;
    }
}
function toolCat(workingDir, p) {
    return toolRead(workingDir, p);
}
function toolHead(workingDir, p, lines = 50) {
    try {
        const resolved = safePath(workingDir, p.trim());
        if (!resolved) {
            return 'Error: Path outside working directory.';
        }
        const content = fs.readFileSync(resolved, 'utf8');
        return content.split('\n').slice(0, lines).join('\n');
    }
    catch (e) {
        return `Error: ${e.message}`;
    }
}
function toolTail(workingDir, p, lines = 50) {
    try {
        const resolved = safePath(workingDir, p.trim());
        if (!resolved) {
            return 'Error: Path outside working directory.';
        }
        const content = fs.readFileSync(resolved, 'utf8');
        return content.split('\n').slice(-lines).join('\n');
    }
    catch (e) {
        return `Error: ${e.message}`;
    }
}
async function toolWrite(workingDir, p, content) {
    try {
        const resolved = safePath(workingDir, p.trim());
        if (!resolved) {
            return 'Error: Path outside working directory.';
        }
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, content);
        return `Successfully saved ${p.trim()}`;
    }
    catch (e) {
        return `Error: ${e.message}`;
    }
}
async function toolPatch(workingDir, p, oldText, newText) {
    const resolved = safePath(workingDir, p.trim());
    if (!resolved) {
        return 'Error: Path outside working directory.';
    }
    try {
        const content = fs.readFileSync(resolved, 'utf8');
        const lineMatch = oldText.match(/^LINE:(\d+)$/);
        if (lineMatch) {
            const n = parseInt(lineMatch[1], 10);
            const lines = content.split('\n');
            if (n < 1 || n > lines.length) {
                return `Error: Line ${n} out of range (${lines.length} lines)`;
            }
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
        const normalize = (s) => s.replace(/\s+/g, ' ').trim();
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
    }
    catch (e) {
        return `Error: ${e.message}`;
    }
}
function toolMkdir(workingDir, p) {
    try {
        const resolved = safePath(workingDir, p.trim());
        if (!resolved) {
            return 'Error: Path outside working directory.';
        }
        fs.mkdirSync(resolved, { recursive: true });
        return `Created ${p}`;
    }
    catch (e) {
        return `Error: ${e.message}`;
    }
}
async function toolRmdir(workingDir, p) {
    try {
        const resolved = safePath(workingDir, p.trim());
        if (!resolved) {
            return 'Error: Path outside working directory.';
        }
        fs.rmSync(resolved, { recursive: true, force: true });
        return `Removed ${p}`;
    }
    catch (e) {
        return `Error: ${e.message}`;
    }
}
function toolPwd(workingDir) {
    return workingDir;
}
function toolFind(workingDir, pattern, dirPath) {
    const patterns = loadIgnorePatterns(workingDir);
    const results = [];
    const base = safePath(workingDir, dirPath?.trim() || '.') || workingDir;
    const re = new RegExp(pattern.replace(/\*/g, '.*').replace(/\?/g, '.'), 'i');
    function walk(dir, depth) {
        if (depth > 8) {
            return;
        }
        try {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const rel = path.relative(workingDir, path.join(dir, entry.name));
                if (shouldIgnore(rel, patterns)) {
                    continue;
                }
                if (re.test(entry.name)) {
                    results.push(rel);
                }
                if (entry.isDirectory()) {
                    walk(path.join(dir, entry.name), depth + 1);
                }
                if (results.length >= 100) {
                    return;
                }
            }
        }
        catch (_) { /* skip unreadable */ }
    }
    walk(base, 0);
    return results.length > 0 ? results.join('\n') : `No matches for: ${pattern}`;
}
function toolSearch(workingDir, pattern) {
    return new Promise((resolve) => {
        const patterns = loadIgnorePatterns(workingDir);
        const allIgnoreDirs = new Set(IGNORE_DIRS);
        for (const { pattern: p, negate } of patterns) {
            if (!negate && p.endsWith('/')) {
                allIgnoreDirs.add(p.replace(/\/+$/, ''));
            }
        }
        const args = ['-rEin', '--max-count=3', pattern, '.'];
        for (const dir of allIgnoreDirs) {
            args.push(`--exclude-dir=${dir}`);
        }
        args.push('--include=*.{js,ts,jsx,tsx,py,java,go,rs,rb,php,c,cpp,h,css,scss,html,json,md,txt,yml,yaml,toml,sh}');
        const proc = child_process.spawn('grep', args, { cwd: workingDir });
        let out = '';
        let lineCount = 0;
        proc.stdout.on('data', (d) => {
            const text = d.toString();
            for (const line of text.split('\n')) {
                if (lineCount >= 50) {
                    proc.kill();
                    return;
                }
                if (line) {
                    out += line + '\n';
                    lineCount++;
                }
            }
        });
        proc.stderr.on('data', () => { });
        proc.on('error', (err) => resolve(`Error searching: ${err.message}`));
        proc.on('close', () => resolve(out.trim() || `No matches for: ${pattern}`));
    });
}
function toolGrep(workingDir, pattern) {
    return toolSearch(workingDir, pattern);
}
function toolChanges(workingDir) {
    return new Promise((resolve) => {
        const proc = child_process.spawn('git', ['status', '--short', '--branch'], { cwd: workingDir });
        let out = '';
        proc.stdout.on('data', (d) => { out += d.toString(); });
        proc.stderr.on('data', (d) => { out += d.toString(); });
        proc.on('error', (e) => resolve(`Error: ${e.message}`));
        proc.on('close', () => {
            if (!out.trim()) {
                resolve('No git changes.');
                return;
            }
            const diffProc = child_process.spawn('git', ['diff', '--stat'], { cwd: workingDir });
            let diff = '';
            diffProc.stdout.on('data', (d) => { diff += d.toString(); });
            diffProc.on('close', () => resolve(`${out.trim()}\n\n${diff.trim()}`.trim()));
            diffProc.on('error', () => resolve(out.trim()));
        });
    });
}
function toolShell(workingDir, cmd, onChunk, timeout = 60000) {
    return new Promise((resolve) => {
        const proc = child_process.spawn('sh', ['-c', cmd], { cwd: workingDir });
        let out = '';
        const timer = setTimeout(() => {
            proc.kill('SIGTERM');
            resolve(out.trim() + '\n[Process timed out]');
        }, timeout);
        proc.stdout.on('data', (d) => {
            const text = d.toString();
            out += text;
            if (onChunk) {
                onChunk(text);
            }
            if (out.length > 50000) {
                proc.kill('SIGTERM');
            }
        });
        proc.stderr.on('data', (d) => {
            const text = d.toString();
            out += text;
            if (onChunk) {
                onChunk(text);
            }
        });
        proc.on('error', (e) => { clearTimeout(timer); resolve(`Error: ${e.message}`); });
        proc.on('close', (code) => { clearTimeout(timer); resolve(`${out.trim()}\n[Exit code: ${code ?? '?'}]`); });
    });
}
async function toolFetchWeb(url, maxChars = 50000) {
    try {
        const https = url.startsWith('https') ? await Promise.resolve().then(() => __importStar(require('https'))) : await Promise.resolve().then(() => __importStar(require('http')));
        return new Promise((resolve) => {
            const req = https.get(url, { headers: { 'User-Agent': 'Sapper/1.0' } }, (res) => {
                let data = '';
                res.on('data', (d) => { data += d.toString(); if (data.length > maxChars) {
                    req.destroy();
                } });
                res.on('end', () => {
                    const text = data.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                        .replace(/<[^>]+>/g, ' ')
                        .replace(/\s+/g, ' ')
                        .trim();
                    resolve(text.substring(0, maxChars) || '(empty response)');
                });
            });
            req.on('error', (e) => resolve(`Error fetching ${url}: ${e.message}`));
            req.setTimeout(15000, () => { req.destroy(); resolve(`Error: Request timed out for ${url}`); });
        });
    }
    catch (e) {
        return `Error: ${e.message}`;
    }
}
function toolMemoryRecall(sapperDir, query) {
    return (0, memory_1.recallMemory)(sapperDir, query);
}
function toolMemoryNote(sapperDir, note) {
    (0, memory_1.appendLongMemory)(sapperDir, note);
    return 'Memory note saved.';
}
//# sourceMappingURL=tools.js.map