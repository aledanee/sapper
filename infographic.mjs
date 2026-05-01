#!/usr/bin/env node
// Sapper — Terminal Infographic
// Run with: node infographic.mjs

import chalk from 'chalk';

const W = 72; // total width including borders

const hl  = chalk.cyan.bold;       // border / headers
const dim = chalk.gray;            // secondary text
const em  = chalk.white.bold;      // emphasis
const grn = chalk.green.bold;      // green labels
const yel = chalk.yellow.bold;     // yellow labels
const blu = chalk.blue.bold;       // blue labels
const mag = chalk.magenta.bold;    // magenta labels
const red = chalk.red.bold;        // red labels
const cyn = chalk.cyan;            // cyan regular

// ── primitives ──────────────────────────────────────────────────────

function hbar(l, mid, r, char = '─') {
  return hl(l + char.repeat(W - 2) + r);
}

function tee(l, c, r) {
  return hbar(l, c, r);
}

function cell(text, width, align = 'left') {
  const plain = text.replace(/\u001b\[[0-9;]*m/g, '');
  const pad   = Math.max(0, width - plain.length);
  if (align === 'center') {
    const lp = Math.floor(pad / 2);
    const rp  = pad - lp;
    return ' '.repeat(lp) + text + ' '.repeat(rp);
  }
  if (align === 'right') return ' '.repeat(pad) + text;
  return text + ' '.repeat(pad);
}

function row(...cols) {
  // cols: array of [text, width]
  let inner = cols.map(([t, w]) => cell(t, w)).join(hl('│'));
  return hl('│') + inner + hl('│');
}

function fullRow(text, align = 'center') {
  return hl('│') + cell(text, W - 2, align) + hl('│');
}

function blank() {
  return hl('│') + ' '.repeat(W - 2) + hl('│');
}

// ── content ─────────────────────────────────────────────────────────

const lines = [];

const push = (l) => lines.push(l);

// ── HEADER ──
push('');
push(hbar('╔', '═', '╗', '═'));
push(fullRow(''));
push(fullRow(em('  S  A  P  P  E  R'), 'center'));
push(fullRow(cyn('Terminal-first AI Coding Assistant'), 'center'));
push(fullRow(dim('v1.1.38  ·  MIT  ·  Node.js ≥ 16  ·  Ollama'), 'center'));
push(fullRow(''));
push(tee('╠', '╬', '╣', '═'));

// ── STARTUP SCREEN ──
push(fullRow(''));
push(fullRow(yel('[ STARTUP — Session Dashboard ]'), 'center'));
push(fullRow(''));

const col3 = Math.floor((W - 5) / 3);   // three equal columns, 2 separators + 2 borders
const col3r = W - 2 - (col3 * 2) - 2;  // remainder to last col

push(row(
  [grn(' Workspace'), col3],
  [grn(' Runtime'), col3],
  [grn(' Agents & Memory'), col3r]
));
push(row(
  [dim(' 5 files  ·  0 symbols'), col3],
  [dim(' tools limit: 40 rounds'), col3],
  [dim(' agents: 3  ·  skills: 2'), col3r]
));
push(row(
  [dim(' auto-attach on'), col3],
  [dim(' shell bg mode: auto'), col3],
  [dim(' .sapper/context.json'), col3r]
));
push(row(
  [dim(' /index to refresh'), col3],
  [dim(' heartbeat + phases on'), col3],
  [dim(' embeddings.json recall'), col3r]
));
push(row(
  [dim(' thinking: auto'), col3],
  [dim(' summary trigger: 65 %'), col3],
  [dim(' resume session [y/N]'), col3r]
));
push(fullRow(''));
push(tee('╠', '╬', '╣', '═'));

// ── MODEL SELECTION ──
push(fullRow(''));
push(fullRow(yel('[ MODEL SELECTION — Interactive Picker ]'), 'center'));
push(fullRow(''));

const colA = 40;
const colB = W - 2 - colA - 1;

push(row(
  [grn(' Model'), colA],
  [grn(' Details'), colB]
));
push(row(
  [em(' > gemma4:e4b-mlx-bf16') + dim('  ← selected'), colA],
  [dim(' 14.9 GB  ·  54 m ago'), colB]
));
push(row(
  [dim('   qwen3.6:35b-a3b-coding-nvfp4'), colA],
  [dim(' 20.4 GB  ·  9 d ago'), colB]
));
push(row(
  [dim('   gemma-4-E4B-it-heretic-GGUF'), colA],
  [dim(' 7.48 GB  ·  7.5 B'), colB]
));
push(row(
  [dim('   qwen3-14b-abliterated:q8_0'), colA],
  [dim(' 14.6 GB  ·  14.8 B'), colB]
));
push(row(
  [dim('   qwen3.5:4b-mlx-bf16'), colA],
  [dim(' 8.47 GB  ·  18 d ago'), colB]
));
push(fullRow(dim('   navigate: ↑ ↓  or  j / k     confirm: Enter'), 'center'));
push(fullRow(''));
push(tee('╠', '╬', '╣', '═'));

// ── ACTIVE SESSION ──
push(fullRow(''));
push(fullRow(yel('[ ACTIVE SESSION — Context Bar ]'), 'center'));
push(fullRow(''));

push(row(
  [grn(' Model'), colA],
  [grn(' Context'), colB]
));
push(row(
  [em(' gemma4:e4b-mlx-bf16'), colA],
  [dim(' 35,000 tokens (custom limit)'), colB]
));
push(row(
  [dim(' native tool calling'), colA],
  [dim(' model capacity: 131,072 tokens'), colB]
));
push(fullRow(''));

// context bar graphic  — total visible chars must fit in W-2 = 70
// prefix (31) + bar (N) + suffix (21) = 70  →  N = 18
const barW   = 18;
const filled = Math.max(1, Math.round(barW * 0.02));
const empty  = barW - filled;
const bar    = chalk.green('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
const barLine = '  ' + chalk.cyan('[gemma4]') + ' ' + chalk.gray('[default]') + ' ' + chalk.yellow('[2% ctx]') + '  ' + bar + '  ' + dim('765 / 35,000 tokens');
push(fullRow(barLine, 'left'));
push(fullRow(''));
push(tee('╠', '╬', '╣', '═'));

// ── TOOL CATALOG ──
push(fullRow(''));
push(fullRow(yel('[ TOOL CATALOG — 28 Built-in Tools ]'), 'center'));
push(fullRow(''));

push(row(
  [blu(' FILE SYSTEM'), col3],
  [mag(' SHELL'), col3],
  [red(' GIT & WEB'), col3r]
));
push(row(
  [dim(' READ  WRITE  PATCH'), col3],
  [dim(' SHELL (attached)'), col3],
  [dim(' STATUS  CHANGES'), col3r]
));
push(row(
  [dim(' CAT   HEAD   TAIL'), col3],
  [dim(' SHELL (background)'), col3],
  [dim(' BRANCH  COMMIT  TAG'), col3r]
));
push(row(
  [dim(' LIST   LS   FIND'), col3],
  [dim(' output streaming'), col3],
  [dim(' STASH   PUSH'), col3r]
));
push(row(
  [dim(' SEARCH  GREP  MKDIR'), col3],
  [dim(' chunked read back'), col3],
  [dim(' FETCH  FETCH_MAIN'), col3r]
));
push(row(
  [dim(' RMDIR  CD   PWD'), col3],
  [dim(' ASK   MEMORY'), col3],
  [dim(' FETCH_MULTI  OPEN'), col3r]
));
push(fullRow(''));
push(tee('╠', '╬', '╣', '═'));

// ── WORKFLOW ──
push(fullRow(''));
push(fullRow(yel('[ WORKFLOW — One Prompt Loop ]'), 'center'));
push(fullRow(''));

push(fullRow(
  em('User Prompt') + dim('  ──►  ') +
  grn('Context Builder') + dim('  ──►  ') +
  mag('Ollama API') + dim('  ──►  ') +
  yel('Tool Parser'),
  'center'
));
push(blank());
push(fullRow(
  dim('                    │                        │              │'),
  'center'
));
push(fullRow(
  dim('               Memory Recall            Streaming      Execute'),
  'center'
));
push(fullRow(
  dim('               Embeddings              Response       Approval'),
  'center'
));
push(blank());
push(fullRow(
  dim('                                            └──► loop until done'),
  'center'
));
push(fullRow(''));
push(tee('╠', '╬', '╣', '═'));

// ── .SAPPER FOLDER ──
push(fullRow(''));
push(fullRow(yel('[ .sapper/  —  Per-project Data Folder ]'), 'center'));
push(fullRow(''));

const colH = Math.floor((W - 3) / 2);
const colH2 = W - 2 - colH - 1;

push(row(
  [grn(' File / Folder'), colH],
  [grn(' Purpose'), colH2]
));
push(row(
  [cyn(' config.json'), colH],
  [dim(' Runtime settings (hot-reload while running)'), colH2]
));
push(row(
  [cyn(' context.json'), colH],
  [dim(' Full conversation history for resume'), colH2]
));
push(row(
  [cyn(' embeddings.json'), colH],
  [dim(' Semantic vector memory, cosine recall'), colH2]
));
push(row(
  [cyn(' workspace.json'), colH],
  [dim(' Project file index and dependency graph'), colH2]
));
push(row(
  [cyn(' agents/'), colH],
  [dim(' Custom agent definitions (.md + YAML)'), colH2]
));
push(row(
  [cyn(' skills/'), colH],
  [dim(' Reusable instruction blocks (.md + YAML)'), colH2]
));
push(row(
  [cyn(' logs/'), colH],
  [dim(' Per-session activity audit logs (.md)'), colH2]
));
push(fullRow(''));
push(tee('╠', '╬', '╣', '═'));

// ── FOOTER ──
push(fullRow(''));
push(fullRow(em('  Install') + dim('  →  npm install -g sapper-iq'), 'center'));
push(fullRow(em('  Run    ') + dim('  →  sapper'), 'center'));
push(fullRow(em('  Source ') + dim('  →  github.com/aledanee/sapper'), 'center'));
push(fullRow(em('  Author ') + dim('  →  Ibrahim Ihsan  ·  MIT License'), 'center'));
push(fullRow(''));
push(hbar('╚', '═', '╝', '═'));
push('');

// ── render ──────────────────────────────────────────────────────────
console.log(lines.join('\n'));
