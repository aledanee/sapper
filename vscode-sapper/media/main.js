// @ts-check
/// <reference lib="dom" />
'use strict';

/** @type {(...args: any[]) => void} */
const vscode = acquireVsCodeApi();

// ── DOM refs ──────────────────────────────────────────────────
const $messages   = /** @type {HTMLDivElement} */ (document.getElementById('messages'));
const $input      = /** @type {HTMLTextAreaElement} */ (document.getElementById('input'));
const $btnSend    = /** @type {HTMLButtonElement} */ (document.getElementById('btn-send'));
const $btnAbort   = /** @type {HTMLButtonElement} */ (document.getElementById('btn-abort'));
const $btnNew     = /** @type {HTMLButtonElement} */ (document.getElementById('btn-new'));
const $btnAgents  = /** @type {HTMLButtonElement} */ (document.getElementById('btn-agents'));
const $modelSel   = /** @type {HTMLSelectElement} */ (document.getElementById('model-select'));
const $statusText = /** @type {HTMLSpanElement} */ (document.getElementById('status-text'));
const $workingDir = /** @type {HTMLSpanElement} */ (document.getElementById('working-dir'));
const $agentPanel = /** @type {HTMLDivElement} */ (document.getElementById('agents-panel'));
const $agentsList = /** @type {HTMLDivElement} */ (document.getElementById('agents-list'));
const $skillsList = /** @type {HTMLDivElement} */ (document.getElementById('skills-list'));
document.getElementById('close-agents')?.addEventListener('click', () => $agentPanel.classList.add('hidden'));

// ── State ─────────────────────────────────────────────────────
let isStreaming = false;
let currentAssistantEl = /** @type {HTMLElement|null} */ (null);
let currentAssistantBody = /** @type {HTMLElement|null} */ (null);
let activeAgent = '';

// ── Helpers ───────────────────────────────────────────────────
function scrollToBottom() {
  $messages.scrollTop = $messages.scrollHeight;
}

function setStatus(text) {
  $statusText.textContent = text;
}

function renderMd(text) {
  // Very light markdown: code blocks, inline code, bold, italic, newlines
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/```([\s\S]*?)```/g, (_, c) => `<pre><code>${c.trim()}</code></pre>`)
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br>');
}

function addMessage(role, text) {
  const wrap = document.createElement('div');
  wrap.className = `message ${role}`;

  const header = document.createElement('div');
  header.className = 'message-header';
  header.textContent = role === 'user' ? '👤 YOU' : '🤖 SAPPER';
  wrap.appendChild(header);

  const body = document.createElement('div');
  body.className = 'message-body';
  body.innerHTML = renderMd(text);
  wrap.appendChild(body);

  $messages.appendChild(wrap);
  scrollToBottom();
  return { wrap, body };
}

function startAssistantMessage() {
  const wrap = document.createElement('div');
  wrap.className = 'message assistant';

  const header = document.createElement('div');
  header.className = 'message-header';
  header.textContent = '🤖 SAPPER';
  wrap.appendChild(header);

  const body = document.createElement('div');
  body.className = 'message-body streaming-cursor';
  wrap.appendChild(body);

  $messages.appendChild(wrap);
  currentAssistantEl = wrap;
  currentAssistantBody = body;
  scrollToBottom();
}

let rawBuffer = '';

function appendChunk(text) {
  if (!currentAssistantBody) { startAssistantMessage(); }
  rawBuffer += text;
  currentAssistantBody.innerHTML = renderMd(rawBuffer);
  scrollToBottom();
}

function finalizeAssistantMessage() {
  if (currentAssistantBody) {
    currentAssistantBody.classList.remove('streaming-cursor');
  }
  currentAssistantEl = null;
  currentAssistantBody = null;
  rawBuffer = '';
}

function addToolCard(tool, path, state) {
  const card = document.createElement('div');
  card.className = `tool-card ${state}`;
  const icons = { READ:'📖', WRITE:'✏️', PATCH:'🔧', LIST:'📂', LS:'📂', SEARCH:'🔍', GREP:'🔍',
                  SHELL:'💻', MKDIR:'📁', FIND:'🔎', CHANGES:'🔀', FETCH:'🌐', MEMORY:'🧠',
                  RMDIR:'🗑️', HEAD:'⬆️', TAIL:'⬇️', CAT:'📄' };
  card.innerHTML = `
    <span class="tool-icon">${icons[tool] || '🔧'}</span>
    <span class="tool-type">${tool}</span>
    <span class="tool-path">${escapeHtml(path || '')}</span>
    ${state === 'running' ? '<span>⏳</span>' : state === 'success' ? '<span>✅</span>' : '<span>❌</span>'}
  `;
  $messages.appendChild(card);
  scrollToBottom();
  return card;
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Tool card map: keyed by "TOOL:path"
const toolCards = {};

// ── Sending messages ──────────────────────────────────────────
function sendChat(text) {
  if (!text.trim()) { return; }

  // Handle slash commands locally
  if (text.trim().startsWith('/new') || text.trim().startsWith('/clear')) {
    vscode.postMessage({ type: 'newSession' });
    return;
  }
  if (text.trim().startsWith('/agent ')) {
    const name = text.trim().slice(7).trim();
    vscode.postMessage({ type: 'setAgent', agent: name });
    return;
  }
  if (text.trim().startsWith('/skill ')) {
    const name = text.trim().slice(7).trim();
    vscode.postMessage({ type: 'addSkill', skill: name });
    return;
  }

  addMessage('user', text);
  startAssistantMessage();
  setIsStreaming(true);
  vscode.postMessage({ type: 'chat', text });
}

function setIsStreaming(streaming) {
  isStreaming = streaming;
  $btnSend.disabled = streaming;
  $btnAbort.classList.toggle('hidden', !streaming);
  $input.disabled = streaming;
  if (!streaming) { $input.focus(); }
}

// ── Event listeners ───────────────────────────────────────────
$btnSend.addEventListener('click', () => {
  const text = $input.value.trim();
  if (!text || isStreaming) { return; }
  $input.value = '';
  autoResize();
  sendChat(text);
});

$input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!isStreaming) { $btnSend.click(); }
  }
});

$input.addEventListener('input', autoResize);

function autoResize() {
  $input.style.height = 'auto';
  $input.style.height = Math.min($input.scrollHeight, 160) + 'px';
}

$btnAbort.addEventListener('click', () => {
  vscode.postMessage({ type: 'abort' });
  finalizeAssistantMessage();
  setIsStreaming(false);
  setStatus('Stopped.');
});

$btnNew.addEventListener('click', () => {
  if (isStreaming) { return; }
  vscode.postMessage({ type: 'newSession' });
});

$modelSel.addEventListener('change', () => {
  const model = $modelSel.value;
  if (model) { vscode.postMessage({ type: 'selectModel', model }); }
});

$btnAgents.addEventListener('click', () => {
  const hidden = $agentPanel.classList.toggle('hidden');
  if (!hidden) {
    vscode.postMessage({ type: 'listAgents' });
    vscode.postMessage({ type: 'listSkills' });
  }
});

// ── Messages from extension ───────────────────────────────────
window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type) {

    case 'models': {
      $modelSel.innerHTML = '<option value="">— select model —</option>';
      for (const m of msg.models) {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m.length > 24 ? m.substring(0, 22) + '…' : m;
        $modelSel.appendChild(opt);
      }
      if (msg.models.length === 0) {
        $modelSel.innerHTML = '<option value="">No models found</option>';
        setStatus('Ollama not running or no models installed.');
      }
      break;
    }

    case 'modelSelected':
      $modelSel.value = msg.model;
      setStatus(`Model: ${msg.model}`);
      break;

    case 'workspaceInfo':
      $workingDir.textContent = msg.workingDir?.split('/').pop() || msg.workingDir;
      $workingDir.title = msg.workingDir;
      break;

    case 'chunk':
      appendChunk(msg.text);
      break;

    case 'status':
      if (msg.status === 'idle') {
        finalizeAssistantMessage();
        setIsStreaming(false);
        setStatus(activeAgent ? `Agent: ${activeAgent}` : 'Ready');
      } else if (msg.status === 'thinking') {
        setStatus('Thinking…');
      } else if (msg.status === 'error') {
        finalizeAssistantMessage();
        setIsStreaming(false);
        setStatus('Error');
      } else {
        setStatus(msg.status);
      }
      break;

    case 'toolStart': {
      const key = `${msg.tool}:${msg.path}`;
      const card = addToolCard(msg.tool, msg.path, 'running');
      toolCards[key] = card;
      break;
    }

    case 'toolEnd': {
      const key = `${msg.tool}:${msg.path}`;
      const card = toolCards[key];
      if (card) {
        card.className = `tool-card ${msg.success ? 'success' : 'error'}`;
        const spinner = card.querySelector('span:last-child');
        if (spinner) { spinner.textContent = msg.success ? '✅' : '❌'; }
        delete toolCards[key];
      }
      break;
    }

    case 'cleared':
      $messages.innerHTML = '';
      setStatus('New session started.');
      break;

    case 'agentSet':
      activeAgent = '';
      showInfoMessage(msg.message);
      break;

    case 'skillAdded':
      showInfoMessage(msg.message);
      break;

    case 'agents': {
      $agentsList.innerHTML = '';
      for (const a of msg.agents) {
        const el = document.createElement('div');
        el.className = 'agent-item';
        el.innerHTML = `<div class="item-name">${escapeHtml(a.name)}</div><div class="item-desc">${escapeHtml(a.description)}</div>`;
        el.addEventListener('click', () => {
          activeAgent = a.name;
          vscode.postMessage({ type: 'setAgent', agent: a.name.toLowerCase() });
          $agentPanel.classList.add('hidden');
          document.querySelectorAll('.agent-item').forEach((x) => x.classList.remove('active'));
          el.classList.add('active');
        });
        $agentsList.appendChild(el);
      }
      if (msg.agents.length === 0) {
        $agentsList.innerHTML = '<div style="font-size:11px;opacity:0.5;padding:4px">No agents found in .sapper/agents/</div>';
      }
      break;
    }

    case 'skills': {
      $skillsList.innerHTML = '';
      for (const s of msg.skills) {
        const el = document.createElement('div');
        el.className = 'skill-item';
        el.innerHTML = `<div class="item-name">${escapeHtml(s.name)}</div><div class="item-desc">${escapeHtml(s.description)}</div>`;
        el.addEventListener('click', () => {
          vscode.postMessage({ type: 'addSkill', skill: s.name.toLowerCase() });
          $agentPanel.classList.add('hidden');
        });
        $skillsList.appendChild(el);
      }
      if (msg.skills.length === 0) {
        $skillsList.innerHTML = '<div style="font-size:11px;opacity:0.5;padding:4px">No skills found in .sapper/skills/</div>';
      }
      break;
    }

    case 'error':
      finalizeAssistantMessage();
      setIsStreaming(false);
      addMessage('assistant', `❌ ${msg.message}`);
      setStatus('Error');
      break;
  }
});

function showInfoMessage(text) {
  const div = document.createElement('div');
  div.style.cssText = 'font-size:11px;padding:6px 10px;border-radius:4px;background:var(--tool-bg);margin:4px 0;';
  div.textContent = `ℹ️ ${text}`;
  $messages.appendChild(div);
  scrollToBottom();
}

// ── Init ──────────────────────────────────────────────────────
vscode.postMessage({ type: 'ready' });
$input.focus();
setStatus('Connecting to Ollama…');
