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
exports.SapperPanel = void 0;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const SapperCore_1 = require("./SapperCore");
const config_1 = require("./config");
const agents_1 = require("./agents");
const memory_1 = require("./memory");
class SapperPanel {
    constructor(context) {
        this._currentModel = '';
        this._streaming = false;
        this._shellApprovalResolvers = new Map();
        this._shellApprovalCounter = 0;
        this._currentMode = 'agent';
        this._context = context;
    }
    /** Called by VS Code when the webview view becomes visible. */
    resolveWebviewView(webviewView) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, 'media')],
        };
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
        // Push editor context whenever active editor changes
        vscode.window.onDidChangeActiveTextEditor(() => this._sendEditorContext());
        vscode.window.onDidChangeTextEditorSelection(() => this._sendEditorContext());
        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case 'ready':
                    await this._onReady();
                    break;
                case 'sendMessage':
                    await this._onChat(msg.text, msg.attachedContext);
                    break;
                case 'selectModel':
                    await this._onSelectModel(msg.model);
                    break;
                case 'newSession':
                    this._onNewSession();
                    break;
                case 'abort':
                    this._core?.abort();
                    break;
                case 'invokeAgent':
                    await this._onSetAgent(msg.name);
                    break;
                case 'addSkill':
                    await this._onAddSkill(msg.skill);
                    break;
                case 'listAgents':
                    this._sendAgentsAndSkills();
                    break;
                case 'getSettings':
                    this._sendSettings();
                    break;
                case 'saveSettings':
                    await this._saveSettings(msg.settings);
                    break;
                case 'getWorkspaceTree':
                    this._sendWorkspaceTree(msg.path || '');
                    break;
                case 'openFile':
                    this._openFile(msg.path);
                    break;
                case 'pickFiles':
                    await this._pickFiles();
                    break;
                case 'dropFiles':
                    await this._handleDroppedFiles(msg.uris || []);
                    break;
                case 'getContextInfo':
                    this._sendContextInfo();
                    break;
                case 'getSystemPromptPreview':
                    this._sendSystemPromptPreview();
                    break;
                case 'indexWorkspace':
                    this._postWorkspaceIndex();
                    break;
                case 'getMemoryInfo':
                    this._sendMemoryInfo();
                    break;
                case 'searchMemory':
                    this._searchMemory(msg.query || '');
                    break;
                case 'saveNote':
                    this._saveNote(msg.text || '');
                    break;
                case 'readNotes':
                    this._readNotes();
                    break;
                case 'saveCodeBlock':
                    this._saveCodeBlock(msg.path || 'output.txt', msg.content || '');
                    break;
                case 'getEditorContext':
                    this._sendEditorContext();
                    break;
                case 'applyDiff':
                    await this._applyDiff(msg.filePath, msg.newContent);
                    break;
                case 'searchWorkspaceFiles':
                    this._searchWorkspaceFiles(msg.query || '');
                    break;
                case 'setMode':
                    this._currentMode = msg.mode;
                    if (this._core) {
                        this._core.updateOptions({ mode: this._currentMode });
                    }
                    this._post({ type: 'modeSet', mode: this._currentMode });
                    break;
                case 'undoLast':
                    {
                        const removed = this._core?.popLastTurn() ?? false;
                        this._post({ type: 'undoResult', removed });
                        if (removed) {
                            this._sendContextInfo();
                        }
                    }
                    break;
                case 'getDiagnostics':
                    this._sendDiagnostics();
                    break;
                case 'shellApprovalResponse':
                    {
                        const resolver = this._shellApprovalResolvers.get(msg.id);
                        if (resolver) {
                            this._shellApprovalResolvers.delete(msg.id);
                            resolver(!!msg.approved);
                        }
                    }
                    break;
                case 'listSessions':
                    this._listSessions();
                    break;
                case 'saveSession':
                    this._saveSession(msg.name);
                    break;
                case 'loadSession':
                    this._loadSession(msg.name);
                    break;
                case 'deleteSession':
                    SapperCore_1.SapperCore.deleteSession(this._getSapperDir(), msg.name);
                    this._listSessions();
                    break;
            }
        });
    }
    /** Send a message to initiate a chat (e.g. from right-click context menu). */
    async sendContextMessage(text) {
        await vscode.commands.executeCommand('sapperPanel.focus');
        if (this._view) {
            this._view.show(true);
            // Small delay to ensure webview is visible
            setTimeout(() => this._onChat(text), 300);
        }
    }
    _getWorkingDir() {
        const folders = vscode.workspace.workspaceFolders;
        return folders && folders.length > 0 ? folders[0].uri.fsPath : (process.env.HOME || '/');
    }
    _getSapperDir() {
        return path.join(this._getWorkingDir(), '.sapper');
    }
    _ensureCore(model) {
        const workingDir = this._getWorkingDir();
        const sapperDir = this._getSapperDir();
        const config = (0, config_1.getEffectiveConfig)(sapperDir);
        const ws = vscode.workspace.getConfiguration('sapper');
        this._core = new SapperCore_1.SapperCore({
            workingDir,
            sapperDir,
            ollamaHost: ws.get('ollamaHost') || 'http://127.0.0.1:11434',
            model,
            toolRoundLimit: config.toolRoundLimit,
            shellEnabled: ws.get('shellEnabled') ?? true,
            disabledTools: ws.get('disabledTools') ?? [],
            systemPromptOverride: ws.get('systemPrompt') || '',
            maxContextTokens: ws.get('maxContextTokens') ?? 0,
            mode: this._currentMode,
            onChunk: (text) => {
                if (!this._streaming) {
                    this._streaming = true;
                    this._post({ type: 'streamStart' });
                }
                this._post({ type: 'streamChunk', text });
            },
            onStatus: (status) => {
                // Map core status strings to UI state + text
                const map = {
                    thinking: { state: 'thinking', text: 'Sapper is thinking…' },
                    streaming: { state: 'running', text: 'Streaming…' },
                    tool: { state: 'running', text: 'Running tool…' },
                    done: { state: 'idle', text: 'Ready' },
                    idle: { state: 'idle', text: 'Ready' },
                    error: { state: 'error', text: 'Error' },
                };
                const m = map[status] || { state: 'idle', text: status };
                this._post({ type: 'status', state: m.state, text: m.text });
                if (status === 'done' || status === 'idle' || status === 'error') {
                    if (this._streaming) {
                        this._streaming = false;
                        this._post({ type: 'streamEnd' });
                    }
                }
            },
            onToolStart: (tool, p) => this._post({ type: 'tool', tool, path: p, status: 'running' }),
            onToolEnd: (tool, p, success) => this._post({ type: 'tool', tool, path: p, status: success ? 'success' : 'error' }),
            onFileChange: (action, p) => this._post({ type: 'fileChange', action, path: p }),
            onShellApprovalRequired: (cmd) => {
                const id = ++this._shellApprovalCounter;
                this._post({ type: 'shellApproval', id, cmd });
                return new Promise((resolve) => {
                    this._shellApprovalResolvers.set(id, resolve);
                });
            },
        });
    }
    async _onReady() {
        // Load model list from Ollama
        const tempCore = new SapperCore_1.SapperCore({
            workingDir: this._getWorkingDir(),
            sapperDir: this._getSapperDir(),
            model: '',
            onChunk: () => { },
            onStatus: () => { },
            onToolStart: () => { },
            onToolEnd: () => { },
        });
        const models = await tempCore.listModels();
        // Load stored model from workspace state / config
        const stored = this._context.workspaceState.get('sapperModel') || '';
        const config = (0, config_1.getEffectiveConfig)(this._getSapperDir());
        const defaultModel = config.defaultModel || stored;
        if (defaultModel && models.includes(defaultModel)) {
            this._currentModel = defaultModel;
            this._ensureCore(defaultModel);
        }
        this._post({ type: 'models', models, current: this._currentModel });
        // Send init payload (cwd + history)
        const history = (this._core?.context || [])
            .filter((m) => m.role === 'user' || m.role === 'assistant')
            .map((m) => ({ role: m.role, content: m.content }));
        const logoUri = this._view.webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'sapper-logo.svg')).toString();
        this._post({
            type: 'init',
            cwd: this._getWorkingDir(),
            history,
            logoUri,
        });
        // Send active editor context on ready
        this._sendEditorContext();
    }
    async _onSelectModel(model) {
        this._currentModel = model;
        await this._context.workspaceState.update('sapperModel', model);
        this._ensureCore(model);
        this._post({ type: 'status', state: 'idle', text: 'Ready' });
    }
    async _onChat(text, attachedContext) {
        if (!this._currentModel) {
            this._post({ type: 'error', text: 'Please select an Ollama model first.' });
            return;
        }
        if (!this._core) {
            this._ensureCore(this._currentModel);
        }
        this._post({ type: 'userMessage', text });
        try {
            await this._core.chat(text, attachedContext);
        }
        catch (e) {
            this._post({ type: 'error', text: e.message || String(e) });
        }
        finally {
            if (this._streaming) {
                this._streaming = false;
                this._post({ type: 'streamEnd' });
            }
            this._sendContextInfo();
        }
    }
    _onNewSession() {
        this._core?.clearContext();
        this._post({ type: 'info', text: 'New session started.' });
        this._post({ type: 'status', state: 'idle', text: 'Ready' });
    }
    async _onSetAgent(agentName) {
        if (!this._core) {
            this._ensureCore(this._currentModel || 'llama3');
        }
        const msg = this._core.setAgent(agentName || null);
        this._post({ type: 'info', text: msg });
    }
    async _onAddSkill(skillName) {
        if (!this._core) {
            this._ensureCore(this._currentModel || 'llama3');
        }
        const msg = this._core.addSkill(skillName);
        this._post({ type: 'info', text: msg });
    }
    _sendAgentsAndSkills() {
        const agents = (0, agents_1.loadAgents)(this._getSapperDir());
        const skills = (0, agents_1.loadSkills)(this._getSapperDir());
        this._post({
            type: 'agents',
            agents: Object.values(agents).map((a) => ({ name: a.name, description: a.description })),
            skills: Object.values(skills).map((s) => ({ name: s.name, description: s.description })),
        });
    }
    _post(msg) {
        this._view?.webview.postMessage(msg);
    }
    _sendSettings() {
        const ws = vscode.workspace.getConfiguration('sapper');
        this._post({
            type: 'settings',
            settings: {
                ollamaHost: ws.get('ollamaHost') || 'http://127.0.0.1:11434',
                defaultModel: ws.get('defaultModel') || '',
                toolRoundLimit: ws.get('toolRoundLimit') ?? 40,
                autoAttach: ws.get('autoAttach') ?? true,
                shellEnabled: ws.get('shellEnabled') ?? true,
                systemPrompt: ws.get('systemPrompt') || '',
                disabledTools: ws.get('disabledTools') ?? [],
                maxContextTokens: ws.get('maxContextTokens') ?? 0,
                contextLimit: ws.get('contextLimit') ?? 0,
                summarizeTriggerPercent: ws.get('summarizeTriggerPercent') ?? 65,
            },
        });
    }
    async _saveSettings(settings) {
        const ws = vscode.workspace.getConfiguration('sapper');
        const target = vscode.ConfigurationTarget.Global;
        for (const [key, value] of Object.entries(settings)) {
            try {
                await ws.update(key, value, target);
            }
            catch (_) { /* ignore */ }
        }
        this._post({ type: 'settingsSaved' });
        // Re-create core with new settings
        if (this._currentModel) {
            this._ensureCore(this._currentModel);
        }
    }
    _sendWorkspaceTree(relPath) {
        const workingDir = this._getWorkingDir();
        const target = relPath ? path.join(workingDir, relPath) : workingDir;
        // Block path traversal
        if (!target.startsWith(workingDir)) {
            return;
        }
        try {
            const entries = require('fs').readdirSync(target, { withFileTypes: true });
            const IGNORE = new Set(['node_modules', '.git', '.sapper', 'dist', 'build', '.cache', '__pycache__', '.next', 'out']);
            const items = entries
                .filter((e) => !IGNORE.has(e.name))
                .map((e) => ({
                name: e.name,
                isDir: e.isDirectory(),
            }))
                .sort((a, b) => {
                if (a.isDir !== b.isDir) {
                    return a.isDir ? -1 : 1;
                }
                return a.name.localeCompare(b.name);
            });
            this._post({ type: 'workspaceTree', path: relPath, entries: items });
        }
        catch (e) {
            this._post({ type: 'workspaceTree', path: relPath, entries: [], error: e.message });
        }
    }
    async _openFile(relPath) {
        try {
            const fullPath = path.join(this._getWorkingDir(), relPath);
            const uri = vscode.Uri.file(fullPath);
            await vscode.window.showTextDocument(uri, { preview: true });
        }
        catch (e) {
            vscode.window.showErrorMessage(`Could not open ${relPath}: ${e.message}`);
        }
    }
    async _pickFiles() {
        const uris = await vscode.window.showOpenDialog({
            canSelectMany: true,
            canSelectFiles: true,
            canSelectFolders: true,
            openLabel: 'Attach to Sapper',
        });
        if (!uris || uris.length === 0) {
            return;
        }
        const files = await this._readFilesForAttach(uris.map(u => u.fsPath));
        this._post({ type: 'filePicked', files });
    }
    async _handleDroppedFiles(uris) {
        const fsPaths = uris.map(u => {
            try {
                return vscode.Uri.parse(u).fsPath;
            }
            catch {
                return u;
            }
        }).filter(Boolean);
        const files = await this._readFilesForAttach(fsPaths);
        this._post({ type: 'filePicked', files });
    }
    async _readFilesForAttach(fsPaths) {
        const fs = require('fs');
        const MAX = 50000;
        const workingDir = this._getWorkingDir();
        const result = [];
        for (const fp of fsPaths) {
            try {
                const stat = fs.statSync(fp);
                const rel = fp.startsWith(workingDir) ? fp.slice(workingDir.length + 1) : fp;
                if (stat.isDirectory()) {
                    const entries = fs.readdirSync(fp, { withFileTypes: true });
                    const listing = entries.map((e) => `  ${e.isDirectory() ? '[dir] ' : '[file]'} ${e.name}`).join('\n');
                    result.push({ name: path.basename(fp), path: rel, content: `Directory: ${rel}\n${listing}`, isDir: true });
                }
                else {
                    let content = fs.readFileSync(fp, 'utf8').slice(0, MAX);
                    if (content.length === MAX) {
                        content += '\n... [truncated]';
                    }
                    result.push({ name: path.basename(fp), path: rel, content: `File: ${rel}\n\`\`\`\n${content}\n\`\`\``, isDir: false });
                }
            }
            catch (_) { /* skip unreadable */ }
        }
        return result;
    }
    _sendContextInfo() {
        const stats = this._core?.getContextStats() ?? { messages: 0, estimatedTokens: 0, rawBytes: 0, rawKB: 0, lastPromptTokens: 0, lastEvalTokens: 0, contextLimit: 0 };
        const ws = vscode.workspace.getConfiguration('sapper');
        // contextLimit is driven by maxContextTokens (token window size)
        const contextLimit = ws.get('maxContextTokens') ?? 0;
        const summarizeTriggerPercent = ws.get('summarizeTriggerPercent') ?? 65;
        const toolRoundLimit = ws.get('toolRoundLimit') ?? 40;
        const systemPrompt = ws.get('systemPrompt') || '';
        this._post({
            type: 'contextInfo',
            ...stats,
            contextLimit,
            summarizeTriggerPercent,
            toolRoundLimit,
            hasCustomPrompt: !!systemPrompt.trim(),
        });
        // Always refresh memory info together with context
        this._sendMemoryInfo();
    }
    _postWorkspaceIndex() {
        try {
            const idx = SapperCore_1.SapperCore.buildWorkspaceIndex(this._getWorkingDir());
            this._post({ type: 'workspaceIndex', ...idx });
        }
        catch (e) {
            this._post({ type: 'workspaceIndex', fileCount: 0, byDir: {}, indexedAt: '', error: e.message });
        }
    }
    _sendMemoryInfo() {
        const sapperDir = this._getSapperDir();
        try {
            const chunks = (0, memory_1.loadEmbeddings)(sapperDir);
            const notes = (0, memory_1.readLongMemory)(sapperDir);
            const noteCount = (notes.match(/^---$/gm) || []).length;
            this._post({ type: 'memoryInfo', chunkCount: chunks.length, noteCount, hasNotes: notes.trim().length > 0 });
        }
        catch {
            this._post({ type: 'memoryInfo', chunkCount: 0, noteCount: 0, hasNotes: false });
        }
    }
    _searchMemory(query) {
        const sapperDir = this._getSapperDir();
        try {
            const result = (0, memory_1.recallMemory)(sapperDir, query, 5);
            this._post({ type: 'memoryResults', query, results: result });
        }
        catch (e) {
            this._post({ type: 'memoryResults', query, results: `Error: ${e.message}`, error: true });
        }
    }
    _saveNote(text) {
        if (!text.trim()) {
            return;
        }
        const sapperDir = this._getSapperDir();
        try {
            (0, memory_1.appendLongMemory)(sapperDir, text);
            this._sendMemoryInfo();
            this._post({ type: 'noteSaved' });
        }
        catch (e) {
            this._post({ type: 'error', text: `Failed to save note: ${e.message}` });
        }
    }
    _readNotes() {
        const sapperDir = this._getSapperDir();
        try {
            const notes = (0, memory_1.readLongMemory)(sapperDir);
            this._post({ type: 'notesContent', content: notes || '' });
        }
        catch {
            this._post({ type: 'notesContent', content: '' });
        }
    }
    _saveCodeBlock(relPath, content) {
        const fs = require('fs');
        const workingDir = this._getWorkingDir();
        const absPath = relPath.startsWith('/') ? relPath : path.join(workingDir, relPath);
        try {
            const dir = path.dirname(absPath);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(absPath, content, 'utf8');
            vscode.workspace.openTextDocument(vscode.Uri.file(absPath)).then(doc => {
                vscode.window.showTextDocument(doc, { preview: false });
            });
            this._post({ type: 'codeSaved', path: relPath });
            this._post({ type: 'fileChange', action: 'created', path: relPath });
        }
        catch (e) {
            vscode.window.showErrorMessage(`Sapper: Failed to save file: ${e.message}`);
            this._post({ type: 'error', text: `Failed to save: ${e.message}` });
        }
    }
    /** Send current active editor file + selection to the webview. */
    _sendEditorContext() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            this._post({ type: 'editorContext', hasEditor: false });
            return;
        }
        const doc = editor.document;
        const sel = editor.selection;
        const selectionText = !sel.isEmpty ? doc.getText(sel) : '';
        const relPath = vscode.workspace.asRelativePath(doc.uri);
        const language = doc.languageId;
        const lineCount = doc.lineCount;
        // Send file content only up to 200 lines around cursor to avoid huge payloads
        const cursorLine = sel.active.line;
        const start = Math.max(0, cursorLine - 100);
        const end = Math.min(lineCount - 1, cursorLine + 100);
        const snippet = doc.getText(new vscode.Range(start, 0, end, doc.lineAt(end).text.length));
        this._post({
            type: 'editorContext',
            hasEditor: true,
            filePath: relPath,
            language,
            lineCount,
            cursorLine: cursorLine + 1,
            selectionText,
            hasSelection: !sel.isEmpty,
            snippet,
            snippetStart: start + 1,
        });
    }
    /** Apply a diff: write newContent to filePath and open it. */
    async _applyDiff(relPath, newContent) {
        const fs = require('fs');
        const workingDir = this._getWorkingDir();
        const absPath = relPath.startsWith('/') ? relPath : path.join(workingDir, relPath);
        try {
            const existed = fs.existsSync(absPath);
            const dir = path.dirname(absPath);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(absPath, newContent, 'utf8');
            vscode.workspace.openTextDocument(vscode.Uri.file(absPath)).then(doc => {
                vscode.window.showTextDocument(doc, { preview: false });
            });
            this._post({ type: 'diffApplied', path: relPath });
            this._post({ type: 'fileChange', action: existed ? 'edited' : 'created', path: relPath });
        }
        catch (e) {
            this._post({ type: 'error', text: `Apply failed: ${e.message}` });
        }
    }
    /** Search workspace files by name pattern (for @ mention autocomplete). */
    _searchWorkspaceFiles(query) {
        const workingDir = this._getWorkingDir();
        const fs = require('fs');
        const q = query.toLowerCase().replace(/^[.\/]/, '');
        const results = [];
        const SKIP = new Set(['node_modules', '.git', '.sapper', 'dist', 'build', 'out', '.next', '__pycache__']);
        const CODE_EXT = new Set(['ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'cs', 'php', 'rb', 'swift', 'kt', 'md', 'json', 'yaml', 'yml', 'toml', 'html', 'css', 'scss', 'sh', 'sql']);
        const walk = (dir, depth) => {
            if (depth > 4 || results.length >= 20) {
                return;
            }
            let entries;
            try {
                entries = fs.readdirSync(dir);
            }
            catch {
                return;
            }
            for (const e of entries) {
                if (SKIP.has(e) || e.startsWith('.')) {
                    continue;
                }
                const full = path.join(dir, e);
                let stat;
                try {
                    stat = fs.statSync(full);
                }
                catch {
                    continue;
                }
                if (stat.isDirectory()) {
                    walk(full, depth + 1);
                }
                else {
                    const rel = path.relative(workingDir, full);
                    const ext = e.split('.').pop()?.toLowerCase() || '';
                    if (CODE_EXT.has(ext) && (q === '' || rel.toLowerCase().includes(q) || e.toLowerCase().includes(q))) {
                        results.push(rel);
                    }
                }
            }
        };
        walk(workingDir, 0);
        this._post({ type: 'workspaceFileSearch', query, results });
    }
    _sendDiagnostics() {
        const all = vscode.languages.getDiagnostics();
        const items = [];
        const sevMap = {
            [vscode.DiagnosticSeverity.Error]: 'error',
            [vscode.DiagnosticSeverity.Warning]: 'warning',
            [vscode.DiagnosticSeverity.Information]: 'info',
            [vscode.DiagnosticSeverity.Hint]: 'hint',
        };
        for (const [uri, diags] of all) {
            const relPath = vscode.workspace.asRelativePath(uri, false);
            for (const d of diags) {
                items.push({
                    file: relPath,
                    severity: sevMap[d.severity] ?? 'info',
                    message: d.message,
                    line: d.range.start.line + 1,
                });
            }
        }
        this._post({ type: 'diagnostics', items });
    }
    _listSessions() {
        const sessions = SapperCore_1.SapperCore.listSessions(this._getSapperDir());
        this._post({ type: 'sessionList', sessions });
    }
    _saveSession(name) {
        if (!name || !this._core) {
            return;
        }
        const safeName = name.replace(/[^a-z0-9_\-]/gi, '_').slice(0, 64);
        this._core.saveSession(safeName);
        this._listSessions();
        this._post({ type: 'sessionSaved', name: safeName });
    }
    _loadSession(name) {
        if (!this._core) {
            return;
        }
        const ok = this._core.loadSession(name);
        if (ok) {
            const history = (this._core.context || [])
                .filter((m) => m.role === 'user' || m.role === 'assistant')
                .map((m) => ({ role: m.role, content: m.content }));
            this._post({ type: 'sessionLoaded', name, history });
            this._sendContextInfo();
        }
    }
    _sendSystemPromptPreview() {
        // Build the default system prompt by creating a temp core snapshot
        const cwd = this._getWorkingDir();
        const now = new Date();
        const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        const ws = vscode.workspace.getConfiguration('sapper');
        const custom = ws.get('systemPrompt') || '';
        const preview = custom.trim()
            ? custom.replace(/\{workingDir\}/g, cwd).replace(/\{date\}/g, dateStr).replace(/\{time\}/g, timeStr)
            : `[Default Sapper prompt — working dir: ${cwd}]`;
        this._post({ type: 'systemPromptPreview', preview });
    }
    _getHtmlForWebview(webview) {
        const mainJs = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'main.js'));
        const mainCss = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'style.css'));
        const markedJs = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'marked.umd.js'));
        const logoUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'sapper-logo.svg'));
        const nonce = getNonce();
        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource}; font-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${mainCss}">
  <title>Sapper</title>
</head>
<body>
  <div id="app">

    <!-- ── Top Header ────────────────────────────────────── -->
    <header id="header">
      <div class="logo-wrap">
        <img class="logo-icon" src="${logoUri}" alt="Sapper" draggable="false">
        <span class="logo-text">Sapper</span>
      </div>
      <div id="header-actions">
        <select id="model-select" title="Ollama model">
          <option value="">Loading…</option>
        </select>
        <button id="btn-agents" title="Agents &amp; Skills" class="icon-btn">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
            <circle cx="19" cy="6" r="2.5" fill="currentColor" stroke="none" opacity=".5"/>
          </svg>
        </button>
        <button id="btn-settings" title="Settings" class="icon-btn">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
        </button>
        <button id="btn-new" title="New session" class="icon-btn">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M12 5v14M5 12h14"/>
          </svg>
        </button>
        <button id="btn-sessions" title="Saved sessions" class="icon-btn">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
            <polyline points="9 22 9 12 15 12 15 22"/>
          </svg>
        </button>
        <button id="btn-errors" title="VS Code diagnostics / errors" class="icon-btn">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
        </button>
      </div>
    </header>

    <!-- ── Sessions popover ──────────────────────────────── -->
    <div id="sessions-popover" class="popover hidden">
      <div class="popover-header">
        <span>Saved Sessions</span>
        <div style="display:flex;gap:6px;align-items:center">
          <input id="session-name-input" type="text" placeholder="Session name…" style="width:110px">
          <button id="btn-save-session" class="primary-btn" style="padding:3px 8px;font-size:11px">Save</button>
          <button id="close-sessions" class="icon-btn close-x"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
        </div>
      </div>
      <div id="sessions-list"></div>
    </div>

    <!-- ── Diagnostics popover ───────────────────────────── -->
    <div id="diag-popover" class="popover hidden">
      <div class="popover-header">
        <span>Problems</span>
        <div style="display:flex;gap:6px;align-items:center">
          <button id="btn-inject-errors" class="secondary-btn" style="padding:3px 8px;font-size:11px" title="Send all errors to chat">Send to chat</button>
          <button id="close-diag" class="icon-btn close-x"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
        </div>
      </div>
      <div id="diag-list"></div>
    </div>

    <!-- ── Tabs ──────────────────────────────────────────── -->
    <nav id="tabs">
      <button class="tab active" data-tab="chat">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        Chat
      </button>
      <button class="tab" data-tab="files">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3h6l2 3h10a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/></svg>
        Files
      </button>
      <button class="tab" data-tab="changes">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
        Changes
        <span id="changes-badge" class="badge hidden">0</span>
      </button>
    </nav>

    <!-- ── Status bar ───────────────────────────────────── -->
    <div id="status-bar">
      <span id="status-dot" class="dot idle"></span>
      <span id="status-text">Initializing…</span>
      <span id="ctx-counter" title="Context window usage"></span>
      <span id="working-dir" title=""></span>
    </div>

    <!-- ── Mode selector ────────────────────────────────── -->
    <div id="mode-bar">
      <button class="mode-btn" data-mode="ask" title="Ask mode — Q&amp;A, explanations, no edits">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        Ask
      </button>
      <button class="mode-btn" data-mode="edit" title="Edit mode — focused code editing &amp; diffs">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>
        Edit
      </button>
      <button class="mode-btn active" data-mode="agent" title="Agent mode — full autonomy, multi-step tasks">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/><circle cx="19" cy="6" r="2.5" fill="currentColor" stroke="none" opacity=".7"/></svg>
        Agent
      </button>
    </div>

    <!-- ── Tab content: Chat ────────────────────────────── -->
    <main id="tab-chat" class="tab-panel active">
      <div id="messages">
        <div id="empty-state">
          <img class="empty-logo" src="${logoUri}" alt="Sapper" draggable="false">
          <h3>Welcome to Sapper</h3>
          <p>Local AI coding assistant.<br>Select a model and start chatting — no accounts needed.</p>
          <div class="quick-actions">
            <button class="quick-btn" data-prompt="What's in this workspace?">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
              Explore workspace
            </button>
            <button class="quick-btn" data-prompt="Run the tests and tell me if anything fails.">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 3h6M9 3v8l-4.5 9a1 1 0 0 0 .9 1.5h13.2a1 1 0 0 0 .9-1.5L15 11V3"/></svg>
              Run tests
            </button>
            <button class="quick-btn" data-prompt="Show me a summary of recent git changes.">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/></svg>
              Git changes
            </button>
          </div>
        </div>
      </div>
    </main>

    <!-- ── Tab content: File Tree ───────────────────────── -->
    <main id="tab-files" class="tab-panel">
      <div id="file-tree-header">
        <div id="breadcrumb">
          <span class="crumb" data-path="">workspace</span>
        </div>
        <button id="btn-index" class="icon-btn index-btn" title="Build workspace index">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
          Index
        </button>
      </div>
      <div id="workspace-index" class="hidden"></div>
      <div id="file-tree"></div>
    </main>

    <!-- ── Tab content: Changes ─────────────────────────── -->
    <main id="tab-changes" class="tab-panel">
      <div id="changes-empty">
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".4"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        <p>No file changes yet.<br><small>Files created or edited by Sapper appear here.</small></p>
      </div>
      <div id="changes-list"></div>
    </main>

    <!-- ── Settings Modal (4 tabs) ─────────────────────── -->
    <div id="settings-modal" class="modal hidden">
      <div class="modal-content wide-modal">
        <div class="modal-header">
          <span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="vertical-align:-2px;margin-right:5px"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            Sapper Settings
          </span>
          <button id="close-settings" class="icon-btn close-x">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <!-- Setting tabs -->
        <div id="stabs">
          <button class="stab active" data-stab="general">General</button>
          <button class="stab" data-stab="tools">Tools</button>
          <button class="stab" data-stab="prompt">System Prompt</button>
          <button class="stab" data-stab="context">Context</button>
        </div>
        <!-- General tab -->
        <div class="stab-panel active" id="stab-general">
          <label class="form-row">
            <span class="form-label">Ollama Host</span>
            <input id="set-ollamaHost" type="text" placeholder="http://127.0.0.1:11434">
            <small>URL of the local Ollama server.</small>
          </label>
          <label class="form-row">
            <span class="form-label">Default Model</span>
            <input id="set-defaultModel" type="text" placeholder="e.g. llama3">
            <small>Auto-selected on startup. Leave empty to pick each time.</small>
          </label>
          <label class="form-row">
            <span class="form-label">Tool Round Limit</span>
            <input id="set-toolRoundLimit" type="number" min="1" max="200" value="40">
            <small>Maximum tool-call rounds per AI response.</small>
          </label>
          <label class="form-row toggle-row">
            <input id="set-autoAttach" type="checkbox">
            <span class="form-label">Auto-attach workspace context</span>
          </label>
          <label class="form-row toggle-row">
            <input id="set-shellEnabled" type="checkbox">
            <span class="form-label">Allow shell commands</span>
          </label>
        </div>
        <!-- Tools tab -->
        <div class="stab-panel" id="stab-tools">
          <p class="stab-hint">Toggle which tools Sapper is allowed to use. Disabled tools are never called.</p>
          <div id="tools-toggles"></div>
        </div>
        <!-- System Prompt tab -->
        <div class="stab-panel" id="stab-prompt">
          <label class="form-row">
            <span class="form-label">Custom System Prompt</span>
            <textarea id="set-systemPrompt" rows="6" placeholder="Leave empty to use the default Sapper prompt.&#10;Variables: {workingDir}, {date}, {time}"></textarea>
            <small>Overrides the built-in Sapper system prompt. Variables <code>{workingDir}</code>, <code>{date}</code>, <code>{time}</code> are substituted at runtime.</small>
          </label>
          <button id="btn-preview-prompt" class="secondary-btn" style="margin-bottom:8px">Preview resolved prompt</button>
          <div id="prompt-preview-wrap" class="hidden">
            <span class="form-label">Preview</span>
            <pre id="prompt-preview"></pre>
          </div>
          <button id="btn-reset-prompt" class="danger-btn">Reset to default</button>
        </div>
        <!-- Context tab -->
        <div class="stab-panel" id="stab-context">
          <label class="form-row">
            <span class="form-label">Context Token Limit</span>
            <input id="set-maxContextTokens" type="number" min="0" max="2000000" step="1000" value="0">
            <small>Max tokens to keep in context. Oldest messages are trimmed when exceeded. Set to your model's context window (e.g. <code>8192</code>, <code>32768</code>, <code>131072</code>). <code>0</code> = no limit.</small>
          </label>
          <label class="form-row">
            <span class="form-label">Summarize Trigger %</span>
            <input id="set-summarizeTriggerPercent" type="number" min="10" max="95" value="65">
            <small>Visual warning threshold — shown in the context meter when usage exceeds this % of the limit.</small>
          </label>
          <div id="ctx-stats-panel" class="ctx-stats-panel">
            <div class="ctx-stat-row">
              <span class="ctx-stat-label">Messages</span>
              <span class="ctx-stat-value" id="ctx-msg-count">—</span>
            </div>
            <div class="ctx-stat-row">
              <span class="ctx-stat-label">Raw size</span>
              <span class="ctx-stat-value" id="ctx-raw-kb">—</span>
            </div>
            <div class="ctx-stat-row">
              <span class="ctx-stat-label">Estimated tokens</span>
              <span class="ctx-stat-value" id="ctx-token-count">—</span>
            </div>
            <div class="ctx-stat-row" id="ctx-limit-row" style="display:none">
              <span class="ctx-stat-label">Token limit</span>
              <span class="ctx-stat-value" id="ctx-limit-val">—</span>
            </div>
            <div class="ctx-stat-row" id="ctx-usage-row" style="display:none">
              <span class="ctx-stat-label">Usage</span>
              <span class="ctx-stat-value" id="ctx-usage-pct">—</span>
            </div>
            <!-- Progress meter -->
            <div id="ctx-meter-wrap" style="display:none">
              <div id="ctx-meter-bar">
                <div id="ctx-meter-fill"></div>
                <div id="ctx-meter-threshold"></div>
              </div>
              <div id="ctx-meter-labels">
                <span id="ctx-meter-label-left">0</span>
                <span id="ctx-meter-label-right">—</span>
              </div>
            </div>
            <div class="ctx-stat-row" id="ctx-lastturn-row" style="display:none">
              <span class="ctx-stat-label">Last turn</span>
              <span class="ctx-stat-value" id="ctx-lastturn-val">—</span>
            </div>
            <div class="ctx-stat-row">
              <span class="ctx-stat-label">System prompt</span>
              <span class="ctx-stat-value" id="ctx-prompt-type">default</span>
            </div>
            <div class="ctx-stat-row">
              <span class="ctx-stat-label">Tool rounds</span>
              <span class="ctx-stat-value" id="ctx-tool-rounds">40</span>
            </div>
          </div>
          <button id="btn-refresh-ctx" class="secondary-btn" style="margin-bottom:8px">Refresh stats</button>
          <button id="btn-clear-context" class="danger-btn">Clear conversation context</button>
        </div>
        <div class="modal-footer">
          <button id="save-settings" class="primary-btn">Save</button>
          <button id="cancel-settings" class="secondary-btn">Cancel</button>
        </div>
      </div>
    </div>

    <!-- ── Agents/Skills Modal ──────────────────────────── -->
    <div id="agents-modal" class="modal hidden">
      <div class="modal-content">
        <div class="modal-header">
          <span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="vertical-align:-2px;margin-right:5px"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>
            Agents &amp; Skills
          </span>
          <button id="close-agents" class="icon-btn close-x">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="modal-body">
          <div class="section-title">Agents</div>
          <div id="agents-list"></div>
          <div class="section-title" style="margin-top:12px">Skills</div>
          <div id="skills-list"></div>
        </div>
      </div>
    </div>

    <!-- ── Input area ────────────────────────────────────── -->
    <footer id="input-area">
      <!-- Drop overlay -->
      <div id="drop-overlay" class="hidden">
        <div class="drop-inner">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          <span>Drop files to attach</span>
        </div>
      </div>
      <!-- Memory recall panel — slides up above input -->
      <div id="memory-panel" class="hidden">
        <div id="memory-panel-header">
          <div id="mem-tabs">
            <button class="mem-tab active" data-tab="recall">Recall</button>
            <button class="mem-tab" data-tab="notes">Notes</button>
          </div>
          <button id="close-memory-panel" class="icon-btn" title="Close">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div id="mem-tab-recall" class="mem-tab-content">
          <div id="recall-search-bar">
            <input id="recall-query" placeholder="Search memories…" autocomplete="off"/>
            <button id="btn-recall" class="icon-btn recall-btn" title="Search">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="22" y2="22"/></svg>
            </button>
          </div>
          <div id="recall-results"></div>
        </div>
        <div id="mem-tab-notes" class="mem-tab-content hidden">
          <div id="notes-content"></div>
          <div id="note-save-bar">
            <textarea id="note-input" placeholder="Save a memory note…" rows="2"></textarea>
            <button id="btn-save-note">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
              Save note
            </button>
          </div>
        </div>
      </div>
      <!-- Input meta-bar: context pill + memory pill -->
      <div id="input-meta-bar">
        <div id="meta-ctx" class="meta-pill" title="Context usage">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="4" height="18" rx="1"/><rect x="10" y="8" width="4" height="13" rx="1"/><rect x="17" y="13" width="4" height="8" rx="1"/></svg>
          <div id="meta-ctx-track"><div id="meta-ctx-fill"></div></div>
          <span id="meta-ctx-label">– msgs</span>
        </div>
        <div id="meta-mem" class="meta-pill meta-pill-btn" title="Memory — click to open">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2a7 7 0 0 1 7 7c0 2.5-1.3 4.7-3.3 6l-.7 3H9l-.7-3C6.3 13.7 5 11.5 5 9a7 7 0 0 1 7-7z"/><line x1="9" y1="21" x2="15" y2="21"/><line x1="9.5" y1="18" x2="14.5" y2="18"/></svg>
          <span id="meta-mem-label">– mem</span>
        </div>
      </div>
      <!-- Attached file chips -->
      <div id="attach-bar" class="hidden"></div>
      <!-- Editor context badge (shown when a file is open in editor) -->
      <div id="editor-badge" class="hidden" title="Active editor — click to attach"></div>
      <div id="input-wrapper">
        <button id="btn-attach" title="Attach files (or type @file)" class="icon-btn attach-btn">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
        </button>
        <textarea id="input" placeholder="Ask anything… or type / for commands, @ to attach" rows="2"></textarea>
        <div id="input-buttons">
          <button id="btn-send" title="Send (Enter)" class="send-btn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>
          </button>
          <button id="btn-abort" class="abort-btn hidden" title="Stop generation">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
          </button>
        </div>
      </div>
      <div id="hint-bar">
        <span title="Type / for slash commands">/explain  /fix  /refactor  /tests</span>
        <span title="Type @ to reference files">@editor  @selection  @file</span>
      </div>
    </footer>
  </div>
  <script nonce="${nonce}" src="${markedJs}"></script>
  <script nonce="${nonce}" src="${mainJs}"></script>
</body>
</html>`;
    }
}
exports.SapperPanel = SapperPanel;
SapperPanel.viewType = 'sapperPanel';
function getNonce() {
    let text = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return text;
}
//# sourceMappingURL=SapperPanel.js.map