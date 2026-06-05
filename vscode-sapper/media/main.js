/* ═══════════════════════════════════════════════════════════════
   Sapper – Webview UI  (emoji-free, modern, icon-based)
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();

  // ── DOM refs ─────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const messagesEl   = $('messages');
  const emptyStateEl = $('empty-state');
  const inputEl      = $('input');
  const sendBtn      = $('btn-send');
  const abortBtn     = $('btn-abort');
  const modelSelect  = $('model-select');
  const statusText   = $('status-text');
  const statusDot    = $('status-dot');
  const workingDir   = $('working-dir');
  const settingsModal = $('settings-modal');
  const agentsModal   = $('agents-modal');
  const tabs          = document.querySelectorAll('.tab');
  const tabPanels     = { chat: $('tab-chat'), files: $('tab-files'), changes: $('tab-changes') };
  const changesBadge  = $('changes-badge');
  const changesList   = $('changes-list');
  const changesEmpty  = $('changes-empty');
  const fileTree      = $('file-tree');
  const breadcrumb    = $('breadcrumb');

  const ctxCounter     = $('ctx-counter');
  const attachBar      = $('attach-bar');
  const dropOverlay    = $('drop-overlay');
  const btnAttach      = $('btn-attach');

  // ── Input meta-bar refs ──────────────────────────────────────
  const metaCtxFill  = $('meta-ctx-fill');
  const metaCtxLabel = $('meta-ctx-label');
  const metaMemLabel = $('meta-mem-label');
  const memoryPanel  = $('memory-panel');

  // ── Memory panel state ───────────────────────────────────────
  let memPanelOpen   = false;
  let activeMemTab   = 'recall';

  // ── Inline SVG icon library (no emoji) ───────────────────────
  const ICONS = {
    // tools
    read:     `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>`,
    write:    `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>`,
    patch:    `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>`,
    list:     `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`,
    search:   `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
    shell:    `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`,
    fetch:    `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`,
    folder:   `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 3h6l2 3h10a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/></svg>`,
    trash:    `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>`,
    memory:   `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/></svg>`,
    pwd:      `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M2 12h3M19 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12"/></svg>`,
    file:     `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`,
    // status
    check:    `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>`,
    x:        `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
    // info
    info:     `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
    alert:    `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
    ok:       `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
    // navigation
    up:       `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg>`,
    chevron:  `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>`,
    // user
    user:     `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
    // change actions
    plus:     `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
    edit:     `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>`,
    // quick action
    grid:     `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>`,
    beaker:   `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 3h6M9 3v8l-4.5 9a1 1 0 0 0 .9 1.5h13.2a1 1 0 0 0 .9-1.5L15 11V3"/></svg>`,
    git:      `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/></svg>`,
    cursor:   `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 4l7 18 3-7 7-3z"/></svg>`,
    spinner:  `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" class="spin-svg"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`,
    undo:     `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>`,
  };

  const ic = (name, color) => {
    const svg = ICONS[name] || ICONS.file;
    if (!color) return svg;
    return svg.replace('stroke="currentColor"', `stroke="${color}"`);
  };

  // ── Marked setup ─────────────────────────────────────────────
  if (typeof marked !== 'undefined') {
    marked.setOptions({ gfm: true, breaks: true });
  }
  const renderMd = text => {
    if (typeof marked === 'undefined') return escHtml(text).replace(/\n/g, '<br>');
    try { return marked.parse(text || ''); } catch { return escHtml(text).replace(/\n/g, '<br>'); }
  };
  const escHtml = s => (s || '').replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

  // ── State ─────────────────────────────────────────────────────
  let isStreaming = false;
  let streamEl = null;
  let streamText = '';
  let thinkingEl = null;
  let currentPath = '';
  const fileChanges = [];
  const changedFiles = new Map();
  let attachedFiles = [];    // [{name, path, content, isDir}]
  let editorCtx = null;       // Current VS Code editor context
  let pendingDiff = null;     // {filePath, newContent} for inline apply flow

  // tool-group state (reset per AI response)
  let tgEl = null, tgBody = null, tgTitleEl = null, tgSpinEl = null;
  let tgRows = [];      // [{tool, path, el, startTime, status}]
  let tgCounts = {};    // {TOOL: count}

  // ── Slash command + @ mention state ──────────────────────────
  let suggestionMode = null;   // 'slash' | 'mention'
  let suggestionQuery = '';
  let suggestionSel = 0;
  let workspaceFiles = [];     // populated by workspaceFileSearch
  let suggestionList = [];     // current items

  const SLASH_COMMANDS = [
    { cmd: '/explain', desc: 'Explain this code or file' },
    { cmd: '/fix',     desc: 'Find and fix bugs in this file' },
    { cmd: '/refactor',desc: 'Refactor or improve the code' },
    { cmd: '/tests',   desc: 'Generate unit tests' },
    { cmd: '/docs',    desc: 'Generate documentation comments' },
    { cmd: '/review',  desc: 'Code review with suggestions' },
    { cmd: '/commit',  desc: 'Generate a git commit message' },
    { cmd: '/new',     desc: 'Create a new file or scaffold' },
  ];

  function resetToolGroup() {
    tgEl = null; tgBody = null; tgTitleEl = null; tgSpinEl = null;
    tgRows = []; tgCounts = {};
  }

  // type → accent color
  const TYPE_COLOR = {
    READ:'#4fc1ff', CAT:'#4fc1ff', HEAD:'#4fc1ff', TAIL:'#4fc1ff',
    WRITE:'#89d185', PATCH:'#89d185',
    LIST:'#9da5b4', LS:'#9da5b4', FIND:'#9da5b4', CHANGES:'#9da5b4',
    SEARCH:'#b48cff', GREP:'#b48cff',
    SHELL:'#e5c07b',
    FETCH:'#56b6c2',
    MKDIR:'#e5c07b', RMDIR:'#f14c4c', DELETE:'#f14c4c',
    MEMORY:'#ff8fa3',
    PWD:'#9da5b4',
  };
  // type → short display label
  const TYPE_LABEL = {
    READ:'read', CAT:'read', HEAD:'head', TAIL:'tail',
    WRITE:'write', PATCH:'patch',
    LIST:'list', LS:'ls', FIND:'find', CHANGES:'changes',
    SEARCH:'search', GREP:'grep',
    SHELL:'shell',
    FETCH:'fetch',
    MKDIR:'mkdir', RMDIR:'rmdir', DELETE:'delete',
    MEMORY:'memory',
    PWD:'pwd',
  };

  // ── Tab switching ─────────────────────────────────────────────
  tabs.forEach(tab => tab.addEventListener('click', () => {
    const t = tab.dataset.tab;
    tabs.forEach(x => x.classList.toggle('active', x === tab));
    Object.entries(tabPanels).forEach(([n, el]) => el.classList.toggle('active', n === t));
    if (t === 'files') refreshTree(currentPath);
  }));

  // ── Mode selector ─────────────────────────────────────────────
  let currentMode = 'agent';
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b === btn));
      currentMode = mode;
      vscode.postMessage({ type: 'setMode', mode });
      // In edit mode, auto-attach editor context
      if (mode === 'edit' && editorCtx?.hasEditor) { attachEditorContext(); }
    });
  });

  // ── Quick actions ─────────────────────────────────────────────
  document.querySelectorAll('.quick-btn').forEach(b =>
    b.addEventListener('click', () => { inputEl.value = b.dataset.prompt; inputEl.focus(); }));

  // ── Sessions popover ──────────────────────────────────────────
  const sessionsPopover = $('sessions-popover');
  $('btn-sessions').addEventListener('click', () => {
    const isOpen = !sessionsPopover.classList.contains('hidden');
    closeAllPopovers();
    if (!isOpen) { sessionsPopover.classList.remove('hidden'); vscode.postMessage({ type: 'listSessions' }); }
  });
  $('close-sessions').addEventListener('click', () => sessionsPopover.classList.add('hidden'));
  $('btn-save-session').addEventListener('click', () => {
    const name = $('session-name-input').value.trim();
    if (!name) { addSystemInfo('Enter a session name first.'); return; }
    vscode.postMessage({ type: 'saveSession', name });
  });

  // ── Diagnostics popover ───────────────────────────────────────
  const diagPopover = $('diag-popover');
  $('btn-errors').addEventListener('click', () => {
    const isOpen = !diagPopover.classList.contains('hidden');
    closeAllPopovers();
    if (!isOpen) { diagPopover.classList.remove('hidden'); vscode.postMessage({ type: 'getDiagnostics' }); }
  });
  $('close-diag').addEventListener('click', () => diagPopover.classList.add('hidden'));
  $('btn-inject-errors').addEventListener('click', () => {
    const items = diagPopover._diagItems || [];
    if (items.length === 0) { addSystemInfo('No problems found.'); return; }
    const text = items.map(d => `${d.severity.toUpperCase()}: ${d.file}:${d.line} — ${d.message}`).join('\n');
    inputEl.value = `Please fix these errors:\n\`\`\`\n${text}\n\`\`\``;
    autoResize();
    diagPopover.classList.add('hidden');
    inputEl.focus();
  });

  function closeAllPopovers() {
    sessionsPopover?.classList.add('hidden');
    diagPopover?.classList.add('hidden');
  }

  // ── Undo last button (injected on messages) ───────────────────
  function addUndoButton(msgEl) {
    const btn = document.createElement('button');
    btn.className = 'undo-btn';
    btn.title = 'Undo this response (remove from context)';
    btn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>`;
    btn.addEventListener('click', () => {
      vscode.postMessage({ type: 'undoLast' });
      btn.disabled = true;
    });
    msgEl.appendChild(btn);
  }

  // ── Settings ──────────────────────────────────────────────────
  // Settings tab switching
  document.querySelectorAll('.stab').forEach(stab => {
    stab.addEventListener('click', () => {
      const target = stab.dataset.stab;
      document.querySelectorAll('.stab').forEach(s => s.classList.toggle('active', s === stab));
      document.querySelectorAll('.stab-panel').forEach(p => p.classList.toggle('active', p.id === 'stab-' + target));
      if (target === 'context') vscode.postMessage({ type: 'getContextInfo' });
      if (target === 'prompt') vscode.postMessage({ type: 'getSystemPromptPreview' });
      if (target === 'tools') { /* already rendered via applySettings */ }
    });
  });

  // System prompt preview
  $('btn-preview-prompt').addEventListener('click', () => vscode.postMessage({ type: 'getSystemPromptPreview' }));
  $('btn-reset-prompt').addEventListener('click', () => { $('set-systemPrompt').value = ''; });
  $('btn-clear-context').addEventListener('click', () => {
    if (!confirm('Clear the entire conversation context? This cannot be undone.')) return;
    vscode.postMessage({ type: 'newSession' });
    messagesEl.innerHTML = '';
    showEmpty();
    settingsModal.classList.add('hidden');
  });
  $('btn-refresh-ctx').addEventListener('click', () => vscode.postMessage({ type: 'getContextInfo' }));

  // All available tools with descriptions
  const ALL_TOOLS = [
    { name: 'READ',   desc: 'Read file contents' },
    { name: 'WRITE',  desc: 'Create or overwrite files' },
    { name: 'PATCH',  desc: 'Apply targeted edits to files' },
    { name: 'LIST',   desc: 'List directory contents' },
    { name: 'SEARCH', desc: 'Search file contents (grep)' },
    { name: 'SHELL',  desc: 'Run shell commands' },
    { name: 'FETCH',  desc: 'Fetch URLs / web pages' },
    { name: 'MEMORY', desc: 'Store & recall memories' },
    { name: 'MKDIR',  desc: 'Create directories' },
    { name: 'DELETE', desc: 'Delete files or directories' },
    { name: 'PWD',    desc: 'Show working directory' },
    { name: 'CHANGES',desc: 'Show recent file changes' },
  ];

  function renderToolToggles(disabledTools) {
    const container = $('tools-toggles');
    container.innerHTML = '';
    ALL_TOOLS.forEach(tool => {
      const enabled = !disabledTools.includes(tool.name);
      const row = document.createElement('div');
      row.className = 'tool-toggle-row';
      row.innerHTML = `
        <div class="tool-toggle-info">
          <div class="tool-toggle-name">${escHtml(tool.name)}</div>
          <div class="tool-toggle-desc">${escHtml(tool.desc)}</div>
        </div>
        <label class="tool-toggle-switch" title="${enabled ? 'Enabled' : 'Disabled'}">
          <input type="checkbox" data-tool="${escHtml(tool.name)}" ${enabled ? 'checked' : ''}>
          <span class="tool-toggle-slider"></span>
        </label>`;
      container.appendChild(row);
    });
  }

  $('btn-settings').addEventListener('click', () => {
    vscode.postMessage({ type: 'getSettings' });
    settingsModal.classList.remove('hidden');
    // Default to General tab
    document.querySelectorAll('.stab').forEach(s => s.classList.toggle('active', s.dataset.stab === 'general'));
    document.querySelectorAll('.stab-panel').forEach(p => p.classList.toggle('active', p.id === 'stab-general'));
    $('prompt-preview-wrap').classList.add('hidden');
  });
  $('close-settings').addEventListener('click',  () => settingsModal.classList.add('hidden'));
  $('cancel-settings').addEventListener('click', () => settingsModal.classList.add('hidden'));
  $('save-settings').addEventListener('click', () => {
    const disabledTools = ALL_TOOLS
      .filter(t => {
        const chk = document.querySelector(`#tools-toggles input[data-tool="${t.name}"]`);
        return chk && !chk.checked;
      })
      .map(t => t.name);
    vscode.postMessage({
      type: 'saveSettings',
      settings: {
        ollamaHost:                $('set-ollamaHost').value.trim(),
        defaultModel:              $('set-defaultModel').value.trim(),
        toolRoundLimit:            parseInt($('set-toolRoundLimit').value, 10) || 40,
        autoAttach:                $('set-autoAttach').checked,
        shellEnabled:              $('set-shellEnabled').checked,
        systemPrompt:              $('set-systemPrompt').value,
        disabledTools,
        maxContextTokens:          parseInt($('set-maxContextTokens').value, 10) || 0,
        summarizeTriggerPercent:   parseInt($('set-summarizeTriggerPercent').value, 10) || 65,
      }
    });
  });

  // ── Agents ────────────────────────────────────────────────────
  $('btn-agents').addEventListener('click', () => {
    vscode.postMessage({ type: 'listAgents' });
    agentsModal.classList.remove('hidden');
  });
  $('close-agents').addEventListener('click', () => agentsModal.classList.add('hidden'));

  // ── New session ───────────────────────────────────────────────
  $('btn-new').addEventListener('click', () => {
    if (!confirm('Start a new session? This clears the current conversation.')) return;
    vscode.postMessage({ type: 'newSession' });
    messagesEl.innerHTML = '';
    showEmpty();
  });

  // ── Suggestion dropdown ──────────────────────────────────────
  const suggestionBox = document.createElement('div');
  suggestionBox.id = 'suggestion-box';
  suggestionBox.className = 'hidden';
  document.body.appendChild(suggestionBox);

  function showSuggestions(items) {
    suggestionList = items;
    suggestionSel = 0;
    if (items.length === 0) { hideSuggestions(); return; }
    suggestionBox.innerHTML = '';
    items.forEach((item, i) => {
      const el = document.createElement('div');
      el.className = 'suggestion-item' + (i === 0 ? ' selected' : '');
      if (item.cmd) {
        el.innerHTML = `<span class="sug-cmd">${escHtml(item.cmd)}</span><span class="sug-desc">${escHtml(item.desc)}</span>`;
      } else {
        el.innerHTML = `<span class="sug-file">${ic('file')} ${escHtml(item.label)}</span><span class="sug-desc">${escHtml(item.sub || '')}</span>`;
      }
      el.addEventListener('mousedown', (e) => { e.preventDefault(); applySuggestion(item); });
      suggestionBox.appendChild(el);
    });
    // Position above input
    const rect = inputEl.getBoundingClientRect();
    suggestionBox.style.left = rect.left + 'px';
    suggestionBox.style.right = (window.innerWidth - rect.right) + 'px';
    suggestionBox.style.top = 'auto';
    suggestionBox.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
    suggestionBox.classList.remove('hidden');
  }

  function hideSuggestions() {
    suggestionBox.classList.add('hidden');
    suggestionList = [];
    suggestionMode = null;
    suggestionQuery = '';
    suggestionSel = 0;
  }

  function updateSuggestionSel(delta) {
    const items = suggestionBox.querySelectorAll('.suggestion-item');
    items[suggestionSel]?.classList.remove('selected');
    suggestionSel = (suggestionSel + delta + items.length) % items.length;
    items[suggestionSel]?.classList.add('selected');
    items[suggestionSel]?.scrollIntoView({ block: 'nearest' });
  }

  function applySuggestion(item) {
    const val = inputEl.value;
    if (suggestionMode === 'slash') {
      // Replace from last '/' to cursor
      const pos = inputEl.selectionStart;
      const before = val.lastIndexOf('/', pos - 1);
      inputEl.value = val.slice(0, before) + item.cmd + ' ' + val.slice(pos);
      const np = before + item.cmd.length + 1;
      inputEl.setSelectionRange(np, np);
    } else if (suggestionMode === 'mention') {
      // Replace from last '@' to cursor
      const pos = inputEl.selectionStart;
      const before = val.lastIndexOf('@', pos - 1);
      const tag = item.cmd || item.label;
      inputEl.value = val.slice(0, before) + '@' + tag + ' ' + val.slice(pos);
      const np = before + tag.length + 2;
      inputEl.setSelectionRange(np, np);
      // Auto-attach if it's a file mention
      if (item.path) {
        vscode.postMessage({ type: 'pickFiles', singlePath: item.path });
      } else if (tag === 'editor') {
        attachEditorContext();
      } else if (tag === 'selection') {
        attachSelection();
      } else if (tag === 'workspace') {
        vscode.postMessage({ type: 'pickFiles', multiple: true, folder: false });
      }
    }
    hideSuggestions();
    autoResize();
    inputEl.focus();
  }

  // ── Editor context attachment helpers ─────────────────────────
  function attachEditorContext() {
    if (!editorCtx || !editorCtx.hasEditor) {
      addSystemInfo('No active editor open.');
      return;
    }
    addAttachment({
      name: editorCtx.filePath,
      path: editorCtx.filePath,
      content: `\`\`\`${editorCtx.language}\n// File: ${editorCtx.filePath} (lines ${editorCtx.snippetStart}–${editorCtx.snippetStart + (editorCtx.snippet?.split('\n').length || 0) - 1} of ${editorCtx.lineCount})\n${editorCtx.snippet}\n\`\`\``,
      isDir: false,
    });
  }

  function attachSelection() {
    if (!editorCtx || !editorCtx.hasSelection) {
      addSystemInfo('No text is currently selected in the editor.');
      return;
    }
    addAttachment({
      name: `selection from ${editorCtx.filePath}`,
      path: `__selection__${editorCtx.filePath}`,
      content: `\`\`\`${editorCtx.language}\n// Selected from ${editorCtx.filePath} line ${editorCtx.cursorLine}\n${editorCtx.selectionText}\n\`\`\``,
      isDir: false,
    });
  }

  function addSystemInfo(msg) {
    const el = document.createElement('div');
    el.className = 'system-info';
    el.textContent = msg;
    messagesEl.appendChild(el);
    scrollBottom();
    setTimeout(() => el.remove(), 3000);
  }

  // ── Input event: detect / and @ triggers ──────────────────────
  function onInputChange() {
    autoResize();
    const val = inputEl.value;
    const pos = inputEl.selectionStart;
    const before = val.slice(0, pos);

    // Slash command: / at beginning or after whitespace
    const slashMatch = before.match(/(^|\s)(\/\S*)$/);
    if (slashMatch) {
      suggestionMode = 'slash';
      const q = slashMatch[2].toLowerCase();
      const filtered = SLASH_COMMANDS.filter(c => c.cmd.startsWith(q));
      showSuggestions(filtered);
      return;
    }

    // @ mention
    const mentionMatch = before.match(/@(\S*)$/);
    if (mentionMatch) {
      suggestionMode = 'mention';
      const q = mentionMatch[1].toLowerCase();
      const FIXED = [
        { cmd: 'editor',    desc: 'Attach current open file', label: 'editor' },
        { cmd: 'selection', desc: 'Attach current selection', label: 'selection' },
        { cmd: 'workspace', desc: 'Pick files from workspace', label: 'workspace' },
      ];
      const fixed = FIXED.filter(m => m.cmd.startsWith(q));
      const files = workspaceFiles.filter(f => f.toLowerCase().includes(q)).slice(0, 8)
        .map(f => ({ label: f, path: f, sub: path_basename(f) }));
      if (q.length >= 1 && files.length === 0 && q.length >= 2) {
        vscode.postMessage({ type: 'searchWorkspaceFiles', query: q });
      }
      showSuggestions([...fixed, ...files]);
      return;
    }

    hideSuggestions();
  }

  function path_basename(p) {
    return p.split('/').pop() || p;
  }

  // ── Send / Abort ──────────────────────────────────────────────
  function send() {
    const rawText = inputEl.value.trim();
    if (!rawText || isStreaming) return;

    // Expand slash command prefixes into context for the model
    let text = rawText;
    const slashMap = {
      '/explain':  'Please explain the following code or file in detail.',
      '/fix':      'Please find and fix any bugs in the following. Use tools to read and patch the file.',
      '/refactor': 'Please refactor and improve the following code for readability, performance, and best practices.',
      '/tests':    'Please generate comprehensive unit tests for the following. Write them to a test file.',
      '/docs':     'Please add clear documentation comments to the following code.',
      '/review':   'Please do a thorough code review of the following, listing issues by severity.',
      '/commit':   'Please run CHANGES to see the git diff, then generate a good git commit message and commit.',
      '/new':      'Please create the following file or project scaffold.',
    };
    for (const [cmd, expansion] of Object.entries(slashMap)) {
      if (text.startsWith(cmd + ' ') || text === cmd) {
        const rest = text.slice(cmd.length).trim();
        text = expansion + (rest ? ' ' + rest : '');
        break;
      }
    }

    // Auto-attach @editor or @selection inline references
    const mentionEditorRe = /@editor\b/gi;
    const mentionSelRe = /@selection\b/gi;
    if (mentionEditorRe.test(text) && editorCtx?.hasEditor) {
      attachEditorContext();
      text = text.replace(/@editor\b/gi, `[${editorCtx.filePath}]`);
    }
    if (mentionSelRe.test(text) && editorCtx?.hasSelection) {
      attachSelection();
      text = text.replace(/@selection\b/gi, '[selected code]');
    }

    let attachedContext = '';
    if (attachedFiles.length > 0) {
      attachedContext = attachedFiles.map(f => f.content).join('\n\n---\n\n');
      clearAttachments();
    }

    hideSuggestions();
    vscode.postMessage({ type: 'sendMessage', text, attachedContext: attachedContext || undefined });
    inputEl.value = '';
    autoResize();
    updateEditorBadge();
  }

  sendBtn.addEventListener('click', send);
  abortBtn.addEventListener('click', () => vscode.postMessage({ type: 'abort' }));

  inputEl.addEventListener('keydown', e => {
    if (!suggestionBox.classList.contains('hidden')) {
      if (e.key === 'ArrowDown')  { e.preventDefault(); updateSuggestionSel(1); return; }
      if (e.key === 'ArrowUp')    { e.preventDefault(); updateSuggestionSel(-1); return; }
      if (e.key === 'Tab' || e.key === 'Enter') {
        if (suggestionList[suggestionSel]) {
          e.preventDefault();
          applySuggestion(suggestionList[suggestionSel]);
          return;
        }
      }
      if (e.key === 'Escape') { hideSuggestions(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  inputEl.addEventListener('input', onInputChange);

  function autoResize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px';
  }

  // ── Editor context badge ──────────────────────────────────────
  const editorBadge = $('editor-badge');
  function updateEditorBadge() {
    if (!editorBadge) return;
    if (editorCtx && editorCtx.hasEditor) {
      const shortName = editorCtx.filePath.split('/').pop() || '';
      editorBadge.innerHTML = `${ic('file')} <span>${escHtml(shortName)}</span>` +
        (editorCtx.hasSelection ? ` <span class="sel-badge">${ic('cursor')} sel</span>` : '');
      editorBadge.classList.remove('hidden');
    } else {
      editorBadge.classList.add('hidden');
    }
  }

  // Click on editor badge → attach editor
  editorBadge && editorBadge.addEventListener('click', () => {
    if (editorCtx?.hasSelection) { attachSelection(); }
    else { attachEditorContext(); }
  });

  // ── Attach files ──────────────────────────────────────────────
  btnAttach.addEventListener('click', () => vscode.postMessage({ type: 'pickFiles', multiple: true, folder: false }));

  function addAttachment(file) {
    if (attachedFiles.some(f => f.path === file.path)) return;
    attachedFiles.push(file);
    renderAttachBar();
  }
  function removeAttachment(path) {
    attachedFiles = attachedFiles.filter(f => f.path !== path);
    renderAttachBar();
  }
  function clearAttachments() {
    attachedFiles = [];
    renderAttachBar();
  }
  function renderAttachBar() {
    attachBar.innerHTML = '';
    if (attachedFiles.length === 0) { attachBar.classList.add('hidden'); return; }
    attachBar.classList.remove('hidden');
    attachedFiles.forEach(f => {
      const chip = document.createElement('div');
      chip.className = 'attach-chip';
      const icon = f.isDir ? ic('folder', '#e5c07b') : fileTypeIcon(f.name);
      chip.innerHTML = `${icon}<span class="chip-name" title="${escHtml(f.path)}">${escHtml(f.name)}</span>` +
        `<button class="remove-chip" title="Remove">${ic('x')}</button>`;
      chip.querySelector('.remove-chip').addEventListener('click', () => removeAttachment(f.path));
      attachBar.appendChild(chip);
    });
  }

  // ── Drag & drop ───────────────────────────────────────────────
  messagesEl.addEventListener('dragover', e => {
    e.preventDefault();
    dropOverlay.classList.remove('hidden');
    dropOverlay.classList.add('drag-active');
  });
  document.addEventListener('dragleave', e => {
    if (!e.relatedTarget || !document.contains(e.relatedTarget)) {
      dropOverlay.classList.add('hidden');
      dropOverlay.classList.remove('drag-active');
    }
  });
  document.addEventListener('drop', e => {
    e.preventDefault();
    dropOverlay.classList.add('hidden');
    dropOverlay.classList.remove('drag-active');
    const uriList = e.dataTransfer && e.dataTransfer.getData('text/uri-list');
    if (uriList) {
      const uris = uriList.split('\n').map(u => u.trim()).filter(u => u && !u.startsWith('#'));
      if (uris.length > 0) vscode.postMessage({ type: 'dropFiles', uris });
    }
  });

  // ── Model picker ──────────────────────────────────────────────
  modelSelect.addEventListener('change', () => {
    if (modelSelect.value) vscode.postMessage({ type: 'selectModel', model: modelSelect.value });
  });

  // ── Empty state ───────────────────────────────────────────────
  function showEmpty() {
    if (!emptyStateEl.parentElement) messagesEl.appendChild(emptyStateEl);
    emptyStateEl.classList.remove('hidden');
  }
  function hideEmpty() {
    if (emptyStateEl.parentElement) emptyStateEl.remove();
  }

  // ── Message helpers ───────────────────────────────────────────
  function addMessage(role, content) {
    hideEmpty();
    const div = document.createElement('div');
    div.className = 'message ' + role;
    const headerIcon = role === 'user'
      ? ic('user')
      : `<img src="${window._logoUri || ''}" class="msg-logo" alt="">`;
    div.innerHTML =
      `<div class="msg-header">${headerIcon}<span>${role === 'user' ? 'You' : 'Sapper'}</span></div>` +
      `<div class="msg-body">${renderMd(content)}</div>`;
    if (role === 'assistant') { injectSaveButtons(div); addUndoButton(div); }
    messagesEl.appendChild(div);
    scrollBottom();
    return div;
  }

  // Thinking indicator (three-dot loader)
  function showThinking() {
    hideEmpty();
    removeThinking();
    thinkingEl = document.createElement('div');
    thinkingEl.className = 'thinking-row';
    const logoImg = window._logoUri
      ? `<img src="${window._logoUri}" class="msg-logo" alt="">`
      : ic('file');
    thinkingEl.innerHTML =
      `${logoImg}` +
      `<div class="thinking-dots"><span></span><span></span><span></span></div>` +
      `<span class="thinking-label" id="thinking-label">Thinking…</span>`;
    messagesEl.appendChild(thinkingEl);
    scrollBottom();
  }
  function updateThinkingLabel(text) {
    const lbl = document.getElementById('thinking-label');
    if (lbl) lbl.textContent = text;
  }
  function removeThinking() {
    if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
  }

  // Stream
  function startStream() {
    removeThinking();
    hideEmpty();
    isStreaming = true;
    streamText = '';
    sendBtn.classList.add('hidden');
    abortBtn.classList.remove('hidden');
    setStatus('running', 'Streaming…');

    streamEl = document.createElement('div');
    streamEl.className = 'message assistant streaming';
    const logoImg = window._logoUri
      ? `<img src="${window._logoUri}" class="msg-logo" alt="">`
      : ic('file');
    streamEl.innerHTML =
      `<div class="msg-header">${logoImg}<span>Sapper</span></div>` +
      `<div class="msg-body"></div>`;
    messagesEl.appendChild(streamEl);
    scrollBottom();
  }
  function streamChunk(chunk) {
    if (!streamEl) startStream();
    streamText += chunk;
    streamEl.querySelector('.msg-body').innerHTML = renderMd(streamText);
    scrollBottom();
  }
  function endStream() {
    isStreaming = false;
    sendBtn.classList.remove('hidden');
    abortBtn.classList.add('hidden');
    setStatus('idle', 'Ready');
    if (streamEl) {
      streamEl.classList.remove('streaming');
      injectSaveButtons(streamEl);
      addUndoButton(streamEl);
    }
    streamEl = null; streamText = '';
    removeThinking();
  }

  /** Inject "Save to file" buttons on code blocks that don't already have one. */
  function injectSaveButtons(msgEl) {
    msgEl.querySelectorAll('pre code').forEach(codeEl => {
      const pre = codeEl.parentElement;
      if (pre.querySelector('.save-code-btn')) return; // already has one
      const lang = (codeEl.className.match(/language-(\S+)/) || [])[1] || '';
      const extMap = { js:'js', ts:'ts', tsx:'tsx', jsx:'jsx', py:'py', go:'go',
        rs:'rs', sh:'sh', bash:'sh', html:'html', css:'css', json:'json',
        md:'md', yaml:'yml', yml:'yml', toml:'toml', sql:'sql', cpp:'cpp', c:'c' };
      const ext = extMap[lang] || (lang || 'txt');
      const btn = document.createElement('button');
      btn.className = 'save-code-btn';
      btn.title = 'Save to file';
      btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Save`;
      btn.addEventListener('click', () => saveCodeBlock(codeEl.textContent || '', ext, btn));
      pre.style.position = 'relative';
      pre.appendChild(btn);
    });
  }

  function saveCodeBlock(content, ext, btn) {
    const defaultName = `file.${ext}`;
    const name = prompt(`Save code as (relative to workspace):`, defaultName);
    if (!name || !name.trim()) return;
    btn.disabled = true;
    btn.textContent = 'Saving…';
    vscode.postMessage({ type: 'saveCodeBlock', path: name.trim(), content });
  }

  // Tool group — create if not exists
  function getOrCreateToolGroup() {
    if (tgEl) return;
    hideEmpty();
    tgEl = document.createElement('div');
    tgEl.className = 'tool-group';

    const header = document.createElement('div');
    header.className = 'tg-header';

    tgSpinEl = document.createElement('div');
    tgSpinEl.className = 'tg-spin';

    tgTitleEl = document.createElement('span');
    tgTitleEl.className = 'tg-title';
    tgTitleEl.textContent = 'Running…';

    const chev = document.createElement('span');
    chev.className = 'tg-chevron';
    chev.innerHTML = ic('chevron');

    header.appendChild(tgSpinEl);
    header.appendChild(tgTitleEl);
    header.appendChild(chev);
    header.addEventListener('click', () => tgEl.classList.toggle('collapsed'));

    tgBody = document.createElement('div');
    tgBody.className = 'tg-body';

    tgEl.appendChild(header);
    tgEl.appendChild(tgBody);
    messagesEl.appendChild(tgEl);
  }

  // Add or update a tool row
  function addToolRow(tool, path, status) {
    getOrCreateToolGroup();
    const color = TYPE_COLOR[tool] || '#9da5b4';
    const label = TYPE_LABEL[tool] || tool.toLowerCase();

    if (status === 'running') {
      const row = document.createElement('div');
      row.className = 'tool-row running';
      row.innerHTML =
        `<span class="tr-dot" style="background:${color}"></span>` +
        `<span class="tr-type" style="color:${color}">${escHtml(label)}</span>` +
        `<span class="tr-path">${escHtml(path || '')}</span>` +
        `<span class="tr-time"></span>` +
        `<div class="tr-status"><div class="tr-spin" style="border-top-color:${color}"></div></div>`;
      tgBody.appendChild(row);
      tgCounts[tool] = (tgCounts[tool] || 0) + 1;
      tgRows.push({ tool, path, el: row, startTime: Date.now(), status: 'running' });

      const total = tgRows.length;
      tgTitleEl.textContent = `Running ${total} tool${total !== 1 ? 's' : ''}…`;
      scrollBottom();
    } else {
      // match last unresolved row for this tool
      const entry = tgRows.slice().reverse().find(r => r.tool === tool && r.status === 'running');
      if (entry) {
        const ms = Date.now() - entry.startTime;
        const timeStr = ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms';
        entry.status = status;
        entry.el.className = 'tool-row ' + status;
        entry.el.querySelector('.tr-time').textContent = timeStr;
        entry.el.querySelector('.tr-status').innerHTML = status === 'success'
          ? `<span class="tr-ok">${ic('check')}</span>`
          : `<span class="tr-err">${ic('x')}</span>`;
      }
    }
  }

  // Finalize group: collapse + show summary
  function finalizeToolGroup() {
    if (!tgEl || tgRows.length === 0) return;

    const total = tgRows.length;
    const errors = tgRows.filter(r => r.status === 'error').length;

    // Replace spinner with done icon
    tgSpinEl.className = 'tg-done';
    tgSpinEl.innerHTML = errors > 0
      ? `<span style="color:var(--red)">${ic('x')}</span>`
      : `<span style="color:var(--green)">${ic('check')}</span>`;

    // Build summary pills
    const pills = Object.entries(tgCounts).map(([k, v]) => {
      const c = TYPE_COLOR[k] || '#9da5b4';
      const lbl = TYPE_LABEL[k] || k.toLowerCase();
      return `<span class="tg-pill" style="color:${c}">${lbl}${v > 1 ? ` ×${v}` : ''}</span>`;
    }).join('');

    tgTitleEl.innerHTML =
      `<span style="color:var(--fg-muted)">${total} tool${total !== 1 ? 's' : ''}</span>` +
      `<span class="tg-summary">${pills}</span>`;

    // Auto-collapse
    tgEl.classList.add('collapsed');
  }

  // Info message
  function addInfo(text, type = 'normal') {
    hideEmpty();
    const el = document.createElement('div');
    el.className = 'info-msg ' + (type === 'error' ? 'err' : type === 'ok' ? 'ok' : '');
    const iconName = type === 'error' ? 'alert' : type === 'ok' ? 'ok' : 'info';
    el.innerHTML = ic(iconName) + ' ' + renderMd(text);
    messagesEl.appendChild(el);
    scrollBottom();
  }

  function setStatus(state, text) {
    statusDot.className = 'dot ' + state;
    statusText.textContent = text;
  }
  function scrollBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }

  // ── File tree ─────────────────────────────────────────────────
  function refreshTree(rel) { vscode.postMessage({ type: 'getWorkspaceTree', path: rel || '' }); }

  function renderTree(rel, entries) {
    currentPath = rel || '';
    fileTree.innerHTML = '';
    renderBreadcrumb(currentPath);

    if (currentPath) {
      const up = document.createElement('div');
      up.className = 'tree-item dir';
      up.innerHTML = `<span class="tree-icon">${ic('up')}</span><span class="tree-name">..</span>`;
      up.addEventListener('click', () => {
        const parts = currentPath.split('/').filter(Boolean);
        parts.pop();
        refreshTree(parts.join('/'));
      });
      fileTree.appendChild(up);
    }

    entries.forEach(e => {
      const item = document.createElement('div');
      item.className = 'tree-item ' + (e.isDir ? 'dir' : 'file');
      const icon = e.isDir ? ic('folder') : fileTypeIcon(e.name);
      const full = currentPath ? currentPath + '/' + e.name : e.name;
      const change = changedFiles.get(full);
      const badge = change
        ? `<span class="tree-badge ${change}">${change === 'create' ? 'NEW' : 'MOD'}</span>`
        : '';
      item.innerHTML =
        `<span class="tree-icon">${icon}</span>` +
        `<span class="tree-name">${escHtml(e.name)}</span>` + badge;
      item.addEventListener('click', () => {
        if (e.isDir) refreshTree(full);
        else vscode.postMessage({ type: 'openFile', path: full });
      });
      fileTree.appendChild(item);
    });
  }

  function renderBreadcrumb(rel) {
    breadcrumb.innerHTML = '';
    const root = document.createElement('span');
    root.className = 'crumb';
    root.innerHTML = ic('folder') + '<span>workspace</span>';
    root.addEventListener('click', () => refreshTree(''));
    breadcrumb.appendChild(root);
    if (!rel) return;
    const parts = rel.split('/').filter(Boolean);
    let acc = '';
    parts.forEach(p => {
      acc = acc ? acc + '/' + p : p;
      const sep = document.createElement('span');
      sep.className = 'crumb-sep'; sep.textContent = '/';
      breadcrumb.appendChild(sep);
      const c = document.createElement('span');
      c.className = 'crumb'; c.textContent = p;
      const path = acc;
      c.addEventListener('click', () => refreshTree(path));
      breadcrumb.appendChild(c);
    });
  }

  function fileTypeIcon(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    // All use the same base SVG but with different accent colors
    const colors = {
      ts: '#4fc1ff', tsx: '#4fc1ff', js: '#e5c07b', jsx: '#e5c07b',
      json: '#89d185', md: '#e5c07b', html: '#f14c4c', css: '#b48cff',
      py: '#4fc1ff', go: '#4fc1ff', rs: '#f14c4c',
      sh: '#89d185', yml: '#89d185', yaml: '#89d185', toml: '#89d185',
    };
    const color = colors[ext];
    return color ? ic('file', color) : ic('file');
  }

  // ── Context stats renderer ────────────────────────────────────
  function renderContextStats(m) {
    const msgs   = m.messages ?? 0;
    const tokens = m.estimatedTokens ?? 0;
    const rawKB  = m.rawKB ?? 0;
    const limit  = m.contextLimit ?? 0;
    const trigPct = m.summarizeTriggerPercent ?? 65;
    const toolRounds = m.toolRoundLimit ?? 40;
    const promptType = m.hasCustomPrompt ? 'custom' : 'default';
    const lastP = m.lastPromptTokens ?? 0;
    const lastR = m.lastEvalTokens ?? 0;

    $('ctx-msg-count').textContent   = String(msgs);
    $('ctx-raw-kb').textContent      = rawKB + ' KB';
    $('ctx-token-count').textContent = tokens.toLocaleString();
    $('ctx-prompt-type').textContent = promptType;
    $('ctx-tool-rounds').textContent = `limit ${toolRounds} rounds`;

    // ── Update input meta-bar context pill ────────────────────
    if (metaCtxLabel) {
      metaCtxLabel.textContent = limit > 0
        ? `${msgs} msgs · ${Math.round((tokens / limit) * 100)}%`
        : `${msgs} msgs`;
    }
    if (metaCtxFill) {
      const pct = limit > 0 ? Math.min(100, Math.round((tokens / limit) * 100)) : 0;
      metaCtxFill.style.width = pct + '%';
      const overTrig = limit > 0 && tokens >= limit * trigPct / 100;
      metaCtxFill.style.background = overTrig
        ? 'var(--red)' : pct > 40
        ? 'linear-gradient(90deg,var(--blue),var(--purple))'
        : 'var(--blue)';
    }

    if (limit > 0) {
      const usagePct = Math.round((tokens / limit) * 100);
      const threshold = Math.round(limit * trigPct / 100);
      $('ctx-limit-row').style.display  = '';
      $('ctx-usage-row').style.display  = '';
      $('ctx-limit-val').textContent    = `${limit.toLocaleString()} tokens`;
      $('ctx-usage-pct').textContent    = `${usagePct}% · summarize near ${threshold.toLocaleString()}`;
      $('ctx-usage-pct').style.color    = usagePct >= trigPct ? 'var(--red)' : usagePct >= trigPct * 0.7 ? 'var(--yellow)' : '';

      // Token meter
      $('ctx-meter-wrap').style.display = '';
      const fillPct  = Math.min(100, usagePct);
      const trigPos  = Math.min(99, trigPct);
      $('ctx-meter-fill').style.width     = fillPct + '%';
      $('ctx-meter-fill').style.background = usagePct >= trigPct
        ? 'var(--red)' : usagePct >= trigPct * 0.75 ? 'var(--yellow)'
        : 'linear-gradient(90deg, var(--blue), var(--purple))';
      $('ctx-meter-threshold').style.left = trigPos + '%';
      $('ctx-meter-label-left').textContent  = `~${tokens.toLocaleString()} tokens`;
      $('ctx-meter-label-right').textContent = `${limit.toLocaleString()} max`;
    } else {
      $('ctx-limit-row').style.display  = 'none';
      $('ctx-usage-row').style.display  = 'none';
      $('ctx-meter-wrap').style.display = 'none';
    }

    if (lastP > 0 || lastR > 0) {
      $('ctx-lastturn-row').style.display = '';
      $('ctx-lastturn-val').textContent   = `${lastP.toLocaleString()} prompt · ${lastR.toLocaleString()} response`;
    } else {
      $('ctx-lastturn-row').style.display = 'none';
    }
  }

  // ── Workspace Index ───────────────────────────────────────────
  const workspaceIndexEl = $('workspace-index');
  const btnIndex = $('btn-index');

  btnIndex && btnIndex.addEventListener('click', () => {
    btnIndex.disabled = true;
    btnIndex.textContent = 'Indexing…';
    vscode.postMessage({ type: 'indexWorkspace' });
  });

  function renderWorkspaceIndex(m) {
    if (btnIndex) { btnIndex.disabled = false; btnIndex.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg> Index`; }
    if (!workspaceIndexEl) return;
    if (m.error) {
      workspaceIndexEl.innerHTML = `<div class="index-error">Error: ${escHtml(m.error)}</div>`;
      workspaceIndexEl.classList.remove('hidden');
      return;
    }
    const dirs = Object.entries(m.byDir || {});
    if (dirs.length === 0) {
      workspaceIndexEl.innerHTML = '<div class="index-empty">No indexed files found.</div>';
      workspaceIndexEl.classList.remove('hidden');
      return;
    }
    let html = `<div class="index-header">${ic('grid','var(--accent)')} Workspace Index <span class="index-count">${m.fileCount} files</span><span class="index-time">${m.indexedAt ? new Date(m.indexedAt).toLocaleTimeString() : ''}</span></div>`;
    for (const [dir, files] of dirs.sort((a, b) => a[0].localeCompare(b[0]))) {
      html += `<div class="index-dir"><span class="index-dir-name">${ic('folder','var(--yellow)')} ${escHtml(dir)}/</span>`;
      html += `<div class="index-files">${files.map(f => `<span class="index-file">${fileTypeIcon(f)} ${escHtml(f)}</span>`).join('')}</div></div>`;
    }
    workspaceIndexEl.innerHTML = html;
    workspaceIndexEl.classList.remove('hidden');
  }

  // ── Memory panel ─────────────────────────────────────────────
  function openMemoryPanel() {
    if (!memoryPanel) return;
    memPanelOpen = true;
    memoryPanel.classList.remove('hidden');
    vscode.postMessage({ type: 'getMemoryInfo' });
    if (activeMemTab === 'recall') {
      // focus recall query
      const rq = $('recall-query');
      if (rq) { setTimeout(() => rq.focus(), 80); }
    } else {
      vscode.postMessage({ type: 'readNotes' });
    }
  }

  function closeMemoryPanel() {
    if (!memoryPanel) return;
    memPanelOpen = false;
    memoryPanel.classList.add('hidden');
  }

  function switchMemTab(tab) {
    activeMemTab = tab;
    document.querySelectorAll('.mem-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.mem-tab-content').forEach(el => el.classList.add('hidden'));
    const target = $(`mem-tab-${tab}`);
    if (target) {
      target.classList.remove('hidden');
      if (tab === 'notes') { vscode.postMessage({ type: 'readNotes' }); }
    }
  }

  // Memory pill click
  const metaMemPill = $('meta-mem');
  metaMemPill && metaMemPill.addEventListener('click', () => {
    if (memPanelOpen) { closeMemoryPanel(); } else { openMemoryPanel(); }
  });

  // Close button
  const closeMemBtn = $('close-memory-panel');
  closeMemBtn && closeMemBtn.addEventListener('click', closeMemoryPanel);

  // Memory tab buttons
  document.querySelectorAll('.mem-tab').forEach(btn => {
    btn.addEventListener('click', () => switchMemTab(btn.dataset.tab));
  });

  // Recall search
  const recallQueryEl = $('recall-query');
  const btnRecall = $('btn-recall');
  function doRecall() {
    const q = recallQueryEl ? recallQueryEl.value.trim() : '';
    if (!q) return;
    const resultsEl = $('recall-results');
    if (resultsEl) { resultsEl.innerHTML = `<div class="mem-searching">${ic('spinner')} Searching…</div>`; }
    vscode.postMessage({ type: 'searchMemory', query: q });
  }
  btnRecall && btnRecall.addEventListener('click', doRecall);
  recallQueryEl && recallQueryEl.addEventListener('keydown', e => { if (e.key === 'Enter') doRecall(); });

  // Save note
  const noteInputEl = $('note-input');
  const btnSaveNote = $('btn-save-note');
  btnSaveNote && btnSaveNote.addEventListener('click', () => {
    const text = noteInputEl ? noteInputEl.value.trim() : '';
    if (!text) return;
    vscode.postMessage({ type: 'saveNote', text });
    if (noteInputEl) { noteInputEl.value = ''; }
  });

  function renderMemoryInfo(m) {
    if (metaMemLabel) {
      const total = (m.chunkCount || 0) + (m.noteCount || 0);
      metaMemLabel.textContent = total > 0 ? `${total} mem` : 'mem';
      metaMemPill && metaMemPill.classList.toggle('meta-pill-active', total > 0);
    }
  }

  function renderMemoryResults(m) {
    const resultsEl = $('recall-results');
    if (!resultsEl) return;
    if (!m.results || m.results.includes('No relevant') || m.results.includes('No memory')) {
      resultsEl.innerHTML = `<div class="mem-empty">No matching memories found.</div>`;
      return;
    }
    const blocks = m.results.split(/\n\n+/);
    let html = '';
    for (const block of blocks) {
      html += `<div class="mem-result-card"><pre class="mem-result-text">${escHtml(block.trim())}</pre></div>`;
    }
    resultsEl.innerHTML = html;
  }

  function renderNotesContent(content) {
    const notesEl = $('notes-content');
    if (!notesEl) return;
    if (!content || !content.trim()) {
      notesEl.innerHTML = '<div class="mem-empty">No memory notes yet. Save something to remember!</div>';
      return;
    }
    // Render each block separated by ---
    const blocks = content.split(/\n---\n/).filter(b => b.trim());
    let html = '';
    for (const block of blocks.reverse()) { // newest first
      const lines = block.trim().split('\n');
      const maybeTs = lines[0] && /^\d{4}-\d{2}-\d{2}/.test(lines[0]);
      const ts = maybeTs ? lines[0] : null;
      const body = (maybeTs ? lines.slice(1) : lines).join('\n').trim();
      html += `<div class="mem-note-card">${ts ? `<span class="mem-note-ts">${ts}</span>` : ''}<p>${escHtml(body)}</p></div>`;
    }
    notesEl.innerHTML = html;
  }

  // ── File changes ──────────────────────────────────────────────
  function addFileChange(action, path) {
    fileChanges.unshift({ action, path, time: Date.now() });
    changedFiles.set(path, action);
    changesBadge.textContent = fileChanges.length;
    changesBadge.classList.toggle('hidden', fileChanges.length === 0);
    renderChangesList();
    if (tabPanels.files.classList.contains('active')) refreshTree(currentPath);
  }

  function renderChangesList() {
    if (fileChanges.length === 0) {
      changesEmpty.classList.remove('hidden');
      changesList.innerHTML = ''; return;
    }
    changesEmpty.classList.add('hidden');
    changesList.innerHTML = '';
    fileChanges.slice(0, 50).forEach(c => {
      const div = document.createElement('div');
      div.className = 'change-item ' + c.action;
      const icon = c.action === 'create' ? ic('plus') : c.action === 'edit' ? ic('edit') : ic('trash');
      const label = c.action === 'create' ? 'Created' : c.action === 'edit' ? 'Edited' : 'Deleted';
      div.innerHTML =
        `<div class="change-icon">${icon}</div>` +
        `<div class="change-info">` +
          `<div class="change-path">${escHtml(c.path)}</div>` +
          `<div class="change-meta">${label} · ${new Date(c.time).toLocaleTimeString()}</div>` +
        `</div>`;
      if (c.action !== 'delete') {
        div.addEventListener('click', () => vscode.postMessage({ type: 'openFile', path: c.path }));
      }
      changesList.appendChild(div);
    });
  }

  // ── Settings apply ────────────────────────────────────────────
  function applySettings(s) {
    $('set-ollamaHost').value     = s.ollamaHost || '';
    $('set-defaultModel').value   = s.defaultModel || '';
    $('set-toolRoundLimit').value = s.toolRoundLimit || 40;
    $('set-autoAttach').checked   = !!s.autoAttach;
    $('set-shellEnabled').checked = !!s.shellEnabled;
    $('set-systemPrompt').value   = s.systemPrompt || '';
    $('set-maxContextTokens').value              = s.maxContextTokens || 0;
    $('set-summarizeTriggerPercent').value   = s.summarizeTriggerPercent || 65;
    renderToolToggles(s.disabledTools || []);
  }

  // ── Agents ────────────────────────────────────────────────────
  function renderAgents(agents, skills) {
    const al = $('agents-list'), sl = $('skills-list');
    al.innerHTML = '';
    sl.innerHTML = '';
    (agents || []).forEach(a => {
      const div = document.createElement('div');
      div.className = 'agent-item';
      div.innerHTML = `<div class="item-name">${escHtml(a.name)}</div>` +
        (a.description ? `<div class="item-desc">${escHtml(a.description)}</div>` : '');
      div.addEventListener('click', () => {
        vscode.postMessage({ type: 'invokeAgent', name: a.name });
        agentsModal.classList.add('hidden');
      });
      al.appendChild(div);
    });
    if (!agents || agents.length === 0) al.innerHTML = '<div class="info-msg">No agents in .sapper/agents/</div>';
    (skills || []).forEach(s => {
      const div = document.createElement('div');
      div.className = 'skill-item';
      div.innerHTML = `<div class="item-name">${escHtml(s.name)}</div>` +
        (s.description ? `<div class="item-desc">${escHtml(s.description)}</div>` : '');
      sl.appendChild(div);
    });
    if (!skills || skills.length === 0) sl.innerHTML = '<div class="info-msg">No skills in .sapper/skills/</div>';
  }

  // ── Shell approval card ──────────────────────────────────────
  function showShellApproval(id, cmd) {
    hideEmpty();
    const card = document.createElement('div');
    card.className = 'shell-approval-card';
    card.innerHTML =
      `<div class="sa-header">${ic('shell', '#e5c07b')} <span>Shell command requires approval</span></div>` +
      `<pre class="sa-cmd">${escHtml(cmd)}</pre>` +
      `<div class="sa-actions">` +
      `<button class="sa-approve">Run</button>` +
      `<button class="sa-deny">Deny</button>` +
      `</div>`;
    card.querySelector('.sa-approve').addEventListener('click', () => {
      vscode.postMessage({ type: 'shellApprovalResponse', id, approved: true });
      card.innerHTML = `<div class="sa-header">${ic('check', '#4ec9b0')} <span>Approved — running…</span></div><pre class="sa-cmd">${escHtml(cmd)}</pre>`;
    });
    card.querySelector('.sa-deny').addEventListener('click', () => {
      vscode.postMessage({ type: 'shellApprovalResponse', id, approved: false });
      card.innerHTML = `<div class="sa-header">${ic('x', '#f14c4c')} <span>Denied</span></div>`;
    });
    messagesEl.appendChild(card);
    scrollBottom();
  }

  // ── Diagnostics renderer ─────────────────────────────────────
  function renderDiagnostics(items) {
    diagPopover._diagItems = items;
    const list = $('diag-list');
    if (!items || items.length === 0) {
      list.innerHTML = '<div class="diag-empty">No problems found.</div>'; return;
    }
    const sevColor = { error: '#f14c4c', warning: '#e5c07b', info: '#4fc1ff', hint: '#9da5b4' };
    list.innerHTML = items.map(d =>
      `<div class="diag-item">` +
      `<span class="diag-sev" style="color:${sevColor[d.severity] || '#9da5b4'}">${d.severity}</span>` +
      `<span class="diag-loc">${escHtml(d.file)}:${d.line}</span>` +
      `<span class="diag-msg">${escHtml(d.message)}</span>` +
      `</div>`
    ).join('');
    // Update button icon to show error count
    const errCount = items.filter(d => d.severity === 'error').length;
    const warnCount = items.filter(d => d.severity === 'warning').length;
    const badge = $('btn-errors').querySelector('.err-badge') || (() => {
      const b = document.createElement('span'); b.className = 'err-badge';
      $('btn-errors').appendChild(b); return b;
    })();
    badge.textContent = errCount > 0 ? String(errCount) : warnCount > 0 ? `!${warnCount}` : '';
    badge.style.color = errCount > 0 ? '#f14c4c' : '#e5c07b';
  }

  // ── Sessions renderer ─────────────────────────────────────────
  function renderSessions(sessions) {
    const list = $('sessions-list');
    if (!sessions || sessions.length === 0) {
      list.innerHTML = '<div class="diag-empty">No saved sessions.</div>'; return;
    }
    list.innerHTML = '';
    sessions.forEach(s => {
      const row = document.createElement('div');
      row.className = 'session-row';
      const d = new Date(s.savedAt);
      const when = isNaN(d) ? '' : d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      row.innerHTML =
        `<div class="session-info"><span class="session-name">${escHtml(s.name)}</span>` +
        `<span class="session-meta">${s.messageCount} msgs · ${when}</span></div>` +
        `<div class="session-actions">` +
        `<button class="secondary-btn srow-load" style="padding:2px 8px;font-size:11px">Load</button>` +
        `<button class="danger-btn srow-del" style="padding:2px 6px;font-size:11px">Del</button>` +
        `</div>`;
      row.querySelector('.srow-load').addEventListener('click', () => {
        vscode.postMessage({ type: 'loadSession', name: s.name });
        sessionsPopover.classList.add('hidden');
      });
      row.querySelector('.srow-del').addEventListener('click', () => {
        if (!confirm(`Delete session "${s.name}"?`)) return;
        vscode.postMessage({ type: 'deleteSession', name: s.name });
      });
      list.appendChild(row);
    });
  }

  // ── Message bus ───────────────────────────────────────────────
  window.addEventListener('message', ev => {
    const m = ev.data;
    switch (m.type) {

      case 'init':
        if (m.logoUri) window._logoUri = m.logoUri;
        if (m.cwd) { workingDir.textContent = m.cwd.split('/').slice(-2).join('/'); workingDir.title = m.cwd; }
        if (m.history && m.history.length) {
          hideEmpty();
          m.history.forEach(h => addMessage(h.role, h.content));
        } else { showEmpty(); }
        setStatus('idle', 'Ready');
        break;

      case 'models':
        modelSelect.innerHTML = '';
        if (!m.models || m.models.length === 0) {
          modelSelect.innerHTML = '<option value="">No models — run: ollama pull llama3</option>';
        } else {
          m.models.forEach(mdl => {
            const opt = document.createElement('option');
            opt.value = mdl; opt.textContent = mdl;
            if (mdl === m.current) opt.selected = true;
            modelSelect.appendChild(opt);
          });
        }
        break;

      case 'userMessage':
        resetToolGroup();
        addMessage('user', m.text);
        showThinking();
        setStatus('thinking', 'Thinking…');
        break;

      case 'streamStart':
        finalizeToolGroup();
        startStream();
        break;

      case 'streamChunk':
        streamChunk(m.text);
        break;

      case 'streamEnd':
        endStream();
        break;

      case 'tool':
        if (m.status === 'running') removeThinking();
        addToolRow(m.tool, m.path, m.status);
        break;

      case 'info':
        addInfo(m.text);
        break;

      case 'error':
        removeThinking();
        finalizeToolGroup();
        endStream();
        addInfo(m.text, 'error');
        setStatus('error', 'Error');
        break;

      case 'status':
        setStatus(m.state || 'idle', m.text || '');
        break;

      case 'settings':
        applySettings(m.settings || {});
        break;

      case 'settingsSaved':
        settingsModal.classList.add('hidden');
        addInfo('Settings saved.', 'ok');
        break;

      case 'workspaceTree':
        renderTree(m.path, m.entries || []);
        break;

      case 'fileChange':
        addFileChange(m.action, m.path);
        break;

      case 'agents':
        renderAgents(m.agents || [], m.skills || []);
        break;

      case 'filePicked':
        (m.files || []).forEach(f => addAttachment(f));
        break;

      case 'contextInfo':
        renderContextStats(m);
        if (ctxCounter) {
          ctxCounter.textContent = `${m.messages} msgs · ~${(m.estimatedTokens || 0).toLocaleString()} tokens`;
        }
        break;

      case 'systemPromptPreview':
        $('prompt-preview').textContent = m.preview || '';
        $('prompt-preview-wrap').classList.remove('hidden');
        break;

      case 'workspaceIndex':
        renderWorkspaceIndex(m);
        break;

      case 'memoryInfo':
        renderMemoryInfo(m);
        break;

      case 'memoryResults':
        renderMemoryResults(m);
        break;

      case 'notesContent':
        renderNotesContent(m.content);
        break;

      case 'noteSaved':
        if (activeMemTab === 'notes') { vscode.postMessage({ type: 'readNotes' }); }
        vscode.postMessage({ type: 'getMemoryInfo' });
        break;

      case 'codeSaved':
        // Visual feedback: find any disabled save button and update it
        document.querySelectorAll('.save-code-btn:disabled').forEach(b => {
          b.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Saved`;
          b.style.color = 'var(--green, #4ec9b0)';
          b.style.borderColor = 'var(--green, #4ec9b0)';
          setTimeout(() => {
            b.textContent = 'Save';
            b.style.color = '';
            b.style.borderColor = '';
            b.disabled = false;
          }, 2500);
        });
        break;

      case 'editorContext':
        editorCtx = m;
        updateEditorBadge();
        break;

      case 'workspaceFileSearch':
        workspaceFiles = m.files || [];
        if (suggestionMode === 'mention') {
          const q2 = suggestionQuery.toLowerCase();
          const FIXED2 = [
            { cmd: 'editor',    desc: 'Attach current open file', label: 'editor' },
            { cmd: 'selection', desc: 'Attach current selection', label: 'selection' },
            { cmd: 'workspace', desc: 'Pick files from workspace', label: 'workspace' },
          ].filter(m2 => m2.cmd.startsWith(q2));
          const files2 = workspaceFiles.filter(f => f.toLowerCase().includes(q2)).slice(0, 8)
            .map(f => ({ label: f, path: f, sub: path_basename(f) }));
          showSuggestions([...FIXED2, ...files2]);
        }
        break;

      case 'diffApplied':
        document.querySelectorAll('.diff-card').forEach(c => c.remove());
        if (m.ok) addSystemInfo(`Applied → ${m.filePath}`);
        break;

      case 'shellApproval':
        showShellApproval(m.id, m.cmd);
        break;

      case 'undoResult':
        if (m.removed) {
          // Remove last two messages (user + assistant) from DOM
          const allMsgs = messagesEl.querySelectorAll('.message');
          const count = Math.min(2, allMsgs.length);
          for (let i = 0; i < count; i++) { allMsgs[allMsgs.length - 1 - i]?.remove(); }
          addSystemInfo('Last response undone.');
          if (messagesEl.children.length === 0) showEmpty();
        } else { addSystemInfo('Nothing to undo.'); }
        break;

      case 'diagnostics':
        renderDiagnostics(m.items);
        break;

      case 'sessionList':
        renderSessions(m.sessions);
        break;

      case 'sessionSaved':
        addSystemInfo(`Session saved: ${m.name}`);
        $('session-name-input').value = '';
        break;

      case 'sessionLoaded':
        messagesEl.innerHTML = '';
        if (m.history && m.history.length) {
          hideEmpty();
          m.history.forEach(h => addMessage(h.role, h.content));
        } else { showEmpty(); }
        addSystemInfo(`Session loaded: ${m.name}`);
        break;

      case 'modeSet':
        // Mode confirmed by backend — UI already updated
        break;
    }
  });

  // ── Boot ──────────────────────────────────────────────────────
  showEmpty();
  setStatus('idle', 'Initializing…');
  vscode.postMessage({ type: 'ready' });
})();
