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
class SapperPanel {
    constructor(context) {
        this._currentModel = '';
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
        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case 'ready':
                    await this._onReady();
                    break;
                case 'chat':
                    await this._onChat(msg.text);
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
                case 'setAgent':
                    await this._onSetAgent(msg.agent);
                    break;
                case 'addSkill':
                    await this._onAddSkill(msg.skill);
                    break;
                case 'listAgents':
                    this._sendAgentsList();
                    break;
                case 'listSkills':
                    this._sendSkillsList();
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
            onChunk: (text) => this._post({ type: 'chunk', text }),
            onStatus: (status) => this._post({ type: 'status', status }),
            onToolStart: (tool, p) => this._post({ type: 'toolStart', tool, path: p }),
            onToolEnd: (tool, p, success, result) => this._post({ type: 'toolEnd', tool, path: p, success, result }),
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
        this._post({ type: 'models', models });
        // Load stored model from workspace state
        const stored = this._context.workspaceState.get('sapperModel') || '';
        const config = (0, config_1.getEffectiveConfig)(this._getSapperDir());
        const defaultModel = config.defaultModel || stored;
        if (defaultModel && models.includes(defaultModel)) {
            this._currentModel = defaultModel;
            this._ensureCore(defaultModel);
            this._post({ type: 'modelSelected', model: defaultModel });
        }
        // Send workspace info
        this._post({
            type: 'workspaceInfo',
            workingDir: this._getWorkingDir(),
            hasContext: this._core ? this._core.context.length > 0 : false,
        });
    }
    async _onSelectModel(model) {
        this._currentModel = model;
        await this._context.workspaceState.update('sapperModel', model);
        this._ensureCore(model);
        this._post({ type: 'modelSelected', model });
        this._post({ type: 'status', status: 'idle' });
    }
    async _onChat(text) {
        if (!this._currentModel) {
            this._post({ type: 'error', message: 'Please select an Ollama model first.' });
            return;
        }
        if (!this._core) {
            this._ensureCore(this._currentModel);
        }
        await this._core.chat(text);
    }
    _onNewSession() {
        this._core?.clearContext();
        this._post({ type: 'cleared' });
        this._post({ type: 'status', status: 'idle' });
    }
    async _onSetAgent(agentName) {
        if (!this._core) {
            this._ensureCore(this._currentModel || 'llama3');
        }
        const msg = this._core.setAgent(agentName || null);
        this._post({ type: 'agentSet', message: msg });
    }
    async _onAddSkill(skillName) {
        if (!this._core) {
            this._ensureCore(this._currentModel || 'llama3');
        }
        const msg = this._core.addSkill(skillName);
        this._post({ type: 'skillAdded', message: msg });
    }
    _sendAgentsList() {
        const agents = (0, agents_1.loadAgents)(this._getSapperDir());
        this._post({ type: 'agents', agents: Object.values(agents).map((a) => ({ name: a.name, description: a.description })) });
    }
    _sendSkillsList() {
        const skills = (0, agents_1.loadSkills)(this._getSapperDir());
        this._post({ type: 'skills', skills: Object.values(skills).map((s) => ({ name: s.name, description: s.description })) });
    }
    _post(msg) {
        this._view?.webview.postMessage(msg);
    }
    _getHtmlForWebview(webview) {
        const mainJs = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'main.js'));
        const mainCss = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'style.css'));
        const nonce = getNonce();
        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${mainCss}">
  <title>Sapper</title>
</head>
<body>
  <div id="app">
    <div id="header">
      <span class="logo">🤖 Sapper</span>
      <div id="header-actions">
        <select id="model-select" title="Select Ollama model">
          <option value="">Loading models…</option>
        </select>
        <button id="btn-agents" title="Agents" class="icon-btn">👤</button>
        <button id="btn-new" title="New session" class="icon-btn">🗑️</button>
      </div>
    </div>
    <div id="status-bar">
      <span id="status-text">Select a model to start</span>
      <span id="working-dir"></span>
    </div>
    <div id="messages"></div>
    <div id="agents-panel" class="hidden">
      <div class="panel-header">
        <span>Agents</span><button id="close-agents">✕</button>
      </div>
      <div id="agents-list"></div>
      <div class="panel-header" style="margin-top:8px">
        <span>Skills</span>
      </div>
      <div id="skills-list"></div>
    </div>
    <div id="input-area">
      <div id="input-wrapper">
        <textarea id="input" placeholder="Ask Sapper anything…" rows="3"></textarea>
        <div id="input-buttons">
          <button id="btn-send" title="Send (Enter)">➤</button>
          <button id="btn-abort" class="hidden" title="Stop">⏹</button>
        </div>
      </div>
      <div id="attach-hint">@file to attach · /agent name · /skill name · /new · /clear</div>
    </div>
  </div>
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