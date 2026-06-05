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
    flex-direction: column; background: var(--bg); overflow: hidden; }
  #term-wrap { flex: 1; min-height: 0; min-width: 0; padding: 6px 0 0 10px;
    overflow: hidden; position: relative; }
  #term-wrap .terminal, #term-wrap .xterm { height: 100% !important; width: 100% !important; }
  .xterm-screen, .xterm-viewport { max-width: 100% !important; }
  .xterm .xterm-viewport { background-color: var(--bg) !important; }
  .xterm-viewport::-webkit-scrollbar { width: 8px; }
  .xterm-viewport::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 4px; }
  .xterm-viewport::-webkit-scrollbar-track { background: transparent; }

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

  #pedit {
    flex: 1; min-height: 0; width: 100%; padding: 12px 14px;
    background: var(--bg); border: none; color: var(--fg);
    font-family: ui-monospace, 'SF Mono', monospace; font-size: 12.5px; line-height: 1.5;
    resize: none; outline: none; display: none;
  }
  #pedit.show { display: block; }
  #pview.hide { display: none; }

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
          <span class="ftb-spacer"></span>
          <button class="ftb" title="Refresh tree" onclick="loadTree()">&#8634;</button>
          <button class="ftb" title="Collapse all" onclick="collapseAll()">&#8676;</button>
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

    <!-- Center: terminal -->
    <main id="center">
      <div id="term-wrap"></div>
    </main>

    <!-- Right: preview -->
    <aside id="preview" class="hidden">
      <div class="ph">
        <span class="pp" id="pPath">No file open</span>
        <button id="pEdit" onclick="startEdit()" style="display:none">Edit</button>
        <button id="pSave" onclick="saveEdit()" class="primary" style="display:none">Save</button>
        <button id="pCancel" onclick="cancelEdit()" style="display:none">Cancel</button>
        <button id="pSrc" onclick="toggleSource()" style="display:none">Source</button>
        <button id="pReload" onclick="reloadPreview()" style="display:none">Reload</button>
        <button onclick="closePreview()">&times;</button>
      </div>
      <div class="ind" id="pInd">File changed on disk — reload to view latest.</div>
      <div id="pview"><div id="empty"><div class="lg">&#128196;</div>Open a file from the sidebar.</div></div>
      <textarea id="pedit" spellcheck="false"></textarea>
    </aside>
  </div>
</div>
<div id="toast"></div>

<script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/xterm-addon-web-links@0.9.0/lib/xterm-addon-web-links.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/highlight.min.js"></script>
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
};

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
  if (!msg || !msg.path) return;
  // Flag the file in the tree
  var row = document.querySelector('.row[data-path="' + cssEscape(msg.path) + '"]');
  if (row) {
    row.classList.add('changed');
    setTimeout(function(){ row.classList.remove('changed'); }, 4000);
  }
  // Refresh tree (parent dir) if a file was added/removed
  if (msg.event === 'rename') {
    var parent = msg.path.split('/').slice(0, -1).join('/');
    refreshDir(parent);
  }
  // If the current preview file changed, auto-refresh (or show indicator if editing)
  if (state.currentFile === msg.path) {
    if (state.editing) {
      document.getElementById('pInd').classList.add('show');
    } else {
      openFile(msg.path, true);
    }
  }
}

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
  setTimeout(doFit, 50);
};
window.togglePreview = function() {
  var p = document.getElementById('preview');
  p.classList.toggle('hidden');
  document.getElementById('btnPrev').classList.toggle('on', !p.classList.contains('hidden'));
  setTimeout(doFit, 50);
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
    row.innerHTML =
      '<span class="chev">' + chev + '</span>' +
      '<span class="ico">' + fileIcon(entry.name, entry.isDir) + '</span>' +
      '<span class="name">' + esc(entry.name) + '</span>' +
      '<span class="badge">&#9679;</span>' +
      '<span class="rmenu" title="Options">&#8943;</span>';
    row.addEventListener('click', function(ev){
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
  items.push({ sep: true });
  items.push({ label: 'Rename\u2026', fn: function(){ renamePrompt(path); } });
  items.push({ label: 'Duplicate', fn: function(){ duplicateItem(path); } });
  items.push({ label: 'Copy path', fn: function(){ copyText(path); showToast('Path copied'); } });
  items.push({ label: 'Copy name', fn: function(){ copyText(path.split('/').pop()); showToast('Name copied'); } });
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

  state.currentFile = path;
  state.editing = false;
  state.showSource = false;
  document.getElementById('pPath').textContent = path;
  document.getElementById('pInd').classList.remove('show');
  document.getElementById('pEdit').style.display = 'none';
  document.getElementById('pSave').style.display = 'none';
  document.getElementById('pCancel').style.display = 'none';
  document.getElementById('pSrc').style.display = 'none';
  document.getElementById('pReload').style.display = 'inline-block';
  document.getElementById('pedit').classList.remove('show');
  document.getElementById('pview').classList.remove('hide');

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
  document.getElementById('pSave').style.display = 'none';
  document.getElementById('pCancel').style.display = 'none';
  document.getElementById('pSrc').style.display = 'none';
  document.getElementById('pReload').style.display = 'none';
  document.getElementById('pedit').classList.remove('show');
  document.getElementById('pview').classList.remove('hide');
};
window.startEdit = function() {
  if (!state.currentFile) return;
  state.editing = true;
  document.getElementById('pedit').value = state.fileOnDisk;
  document.getElementById('pedit').classList.add('show');
  document.getElementById('pview').classList.add('hide');
  document.getElementById('pEdit').style.display = 'none';
  document.getElementById('pSave').style.display = 'inline-block';
  document.getElementById('pCancel').style.display = 'inline-block';
};
window.cancelEdit = function() {
  state.editing = false;
  document.getElementById('pedit').classList.remove('show');
  document.getElementById('pview').classList.remove('hide');
  document.getElementById('pEdit').style.display = 'inline-block';
  document.getElementById('pSave').style.display = 'none';
  document.getElementById('pCancel').style.display = 'none';
  document.getElementById('pInd').classList.remove('show');
};
window.saveEdit = function() {
  if (!state.currentFile) return;
  var content = document.getElementById('pedit').value;
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

// ─── Boot ────────────────────────────────────────────────────
connectPty();
connectEvents();
loadTree();
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
        return json(res, { content: buf.toString('utf8'), size: stat.size });
      } catch (e) { return json(res, { error: e.message }, 500); }
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

function startWatcher() {
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
      const payload = JSON.stringify({ event, path: rel, ts: now });
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

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
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

process.on('SIGINT', () => { console.log('\nShutting down…'); try { watcher && watcher.close(); } catch {} process.exit(0); });
process.on('SIGTERM', () => process.exit(0));
