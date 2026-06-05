#!/usr/bin/env node
/**
 * Sapper Web — Runs the real sapper.mjs inside a browser terminal,
 * with a sidebar (Files / Config / Agents / Skills) and a document
 * viewer/editor that auto-refreshes when Sapper modifies a file.
 *
 *   Browser  <--WebSocket-->  Node  <--pty-->  sapper.mjs
 *           <--WebSocket-->  Node  <--fs.watch-->  workspace
 *           <--REST-->        Node  <--fs-->        files / config
 */

import http from 'http';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { dirname, join, resolve as pathResolve, relative, sep } from 'path';
import { spawn as ptySpawn } from 'node-pty';
import { WebSocketServer } from 'ws';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env.SAPPER_UI_PORT || '3777', 10);
const SAPPER_BIN = join(__dirname, 'sapper.mjs');
const workingDir = process.cwd();
const SAPPER_DIR = join(workingDir, '.sapper');
const CONFIG_FILE = join(SAPPER_DIR, 'config.json');
const AGENTS_DIR = join(SAPPER_DIR, 'agents');
const SKILLS_DIR = join(SAPPER_DIR, 'skills');

const IGNORE_NAMES = new Set([
  '.git', 'node_modules', '.next', 'dist', 'build', '.cache',
  '.DS_Store', '__pycache__', '.venv', 'venv',
]);

const DEBUG = !!process.env.SAPPER_UI_DEBUG;
const dbg = (...a) => { if (DEBUG) console.log('[ui]', ...a); };

// ─── Path safety ─────────────────────────────────────────────────

function safePath(p) {
  if (typeof p !== 'string') return null;
  const cleaned = p.replace(/^\/+/, '');
  const abs = pathResolve(workingDir, cleaned || '.');
  if (abs !== workingDir && !abs.startsWith(workingDir + sep)) return null;
  return abs;
}

function stripJSONC(src) {
  // Remove // line comments and /* ... */ block comments outside strings.
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '"' || c === "'") {
      const quote = c;
      out += c; i++;
      while (i < n) {
        const ch = src[i];
        out += ch; i++;
        if (ch === '\\' && i < n) { out += src[i]; i++; continue; }
        if (ch === quote) break;
      }
      continue;
    }
    if (c === '/' && c2 === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2; continue;
    }
    out += c; i++;
  }
  return out;
}

function readJSON(file, fallback = null) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    try { return JSON.parse(raw); }
    catch {
      const cleaned = stripJSONC(raw).replace(/,(\s*[}\]])/g, '$1'); // also tolerate trailing commas
      return JSON.parse(cleaned);
    }
  } catch { return fallback; }
}

function ensureDir(d) { try { fs.mkdirSync(d, { recursive: true }); } catch {} }

// ─── Markdown frontmatter (for agents/skills) ────────────────────

function parseFrontmatter(raw) {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    let k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (v.startsWith('[') && v.endsWith(']')) {
      v = v.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    }
    meta[k] = v;
  }
  return { meta, body: m[2] };
}

function listMdDir(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    const full = join(dir, f);
    try {
      const raw = fs.readFileSync(full, 'utf8');
      const { meta } = parseFrontmatter(raw);
      out.push({
        key: f.replace(/\.md$/, ''),
        file: f,
        name: meta.name || f.replace(/\.md$/, ''),
        description: meta.description || '',
        path: relative(workingDir, full),
      });
    } catch {}
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ─── HTML page ───────────────────────────────────────────────────

function buildHTML() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Sapper</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.min.css" />
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/github-dark.min.css" />
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/codemirror@5.65.16/lib/codemirror.min.css" />
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/codemirror@5.65.16/theme/material-darker.min.css" />
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/codemirror@5.65.16/addon/dialog/dialog.min.css" />
<style>
  :root {
    --bg: #0a0e14;
    --panel: #0d1117;
    --panel2: #11161d;
    --border: #21262d;
    --border2: #30363d;
    --fg: #e6edf3;
    --muted: #8b949e;
    --dim: #6e7681;
    --accent: #58a6ff;
    --accent2: #79c0ff;
    --green: #3fb950;
    --red: #f85149;
    --yellow: #d29922;
    --purple: #bc8cff;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; width: 100%; max-width: 100vw; overflow: hidden;
    background: var(--bg); color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif; }
  button { font-family: inherit; }

  #app { display: flex; flex-direction: column; height: 100vh; width: 100vw;
    max-width: 100vw; overflow: hidden; }

  /* ─── Top bar ─── */
  #bar {
    height: 38px; flex-shrink: 0; display: flex; align-items: center;
    padding: 0 12px; gap: 10px;
    background: var(--panel); border-bottom: 1px solid var(--border);
    font-size: 12px;
  }
  #bar .title { font-weight: 700; letter-spacing: .3px; user-select: none; }
  #bar .title span { color: var(--accent); }
  #bar .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); transition: background .2s; }
  #bar .dot.on { background: var(--green); }
  #bar .dot.err { background: var(--red); }
  #bar .cwd { color: var(--muted); font-family: ui-monospace, 'SF Mono', monospace;
    font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 35vw; }
  #bar .spacer { flex: 1; }
  #bar button {
    background: transparent; color: var(--muted); border: 1px solid var(--border);
    border-radius: 6px; padding: 4px 10px; font-size: 11px; cursor: pointer;
    transition: all .12s;
  }
  #bar button:hover { color: var(--accent); border-color: var(--accent); }
  #bar button.toggle.on { color: var(--accent); border-color: var(--accent); background: rgba(88,166,255,.08); }

  /* live system stats */
  #stats { display: grid; grid-template-columns: auto auto auto; gap: 4px 10px;
    align-items: center; padding: 4px 10px; margin: 0 8px;
    background: var(--panel2); border: 1px solid var(--border); border-radius: 6px;
    font-family: ui-monospace, 'SF Mono', monospace; font-size: 10px; line-height: 1; }
  #stats .srow { display: contents; }
  #stats .slbl { color: var(--dim); font-size: 9px; letter-spacing: .5px; min-width: 22px; }
  #stats .sbar { width: 60px; height: 5px; background: var(--bg); border-radius: 3px;
    overflow: hidden; }
  #stats .sbar i { display: block; height: 100%; width: 0%;
    background: linear-gradient(90deg, var(--green), var(--accent));
    transition: width .35s ease, background .25s; }
  #stats .sbar i.warn { background: linear-gradient(90deg, var(--yellow), #ff9b3f); }
  #stats .sbar i.crit { background: linear-gradient(90deg, #ff7b72, var(--red)); }
  #stats .sval { color: var(--fg); min-width: 60px; text-align: right; font-variant-numeric: tabular-nums; }
  @media (max-width: 1100px) {
    #stats .sbar { width: 40px; }
    #stats .sval { min-width: 48px; font-size: 9px; }
    #bar .cwd { display: none; }
  }
  @media (max-width: 820px) { #stats { display: none; } }

  /* ─── Body layout ─── */
  #body { flex: 1; min-height: 0; min-width: 0; display: flex; overflow: hidden; }

  /* ─── Sidebar ─── */
  #side {
    width: 280px; flex-shrink: 0; display: flex; flex-direction: column;
    background: var(--panel); border-right: 1px solid var(--border);
    min-width: 0; overflow: hidden;
  }
  #side.hidden { display: none; }
  .tabs { display: flex; border-bottom: 1px solid var(--border); flex-shrink: 0; }
  .tabs button {
    flex: 1; padding: 8px 4px; background: none; border: none;
    border-bottom: 2px solid transparent; color: var(--dim); font-size: 11px;
    font-weight: 600; cursor: pointer; text-transform: uppercase; letter-spacing: .5px;
  }
  .tabs button:hover { color: var(--muted); }
  .tabs button.active { color: var(--accent); border-bottom-color: var(--accent); }
  .pane { flex: 1; min-height: 0; min-width: 0; overflow-x: hidden; overflow-y: auto; display: none; padding: 6px 0; }
  .pane.active { display: block; }
  .pane::-webkit-scrollbar { width: 6px; }
  .pane::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 3px; }

  /* Files tree */
  .files-toolbar { display: flex; align-items: center; gap: 4px; padding: 6px 8px;
    border-bottom: 1px solid var(--border); background: var(--panel); }
  .files-toolbar .ftb-spacer { flex: 1; }
  .files-toolbar .ftb { background: transparent; color: var(--muted); border: 1px solid transparent;
    border-radius: 4px; padding: 3px 7px; font-size: 13px; cursor: pointer; line-height: 1;
    position: relative; }
  .files-toolbar .ftb sup { font-size: 9px; color: var(--green); margin-left: 1px; }
  .files-toolbar .ftb:hover { background: rgba(255,255,255,.05); color: var(--fg); border-color: var(--border); }
  .files-toolbar .ftb.on { color: var(--accent); border-color: var(--accent); background: rgba(88,166,255,.08); }

  /* Activity feed */
  #activityPanel { display: none; border-bottom: 1px solid var(--border);
    background: var(--panel2); max-height: 180px; overflow-y: auto;
    font-family: ui-monospace, 'SF Mono', monospace; font-size: 11px; }
  #activityPanel.on { display: block; }
  #activityPanel .ah { display: flex; align-items: center; padding: 5px 10px;
    border-bottom: 1px solid var(--border); color: var(--dim); font-size: 10px;
    text-transform: uppercase; letter-spacing: .5px; position: sticky; top: 0;
    background: var(--panel2); z-index: 1; }
  #activityPanel .ah .acl { margin-left: auto; color: var(--accent); cursor: pointer;
    text-transform: none; letter-spacing: 0; font-size: 10px; }
  #activityPanel .ai { display: flex; align-items: center; gap: 6px; padding: 4px 10px;
    color: var(--muted); cursor: pointer; border-left: 2px solid transparent; }
  #activityPanel .ai:hover { background: rgba(255,255,255,.04); color: var(--fg); }
  #activityPanel .ai .ak { font-size: 9px; text-transform: uppercase; letter-spacing: .5px;
    width: 56px; flex-shrink: 0; font-weight: 600; }
  #activityPanel .ai .ap { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #activityPanel .ai .at { color: var(--dim); font-size: 9px; flex-shrink: 0; }
  #activityPanel .ai.kind-created { border-left-color: var(--green); }
  #activityPanel .ai.kind-modified { border-left-color: var(--yellow); }
  #activityPanel .ai.kind-deleted { border-left-color: var(--red); }
  #activityPanel .ai.kind-created .ak { color: var(--green); }
  #activityPanel .ai.kind-modified .ak { color: var(--yellow); }
  #activityPanel .ai.kind-deleted .ak { color: var(--red); }
  #activityPanel .ai .acts { display: none; gap: 4px; flex-shrink: 0; }
  #activityPanel .ai:hover .acts { display: inline-flex; }
  #activityPanel .ai .ab { background: transparent; border: 1px solid var(--border2);
    color: var(--muted); border-radius: 3px; padding: 1px 5px; font-size: 10px; cursor: pointer;
    line-height: 1.2; font-family: inherit; }
  #activityPanel .ai .ab:hover { color: var(--accent); border-color: var(--accent); }
  #activityPanel .ai .ab.danger:hover { color: var(--red); border-color: var(--red); }
  #activityPanel .note { padding: 2px 10px 6px 76px; color: var(--accent2);
    font-style: italic; font-size: 11px; white-space: pre-wrap; word-break: break-word; }
  #activityPanel .note:before { content: '💬  '; margin-right: 2px; font-style: normal; }
  #activityPanel .empty { padding: 12px; color: var(--dim); text-align: center; font-size: 11px; }

  /* Index tray — multi-select files/folders to send into chat */
  #indexPanel { display: none; border-bottom: 1px solid var(--border);
    background: linear-gradient(180deg, rgba(88,166,255,.08), rgba(88,166,255,.02));
    font-family: ui-monospace, 'SF Mono', monospace; font-size: 11px; }
  #indexPanel.on { display: block; }
  #indexPanel .ih { display: flex; align-items: center; gap: 6px; padding: 5px 10px;
    border-bottom: 1px solid var(--border); color: var(--accent); font-size: 10px;
    text-transform: uppercase; letter-spacing: .5px; }
  #indexPanel .ih .icnt { color: var(--muted); text-transform: none; letter-spacing: 0; }
  #indexPanel .ih .iact { margin-left: auto; display: inline-flex; gap: 4px; }
  #indexPanel .ih .iact button { background: transparent; color: var(--accent);
    border: 1px solid var(--border2); border-radius: 3px; padding: 1px 7px; font-size: 10px;
    cursor: pointer; font-family: inherit; line-height: 1.3; }
  #indexPanel .ih .iact button:hover { border-color: var(--accent); }
  #indexPanel .ih .iact button.primary { color: #fff; background: var(--accent); border-color: var(--accent); }
  #indexPanel .ih .iact button.primary:hover { background: var(--accent2); border-color: var(--accent2); }
  #indexPanel .ih .iact button.danger { color: var(--muted); }
  #indexPanel .ih .iact button.danger:hover { color: var(--red); border-color: var(--red); }
  #indexPanel .chips { display: flex; flex-wrap: wrap; gap: 4px; padding: 6px 10px 4px;
    max-height: 110px; overflow-y: auto; }
  #indexPanel .chip { display: inline-flex; align-items: center; gap: 4px;
    background: rgba(88,166,255,.12); border: 1px solid rgba(88,166,255,.3);
    border-radius: 10px; padding: 1px 4px 1px 8px; font-size: 10px; color: var(--fg); }
  #indexPanel .chip.dir { background: rgba(210,153,34,.12); border-color: rgba(210,153,34,.3); }
  #indexPanel .chip .cp { max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #indexPanel .chip .cx { cursor: pointer; opacity: .55; padding: 0 3px; font-size: 12px; }
  #indexPanel .chip .cx:hover { opacity: 1; color: var(--red); }
  #indexPanel .empty { padding: 8px 10px; color: var(--dim); font-style: italic; }
  #indexPanel .icmt { display: block; margin: 4px 10px 8px; width: calc(100% - 20px);
    box-sizing: border-box; background: var(--panel); color: var(--fg);
    border: 1px solid var(--border2); border-radius: 4px; padding: 4px 6px;
    font-size: 11px; font-family: inherit; resize: vertical; min-height: 26px; max-height: 80px; }
  #indexPanel .icmt:focus { outline: none; border-color: var(--accent); }
  /* Per-row index checkbox (visible only when index mode is on) */
  .row .chk { display: none; width: 12px; flex-shrink: 0; color: var(--dim);
    text-align: center; font-size: 11px; line-height: 1; }
  body.indexmode .row .chk { display: inline-block; cursor: pointer; }
  body.indexmode .row .chk:hover { color: var(--accent); }
  .row .chk.on { color: var(--accent); }
  .ftb.on { color: var(--accent); }
  .tree { font-family: ui-monospace, 'SF Mono', monospace; font-size: 12px; padding-bottom: 12px; }
  .row { display: flex; align-items: center; gap: 4px; padding: 3px 8px; cursor: pointer; color: var(--muted);
    white-space: nowrap; user-select: none; position: relative; }
  .row:hover { background: rgba(255,255,255,.04); color: var(--fg); }
  .row.active { background: rgba(88,166,255,.12); color: var(--accent); }
  .row .chev { width: 12px; display: inline-block; color: var(--dim); font-size: 9px; flex-shrink: 0; text-align: center; }
  .row .ico { width: 14px; flex-shrink: 0; }
  .row .name { overflow: hidden; text-overflow: ellipsis; }
  .row .badge { margin-left: auto; font-size: 9px; color: var(--yellow); opacity: 0; transition: opacity .2s; }
  .row.changed .badge { opacity: 1; }
  .row .actdot { display: none; width: 7px; height: 7px; border-radius: 50%;
    margin-left: 4px; flex-shrink: 0; box-shadow: 0 0 6px currentColor; }
  .row.act-created .actdot { display: inline-block; background: var(--green); color: var(--green); }
  .row.act-modified .actdot { display: inline-block; background: var(--yellow); color: var(--yellow); }
  .row.act-deleted .actdot { display: inline-block; background: var(--red); color: var(--red); }
  .row.act-fresh .actdot { animation: pulse 1.4s ease-out 2; }
  .row.act-created .name { color: #56d364; }
  .row.act-modified .name { color: #e3b341; }
  .row.act-deleted .name { color: #ffa198; text-decoration: line-through; opacity: .7; }
  @keyframes pulse { 0%{transform:scale(1);} 50%{transform:scale(1.6);} 100%{transform:scale(1);} }
  .row .actcount { display: none; font-size: 9px; color: var(--dim);
    font-family: ui-monospace, monospace; margin-left: 2px; }
  .row.act-multi .actcount { display: inline-block; }
  .row .rmenu { margin-left: auto; color: var(--dim); font-size: 14px; padding: 0 4px;
    opacity: 0; flex-shrink: 0; line-height: 1; border-radius: 3px; }
  .row.changed .rmenu { margin-left: 4px; }
  .row:hover .rmenu, .row .rmenu.open { opacity: 1; }
  .row .rmenu:hover { color: var(--fg); background: rgba(255,255,255,.08); }

  /* Context menu */
  .ctx-menu { position: fixed; z-index: 9999; min-width: 180px;
    background: var(--panel2); border: 1px solid var(--border); border-radius: 6px;
    padding: 4px 0; box-shadow: 0 8px 24px rgba(0,0,0,.5); font-size: 12px;
    color: var(--fg); font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
  .ctx-menu .ci { padding: 6px 14px; cursor: pointer; display: flex; align-items: center;
    gap: 10px; color: var(--muted); }
  .ctx-menu .ci:hover { background: rgba(88,166,255,.12); color: var(--accent); }
  .ctx-menu .ci.danger:hover { background: rgba(248,81,73,.15); color: var(--red); }
  .ctx-menu .ci .k { margin-left: auto; color: var(--dim); font-size: 10px; }
  .ctx-menu .sep { height: 1px; background: var(--border); margin: 4px 0; }

  /* Modal */
  .modal-bd { position: fixed; inset: 0; background: rgba(0,0,0,.55); z-index: 10000;
    display: flex; align-items: center; justify-content: center; }
  .modal { background: var(--panel2); border: 1px solid var(--border); border-radius: 8px;
    padding: 18px 18px 14px; width: 460px; max-width: 92vw;
    font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
  .modal h3 { margin: 0 0 12px; font-size: 14px; color: var(--fg); font-weight: 600; }
  .modal label { display: block; font-size: 11px; color: var(--dim); margin: 8px 0 4px;
    text-transform: uppercase; letter-spacing: .5px; }
  .modal input[type=text] { width: 100%; box-sizing: border-box; background: var(--bg);
    color: var(--fg); border: 1px solid var(--border); border-radius: 4px;
    padding: 7px 9px; font-family: ui-monospace, 'SF Mono', monospace; font-size: 12px; outline: none; }
  .modal input[type=text]:focus { border-color: var(--accent); }
  .modal .hint { font-size: 11px; color: var(--dim); margin-top: 4px; }
  .modal .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; }
  .modal .actions button { background: transparent; color: var(--muted); border: 1px solid var(--border);
    border-radius: 5px; padding: 6px 14px; font-size: 12px; cursor: pointer; }
  .modal .actions button:hover { color: var(--fg); border-color: var(--accent); }
  .modal .actions button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
  .modal .actions button.primary:hover { filter: brightness(1.1); }
  .modal .actions button.danger { background: var(--red); color: #fff; border-color: var(--red); }

  /* Config / Agents / Skills lists */
  .pane-section { padding: 10px 14px; }
  .pane-section h4 { font-size: 11px; color: var(--dim); text-transform: uppercase;
    letter-spacing: .5px; margin: 0 0 8px; font-weight: 600; }
  .pane-section p { font-size: 12px; color: var(--muted); margin: 4px 0 12px; line-height: 1.4; }
  .pane-section label { display: block; font-size: 11px; color: var(--muted); margin: 8px 0 4px; font-weight: 500; }
  .pane-section input[type=text], .pane-section input[type=number], .pane-section select {
    width: 100%; background: var(--panel2); border: 1px solid var(--border2); border-radius: 5px;
    padding: 5px 8px; color: var(--fg); font-size: 12px; outline: none; font-family: inherit;
  }
  .pane-section input:focus, .pane-section select:focus { border-color: var(--accent); }
  .pane-section .toggle-row { display: flex; align-items: center; justify-content: space-between;
    padding: 6px 0; border-bottom: 1px solid var(--border); }
  .pane-section .toggle-row span { font-size: 12px; color: var(--muted); }
  .switch { position: relative; width: 30px; height: 16px; background: var(--border2); border-radius: 8px;
    cursor: pointer; transition: background .15s; flex-shrink: 0; }
  .switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px;
    background: var(--muted); border-radius: 50%; transition: all .15s; }
  .switch.on { background: var(--accent); }
  .switch.on::after { background: white; left: 16px; }

  .json-edit {
    width: 100%; max-width: 100%; height: 320px; background: var(--bg);
    border: 1px solid var(--border2); border-radius: 6px; padding: 8px 10px; color: var(--fg);
    font-family: ui-monospace, 'SF Mono', monospace; font-size: 11px; line-height: 1.45;
    resize: vertical; outline: none; display: block;
    white-space: pre; overflow: auto;
  }
  .json-edit:focus { border-color: var(--accent); }
  .row-btns { display: flex; gap: 6px; margin-top: 8px; }
  .row-btns button {
    flex: 1; padding: 6px 10px; border-radius: 5px; border: 1px solid var(--border2);
    background: var(--panel2); color: var(--muted); font-size: 11px; cursor: pointer;
    transition: all .12s;
  }
  .row-btns button:hover { color: var(--accent); border-color: var(--accent); }
  .row-btns button.primary { background: var(--accent); color: white; border-color: var(--accent); }
  .row-btns button.primary:hover { background: var(--accent2); }
  .row-btns button.danger:hover { color: var(--red); border-color: var(--red); }

  .item { padding: 8px 14px; cursor: pointer; border-left: 2px solid transparent; }
  .item:hover { background: rgba(255,255,255,.03); border-left-color: var(--border2); }
  .item .ti { font-size: 13px; color: var(--fg); display: flex; align-items: center; gap: 6px; }
  .item .ti .b { background: var(--accent); color: white; font-size: 9px; padding: 1px 5px;
    border-radius: 8px; text-transform: uppercase; letter-spacing: .3px; }
  .item .ds { font-size: 11px; color: var(--dim); margin-top: 2px; line-height: 1.35; }

  /* ─── Terminal area ─── */
  #center { flex: 1; min-width: 0; min-height: 0; display: flex;
    flex-direction: column; background: var(--bg); overflow: hidden; position: relative; }
  #qa { display: flex; align-items: center; gap: 6px; padding: 6px 10px;
    background: var(--panel2); border-bottom: 1px solid var(--border); flex-shrink: 0; }
  #qa .qabtn { background: transparent; color: var(--muted); border: 1px solid var(--border);
    border-radius: 5px; padding: 4px 10px; font-size: 11px; cursor: pointer;
    display: inline-flex; align-items: center; gap: 5px; font-family: inherit; line-height: 1; }
  #qa .qabtn:hover { color: var(--accent); border-color: var(--accent); }
  #qa .qabtn .qaico { font-size: 13px; }
  #qa .qabtn.rec.on { color: var(--red); border-color: var(--red); background: rgba(248,81,73,.08); }
  #qa .qa-sp { flex: 1; }
  #qa .rec-dot { display: none; width: 8px; height: 8px; border-radius: 50%;
    background: var(--red); animation: blink 1s infinite; }
  #qa .rec-dot.on { display: inline-block; }
  #qa .rec-time { display: none; font-family: ui-monospace, 'SF Mono', monospace;
    font-size: 11px; color: var(--red); font-variant-numeric: tabular-nums; }
  #qa .rec-time.on { display: inline-block; }
  @keyframes blink { 0%,100%{opacity:1;} 50%{opacity:.3;} }

  #term-wrap { flex: 1; min-height: 0; min-width: 0; padding: 6px 0 0 10px;
    overflow: hidden; position: relative; }
  #term-wrap .terminal, #term-wrap .xterm { height: 100% !important; width: 100% !important; }
  .xterm-screen, .xterm-viewport { max-width: 100% !important; }
  .xterm .xterm-viewport { background-color: var(--bg) !important; }
  .xterm-viewport::-webkit-scrollbar { width: 8px; }
  .xterm-viewport::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 4px; }
  .xterm-viewport::-webkit-scrollbar-track { background: transparent; }

  /* drag-drop overlay */
  #dropOverlay { position: absolute; inset: 0; display: none; z-index: 200;
    background: rgba(10,14,20,.85); align-items: center; justify-content: center;
    border: 2px dashed var(--accent); pointer-events: none; }
  #dropOverlay.on { display: flex; }
  #dropOverlay .drop-card { text-align: center; }
  #dropOverlay .drop-icon { font-size: 48px; margin-bottom: 8px; }
  #dropOverlay .drop-text { color: var(--accent); font-size: 16px; font-weight: 600; }
  #dropOverlay .drop-text span { color: var(--muted); font-weight: 400; font-size: 12px; }

  /* ─── Preview panel ─── */
  #preview {
    width: 480px; flex-shrink: 0; display: flex; flex-direction: column;
    background: var(--panel); border-left: 1px solid var(--border);
    min-width: 0; overflow: hidden;
  }
  #preview.hidden { display: none; }
  #preview .ph {
    display: flex; align-items: center; gap: 8px; padding: 8px 12px;
    background: var(--panel2); border-bottom: 1px solid var(--border); flex-shrink: 0;
  }
  #preview .ph .pp { flex: 1; font-family: ui-monospace, 'SF Mono', monospace;
    font-size: 11px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #preview .ph button {
    background: transparent; color: var(--muted); border: 1px solid var(--border2);
    border-radius: 5px; padding: 3px 9px; font-size: 11px; cursor: pointer;
  }
  #preview .ph button:hover { color: var(--accent); border-color: var(--accent); }
  #preview .ph button.primary { background: var(--accent); color: white; border-color: var(--accent); }
  #preview .ph button.primary:hover { background: var(--accent2); }

  #preview .ind {
    display: none; padding: 4px 12px; background: rgba(210,153,34,.12);
    color: var(--yellow); font-size: 11px; border-bottom: 1px solid rgba(210,153,34,.3);
  }
  #preview .ind.show { display: block; }

  #pview { flex: 1; min-height: 0; overflow: auto; padding: 14px 18px; font-size: 13.5px; line-height: 1.6; }
  #pview::-webkit-scrollbar { width: 8px; }
  #pview::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 4px; }
  #pview pre { background: var(--bg); border: 1px solid var(--border);
    border-radius: 6px; padding: 10px 12px; overflow-x: auto;
    font-family: ui-monospace, 'SF Mono', monospace; font-size: 12px; line-height: 1.5; }
  #pview code { font-family: ui-monospace, 'SF Mono', monospace; font-size: 12px; }
  #pview :not(pre) > code { background: var(--panel2); padding: 1px 5px; border-radius: 3px; }
  #pview h1, #pview h2, #pview h3 { color: var(--accent); margin-top: 1.2em; }
  #pview h1 { font-size: 22px; border-bottom: 1px solid var(--border); padding-bottom: .3em; }
  #pview h2 { font-size: 18px; }
  #pview h3 { font-size: 15px; }
  #pview a { color: var(--accent); }
  #pview blockquote { border-left: 3px solid var(--accent); padding-left: 12px; color: var(--muted); margin: 8px 0; }
  #pview table { border-collapse: collapse; margin: 8px 0; }
  #pview th, #pview td { border: 1px solid var(--border); padding: 5px 8px; }
  #pview hr { border: none; border-top: 1px solid var(--border); margin: 14px 0; }
  #pview img { max-width: 100%; border-radius: 4px; }
  #pview iframe.html-preview { width: 100%; height: 100%; border: 0; background: #fff;
    border-radius: 4px; display: block; }

  #pview.code { padding: 0; }
  #pview.code pre { margin: 0; border: none; border-radius: 0; min-height: 100%; }

  /* Diff view */
  #pview.diff { padding: 0; font-family: ui-monospace, 'SF Mono', monospace; font-size: 12px; line-height: 1.45; }
  #pview.diff .dh { padding: 8px 14px; background: var(--panel2); color: var(--dim);
    border-bottom: 1px solid var(--border); font-size: 10px; text-transform: uppercase;
    letter-spacing: .5px; display: flex; gap: 14px; }
  #pview.diff .dh .add { color: var(--green); } #pview.diff .dh .del { color: var(--red); }
  #pview.diff .hunk { border-bottom: 1px solid var(--border); }
  #pview.diff .hunk-h { padding: 4px 14px; background: rgba(88,166,255,.08);
    color: var(--accent); font-size: 10px; }
  #pview.diff .ln { display: flex; }
  #pview.diff .ln .gut { flex-shrink: 0; width: 70px; padding: 0 6px 0 10px; text-align: right;
    color: var(--dim); border-right: 1px solid var(--border); user-select: none;
    font-variant-numeric: tabular-nums; font-size: 10px; line-height: 18px; white-space: pre; }
  #pview.diff .ln .txt { flex: 1; padding: 0 10px; white-space: pre; overflow-x: auto;
    line-height: 18px; }
  #pview.diff .ln.add { background: rgba(63,185,80,.10); }
  #pview.diff .ln.add .txt { color: #56d364; }
  #pview.diff .ln.add .txt::before { content: '+ '; color: var(--green); }
  #pview.diff .ln.del { background: rgba(248,81,73,.10); }
  #pview.diff .ln.del .txt { color: #ffa198; }
  #pview.diff .ln.del .txt::before { content: '- '; color: var(--red); }
  #pview.diff .ln.ctx .txt { color: var(--muted); }
  #pview.diff .ln.ctx .txt::before { content: '  '; }
  #pview.diff .empty-diff { padding: 20px; color: var(--dim); text-align: center; }

  #pedit {
    flex: 1; min-height: 0; width: 100%; padding: 12px 14px;
    background: var(--bg); border: none; color: var(--fg);
    font-family: ui-monospace, 'SF Mono', monospace; font-size: 12.5px; line-height: 1.5;
    resize: none; outline: none; display: none;
  }
  #pedit.show { display: block; }
  #pview.hide { display: none; }
  /* CodeMirror editor inside #preview */
  #editorWrap { flex: 1; min-height: 0; display: none; position: relative; }
  #editorWrap.show { display: flex; flex-direction: column; }
  #editorWrap .CodeMirror { flex: 1; min-height: 0; height: 100% !important; width: 100%;
    font-family: ui-monospace, 'SF Mono', monospace; font-size: 12.5px; line-height: 1.5; }
  #editorWrap .editorbar { display: flex; align-items: center; gap: 10px; padding: 4px 10px;
    background: var(--panel2); border-bottom: 1px solid var(--border); font-size: 10px;
    color: var(--dim); font-family: ui-monospace, 'SF Mono', monospace;
    text-transform: uppercase; letter-spacing: .5px; flex-shrink: 0; }
  #editorWrap .editorbar .lang { color: var(--accent); }
  #editorWrap .editorbar .ln-toggle { margin-left: auto; cursor: pointer; color: var(--muted); }
  #editorWrap .editorbar .ln-toggle:hover { color: var(--accent); }
  .CodeMirror-linenumber { color: var(--dim) !important; }
  .cm-s-material-darker.CodeMirror, .cm-s-material-darker .CodeMirror-gutters { background: var(--bg) !important; }
  .cm-s-material-darker .CodeMirror-gutters { border-right: 1px solid var(--border) !important; }
  .cm-s-material-darker .CodeMirror-activeline-background { background: rgba(88,166,255,.05) !important; }

  /* Resizable splitters between panes */
  .resizer { width: 5px; background: transparent; cursor: col-resize; flex-shrink: 0;
    transition: background .15s; position: relative; z-index: 5; }
  .resizer:hover, .resizer.active { background: var(--accent); }
  .resizer.hidden { display: none; }
  body.resizing { cursor: col-resize !important; user-select: none; }
  body.resizing iframe { pointer-events: none; }

  #empty { padding: 40px 20px; text-align: center; color: var(--dim); font-size: 13px; }
  #empty .lg { font-size: 36px; margin-bottom: 8px; }

  /* Toast for fs events */
  #toast { position: fixed; bottom: 14px; right: 14px; z-index: 100;
    display: flex; flex-direction: column; gap: 6px; pointer-events: none; }
  .tmsg { background: rgba(13,17,23,.95); color: var(--fg); border: 1px solid var(--border2);
    border-radius: 6px; padding: 8px 12px; font-size: 12px; pointer-events: auto;
    animation: slideIn .2s ease; max-width: 360px; box-shadow: 0 4px 16px rgba(0,0,0,.4); }
  .tmsg.warn { border-color: rgba(210,153,34,.5); }
  .tmsg.err { border-color: var(--red); }
  @keyframes slideIn { from { transform: translateX(10px); opacity: 0; } to { transform: none; opacity: 1; } }
</style>
</head>
<body>
<div id="app">
  <div id="bar">
    <span class="dot" id="dot"></span>
    <span class="title">&#9889; <span>Sapper</span></span>
    <span class="cwd" id="cwd"></span>
    <div id="stats" title="Live system stats">
      <div class="srow"><span class="slbl">CPU</span><div class="sbar"><i id="bCpu"></i></div><span class="sval" id="vCpu">—</span></div>
      <div class="srow"><span class="slbl">RAM</span><div class="sbar"><i id="bRam"></i></div><span class="sval" id="vRam">—</span></div>
      <div class="srow"><span class="slbl">GPU</span><div class="sbar"><i id="bGpu"></i></div><span class="sval" id="vGpu">—</span></div>
    </div>
    <span class="spacer"></span>
    <button id="btnSide" class="toggle on" onclick="toggleSide()">Sidebar</button>
    <button id="btnPrev" class="toggle" onclick="togglePreview()">Preview</button>
    <button onclick="sendCmd('/help')">/help</button>
    <button onclick="sendCmd('/agents')">agents</button>
    <button onclick="sendCmd('/model')">model</button>
    <button onclick="sendCmd('/clear')">clear</button>
    <button onclick="restartSapper()">restart</button>
  </div>

  <div id="body">
    <!-- Sidebar -->
    <aside id="side">
      <div class="tabs">
        <button class="active" data-tab="files" onclick="switchTab('files')">Files</button>
        <button data-tab="config" onclick="switchTab('config')">Config</button>
        <button data-tab="agents" onclick="switchTab('agents')">Agents</button>
        <button data-tab="skills" onclick="switchTab('skills')">Skills</button>
      </div>
      <div class="pane active" id="pane-files">
        <div class="files-toolbar">
          <button class="ftb" title="New file" onclick="newItemPrompt('file','')">&#128462;<sup>+</sup></button>
          <button class="ftb" title="New folder" onclick="newItemPrompt('folder','')">&#128193;<sup>+</sup></button>
          <button class="ftb" id="ftbAct" title="Show activity log" onclick="toggleActivity()">&#9737;</button>
          <button class="ftb" id="ftbIdx" title="Index files/folders into chat (multi-select)" onclick="toggleIndexMode()">&#128218;</button>
          <span class="ftb-spacer"></span>
          <button class="ftb" title="Clear change marks" onclick="clearAllMarks()">&#10005;</button>
          <button class="ftb" title="Refresh tree" onclick="loadTree()">&#8634;</button>
          <button class="ftb" title="Collapse all" onclick="collapseAll()">&#8676;</button>
        </div>
        <div id="activityPanel">
          <div class="ah">Recent activity<span class="acl" onclick="clearActivity()">clear</span></div>
          <div id="activityList"></div>
        </div>
        <div id="indexPanel">
          <div class="ih">
            <span>Index</span><span class="icnt" id="idxCount">0 items</span>
            <span class="iact">
              <button class="primary" title="Send to chat (Enter sends if a prompt is filled, otherwise files are staged at the cursor)" onclick="sendIndexToChat()">Send</button>
              <button class="danger" title="Clear all" onclick="clearIndex()">Clear</button>
            </span>
          </div>
          <div class="chips" id="idxChips"></div>
          <textarea class="icmt" id="idxComment" placeholder="Optional prompt — fill this to send immediately. Empty = stage at cursor so you can keep typing."></textarea>
        </div>
        <div class="tree" id="tree"></div>
      </div>
      <div class="pane" id="pane-config">
        <div class="pane-section" id="cfgQuick">
          <h4>Quick settings</h4>
          <div id="cfgQuickBody"></div>
        </div>
        <div class="pane-section">
          <h4>Raw config.json</h4>
          <p>Full <code>.sapper/config.json</code> — every Sapper option lives here.</p>
          <textarea class="json-edit" id="cfgJson" spellcheck="false"></textarea>
          <div class="row-btns">
            <button onclick="reloadConfig()">Reload</button>
            <button class="primary" onclick="saveConfig()">Save</button>
          </div>
        </div>
      </div>
      <div class="pane" id="pane-agents">
        <div class="pane-section">
          <h4>Available agents</h4>
          <p>Click any agent to open its <code>.md</code> file in preview.</p>
        </div>
        <div id="agentsList"></div>
      </div>
      <div class="pane" id="pane-skills">
        <div class="pane-section">
          <h4>Available skills</h4>
          <p>Click a skill to open it. Use <code>/use name</code> in the terminal to load.</p>
        </div>
        <div id="skillsList"></div>
      </div>
    </aside>

    <div class="resizer" id="sideRes"></div>

    <!-- Center: terminal -->
    <main id="center">
      <div id="qa">
        <button class="qabtn" title="Attach files (sends @path to Sapper)" onclick="pickAndUpload()">
          <span class="qaico">&#128206;</span><span class="qalbl">Attach</span>
        </button>
        <button class="qabtn rec" title="Record voice (auto-transcribed by Sapper)" onclick="toggleRecord()" id="qaRec">
          <span class="qaico">&#127908;</span><span class="qalbl">Record</span>
        </button>
        <span id="recDot" class="rec-dot"></span>
        <span id="recTime" class="rec-time"></span>
        <span class="qa-sp"></span>
        <button class="qabtn" title="Send /attach (interactive)" onclick="sendCmd('/attach')">/attach</button>
        <button class="qabtn" title="Open file by path" onclick="sendOpenPrompt()">/open</button>
        <button class="qabtn" title="Compact context" onclick="sendCmd('/summary')">/summary</button>
        <input type="file" id="qaFile" multiple style="display:none">
      </div>
      <div id="term-wrap"></div>
      <div id="dropOverlay">
        <div class="drop-card">
          <div class="drop-icon">&#128229;</div>
          <div class="drop-text">Drop files to upload<br><span>They will be attached to Sapper with <code>@path</code></span></div>
        </div>
      </div>
    </main>

    <div class="resizer" id="prevRes"></div>

    <!-- Right: preview -->
    <aside id="preview" class="hidden">
      <div class="ph">
        <span class="pp" id="pPath">No file open</span>
        <button id="pEdit" onclick="startEdit()" style="display:none">Edit</button>
        <button id="pDiff" onclick="showDiff()" style="display:none" title="Show what changed">Diff</button>
        <button id="pAsk" onclick="askAboutSelection()" style="display:none" title="Send the selection (or whole file) to Sapper with a comment">&#128172; Ask AI</button>
        <button id="pSave" onclick="saveEdit()" class="primary" style="display:none">Save</button>
        <button id="pCancel" onclick="cancelEdit()" style="display:none">Cancel</button>
        <button id="pSrc" onclick="toggleSource()" style="display:none">Source</button>
        <button id="pReload" onclick="reloadPreview()" style="display:none">Reload</button>
        <button onclick="closePreview()">&times;</button>
      </div>
      <div class="ind" id="pInd">File changed on disk — reload to view latest.</div>
      <div id="pview"><div id="empty"><div class="lg">&#128196;</div>Open a file from the sidebar.</div></div>
      <div id="editorWrap">
        <div class="editorbar"><span class="lang" id="edLang">text</span><span id="edPos"></span><span class="ln-toggle" id="edWrap" title="Toggle word wrap">wrap</span><span class="ln-toggle" id="edLines" title="Toggle line numbers">lines</span></div>
        <textarea id="pedit" spellcheck="false"></textarea>
      </div>
    </aside>
  </div>
</div>
<div id="toast"></div>

<script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/xterm-addon-web-links@0.9.0/lib/xterm-addon-web-links.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/highlight.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/codemirror@5.65.16/lib/codemirror.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/codemirror@5.65.16/mode/meta.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/codemirror@5.65.16/addon/mode/loadmode.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/codemirror@5.65.16/addon/edit/matchbrackets.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/codemirror@5.65.16/addon/edit/closebrackets.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/codemirror@5.65.16/addon/selection/active-line.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/codemirror@5.65.16/addon/search/searchcursor.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/codemirror@5.65.16/addon/search/search.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/codemirror@5.65.16/addon/dialog/dialog.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/diff@5.2.0/dist/diff.min.js"></script>
<script>
/* ─────────────────────────────────────────────────────────────── */
/*  Sapper Web — frontend                                         */
/* ─────────────────────────────────────────────────────────────── */

var BT = String.fromCharCode(96);

// ─── State ────────────────────────────────────────────────────
var state = {
  cwd: '',
  currentFile: null,    // workspace-relative path currently in preview
  fileOnDisk: '',       // last loaded content from server
  editing: false,
  expanded: { '': true },
  fsWS: null,
  marks: {},            // path -> { kind, count, ts }
  activity: [],         // ordered list of {kind, path, isDir, ts}
  activityOpen: false,
  indexMode: false,     // true = show checkboxes on tree rows
  indexSet: {},         // path -> { isDir, ts } selected for "Index to chat"
};

var cm = null; // CodeMirror instance (lazy)

// Notes persisted across reloads: { "path|ts": "note text" }
var savedNotes = {};
try { savedNotes = JSON.parse(localStorage.getItem('sapperNotes') || '{}') || {}; } catch(e) {}
function saveNotes() {
  try { localStorage.setItem('sapperNotes', JSON.stringify(savedNotes)); } catch(e) {}
}
function noteKey(a) { return a.path + '|' + a.ts; }

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function showToast(msg, kind) {
  var el = document.createElement('div');
  el.className = 'tmsg' + (kind ? ' ' + kind : '');
  el.textContent = msg;
  document.getElementById('toast').appendChild(el);
  setTimeout(function(){ el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 2200);
  setTimeout(function(){ el.remove(); }, 2700);
}

// ─── Terminal & pty WS ───────────────────────────────────────
var term = new Terminal({
  fontFamily: '"SF Mono","Fira Code","JetBrains Mono",Menlo,ui-monospace,monospace',
  fontSize: 13, lineHeight: 1.25, cursorBlink: true, cursorStyle: 'bar',
  scrollback: 10000, allowProposedApi: true, macOptionIsMeta: true,
  theme: {
    background:'#0a0e14', foreground:'#e6edf3', cursor:'#58a6ff', cursorAccent:'#0a0e14',
    selectionBackground:'rgba(88,166,255,0.35)',
    black:'#484f58', red:'#ff7b72', green:'#3fb950', yellow:'#d29922',
    blue:'#58a6ff', magenta:'#bc8cff', cyan:'#39c5cf', white:'#e6edf3',
    brightBlack:'#6e7681', brightRed:'#ffa198', brightGreen:'#56d364',
    brightYellow:'#e3b341', brightBlue:'#79c0ff', brightMagenta:'#d2a8ff',
    brightCyan:'#56d4dd', brightWhite:'#f0f6fc'
  }
});
var fit = new FitAddon.FitAddon();
term.loadAddon(fit);
try { term.loadAddon(new WebLinksAddon.WebLinksAddon()); } catch(e){}
term.open(document.getElementById('term-wrap'));
setTimeout(function(){ try { fit.fit(); } catch(e){} }, 30);

var ws = null, reconnectTimer = null;

function connectPty() {
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host + '/ws');
  ws.binaryType = 'arraybuffer';
  ws.onopen = function() {
    document.getElementById('dot').className = 'dot on';
    var d = fit.proposeDimensions() || { cols: 100, rows: 30 };
    ws.send(JSON.stringify({ type:'init', cols:d.cols, rows:d.rows }));
    term.focus();
  };
  ws.onmessage = function(ev) {
    if (typeof ev.data === 'string') {
      try {
        var m = JSON.parse(ev.data);
        if (m.type === 'cwd') { state.cwd = m.path; document.getElementById('cwd').textContent = m.path; }
        else if (m.type === 'exit') {
          term.writeln('\\r\\n\\x1b[33m[sapper exited — click "restart" to relaunch]\\x1b[0m');
          document.getElementById('dot').className = 'dot err';
        }
      } catch(e){}
    } else {
      term.write(new Uint8Array(ev.data));
    }
  };
  ws.onclose = function() {
    document.getElementById('dot').className = 'dot err';
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectPty, 1200);
  };
  ws.onerror = function(){};
}
term.onData(function(d){ if (ws && ws.readyState === 1) ws.send(d); });
function doFit() {
  try {
    fit.fit();
    var d = fit.proposeDimensions();
    if (d && ws && ws.readyState === 1) ws.send(JSON.stringify({ type:'resize', cols:d.cols, rows:d.rows }));
  } catch(e){}
}
var rTimer = null;
window.addEventListener('resize', function(){ clearTimeout(rTimer); rTimer = setTimeout(doFit, 80); });

window.sendCmd = function(cmd) { if (ws && ws.readyState === 1) ws.send(cmd + '\\r'); term.focus(); };
window.restartSapper = function() { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type:'restart' })); };
document.getElementById('term-wrap').addEventListener('click', function(){ term.focus(); });

// ─── FS events WS ────────────────────────────────────────────
function connectEvents() {
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  state.fsWS = new WebSocket(proto + '//' + location.host + '/events');
  state.fsWS.onmessage = function(ev) {
    var msg = null;
    try { msg = JSON.parse(ev.data); } catch(e) { return; }
    if (msg.type === 'stats') { handleStats(msg); return; }
    handleFsEvent(msg);
  };
  state.fsWS.onclose = function() { setTimeout(connectEvents, 2000); };
}

function fmtBytes(b) {
  if (b == null) return '—';
  var u = ['B','KB','MB','GB','TB']; var i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return (i >= 3 ? b.toFixed(1) : Math.round(b)) + ' ' + u[i];
}

function setBar(id, pct) {
  var el = document.getElementById(id);
  if (!el) return;
  pct = Math.max(0, Math.min(100, pct || 0));
  el.style.width = pct + '%';
  el.classList.remove('warn', 'crit');
  if (pct >= 85) el.classList.add('crit');
  else if (pct >= 65) el.classList.add('warn');
}

function handleStats(msg) {
  if (msg.cpu) {
    setBar('bCpu', msg.cpu.percent);
    document.getElementById('vCpu').textContent = msg.cpu.percent + '%';
  }
  if (msg.mem) {
    setBar('bRam', msg.mem.percent);
    document.getElementById('vRam').textContent = fmtBytes(msg.mem.used) + '/' + fmtBytes(msg.mem.total);
  } else if (msg.totalMem) {
    document.getElementById('vRam').textContent = fmtBytes(msg.totalMem);
  }
  if (msg.gpu) {
    setBar('bGpu', msg.gpu.percent);
    document.getElementById('vGpu').textContent = msg.gpu.percent + '%';
  } else {
    document.getElementById('vGpu').textContent = 'n/a';
  }
}

function handleFsEvent(msg) {
  if (!msg) return;
  if (msg.type === 'activity-replay') {
    if (Array.isArray(msg.items)) msg.items.forEach(applyActivityItem);
    return;
  }
  if (!msg.path) return;
  applyActivityItem(msg);
  // Re-fetch tree (parent dir) for create/delete so the new/removed file appears
  if (msg.kind === 'created' || msg.kind === 'deleted') {
    var parent = msg.path.split('/').slice(0, -1).join('/');
    refreshDir(parent);
  }
  // If the current preview file changed, auto-refresh (or show indicator if editing)
  if (state.currentFile === msg.path) {
    if (msg.kind === 'deleted') return; // file gone; leave preview state
    if (state.editing) {
      document.getElementById('pInd').classList.add('show');
    } else {
      openFile(msg.path, true);
    }
  }
}

function applyActivityItem(item) {
  // bump persistent mark
  var prev = state.marks[item.path];
  var count = prev ? (prev.count + 1) : 1;
  state.marks[item.path] = { kind: item.kind, count: count, ts: item.ts };
  var row = document.querySelector('.row[data-path="' + cssEscape(item.path) + '"]');
  if (row) applyMark(row, state.marks[item.path]);
  // push into activity log (dedupe consecutive entries for same path)
  var last = state.activity[state.activity.length - 1];
  if (last && last.path === item.path && last.kind === item.kind && (item.ts - last.ts) < 1500) {
    last.count = (last.count || 1) + 1;
    last.ts = item.ts;
  } else {
    var entry = { kind: item.kind, path: item.path, isDir: item.isDir, ts: item.ts, count: 1 };
    // restore any saved note for this exact timestamp (rarely matches but safe)
    if (savedNotes[noteKey(entry)]) entry.note = savedNotes[noteKey(entry)];
    state.activity.push(entry);
    if (state.activity.length > 100) state.activity.shift();
  }
  renderActivity();
  // Highlight parent dirs subtly so user notices nested change even when collapsed
  var parts = item.path.split('/');
  for (var i = 1; i < parts.length; i++) {
    var dirPath = parts.slice(0, i).join('/');
    var dirRow = document.querySelector('.row[data-path="' + cssEscape(dirPath) + '"]');
    if (dirRow && !dirRow.classList.contains('act-created') && !dirRow.classList.contains('act-modified') && !dirRow.classList.contains('act-deleted')) {
      dirRow.classList.add('act-modified', 'act-fresh');
      setTimeout((function(r){ return function(){ r.classList.remove('act-fresh'); }; })(dirRow), 1500);
    }
  }
}

function applyMark(row, mark) {
  row.classList.remove('act-created', 'act-modified', 'act-deleted', 'act-multi', 'act-fresh');
  row.classList.add('act-' + mark.kind, 'act-fresh');
  if (mark.count > 1) {
    row.classList.add('act-multi');
    var cnt = row.querySelector('.actcount');
    if (cnt) cnt.textContent = String(mark.count);
  }
  setTimeout(function(){ row.classList.remove('act-fresh'); }, 1500);
}

function renderActivity() {
  var host = document.getElementById('activityList');
  if (!host) return;
  if (!state.activity.length) {
    host.innerHTML = '<div class="empty">No changes yet. Ask Sapper to edit something.</div>';
    return;
  }
  // Render newest-first; track original index via data-idx
  var html = '';
  for (var i = state.activity.length - 1; i >= 0; i--) {
    var a = state.activity[i];
    var rel = relTime(a.ts);
    var ct = a.count > 1 ? ' &times;' + a.count : '';
    html += '<div class="ai kind-' + a.kind + '" data-idx="' + i + '" data-path="' + esc(a.path) + '">' +
      '<span class="ak">' + a.kind + ct + '</span>' +
      '<span class="ap">' + esc(a.path) + '</span>' +
      '<span class="at">' + rel + '</span>' +
      '<span class="acts">' +
        '<button class="ab" data-act="note" title="' + (a.note ? 'Edit note' : 'Add note') + '">' + (a.note ? '&#9998;' : '&#128172;') + '</button>' +
        '<button class="ab danger" data-act="dismiss" title="Dismiss this change">&times;</button>' +
      '</span></div>';
    if (a.note) {
      html += '<div class="note" data-idx="' + i + '">' + esc(a.note) + '</div>';
    }
  }
  host.innerHTML = html;
  Array.from(host.querySelectorAll('.ai')).forEach(function(el){
    el.addEventListener('click', function(ev){
      var btn = ev.target.closest('button.ab');
      var idx = parseInt(el.dataset.idx, 10);
      var entry = state.activity[idx];
      if (!entry) return;
      if (btn) {
        ev.stopPropagation();
        if (btn.dataset.act === 'dismiss') {
          dismissActivity(idx);
        } else if (btn.dataset.act === 'note') {
          promptNote(idx);
        }
        return;
      }
      var p = entry.path;
      var mark = state.marks[p];
      if (mark && mark.kind === 'deleted') { showToast(p + ' (deleted)'); return; }
      var parts = p.split('/');
      var soFar = '';
      for (var j = 0; j < parts.length - 1; j++) {
        soFar = soFar ? soFar + '/' + parts[j] : parts[j];
        state.expanded[soFar] = true;
      }
      loadTree();
      setTimeout(function(){ openFile(p); }, 80);
      clearMark(p);
    });
  });
  // Click on a note line lets you edit it too
  Array.from(host.querySelectorAll('.note')).forEach(function(el){
    el.addEventListener('click', function(){
      promptNote(parseInt(el.dataset.idx, 10));
    });
  });
}

function dismissActivity(idx) {
  var entry = state.activity[idx];
  if (!entry) return;
  state.activity.splice(idx, 1);
  // If this was the only outstanding mark for that path, clear the row mark
  var stillHas = state.activity.some(function(x){ return x.path === entry.path; });
  if (!stillHas) clearMark(entry.path);
  if (savedNotes[noteKey(entry)]) { delete savedNotes[noteKey(entry)]; saveNotes(); }
  renderActivity();
}

async function promptNote(idx) {
  var entry = state.activity[idx];
  if (!entry) return;
  var val = await showModal({
    title: 'Note for change',
    label: entry.kind + '  ' + entry.path,
    placeholder: 'e.g. reviewed, intentional, needs revert',
    value: entry.note || '',
    okLabel: 'Save note',
  });
  if (val == null) return; // cancelled
  var trimmed = val.trim();
  if (!trimmed) {
    delete entry.note;
    delete savedNotes[noteKey(entry)];
  } else {
    entry.note = trimmed;
    savedNotes[noteKey(entry)] = trimmed;
  }
  saveNotes();
  renderActivity();
}

function dismissPathMarks(path) {
  // Remove every activity entry for this path
  for (var i = state.activity.length - 1; i >= 0; i--) {
    if (state.activity[i].path === path) {
      var k = noteKey(state.activity[i]);
      if (savedNotes[k]) { delete savedNotes[k]; }
      state.activity.splice(i, 1);
    }
  }
  saveNotes();
  clearMark(path);
  renderActivity();
}

function noteForPath(path) {
  // Note attaches to the most recent activity entry for this path
  for (var i = state.activity.length - 1; i >= 0; i--) {
    if (state.activity[i].path === path) { promptNote(i); return; }
  }
  showToast('No tracked change for ' + path);
}

function relTime(ts) {
  var s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return 'now';
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  return Math.floor(s / 3600) + 'h';
}

function clearMark(path) {
  delete state.marks[path];
  var row = document.querySelector('.row[data-path="' + cssEscape(path) + '"]');
  if (row) row.classList.remove('act-created', 'act-modified', 'act-deleted', 'act-multi', 'act-fresh');
}

window.toggleActivity = function() {
  state.activityOpen = !state.activityOpen;
  document.getElementById('activityPanel').classList.toggle('on', state.activityOpen);
  document.getElementById('ftbAct').classList.toggle('on', state.activityOpen);
  if (state.activityOpen) renderActivity();
};

window.clearActivity = function() {
  state.activity = [];
  renderActivity();
};

window.clearAllMarks = function() {
  state.marks = {};
  document.querySelectorAll('.row').forEach(function(r){
    r.classList.remove('act-created', 'act-modified', 'act-deleted', 'act-multi', 'act-fresh');
  });
  showToast('Cleared change marks');
};

// Periodically refresh "rel time" labels in the activity panel
setInterval(function(){ if (state.activityOpen) renderActivity(); }, 30000);

function cssEscape(s) { return s.replace(/(["\\\\])/g, '\\\\$1'); }

// ─── Sidebar tabs ────────────────────────────────────────────
window.switchTab = function(name) {
  document.querySelectorAll('.tabs button').forEach(function(b){
    b.classList.toggle('active', b.dataset.tab === name);
  });
  document.querySelectorAll('.pane').forEach(function(p){
    p.classList.toggle('active', p.id === 'pane-' + name);
  });
  if (name === 'config' && !document.getElementById('cfgJson').value) reloadConfig();
  if (name === 'agents') loadAgents();
  if (name === 'skills') loadSkills();
};
window.toggleSide = function() {
  var s = document.getElementById('side');
  s.classList.toggle('hidden');
  document.getElementById('btnSide').classList.toggle('on', !s.classList.contains('hidden'));
  if (typeof updateResizerVisibility === 'function') updateResizerVisibility();
  setTimeout(doFit, 50);
};
window.togglePreview = function() {
  var p = document.getElementById('preview');
  p.classList.toggle('hidden');
  document.getElementById('btnPrev').classList.toggle('on', !p.classList.contains('hidden'));
  if (typeof updateResizerVisibility === 'function') updateResizerVisibility();
  setTimeout(doFit, 50);
  if (cm && !p.classList.contains('hidden')) setTimeout(function(){ cm.refresh(); }, 80);
};

// ─── File tree ───────────────────────────────────────────────
function fileIcon(name, isDir) {
  if (isDir) return '&#128193;';
  var ext = name.split('.').pop().toLowerCase();
  if (['md','markdown'].indexOf(ext) >= 0) return '&#128221;';
  if (['png','jpg','jpeg','gif','svg','webp'].indexOf(ext) >= 0) return '&#128247;';
  if (['json','yml','yaml','toml'].indexOf(ext) >= 0) return '&#9881;';
  return '&#128196;';
}

function loadTree() {
  fetch('/api/tree?path=').then(function(r){return r.json();}).then(function(d){
    var root = document.getElementById('tree');
    root.innerHTML = '';
    renderDir(root, '', d.entries, 0);
  }).catch(function(e){ showToast('Tree error: ' + e.message, 'err'); });
}

function refreshDir(path) {
  // Re-fetch the directory contents and re-render in place if expanded
  var key = path || '';
  if (!state.expanded[key]) return;
  fetch('/api/tree?path=' + encodeURIComponent(path)).then(function(r){return r.json();}).then(function(d){
    // Find parent row, then rebuild its children
    if (key === '') { loadTree(); return; }
    var parentRow = document.querySelector('.row[data-path="' + cssEscape(key) + '"]');
    if (!parentRow) return;
    var depth = parseInt(parentRow.dataset.depth || '0', 10);
    var next = parentRow.nextSibling;
    while (next && parseInt(next.dataset.depth || '-1', 10) > depth) {
      var rem = next; next = next.nextSibling; rem.remove();
    }
    // Re-insert children
    var container = document.createDocumentFragment();
    renderEntries(container, key, d.entries, depth + 1);
    parentRow.parentNode.insertBefore(container, parentRow.nextSibling);
  });
}

function renderDir(container, basePath, entries, depth) {
  renderEntries(container, basePath, entries, depth);
}

function renderEntries(container, basePath, entries, depth) {
  entries.forEach(function(entry){
    var path = basePath ? (basePath + '/' + entry.name) : entry.name;
    var row = document.createElement('div');
    row.className = 'row';
    row.dataset.path = path;
    row.dataset.depth = depth;
    row.dataset.isdir = entry.isDir ? '1' : '0';
    row.style.paddingLeft = (8 + depth * 14) + 'px';
    var chev = entry.isDir ? (state.expanded[path] ? '&#9662;' : '&#9656;') : '';
    var chkOn = state.indexSet[path] ? ' on' : '';
    var chkChar = state.indexSet[path] ? '&#9745;' : '&#9744;'; // ☑ / ☐
    row.innerHTML =
      '<span class="chk' + chkOn + '" title="Add to index">' + chkChar + '</span>' +
      '<span class="chev">' + chev + '</span>' +
      '<span class="ico">' + fileIcon(entry.name, entry.isDir) + '</span>' +
      '<span class="name">' + esc(entry.name) + '</span>' +
      '<span class="actdot"></span>' +
      '<span class="actcount"></span>' +
      '<span class="badge">&#9679;</span>' +
      '<span class="rmenu" title="Options">&#8943;</span>';
    row.addEventListener('click', function(ev){
      if (ev.target && ev.target.classList && ev.target.classList.contains('chk')) {
        ev.stopPropagation();
        toggleIndex(path, entry.isDir);
        return;
      }
      if (ev.target && ev.target.classList && ev.target.classList.contains('rmenu')) {
        ev.stopPropagation();
        openRowMenu(ev.target, path, entry.isDir);
        return;
      }
      if (entry.isDir) toggleDir(row, path);
      else openFile(path);
    });
    row.addEventListener('contextmenu', function(ev){
      ev.preventDefault();
      openRowMenu({ getBoundingClientRect: function(){ return { left: ev.clientX, bottom: ev.clientY, right: ev.clientX, top: ev.clientY }; } }, path, entry.isDir);
    });
    container.appendChild(row);
    // Re-apply any persistent activity mark for this path
    var m = state.marks[path];
    if (m) applyMark(row, m);
    if (entry.isDir && state.expanded[path]) {
      // Load children if not already loaded
      fetch('/api/tree?path=' + encodeURIComponent(path)).then(function(r){return r.json();}).then(function(d){
        var frag = document.createDocumentFragment();
        renderEntries(frag, path, d.entries, depth + 1);
        row.parentNode.insertBefore(frag, row.nextSibling);
      });
    }
  });
}

function toggleDir(row, path) {
  var depth = parseInt(row.dataset.depth, 10);
  var isExpanded = !!state.expanded[path];
  if (isExpanded) {
    // Collapse: remove all following rows with greater depth
    var next = row.nextSibling;
    while (next && parseInt(next.dataset.depth || '-1', 10) > depth) {
      var rem = next; next = next.nextSibling; rem.remove();
    }
    delete state.expanded[path];
    row.querySelector('.chev').innerHTML = '&#9656;';
  } else {
    state.expanded[path] = true;
    row.querySelector('.chev').innerHTML = '&#9662;';
    fetch('/api/tree?path=' + encodeURIComponent(path)).then(function(r){return r.json();}).then(function(d){
      var frag = document.createDocumentFragment();
      renderEntries(frag, path, d.entries, depth + 1);
      row.parentNode.insertBefore(frag, row.nextSibling);
    });
  }
}

window.collapseAll = function() {
  state.expanded = {};
  loadTree();
};

// ─── Context menu + file actions ─────────────────────────────
function closeCtxMenu() {
  var m = document.getElementById('ctxMenu');
  if (m) m.remove();
  document.querySelectorAll('.rmenu.open').forEach(function(e){ e.classList.remove('open'); });
}

document.addEventListener('click', function(e){
  if (e.target.closest && e.target.closest('#ctxMenu')) return;
  closeCtxMenu();
});
document.addEventListener('keydown', function(e){
  if (e.key === 'Escape') closeCtxMenu();
});

function openRowMenu(anchor, path, isDir) {
  closeCtxMenu();
  var rect = anchor.getBoundingClientRect();
  if (anchor.classList) anchor.classList.add('open');
  var menu = document.createElement('div');
  menu.id = 'ctxMenu';
  menu.className = 'ctx-menu';
  var items = [];
  if (isDir) {
    items.push({ label: '&#128462; New file inside', fn: function(){ newItemPrompt('file', path); } });
    items.push({ label: '&#128193; New folder inside', fn: function(){ newItemPrompt('folder', path); } });
    items.push({ sep: true });
    items.push({ label: 'Expand / Collapse', fn: function(){
      var row = document.querySelector('.row[data-path="' + cssEscape(path) + '"]');
      if (row) toggleDir(row, path);
    }});
  } else {
    items.push({ label: 'Open', fn: function(){ openFile(path); } });
  }
  // Change-mark actions, only shown when the row has a mark
  if (state.marks[path]) {
    items.push({ sep: true });
    items.push({ label: '&#10005; Dismiss change mark', fn: function(){ dismissPathMarks(path); } });
    items.push({ label: '&#128172; Add note to last change', fn: function(){ noteForPath(path); } });
  }
  items.push({ sep: true });
  items.push({ label: 'Rename\u2026', fn: function(){ renamePrompt(path); } });
  items.push({ label: 'Duplicate', fn: function(){ duplicateItem(path); } });
  items.push({ label: 'Copy path', fn: function(){ copyText(path); showToast('Path copied'); } });
  items.push({ label: 'Copy name', fn: function(){ copyText(path.split('/').pop()); showToast('Name copied'); } });
  items.push({ sep: true });
  var inIdx = !!state.indexSet[path];
  items.push({
    label: (inIdx ? '&#128218; Remove from index' : '&#128218; Add to index'),
    fn: function(){ toggleIndex(path, isDir); if (!state.indexMode) toggleIndexMode(true); }
  });
  items.push({ sep: true });
  items.push({ label: 'Reveal in Finder', fn: function(){
    fetch('/api/fs/reveal', { method: 'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ path: path }) });
  }});
  if (!isDir) {
    items.push({ label: 'Send path to terminal', fn: function(){ sendCmd(path); } });
    items.push({ label: 'Use as preview', fn: function(){ openFile(path); } });
  }
  items.push({ sep: true });
  items.push({ label: 'Delete (move to .sapper/.trash)', danger: true, fn: function(){ deleteItem(path, false); } });

  items.forEach(function(it){
    if (it.sep) { var s = document.createElement('div'); s.className = 'sep'; menu.appendChild(s); return; }
    var el = document.createElement('div');
    el.className = 'ci' + (it.danger ? ' danger' : '');
    el.innerHTML = '<span>' + it.label + '</span>';
    el.addEventListener('click', function(e){ e.stopPropagation(); closeCtxMenu(); it.fn(); });
    menu.appendChild(el);
  });

  document.body.appendChild(menu);
  // Position
  var mw = menu.offsetWidth, mh = menu.offsetHeight;
  var x = rect.right + 4, y = rect.top;
  if (x + mw > window.innerWidth - 8) x = Math.max(8, rect.left - mw - 4);
  if (y + mh > window.innerHeight - 8) y = Math.max(8, window.innerHeight - mh - 8);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
}

function copyText(t) {
  try { navigator.clipboard.writeText(t); }
  catch(e) {
    var ta = document.createElement('textarea');
    ta.value = t; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch(_){}
    ta.remove();
  }
}

// ─── Modal prompt ─────────────────────────────────────────────
function showModal(opts) {
  return new Promise(function(resolve){
    var bd = document.createElement('div'); bd.className = 'modal-bd';
    var html = '<div class="modal"><h3>' + esc(opts.title) + '</h3>';
    if (opts.label) html += '<label>' + esc(opts.label) + '</label>';
    if (opts.input !== false) {
      html += '<input type="text" id="mdInput" value="' + esc(opts.value || '') + '" placeholder="' + esc(opts.placeholder || '') + '">';
    }
    if (opts.hint) html += '<div class="hint">' + esc(opts.hint) + '</div>';
    html += '<div class="actions">' +
      '<button id="mdCancel">' + (opts.cancelLabel || 'Cancel') + '</button>' +
      '<button id="mdOk" class="' + (opts.danger ? 'danger' : 'primary') + '">' + (opts.okLabel || 'OK') + '</button>' +
      '</div></div>';
    bd.innerHTML = html;
    document.body.appendChild(bd);
    var input = bd.querySelector('#mdInput');
    var ok = function(){ var v = input ? input.value : ''; bd.remove(); resolve(v); };
    var cancel = function(){ bd.remove(); resolve(null); };
    bd.querySelector('#mdOk').addEventListener('click', ok);
    bd.querySelector('#mdCancel').addEventListener('click', cancel);
    bd.addEventListener('click', function(e){ if (e.target === bd) cancel(); });
    if (input) {
      input.focus();
      // Select stem (before last dot) for renames
      if (opts.selectStem && input.value) {
        var dot = input.value.lastIndexOf('.');
        if (dot > 0) input.setSelectionRange(0, dot);
        else input.select();
      } else if (input.value) {
        input.select();
      }
      input.addEventListener('keydown', function(e){
        if (e.key === 'Enter') ok();
        if (e.key === 'Escape') cancel();
      });
    }
  });
}

window.newItemPrompt = async function(kind, parentDir) {
  var defPath = parentDir ? (parentDir + '/') : '';
  var v = await showModal({
    title: kind === 'folder' ? 'New folder' : 'New file',
    label: 'Path (relative to workspace)',
    value: defPath,
    placeholder: kind === 'folder' ? 'src/utils' : 'src/index.ts',
    hint: 'Use "/" for subdirectories. Intermediate folders are created automatically.',
    okLabel: 'Create',
  });
  if (v == null) return;
  v = v.replace(/^[\\/]+/, '').trim();
  if (!v) return;
  var r = await fetch('/api/fs/new', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ path: v, kind: kind })
  });
  var d = await r.json();
  if (d.error) { showToast('Create failed: ' + d.error, 'err'); return; }
  showToast(kind === 'folder' ? 'Folder created' : 'File created');
  // expand parent + refresh
  if (parentDir) state.expanded[parentDir] = true;
  loadTree();
  if (kind === 'file') setTimeout(function(){ openFile(v); }, 200);
};

async function renamePrompt(path) {
  var name = path.split('/').pop();
  var parent = path.split('/').slice(0, -1).join('/');
  var v = await showModal({
    title: 'Rename',
    label: 'New name',
    value: name,
    selectStem: true,
    okLabel: 'Rename',
  });
  if (v == null) return;
  v = v.trim();
  if (!v || v === name) return;
  var to = parent ? (parent + '/' + v) : v;
  var r = await fetch('/api/fs/rename', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ from: path, to: to })
  });
  var d = await r.json();
  if (d.error) { showToast('Rename failed: ' + d.error, 'err'); return; }
  showToast('Renamed');
  if (state.currentFile === path) state.currentFile = to;
  loadTree();
}

async function duplicateItem(path) {
  var r = await fetch('/api/fs/duplicate', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ from: path })
  });
  var d = await r.json();
  if (d.error) { showToast('Duplicate failed: ' + d.error, 'err'); return; }
  showToast('Duplicated to ' + d.path);
  loadTree();
}

async function deleteItem(path, hard) {
  var v = await showModal({
    title: 'Delete?',
    label: path,
    input: false,
    hint: hard ? 'This permanently removes the item. This cannot be undone.'
               : 'Item will be moved to .sapper/.trash/ so you can restore it manually.',
    okLabel: 'Delete',
    danger: true,
  });
  if (v == null) return;
  var r = await fetch('/api/fs/delete', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ path: path, hard: !!hard })
  });
  var d = await r.json();
  if (d.error) { showToast('Delete failed: ' + d.error, 'err'); return; }
  showToast('Deleted');
  if (state.currentFile === path) closePreview();
  loadTree();
}

// ─── Preview / editor ────────────────────────────────────────
function isTextLikeExt(ext) {
  return /^(md|markdown|txt|json|jsonc|yml|yaml|toml|js|mjs|cjs|ts|tsx|jsx|css|scss|html|htm|xml|py|rb|go|rs|java|c|cpp|h|hpp|sh|bash|zsh|fish|env|gitignore|conf|ini|sql|graphql|svelte|vue|astro|lock|log)$/i.test(ext);
}

window.openFile = function(path, isReload) {
  // Ensure preview is open
  var prev = document.getElementById('preview');
  if (prev.classList.contains('hidden')) togglePreview();
  // Mark active row
  document.querySelectorAll('.row.active').forEach(function(r){ r.classList.remove('active'); });
  var row = document.querySelector('.row[data-path="' + cssEscape(path) + '"]');
  if (row) row.classList.add('active');
  // Capture mark BEFORE clearing so we know whether to show the Diff button
  var hadModification = !isReload && state.marks[path] && state.marks[path].kind === 'modified';
  if (!isReload && state.marks[path]) clearMark(path);

  state.currentFile = path;
  state.editing = false;
  state.showSource = false;
  document.getElementById('pPath').textContent = path;
  document.getElementById('pInd').classList.remove('show');
  document.getElementById('pEdit').style.display = 'none';
  document.getElementById('pDiff').style.display = hadModification ? 'inline-block' : 'none';
  document.getElementById('pAsk').style.display = 'inline-block';
  document.getElementById('pSave').style.display = 'none';
  document.getElementById('pCancel').style.display = 'none';
  document.getElementById('pSrc').style.display = 'none';
  document.getElementById('pReload').style.display = 'inline-block';
  document.getElementById('editorWrap').classList.remove('show');
  document.getElementById('pview').classList.remove('hide');
  // auto-open the diff if we just navigated to a modified file
  if (hadModification) setTimeout(function(){ if (state.currentFile === path) window.showDiff(); }, 250);

  fetch('/api/file?path=' + encodeURIComponent(path)).then(function(r){return r.json();}).then(function(d){
    if (d.error) {
      document.getElementById('pview').innerHTML = '<div id="empty"><div class="lg">&#9888;</div>' + esc(d.error) + '</div>';
      document.getElementById('pview').className = '';
      return;
    }
    state.fileOnDisk = d.content || '';
    var ext = (path.split('.').pop() || '').toLowerCase();
    var view = document.getElementById('pview');
    if (d.binary) {
      view.className = '';
      if (/^(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(ext)) {
        view.innerHTML = '<img src="/api/file/raw?path=' + encodeURIComponent(path) + '" alt="' + esc(path) + '">';
      } else {
        view.innerHTML = '<div id="empty"><div class="lg">&#128190;</div>Binary file (' + d.size + ' bytes)</div>';
      }
      document.getElementById('pEdit').style.display = 'none';
    } else if (ext === 'md' || ext === 'markdown') {
      view.className = '';
      try {
        marked.setOptions({ breaks: false, gfm: true });
        view.innerHTML = marked.parse(d.content || '');
        view.querySelectorAll('pre code').forEach(function(b){ try { hljs.highlightElement(b); } catch(e){} });
      } catch(e) {
        view.innerHTML = '<pre>' + esc(d.content || '') + '</pre>';
      }
      document.getElementById('pEdit').style.display = 'inline-block';
    } else if (ext === 'html' || ext === 'htm') {
      renderHtmlPreview(d.content || '');
      document.getElementById('pEdit').style.display = 'inline-block';
      document.getElementById('pSrc').style.display = 'inline-block';
      document.getElementById('pSrc').textContent = 'Source';
    } else if (isTextLikeExt(ext) || d.text) {
      view.className = 'code';
      var langClass = ext ? ' class="language-' + esc(ext) + '"' : '';
      view.innerHTML = '<pre><code' + langClass + '>' + esc(d.content || '') + '</code></pre>';
      try { hljs.highlightElement(view.querySelector('code')); } catch(e){}
      document.getElementById('pEdit').style.display = 'inline-block';
    } else {
      view.className = '';
      view.innerHTML = '<pre>' + esc(d.content || '') + '</pre>';
      document.getElementById('pEdit').style.display = 'inline-block';
    }
    if (isReload) showToast('Reloaded ' + path);
  }).catch(function(e){ showToast('Read failed: ' + e.message, 'err'); });
};

function renderHtmlPreview(content) {
  var view = document.getElementById('pview');
  view.className = '';
  view.innerHTML = '';
  var iframe = document.createElement('iframe');
  iframe.className = 'html-preview';
  iframe.setAttribute('sandbox', 'allow-same-origin allow-popups');
  iframe.srcdoc = content;
  view.appendChild(iframe);
}

function renderHtmlSource(content) {
  var view = document.getElementById('pview');
  view.className = 'code';
  view.innerHTML = '<pre><code class="language-html">' + esc(content) + '</code></pre>';
  try { hljs.highlightElement(view.querySelector('code')); } catch(e){}
}

window.toggleSource = function() {
  if (!state.currentFile) return;
  state.showSource = !state.showSource;
  var btn = document.getElementById('pSrc');
  if (state.showSource) {
    renderHtmlSource(state.fileOnDisk || '');
    btn.textContent = 'Rendered';
  } else {
    renderHtmlPreview(state.fileOnDisk || '');
    btn.textContent = 'Source';
  }
};

window.reloadPreview = function() { if (state.currentFile) openFile(state.currentFile, true); };
window.closePreview = function() {
  state.currentFile = null; state.editing = false;
  document.getElementById('pview').innerHTML = '<div id="empty"><div class="lg">&#128196;</div>Open a file from the sidebar.</div>';
  document.getElementById('pview').className = '';
  document.getElementById('pPath').textContent = 'No file open';
  document.getElementById('pEdit').style.display = 'none';
  document.getElementById('pDiff').style.display = 'none';
  document.getElementById('pAsk').style.display = 'none';
  document.getElementById('pSave').style.display = 'none';
  document.getElementById('pCancel').style.display = 'none';
  document.getElementById('pSrc').style.display = 'none';
  document.getElementById('pReload').style.display = 'none';
  document.getElementById('editorWrap').classList.remove('show');
  document.getElementById('pview').classList.remove('hide');
};
window.startEdit = function() {
  if (!state.currentFile) return;
  state.editing = true;
  document.getElementById('pview').classList.add('hide');
  document.getElementById('editorWrap').classList.add('show');
  ensureEditor();
  setEditorMode(state.currentFile);
  cm.setValue(state.fileOnDisk || '');
  cm.clearHistory();
  setTimeout(function(){ cm.refresh(); cm.focus(); }, 30);
  document.getElementById('pEdit').style.display = 'none';
  document.getElementById('pDiff').style.display = 'none';
  document.getElementById('pSave').style.display = 'inline-block';
  document.getElementById('pCancel').style.display = 'inline-block';
};
window.cancelEdit = function() {
  state.editing = false;
  document.getElementById('editorWrap').classList.remove('show');
  document.getElementById('pview').classList.remove('hide');
  document.getElementById('pEdit').style.display = 'inline-block';
  document.getElementById('pSave').style.display = 'none';
  document.getElementById('pCancel').style.display = 'none';
  document.getElementById('pInd').classList.remove('show');
};
window.saveEdit = function() {
  if (!state.currentFile) return;
  var content = cm ? cm.getValue() : document.getElementById('pedit').value;
  fetch('/api/file', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: state.currentFile, content: content })
  }).then(function(r){return r.json();}).then(function(d){
    if (d.error) { showToast('Save failed: ' + d.error, 'err'); return; }
    showToast('Saved ' + state.currentFile);
    state.editing = false;
    openFile(state.currentFile, false);
  }).catch(function(e){ showToast('Save failed: ' + e.message, 'err'); });
};

window.showDiff = function() {
  if (!state.currentFile) return;
  var view = document.getElementById('pview');
  document.getElementById('editorWrap').classList.remove('show');
  view.classList.remove('hide');
  view.className = 'diff';
  view.innerHTML = '<div class="empty-diff">Loading diff…</div>';
  document.getElementById('pDiff').style.display = 'none';
  document.getElementById('pEdit').style.display = 'inline-block';
  fetch('/api/diff?path=' + encodeURIComponent(state.currentFile))
    .then(function(r){return r.json();})
    .then(function(d){
      if (d.error) { view.innerHTML = '<div class="empty-diff">' + esc(d.error) + '</div>'; return; }
      if (d.prev == null) {
        view.innerHTML = '<div class="empty-diff">' + esc(d.message || 'No prior snapshot available.') +
          '<br><br>Sapper started tracking this file from now on \u2014 the next change will show a diff.</div>';
        return;
      }
      renderUnifiedDiff(view, d.prev, d.curr);
    })
    .catch(function(e){ view.innerHTML = '<div class="empty-diff">Diff failed: ' + esc(e.message) + '</div>'; });
};

function renderUnifiedDiff(host, prev, curr) {
  if (!window.Diff) {
    host.innerHTML = '<div class="empty-diff">Diff library failed to load.</div>';
    return;
  }
  var patch = Diff.structuredPatch('a', 'b', prev || '', curr || '', '', '', { context: 3 });
  if (!patch.hunks.length) {
    host.innerHTML = '<div class="empty-diff">No textual differences \u2014 file content is identical.</div>';
    return;
  }
  var added = 0, removed = 0;
  patch.hunks.forEach(function(h){
    h.lines.forEach(function(l){
      if (l[0] === '+') added++;
      else if (l[0] === '-') removed++;
    });
  });
  var html = '<div class="dh"><span class="add">+' + added + ' added</span>' +
             '<span class="del">-' + removed + ' removed</span>' +
             '<span>' + patch.hunks.length + ' hunk' + (patch.hunks.length>1?'s':'') + '</span></div>';
  patch.hunks.forEach(function(h){
    html += '<div class="hunk">';
    html += '<div class="hunk-h">@@ -' + h.oldStart + ',' + h.oldLines +
            ' +' + h.newStart + ',' + h.newLines + ' @@</div>';
    var oldNo = h.oldStart, newNo = h.newStart;
    h.lines.forEach(function(l){
      var sign = l[0], body = l.slice(1);
      if (sign === '\\\\') return; // "\\ No newline at end of file"
      var cls = sign === '+' ? 'add' : (sign === '-' ? 'del' : 'ctx');
      var lo = sign === '+' ? '' : String(oldNo);
      var ln = sign === '-' ? '' : String(newNo);
      var gut = lo.padStart(4, ' ') + ' ' + ln.padStart(4, ' ');
      html += '<div class="ln ' + cls + '"><span class="gut">' + gut + '</span>' +
              '<span class="txt">' + esc(body || ' ') + '</span></div>';
      if (sign !== '+') oldNo++;
      if (sign !== '-') newNo++;
    });
    html += '</div>';
  });
  host.innerHTML = html;
}

// ─── Ask AI: send selection + comment to terminal ─────────────
function detectLang(path) {
  var ext = ((path || '').split('.').pop() || '').toLowerCase();
  var map = { js:'js', mjs:'js', cjs:'js', jsx:'jsx', ts:'ts', tsx:'tsx', py:'python',
    rb:'ruby', go:'go', rs:'rust', java:'java', c:'c', h:'c', cpp:'cpp', hpp:'cpp',
    cs:'csharp', kt:'kotlin', swift:'swift', php:'php', sh:'bash', bash:'bash',
    zsh:'zsh', md:'markdown', json:'json', yml:'yaml', yaml:'yaml', toml:'toml',
    xml:'xml', html:'html', css:'css', scss:'scss', sql:'sql', lua:'lua', pl:'perl',
    r:'r', erl:'erlang', ex:'elixir', dart:'dart', vue:'vue', svelte:'svelte' };
  return map[ext] || '';
}

// Collect what the user has selected in the preview/editor/diff
function getCurrentSelection() {
  var out = { text: '', startLine: null, endLine: null, source: '' };
  // Editor (CodeMirror) selection wins if visible
  var edWrap = document.getElementById('editorWrap');
  if (cm && edWrap && edWrap.classList.contains('show') && cm.somethingSelected()) {
    out.text = cm.getSelection();
    var sel = cm.listSelections()[0];
    var a = sel.anchor, h = sel.head;
    var startL = Math.min(a.line, h.line), endL = Math.max(a.line, h.line);
    out.startLine = startL + 1; out.endLine = endL + 1;
    out.source = 'editor';
    return out;
  }
  // DOM selection (preview / diff)
  var sel = window.getSelection ? window.getSelection() : null;
  var pview = document.getElementById('pview');
  if (sel && sel.rangeCount && !sel.isCollapsed && pview.contains(sel.anchorNode)) {
    out.text = sel.toString();
    out.source = pview.classList.contains('diff') ? 'diff' : 'preview';
    // Try to recover line range from the diff gutter (.gut spans contain old/new line nums)
    if (out.source === 'diff') {
      var range = sel.getRangeAt(0);
      var node = range.startContainer;
      while (node && node.nodeType !== 1) node = node.parentNode;
      var startLn = node && node.closest ? node.closest('.ln') : null;
      node = range.endContainer;
      while (node && node.nodeType !== 1) node = node.parentNode;
      var endLn = node && node.closest ? node.closest('.ln') : null;
      function rightNum(ln) {
        if (!ln) return null;
        var g = ln.querySelector('.gut');
        if (!g) return null;
        var parts = g.textContent.trim().split(/\\s+/);
        var n = parseInt(parts[parts.length - 1], 10);
        return isNaN(n) ? null : n;
      }
      var s = rightNum(startLn), e = rightNum(endLn);
      if (s && e) { out.startLine = Math.min(s,e); out.endLine = Math.max(s,e); }
    }
    return out;
  }
  return out;
}

function sendPasteToTerm(text) {
  if (!ws || ws.readyState !== 1) {
    showToast('Terminal not connected', 'err');
    return false;
  }
  // Sapper's readline does NOT advertise bracketed-paste mode (no ESC[?2004h),
  // so wrapping in ESC[200~ … ESC[201~ would leak the literal "^[[200~" into
  // the prompt. Only use bracket-paste when we truly need multi-line atomicity
  // (Ask AI feature). For single-line content, send it raw and submit with \\r.
  var LF = String.fromCharCode(10);
  var CR = String.fromCharCode(13);
  if (text.indexOf(LF) < 0 && text.indexOf(CR) < 0) {
    ws.send(text + CR);
    return true;
  }
  // Multi-line: bracketed paste so readline treats it as one input.
  ws.send('\\u001b[200~');
  ws.send(text);
  ws.send('\\u001b[201~');
  ws.send(CR);
  return true;
}

function sendRawToTerm(text) {
  if (!ws || ws.readyState !== 1) {
    showToast('Terminal not connected', 'err');
    return false;
  }
  ws.send(text);
  return true;
}

// ─── Index tray: multi-select files/folders into the chat ────────
try { state.indexSet = JSON.parse(localStorage.getItem('sapperIndex') || '{}') || {}; } catch(e) { state.indexSet = {}; }
function saveIndex() {
  try { localStorage.setItem('sapperIndex', JSON.stringify(state.indexSet)); } catch(e) {}
}

window.toggleIndexMode = function(forceOn) {
  state.indexMode = (forceOn === true) ? true : !state.indexMode;
  document.body.classList.toggle('indexmode', state.indexMode);
  var btn = document.getElementById('ftbIdx');
  if (btn) btn.classList.toggle('on', state.indexMode);
  var panel = document.getElementById('indexPanel');
  if (panel) panel.classList.toggle('on', state.indexMode);
  if (state.indexMode) renderIndex();
};

window.toggleIndex = function(path, isDir) {
  if (state.indexSet[path]) {
    delete state.indexSet[path];
  } else {
    state.indexSet[path] = { isDir: !!isDir, ts: Date.now() };
  }
  saveIndex();
  // Update the row checkbox without full rerender
  var row = document.querySelector('.row[data-path="' + cssEscape(path) + '"]');
  if (row) {
    var chk = row.querySelector('.chk');
    if (chk) {
      var on = !!state.indexSet[path];
      chk.classList.toggle('on', on);
      chk.innerHTML = on ? '&#9745;' : '&#9744;';
    }
  }
  renderIndex();
};

window.clearIndex = function() {
  state.indexSet = {};
  saveIndex();
  document.querySelectorAll('.row .chk.on').forEach(function(el){
    el.classList.remove('on'); el.innerHTML = '&#9744;';
  });
  renderIndex();
  showToast('Index cleared');
};

function renderIndex() {
  var panel = document.getElementById('indexPanel');
  if (!panel) return;
  var chips = document.getElementById('idxChips');
  var count = document.getElementById('idxCount');
  var paths = Object.keys(state.indexSet).sort();
  if (count) count.textContent = paths.length + ' item' + (paths.length === 1 ? '' : 's');
  if (!chips) return;
  if (!paths.length) {
    chips.innerHTML = '<div class="empty">Tick files or folders in the tree, or right-click &gt; Add to index.</div>';
    return;
  }
  chips.innerHTML = paths.map(function(p){
    var info = state.indexSet[p];
    var cls = info.isDir ? 'chip dir' : 'chip';
    var ico = info.isDir ? '&#128193;' : '&#128462;';
    return '<span class="' + cls + '" title="' + esc(p) + '">' +
      '<span>' + ico + '</span>' +
      '<span class="cp">' + esc(p) + '</span>' +
      '<span class="cx" data-p="' + esc(p) + '" title="Remove">&times;</span>' +
      '</span>';
  }).join('');
  chips.querySelectorAll('.cx').forEach(function(el){
    el.addEventListener('click', function(ev){
      ev.stopPropagation();
      toggleIndex(el.getAttribute('data-p'), state.indexSet[el.getAttribute('data-p')] && state.indexSet[el.getAttribute('data-p')].isDir);
    });
  });
}

window.sendIndexToChat = function() {
  var paths = Object.keys(state.indexSet);
  if (!paths.length) { showToast('Index is empty', 'err'); return; }
  if (!ws || ws.readyState !== 1) { showToast('Terminal not connected', 'err'); return; }
  var files = [], dirs = [];
  paths.forEach(function(p){
    if (state.indexSet[p] && state.indexSet[p].isDir) dirs.push(p); else files.push(p);
  });
  // 1) /scan each folder (each sent as its own command + Enter)
  dirs.forEach(function(d){ sendPasteToTerm('/scan ' + d); });
  // 2) Build attachments token for files
  var atTokens = files.map(function(f){ return '@' + f; }).join(' ');
  var comment = (document.getElementById('idxComment') || {}).value || '';
  comment = comment.trim();
  if (comment) {
    // Send a complete message that Sapper will execute immediately
    var msg = comment;
    if (atTokens) msg = comment + ' ' + atTokens;
    sendPasteToTerm(msg);
  } else if (atTokens) {
    // Stage at cursor — no Enter, so the user can type their question
    sendRawToTerm(atTokens + ' ');
  }
  showToast('Sent ' + files.length + ' file' + (files.length === 1 ? '' : 's') +
            (dirs.length ? ' and ' + dirs.length + ' folder' + (dirs.length === 1 ? '' : 's') : '') +
            ' to chat');
  // Clear comment, clear index, refocus terminal
  var cmt = document.getElementById('idxComment'); if (cmt) cmt.value = '';
  clearIndex();
  try { term.focus(); } catch(e) {}
};

window.askAboutSelection = async function() {
  if (!state.currentFile) return;
  var sel = getCurrentSelection();
  var snippet = sel.text;
  var lineNote = '';
  if (snippet) {
    if (sel.startLine && sel.endLine) {
      lineNote = ' (lines ' + sel.startLine +
        (sel.endLine !== sel.startLine ? '-' + sel.endLine : '') + ')';
    }
  } else {
    // No selection: offer the whole file but warn if huge
    snippet = state.fileOnDisk || '';
    if (snippet.length > 8000) {
      showToast('No selection; file is large \u2014 select a region first.', 'warn');
      return;
    }
    lineNote = ' (entire file, ' + snippet.split('\\n').length + ' lines)';
  }
  // Trim trailing whitespace per line to keep prompt tidy; keep leading indentation
  var trimmed = snippet.replace(/[ \\t]+$/gm, '');
  showAskModal({
    file: state.currentFile,
    lineNote: lineNote,
    snippet: trimmed,
    lang: detectLang(state.currentFile),
  });
};

function showAskModal(opts) {
  // Build a richer modal with two textareas
  var bd = document.createElement('div'); bd.className = 'modal-bd';
  var html = '<div class="modal" style="width:600px">' +
    '<h3>Ask Sapper about this</h3>' +
    '<label>File</label>' +
    '<div class="hint" style="font-family:ui-monospace,monospace;color:var(--muted);font-size:11px">' +
      esc(opts.file) + esc(opts.lineNote || '') + '</div>' +
    '<label>Your comment / question</label>' +
    '<textarea id="askComment" placeholder="What should Sapper do with this? (e.g. \\'explain\\', \\'refactor\\', \\'why did this change?\\')" ' +
      'style="width:100%;box-sizing:border-box;height:60px;background:var(--bg);color:var(--fg);' +
      'border:1px solid var(--border);border-radius:4px;padding:7px 9px;' +
      'font-family:inherit;font-size:12px;outline:none;resize:vertical"></textarea>' +
    '<label>Snippet (editable)</label>' +
    '<textarea id="askSnippet" spellcheck="false" ' +
      'style="width:100%;box-sizing:border-box;height:240px;background:var(--bg);color:var(--fg);' +
      'border:1px solid var(--border);border-radius:4px;padding:7px 9px;' +
      'font-family:ui-monospace,\\'SF Mono\\',monospace;font-size:11.5px;line-height:1.5;' +
      'outline:none;white-space:pre;overflow:auto;resize:vertical"></textarea>' +
    '<div class="actions">' +
      '<button id="askCancel">Cancel</button>' +
      '<button id="askSend" class="primary">Send to Sapper</button>' +
    '</div></div>';
  bd.innerHTML = html;
  document.body.appendChild(bd);
  var ta = bd.querySelector('#askSnippet');
  ta.value = opts.snippet;
  var ca = bd.querySelector('#askComment');
  ca.focus();
  var cancel = function(){ bd.remove(); };
  bd.querySelector('#askCancel').addEventListener('click', cancel);
  bd.addEventListener('click', function(e){ if (e.target === bd) cancel(); });
  bd.querySelector('#askSend').addEventListener('click', function(){
    var comment = ca.value.trim();
    var code = ta.value;
    if (!comment && !code) { cancel(); return; }
    var lang = opts.lang || '';
    var fence = BT + BT + BT;
    var msg = '';
    if (comment) msg += comment + '\\n\\n';
    msg += 'From ' + BT + opts.file + BT + (opts.lineNote || '') + ':\\n';
    msg += fence + lang + '\\n' + code + '\\n' + fence;
    var ok = sendPasteToTerm(msg);
    if (ok) { showToast('Sent to Sapper'); cancel(); term && term.focus(); }
  });
  // Cmd/Ctrl+Enter = send
  ca.addEventListener('keydown', function(e){
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { bd.querySelector('#askSend').click(); }
    if (e.key === 'Escape') cancel();
  });
}
function ensureEditor() {
  if (cm || !window.CodeMirror) return cm;
  CodeMirror.modeURL = 'https://cdn.jsdelivr.net/npm/codemirror@5.65.16/mode/%N/%N.min.js';
  var ta = document.getElementById('pedit');
  cm = CodeMirror.fromTextArea(ta, {
    lineNumbers: true,
    theme: 'material-darker',
    matchBrackets: true,
    autoCloseBrackets: true,
    styleActiveLine: true,
    indentUnit: 2,
    tabSize: 2,
    smartIndent: true,
    lineWrapping: false,
    extraKeys: {
      'Cmd-S': function(){ window.saveEdit(); },
      'Ctrl-S': function(){ window.saveEdit(); },
      'Cmd-F': 'findPersistent',
      'Ctrl-F': 'findPersistent',
      'Esc': function(){ window.cancelEdit(); },
      'Tab': function(c){ if (c.somethingSelected()) c.indentSelection('add'); else c.replaceSelection(Array(c.getOption('indentUnit')+1).join(' ')); }
    }
  });
  cm.on('cursorActivity', function(){
    var p = cm.getCursor();
    var el = document.getElementById('edPos');
    if (el) el.textContent = 'L' + (p.line+1) + ':' + (p.ch+1);
  });
  var lnBtn = document.getElementById('edLines');
  if (lnBtn) lnBtn.onclick = function(){ cm.setOption('lineNumbers', !cm.getOption('lineNumbers')); };
  var wrBtn = document.getElementById('edWrap');
  if (wrBtn) wrBtn.onclick = function(){ cm.setOption('lineWrapping', !cm.getOption('lineWrapping')); cm.refresh(); };
  return cm;
}

// Extras CodeMirror's meta.js doesn't always cover well
var EXTRA_MODES = {
  erl: { mime: 'text/x-erlang', mode: 'erlang' },
  hrl: { mime: 'text/x-erlang', mode: 'erlang' },
  ex:  { mime: 'text/x-elixir', mode: 'elixir' }, // not bundled in CM5; falls back gracefully
  exs: { mime: 'text/x-elixir', mode: 'elixir' },
  rs:  { mime: 'text/x-rustsrc', mode: 'rust' },
  kt:  { mime: 'text/x-kotlin', mode: 'clike' },
  kts: { mime: 'text/x-kotlin', mode: 'clike' },
  swift:{ mime: 'text/x-swift', mode: 'swift' },
  dart:{ mime: 'application/dart', mode: 'dart' },
  zig: { mime: 'text/x-csrc', mode: 'clike' },
  toml:{ mime: 'text/x-toml', mode: 'toml' },
  vue: { mime: 'text/html', mode: 'htmlmixed' },
  svelte:{ mime: 'text/html', mode: 'htmlmixed' },
  mjs: { mime: 'application/javascript', mode: 'javascript' },
  cjs: { mime: 'application/javascript', mode: 'javascript' },
  jsx: { mime: 'text/jsx', mode: 'jsx' },
  tsx: { mime: 'text/typescript-jsx', mode: 'jsx' },
  ts:  { mime: 'application/typescript', mode: 'javascript' },
  ipynb:{ mime: 'application/json', mode: 'javascript' },
  log: { mime: 'text/plain', mode: 'null' },
  env: { mime: 'text/x-sh', mode: 'shell' },
  dockerfile:{ mime: 'text/x-dockerfile', mode: 'dockerfile' }
};

function setEditorMode(path) {
  if (!cm || !window.CodeMirror) return;
  var name = (path || '').split('/').pop() || '';
  var ext = (name.split('.').pop() || '').toLowerCase();
  var info = null;
  if (CodeMirror.findModeByFileName) info = CodeMirror.findModeByFileName(name);
  if (!info && EXTRA_MODES[ext]) info = EXTRA_MODES[ext];
  if (!info && CodeMirror.findModeByExtension) info = CodeMirror.findModeByExtension(ext);
  if (!info) info = { mime: 'text/plain', mode: 'null' };
  cm.setOption('mode', info.mime || info.mode);
  if (info.mode && info.mode !== 'null' && CodeMirror.autoLoadMode) {
    try { CodeMirror.autoLoadMode(cm, info.mode); } catch(e){}
  }
  var langEl = document.getElementById('edLang');
  if (langEl) langEl.textContent = (info.name || info.mode || 'text');
}

// ─── Config tab ──────────────────────────────────────────────
window.reloadConfig = function() {
  fetch('/api/config').then(function(r){return r.json();}).then(function(d){
    document.getElementById('cfgJson').value = JSON.stringify(d.config || {}, null, 2);
    renderQuickConfig(d.config || {});
  }).catch(function(e){ showToast('Config read failed: ' + e.message, 'err'); });
};
window.saveConfig = function() {
  var raw = document.getElementById('cfgJson').value;
  var parsed;
  try { parsed = JSON.parse(raw); }
  catch(e) { showToast('Invalid JSON: ' + e.message, 'err'); return; }
  fetch('/api/config', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ config: parsed })
  }).then(function(r){return r.json();}).then(function(d){
    if (d.error) { showToast('Save failed: ' + d.error, 'err'); return; }
    showToast('Config saved');
    renderQuickConfig(parsed);
  });
};

function renderQuickConfig(cfg) {
  var host = document.getElementById('cfgQuickBody');
  host.innerHTML = '';
  function add(html) { host.insertAdjacentHTML('beforeend', html); }
  add('<label>Default model</label><input type="text" id="qDefMod" placeholder="auto" value="' + esc(cfg.defaultModel || '') + '">');
  add('<label>Default agent</label><input type="text" id="qDefAgent" placeholder="(none)" value="' + esc(cfg.defaultAgent || '') + '">');
  add('<label>Context limit (tokens, blank = model default)</label><input type="number" id="qCtxLim" value="' + esc(cfg.contextLimit == null ? '' : cfg.contextLimit) + '">');
  add('<label>Tool round limit</label><input type="number" id="qToolRnd" value="' + esc(cfg.toolRoundLimit != null ? cfg.toolRoundLimit : 40) + '">');
  add('<div class="toggle-row"><span>Summary phases</span><div class="switch ' + (cfg.summaryPhases ? 'on' : '') + '" id="qSumPh"></div></div>');
  add('<label>Summary trigger %</label><input type="number" id="qSumTr" value="' + esc(cfg.summarizeTriggerPercent != null ? cfg.summarizeTriggerPercent : 65) + '">');
  add('<div class="toggle-row"><span>Debug mode</span><div class="switch ' + (cfg.debug ? 'on' : '') + '" id="qDebug"></div></div>');
  add('<div class="toggle-row"><span>Auto-attach files</span><div class="switch ' + (cfg.autoAttach !== false ? 'on' : '') + '" id="qAutoAtt"></div></div>');
  add('<div class="row-btns"><button class="primary" onclick="saveQuickConfig()">Apply quick changes</button></div>');

  function bindSwitch(id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('click', function(){ el.classList.toggle('on'); });
  }
  bindSwitch('qSumPh'); bindSwitch('qDebug'); bindSwitch('qAutoAtt');
}

window.saveQuickConfig = function() {
  var current;
  try { current = JSON.parse(document.getElementById('cfgJson').value || '{}'); }
  catch(e) { current = {}; }
  function val(id) { var el = document.getElementById(id); return el ? el.value : ''; }
  function on(id) { var el = document.getElementById(id); return el && el.classList.contains('on'); }
  var v;
  v = val('qDefMod').trim();  current.defaultModel = v || null;
  v = val('qDefAgent').trim(); current.defaultAgent = v || null;
  v = val('qCtxLim').trim();   current.contextLimit = v === '' ? null : parseInt(v, 10);
  v = val('qToolRnd').trim();  current.toolRoundLimit = v === '' ? 40 : parseInt(v, 10);
  v = val('qSumTr').trim();    current.summarizeTriggerPercent = v === '' ? 65 : parseInt(v, 10);
  current.summaryPhases = on('qSumPh');
  current.debug = on('qDebug');
  current.autoAttach = on('qAutoAtt');
  document.getElementById('cfgJson').value = JSON.stringify(current, null, 2);
  saveConfig();
};

// ─── Agents & Skills tabs ────────────────────────────────────
function loadAgents() {
  fetch('/api/agents').then(function(r){return r.json();}).then(function(d){
    var host = document.getElementById('agentsList');
    host.innerHTML = '';
    if (!d.agents || d.agents.length === 0) {
      host.innerHTML = '<div class="pane-section"><p>No agents yet. Create one with <code>/newagent</code>.</p></div>';
      return;
    }
    d.agents.forEach(function(a){
      var div = document.createElement('div');
      div.className = 'item';
      div.innerHTML = '<div class="ti">' + esc(a.name) + '</div>' +
        (a.description ? '<div class="ds">' + esc(a.description) + '</div>' : '');
      div.addEventListener('click', function(){
        openFile(a.path);
        sendCmd('/' + a.key);
      });
      host.appendChild(div);
    });
  });
}

function loadSkills() {
  fetch('/api/skills').then(function(r){return r.json();}).then(function(d){
    var host = document.getElementById('skillsList');
    host.innerHTML = '';
    if (!d.skills || d.skills.length === 0) {
      host.innerHTML = '<div class="pane-section"><p>No skills yet. Create one with <code>/newskill</code>.</p></div>';
      return;
    }
    d.skills.forEach(function(s){
      var div = document.createElement('div');
      div.className = 'item';
      div.innerHTML = '<div class="ti">' + esc(s.name) + '</div>' +
        (s.description ? '<div class="ds">' + esc(s.description) + '</div>' : '');
      div.addEventListener('click', function(){ openFile(s.path); });
      host.appendChild(div);
    });
  });
}

// ─── Quick actions: upload + voice record ────────────────────

function uploadBlob(blob, filename, targetDir) {
  return fetch('/api/upload', {
    method: 'POST',
    headers: {
      'Content-Type': blob.type || 'application/octet-stream',
      'X-Filename': encodeURIComponent(filename),
      'X-Target-Dir': encodeURIComponent(targetDir || 'uploads'),
    },
    body: blob,
  }).then(function(r){ return r.json(); }).then(function(d){
    if (d.error) throw new Error(d.error);
    return d.path;
  });
}

window.pickAndUpload = function() {
  var inp = document.getElementById('qaFile');
  inp.value = '';
  inp.onchange = function() {
    var files = Array.from(inp.files || []);
    if (!files.length) return;
    uploadFileList(files, 'uploads');
  };
  inp.click();
};

async function uploadFileList(files, targetDir) {
  var paths = [];
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    showToast('Uploading ' + f.name + '…');
    try {
      var p = await uploadBlob(f, f.name, targetDir);
      paths.push(p);
    } catch (e) {
      showToast('Upload failed: ' + e.message, 'err');
    }
  }
  if (paths.length) {
    loadTree();
    // Send "@path1 @path2 " to terminal so user can keep typing
    if (ws && ws.readyState === 1) {
      ws.send(paths.map(function(p){ return '@' + p; }).join(' ') + ' ');
    }
    showToast(paths.length + ' file' + (paths.length > 1 ? 's' : '') + ' attached');
    term.focus();
  }
}

// ─── Drag-drop on terminal area ──────────────────────────────
(function setupDropZone(){
  var center = document.getElementById('center');
  var ov = document.getElementById('dropOverlay');
  var depth = 0;
  function show(){ ov.classList.add('on'); }
  function hide(){ ov.classList.remove('on'); depth = 0; }
  center.addEventListener('dragenter', function(e){
    if (!e.dataTransfer || !e.dataTransfer.types || e.dataTransfer.types.indexOf('Files') < 0) return;
    e.preventDefault(); depth++; show();
  });
  center.addEventListener('dragover', function(e){
    if (!e.dataTransfer || !e.dataTransfer.types || e.dataTransfer.types.indexOf('Files') < 0) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
  });
  center.addEventListener('dragleave', function(e){
    depth--; if (depth <= 0) hide();
  });
  center.addEventListener('drop', function(e){
    if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) { hide(); return; }
    e.preventDefault(); hide();
    uploadFileList(Array.from(e.dataTransfer.files), 'uploads');
  });
})();

// ─── Audio recording (16 kHz mono WAV for Whisper) ───────────
var recState = null;

window.toggleRecord = async function() {
  if (recState) return stopRecording();
  await startRecording();
};

async function startRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showToast('Microphone API not available (use HTTPS or localhost)', 'err');
    return;
  }
  try {
    var stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    var Ctx = window.AudioContext || window.webkitAudioContext;
    var ctx = new Ctx({ sampleRate: 16000 });
    // Resume in case of autoplay policy
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch(_){} }
    var src = ctx.createMediaStreamSource(stream);
    var proc = ctx.createScriptProcessor(4096, 1, 1);
    var chunks = [];
    proc.onaudioprocess = function(e) {
      var d = e.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(d));
    };
    src.connect(proc);
    proc.connect(ctx.destination);
    var startedAt = Date.now();
    recState = { stream: stream, ctx: ctx, src: src, proc: proc, chunks: chunks, sr: ctx.sampleRate, startedAt: startedAt };
    document.getElementById('qaRec').classList.add('on');
    document.getElementById('recDot').classList.add('on');
    document.getElementById('recTime').classList.add('on');
    recState.timer = setInterval(function(){
      var sec = Math.floor((Date.now() - startedAt) / 1000);
      var m = Math.floor(sec / 60), s = sec % 60;
      document.getElementById('recTime').textContent = m + ':' + (s < 10 ? '0' : '') + s;
    }, 250);
    showToast('Recording… click again to stop');
  } catch (e) {
    showToast('Mic permission: ' + e.message, 'err');
  }
}

async function stopRecording() {
  var r = recState; if (!r) return;
  recState = null;
  document.getElementById('qaRec').classList.remove('on');
  document.getElementById('recDot').classList.remove('on');
  document.getElementById('recTime').classList.remove('on');
  document.getElementById('recTime').textContent = '';
  clearInterval(r.timer);
  try { r.proc.disconnect(); } catch(_){}
  try { r.src.disconnect(); } catch(_){}
  try { r.stream.getTracks().forEach(function(t){ t.stop(); }); } catch(_){}
  try { await r.ctx.close(); } catch(_){}

  var len = 0; for (var i = 0; i < r.chunks.length; i++) len += r.chunks[i].length;
  if (len < r.sr / 4) { showToast('Too short (< 250 ms)', 'warn'); return; }
  var merged = new Float32Array(len);
  var off = 0;
  for (var j = 0; j < r.chunks.length; j++) { merged.set(r.chunks[j], off); off += r.chunks[j].length; }
  var wav = encodeWAV(merged, r.sr);
  var stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  showToast('Uploading recording…');
  try {
    var rel = await uploadBlob(new Blob([wav], { type: 'audio/wav' }),
                               'rec-' + stamp + '.wav',
                               '.sapper/voice/incoming');
    loadTree();
    sendCmd('/voice file ' + rel);
    showToast('Sent to Sapper for transcription');
  } catch (e) {
    showToast('Upload failed: ' + e.message, 'err');
  }
}

function encodeWAV(samples, sampleRate) {
  var bytesPerSample = 2;
  var buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  var view = new DataView(buffer);
  function writeStr(o, s) { for (var i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); }
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);    // PCM
  view.setUint16(22, 1, true);    // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, samples.length * bytesPerSample, true);
  var o = 44;
  for (var i = 0; i < samples.length; i++) {
    var s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    o += 2;
  }
  return buffer;
}

window.sendOpenPrompt = async function() {
  var v = await showModal({
    title: 'Open file in Sapper',
    label: 'Path',
    placeholder: 'src/index.ts',
    okLabel: 'Open',
  });
  if (v == null || !v.trim()) return;
  sendCmd('/open ' + v.trim());
};

// ─── Boot ────────────────────────────────────────────────────
connectPty();
connectEvents();
loadTree();
setupResizers();

function setupResizers() {
  initResizer('sideRes', 'side', 'right');   // drag adjusts #side width
  initResizer('prevRes', 'preview', 'left'); // drag adjusts #preview width
  // Hide preview resizer while preview is hidden
  updateResizerVisibility();
}
function updateResizerVisibility() {
  var prev = document.getElementById('preview');
  var pr = document.getElementById('prevRes');
  if (pr) pr.classList.toggle('hidden', prev.classList.contains('hidden'));
  var side = document.getElementById('side');
  var sr = document.getElementById('sideRes');
  if (sr) sr.classList.toggle('hidden', side.classList.contains('hidden'));
}
function initResizer(barId, paneId, edge) {
  var bar = document.getElementById(barId);
  var pane = document.getElementById(paneId);
  if (!bar || !pane) return;
  bar.addEventListener('mousedown', function(ev){
    if (pane.classList.contains('hidden')) return;
    ev.preventDefault();
    bar.classList.add('active');
    document.body.classList.add('resizing');
    var startX = ev.clientX;
    var startW = pane.getBoundingClientRect().width;
    function move(e){
      var dx = e.clientX - startX;
      var w = edge === 'right' ? startW + dx : startW - dx;
      w = Math.max(180, Math.min(window.innerWidth - 320, w));
      pane.style.width = w + 'px';
      try { fit.fit(); } catch(e){}
      if (cm) try { cm.refresh(); } catch(e){}
    }
    function up(){
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      bar.classList.remove('active');
      document.body.classList.remove('resizing');
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
  // double-click to reset
  bar.addEventListener('dblclick', function(){
    pane.style.width = '';
    try { fit.fit(); } catch(e){}
    if (cm) try { cm.refresh(); } catch(e){}
  });
}
</script>
</body>
</html>`;
}

// ─── HTTP routes ─────────────────────────────────────────────────

function json(res, data, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readReqJSON(req) {
  return new Promise((resolve) => {
    let body = ''; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 5 * 1024 * 1024) { req.destroy(); resolve({ _err: 'too large' }); return; } body += c; });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function listEntries(dirPath) {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return entries
      .filter(e => !IGNORE_NAMES.has(e.name))
      .map(e => ({ name: e.name, isDir: e.isDirectory() }))
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : (a.isDir ? -1 : 1)));
  } catch { return []; }
}

function looksBinary(buf) {
  const len = Math.min(buf.length, 4096);
  let nonText = 0;
  for (let i = 0; i < len; i++) {
    const c = buf[i];
    if (c === 0) return true;
    if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c >= 127) nonText++;
  }
  return nonText / Math.max(len, 1) > 0.3;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    // Pages
    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buildHTML());
      return;
    }
    if (req.method === 'GET' && path === '/health') return json(res, { ok: true, cwd: workingDir });

    // ── Tree
    if (req.method === 'GET' && path === '/api/tree') {
      const rel = url.searchParams.get('path') || '';
      const abs = safePath(rel);
      if (!abs) return json(res, { error: 'invalid path' }, 400);
      return json(res, { path: rel, entries: listEntries(abs) });
    }

    // ── File read (text)
    if (req.method === 'GET' && path === '/api/file') {
      const rel = url.searchParams.get('path') || '';
      const abs = safePath(rel);
      if (!abs) return json(res, { error: 'invalid path' }, 400);
      try {
        const stat = fs.statSync(abs);
        if (stat.isDirectory()) return json(res, { error: 'is a directory' }, 400);
        if (stat.size > 2 * 1024 * 1024) return json(res, { error: 'file too large (>2MB)', size: stat.size, binary: true }, 200);
        const buf = fs.readFileSync(abs);
        if (looksBinary(buf)) return json(res, { binary: true, size: stat.size });
        const text = buf.toString('utf8');
        // seed snapshot so a subsequent edit can produce a diff
        if (!snapshots.has(rel) && stat.size <= SNAP_MAX_BYTES) {
          snapshots.set(rel, { prev: null, curr: text });
        }
        return json(res, { content: text, size: stat.size });
      } catch (e) { return json(res, { error: e.message }, 500); }
    }

    // ── Diff: compare last-known snapshot vs current content
    if (req.method === 'GET' && path === '/api/diff') {
      const rel = url.searchParams.get('path') || '';
      const abs = safePath(rel);
      if (!abs) return json(res, { error: 'invalid path' }, 400);
      const snap = snapshots.get(rel);
      let curr = '';
      try {
        if (fs.existsSync(abs)) {
          const st = fs.statSync(abs);
          if (st.isFile() && st.size <= SNAP_MAX_BYTES) {
            const buf = fs.readFileSync(abs);
            if (!looksBinary(buf)) curr = buf.toString('utf8');
            else return json(res, { error: 'binary file' }, 200);
          } else if (st.size > SNAP_MAX_BYTES) {
            return json(res, { error: 'file too large for diff (>' + Math.round(SNAP_MAX_BYTES/1024) + 'KB)' }, 200);
          }
        }
      } catch (e) { return json(res, { error: e.message }, 500); }
      if (!snap || snap.prev == null) {
        return json(res, { prev: null, curr, message: 'No prior snapshot — open the file again before the next change to enable diff.' });
      }
      return json(res, { prev: snap.prev, curr });
    }

    // ── File raw (images)
    if (req.method === 'GET' && path === '/api/file/raw') {
      const rel = url.searchParams.get('path') || '';
      const abs = safePath(rel);
      if (!abs) { res.writeHead(400); return res.end('invalid path'); }
      try {
        const ext = (rel.split('.').pop() || '').toLowerCase();
        const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon' }[ext] || 'application/octet-stream';
        const buf = fs.readFileSync(abs);
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
        return res.end(buf);
      } catch (e) { res.writeHead(500); return res.end(e.message); }
    }

    // ── File write
    if (req.method === 'POST' && path === '/api/file') {
      const body = await readReqJSON(req);
      const abs = safePath(body.path);
      if (!abs) return json(res, { error: 'invalid path' }, 400);
      try {
        ensureDir(dirname(abs));
        fs.writeFileSync(abs, body.content == null ? '' : String(body.content));
        return json(res, { ok: true });
      } catch (e) { return json(res, { error: e.message }, 500); }
    }

    // ── Create file or folder
    if (req.method === 'POST' && path === '/api/fs/new') {
      const body = await readReqJSON(req);
      const abs = safePath(body.path);
      if (!abs) return json(res, { error: 'invalid path' }, 400);
      try {
        if (fs.existsSync(abs)) return json(res, { error: 'already exists' }, 409);
        if (body.kind === 'folder') {
          fs.mkdirSync(abs, { recursive: true });
        } else {
          ensureDir(dirname(abs));
          fs.writeFileSync(abs, body.content == null ? '' : String(body.content));
        }
        return json(res, { ok: true, path: body.path });
      } catch (e) { return json(res, { error: e.message }, 500); }
    }

    // ── Rename / move
    if (req.method === 'POST' && path === '/api/fs/rename') {
      const body = await readReqJSON(req);
      const from = safePath(body.from);
      const to = safePath(body.to);
      if (!from || !to) return json(res, { error: 'invalid path' }, 400);
      try {
        if (!fs.existsSync(from)) return json(res, { error: 'source not found' }, 404);
        if (fs.existsSync(to)) return json(res, { error: 'destination exists' }, 409);
        ensureDir(dirname(to));
        fs.renameSync(from, to);
        return json(res, { ok: true });
      } catch (e) { return json(res, { error: e.message }, 500); }
    }

    // ── Duplicate
    if (req.method === 'POST' && path === '/api/fs/duplicate') {
      const body = await readReqJSON(req);
      const from = safePath(body.from);
      if (!from) return json(res, { error: 'invalid path' }, 400);
      try {
        if (!fs.existsSync(from)) return json(res, { error: 'source not found' }, 404);
        // build target name: foo.txt -> foo copy.txt, foo copy.txt -> foo copy 2.txt
        const dir = dirname(from);
        const base = from.slice(dir.length + 1);
        const dot = base.lastIndexOf('.');
        const stem = (dot > 0) ? base.slice(0, dot) : base;
        const ext = (dot > 0) ? base.slice(dot) : '';
        let target = '';
        for (let i = 0; i < 1000; i++) {
          const suffix = (i === 0) ? ' copy' : (' copy ' + (i + 1));
          const candidate = dir + '/' + stem + suffix + ext;
          if (!fs.existsSync(candidate)) { target = candidate; break; }
        }
        if (!target) return json(res, { error: 'too many copies' }, 500);
        fs.cpSync(from, target, { recursive: true });
        return json(res, { ok: true, path: relative(workingDir, target).split(sep).join('/') });
      } catch (e) { return json(res, { error: e.message }, 500); }
    }

    // ── Delete (move to .sapper/.trash for safety)
    if (req.method === 'POST' && path === '/api/fs/delete') {
      const body = await readReqJSON(req);
      const abs = safePath(body.path);
      if (!abs) return json(res, { error: 'invalid path' }, 400);
      if (abs === workingDir) return json(res, { error: 'cannot delete workspace root' }, 400);
      try {
        if (!fs.existsSync(abs)) return json(res, { error: 'not found' }, 404);
        if (body.hard) {
          fs.rmSync(abs, { recursive: true, force: true });
        } else {
          const trashDir = join(SAPPER_DIR, '.trash');
          ensureDir(trashDir);
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const name = body.path.split('/').pop() || 'item';
          const target = join(trashDir, stamp + '__' + name);
          fs.renameSync(abs, target);
        }
        return json(res, { ok: true });
      } catch (e) { return json(res, { error: e.message }, 500); }
    }

    // ── Reveal in OS file manager
    if (req.method === 'POST' && path === '/api/fs/reveal') {
      const body = await readReqJSON(req);
      const abs = safePath(body.path);
      if (!abs) return json(res, { error: 'invalid path' }, 400);
      try {
        if (process.platform === 'darwin') spawn('open', ['-R', abs]);
        else if (process.platform === 'win32') spawn('explorer', ['/select,' + abs]);
        else spawn('xdg-open', [dirname(abs)]);
        return json(res, { ok: true });
      } catch (e) { return json(res, { error: e.message }, 500); }
    }

    // ── Upload (raw body; headers carry filename + target dir)
    if (req.method === 'POST' && path === '/api/upload') {
      try {
        let name = decodeURIComponent(req.headers['x-filename'] || 'upload.bin');
        let dir = decodeURIComponent(req.headers['x-target-dir'] || 'uploads');
        // sanitize filename (strip slashes), keep extension
        name = name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 200) || 'upload.bin';
        dir = dir.replace(/^[\\/]+/, '');
        const absDir = safePath(dir);
        if (!absDir) return json(res, { error: 'invalid target dir' }, 400);
        ensureDir(absDir);
        let target = join(absDir, name);
        // de-dupe if exists
        if (fs.existsSync(target)) {
          const dot = name.lastIndexOf('.');
          const stem = dot > 0 ? name.slice(0, dot) : name;
          const ext = dot > 0 ? name.slice(dot) : '';
          for (let i = 1; i < 1000; i++) {
            const cand = join(absDir, stem + '-' + i + ext);
            if (!fs.existsSync(cand)) { target = cand; break; }
          }
        }
        const ws = fs.createWriteStream(target);
        let size = 0; let aborted = false;
        const MAX = 50 * 1024 * 1024;
        req.on('data', (c) => {
          size += c.length;
          if (size > MAX && !aborted) {
            aborted = true;
            ws.destroy();
            try { fs.unlinkSync(target); } catch {}
            json(res, { error: 'upload too large (>50MB)' }, 413);
            req.destroy();
          }
        });
        req.pipe(ws);
        await new Promise((resolve, reject) => {
          ws.on('finish', resolve);
          ws.on('error', reject);
          req.on('error', reject);
        });
        if (aborted) return;
        const rel = relative(workingDir, target).split(sep).join('/');
        return json(res, { ok: true, path: rel, size });
      } catch (e) { return json(res, { error: e.message }, 500); }
    }

    // ── Config read/write
    if (req.method === 'GET' && path === '/api/config') {
      return json(res, { config: readJSON(CONFIG_FILE, {}), path: relative(workingDir, CONFIG_FILE) });
    }
    if (req.method === 'POST' && path === '/api/config') {
      const body = await readReqJSON(req);
      try {
        ensureDir(SAPPER_DIR);
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(body.config || {}, null, 2));
        return json(res, { ok: true });
      } catch (e) { return json(res, { error: e.message }, 500); }
    }

    // ── Agents / Skills
    if (req.method === 'GET' && path === '/api/agents') return json(res, { agents: listMdDir(AGENTS_DIR) });
    if (req.method === 'GET' && path === '/api/skills') return json(res, { skills: listMdDir(SKILLS_DIR) });

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
});

// ─── WebSockets: /ws (pty) and /events (fs watcher) ──────────────

const wssPty = new WebSocketServer({ noServer: true });
const wssEvents = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, sock, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/ws') {
    wssPty.handleUpgrade(req, sock, head, (ws) => wssPty.emit('connection', ws, req));
  } else if (url.pathname === '/events') {
    wssEvents.handleUpgrade(req, sock, head, (ws) => wssEvents.emit('connection', ws, req));
  } else {
    sock.destroy();
  }
});

function spawnSapper(cols, rows) {
  return ptySpawn(process.execPath, [SAPPER_BIN], {
    name: 'xterm-256color',
    cols: cols || 100, rows: rows || 30,
    cwd: workingDir,
    env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '1', COLORTERM: 'truecolor' },
  });
}

wssPty.on('connection', (ws) => {
  dbg('pty client connected');
  let pty = null; let initialized = false;

  function start(cols, rows) {
    if (pty) { try { pty.kill(); } catch {} }
    try { pty = spawnSapper(cols, rows); }
    catch (e) {
      console.error('[ui] spawn failed:', e.message);
      try { ws.send(Buffer.from('\x1b[31mFailed to spawn sapper: ' + e.message + '\x1b[0m\r\n', 'utf8')); } catch {}
      return;
    }
    dbg('pty pid=' + pty.pid + ' ' + cols + 'x' + rows);
    pty.onData((d) => { if (ws.readyState === ws.OPEN) ws.send(Buffer.from(d, 'utf8')); });
    pty.onExit(({ exitCode, signal }) => {
      dbg('pty exit code=' + exitCode);
      if (ws.readyState === ws.OPEN) { try { ws.send(JSON.stringify({ type: 'exit', code: exitCode, signal })); } catch {} }
    });
    try { ws.send(JSON.stringify({ type: 'cwd', path: workingDir })); } catch {}
  }

  ws.on('message', (raw, isBinary) => {
    const str = raw.toString('utf8');
    if (!isBinary && str.startsWith('{')) {
      try {
        const m = JSON.parse(str);
        if (m.type === 'init') { if (!initialized) { initialized = true; start(m.cols, m.rows); } return; }
        if (m.type === 'resize' && pty) { try { pty.resize(m.cols || 100, m.rows || 30); } catch {} return; }
        if (m.type === 'restart') { initialized = true; start(100, 30); return; }
      } catch {}
    }
    if (pty) pty.write(str);
  });

  ws.on('close', () => { if (pty) { try { pty.kill(); } catch {} pty = null; } });
});

// ── FS watcher: broadcast to all /events clients ─────────────────

let watcher = null;
const eventsClients = new Set();
const recentEvents = new Map(); // path -> timestamp (dedupe burst events)
const knownPaths = new Set(); // paths we have seen exist (for create vs delete detection)
const recentActivity = []; // last N classified events for late-joining clients
const SNAP_MAX_BYTES = 512 * 1024; // per-file snapshot cap (512KB)
const SNAP_MAX_FILES = 200;
const snapshots = new Map(); // path -> { prev: string|null, curr: string }

function isSnapshottable(abs) {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return false;
    if (st.size > SNAP_MAX_BYTES) return false;
    return true;
  } catch { return false; }
}

function readTextMaybe(abs) {
  try {
    const buf = fs.readFileSync(abs);
    // Quick binary probe: count NULs in first 4KB
    const slice = buf.subarray(0, Math.min(buf.length, 4096));
    for (let i = 0; i < slice.length; i++) if (slice[i] === 0) return null;
    return buf.toString('utf8');
  } catch { return null; }
}

function bumpSnapshot(rel, abs, kind) {
  if (kind === 'deleted') {
    const prev = snapshots.get(rel);
    if (prev) snapshots.set(rel, { prev: prev.curr, curr: '' });
    return;
  }
  if (!isSnapshottable(abs)) return;
  const text = readTextMaybe(abs);
  if (text == null) return;
  const existing = snapshots.get(rel);
  if (existing) {
    if (existing.curr === text) return; // no actual change
    snapshots.set(rel, { prev: existing.curr, curr: text });
  } else {
    // first time we see this file — no prior version available
    snapshots.set(rel, { prev: null, curr: text });
  }
  // simple LRU-ish cap
  if (snapshots.size > SNAP_MAX_FILES) {
    const firstKey = snapshots.keys().next().value;
    if (firstKey) snapshots.delete(firstKey);
  }
}

function classifyEvent(rawEvent, rel, abs) {
  // fs.watch only gives 'rename' or 'change'
  const exists = fs.existsSync(abs);
  if (rawEvent === 'change') return exists ? 'modified' : 'deleted';
  // 'rename' = created, deleted, or moved-in/out
  if (!exists) return 'deleted';
  return knownPaths.has(rel) ? 'modified' : 'created';
}

function seedKnownPaths(dir, rel = '') {
  try {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (IGNORE_NAMES.has(ent.name)) continue;
      const sub = rel ? rel + '/' + ent.name : ent.name;
      knownPaths.add(sub);
      if (ent.isDirectory() && knownPaths.size < 20000) {
        seedKnownPaths(join(dir, ent.name), sub);
      }
    }
  } catch {}
}

function startWatcher() {
  seedKnownPaths(workingDir);
  try {
    watcher = fs.watch(workingDir, { recursive: true }, (event, filename) => {
      if (!filename) return;
      // Normalize to forward slashes, skip ignored
      const rel = filename.split(sep).join('/');
      const top = rel.split('/')[0];
      if (IGNORE_NAMES.has(top)) return;
      const now = Date.now();
      const last = recentEvents.get(rel) || 0;
      if (now - last < 250) return; // dedupe
      recentEvents.set(rel, now);
      if (recentEvents.size > 500) { // bounded
        const cutoff = now - 10000;
        for (const [k, t] of recentEvents) if (t < cutoff) recentEvents.delete(k);
      }
      const abs = pathResolve(workingDir, rel);
      const kind = classifyEvent(event, rel, abs);
      if (kind === 'deleted') knownPaths.delete(rel);
      else knownPaths.add(rel);
      // capture old/new content snapshot for diff (text files only, async-safe)
      try { bumpSnapshot(rel, abs, kind); } catch {}
      let isDir = false;
      try { isDir = fs.statSync(abs).isDirectory(); } catch {}
      const enriched = { event, kind, path: rel, isDir, ts: now };
      // remember for new clients (cap at 50)
      recentActivity.push(enriched);
      if (recentActivity.length > 50) recentActivity.shift();
      const payload = JSON.stringify(enriched);
      for (const c of eventsClients) {
        if (c.readyState === c.OPEN) { try { c.send(payload); } catch {} }
      }
    });
    dbg('fs.watch started on', workingDir);
  } catch (e) {
    console.error('[ui] fs.watch failed:', e.message);
  }
}

wssEvents.on('connection', (ws) => {
  eventsClients.add(ws);
  dbg('events client connected (total=' + eventsClients.size + ')');
  // Replay last activity so the new tab sees recent changes
  if (recentActivity.length) {
    try { ws.send(JSON.stringify({ type: 'activity-replay', items: recentActivity.slice(-25) })); } catch {}
  }
  if (lastStats) { try { ws.send(lastStats); } catch {} }
  ws.on('close', () => { eventsClients.delete(ws); });
});

// ── System stats poller (RAM + GPU on macOS) ─────────────────────

let lastStats = null;
let statsTimer = null;
let lastCpuSample = null;

function broadcastEvents(payload) {
  for (const c of eventsClients) {
    if (c.readyState === c.OPEN) { try { c.send(payload); } catch {} }
  }
}

function runCmd(cmd, args, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let out = ''; let done = false;
    try {
      const p = spawn(cmd, args);
      const t = setTimeout(() => { if (!done) { done = true; try { p.kill(); } catch {} resolve(''); } }, timeoutMs);
      p.stdout.on('data', (d) => { out += d.toString(); });
      p.on('error', () => { if (!done) { done = true; clearTimeout(t); resolve(''); } });
      p.on('close', () => { if (!done) { done = true; clearTimeout(t); resolve(out); } });
    } catch { resolve(''); }
  });
}

async function readMemMac() {
  // Parse vm_stat. On Apple Silicon page size = 16384, on Intel = 4096.
  const out = await runCmd('vm_stat', []);
  if (!out) return null;
  const pageMatch = out.match(/page size of (\d+)/);
  const pageSize = pageMatch ? parseInt(pageMatch[1], 10) : 4096;
  function pages(name) {
    const m = out.match(new RegExp(name + '[^\\d]+(\\d+)'));
    return m ? parseInt(m[1], 10) : 0;
  }
  const wired = pages('Pages wired down');
  const active = pages('Pages active');
  const compressed = pages('Pages occupied by compressor');
  const used = (wired + active + compressed) * pageSize;
  const total = os.totalmem();
  return { used, total, percent: total > 0 ? Math.round((used / total) * 100) : 0 };
}

async function readGPUMac() {
  // ioreg dumps GPU performance stats including "Device Utilization %"
  const out = await runCmd('ioreg', ['-r', '-c', 'IOAccelerator', '-d', '1', '-w', '0']);
  if (!out) return null;
  const m = out.match(/"Device Utilization %"\s*=\s*(\d+)/);
  if (!m) return null;
  const memMatch = out.match(/"In use system memory"\s*=\s*(\d+)/);
  return {
    percent: parseInt(m[1], 10),
    memBytes: memMatch ? parseInt(memMatch[1], 10) : null,
  };
}

function readCPU() {
  const cpus = os.cpus();
  let idle = 0; let total = 0;
  for (const c of cpus) {
    for (const k of Object.keys(c.times)) total += c.times[k];
    idle += c.times.idle;
  }
  if (!lastCpuSample) { lastCpuSample = { idle, total }; return null; }
  const di = idle - lastCpuSample.idle;
  const dt = total - lastCpuSample.total;
  lastCpuSample = { idle, total };
  if (dt <= 0) return null;
  return { percent: Math.max(0, Math.min(100, Math.round((1 - di / dt) * 100))), cores: cpus.length };
}

async function pollStats() {
  const isMac = process.platform === 'darwin';
  const [mem, gpu] = await Promise.all([
    isMac ? readMemMac() : null,
    isMac ? readGPUMac() : null,
  ]);
  const cpu = readCPU();
  const payload = JSON.stringify({
    type: 'stats', ts: Date.now(),
    platform: process.platform,
    cpu, mem, gpu,
    totalMem: os.totalmem(),
  });
  lastStats = payload;
  if (eventsClients.size > 0) broadcastEvents(payload);
}

function startStatsPoll() {
  pollStats(); // first sample primes cpu delta
  statsTimer = setInterval(pollStats, 1500);
}

// ─── Launch ──────────────────────────────────────────────────────

const PORT_RETRY_LIMIT = parseInt(process.env.SAPPER_UI_PORT_RETRIES || '20', 10);
const portExplicit = !!process.env.SAPPER_UI_PORT;
let portAttempt = 0;
let activePort = PORT;

function tryListen(port) {
  activePort = port;
  server.listen(port);
}

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE' && portAttempt < PORT_RETRY_LIMIT) {
    portAttempt++;
    const next = activePort + 1;
    const reason = portExplicit
      ? `port ${activePort} (from SAPPER_UI_PORT) is in use`
      : `port ${activePort} is in use`;
    console.log(`  \x1b[33m⚠\x1b[0m  ${reason}, trying ${next}…`);
    setTimeout(() => tryListen(next), 50);
    return;
  }
  console.error(`\n  \x1b[31m✖ Sapper Web failed to start:\x1b[0m ${err && err.message ? err.message : err}`);
  process.exit(1);
});

server.on('listening', () => {
  const url = `http://localhost:${activePort}`;
  console.log(`\n  \x1b[36m⚡ Sapper Web\x1b[0m running at \x1b[1m${url}\x1b[0m`);
  console.log(`  Working dir: ${workingDir}\n`);
  startWatcher();
  startStatsPoll();

  if (process.env.SAPPER_UI_NO_OPEN) return;

  const browsers = [
    ['open', ['-na', 'Google Chrome', '--args', `--app=${url}`, '--new-window']],
    ['open', ['-na', 'Microsoft Edge', '--args', `--app=${url}`]],
    ['open', ['-na', 'Brave Browser', '--args', `--app=${url}`]],
    ['open', [url]],
  ];
  for (const [cmd, args] of browsers) {
    try {
      const p = spawn(cmd, args, { stdio: 'ignore', detached: true });
      p.unref();
      p.on('error', () => {});
      break;
    } catch {}
  }
});

tryListen(PORT);

process.on('SIGINT', () => { console.log('\nShutting down…'); try { watcher && watcher.close(); } catch {} process.exit(0); });
process.on('SIGTERM', () => process.exit(0));
