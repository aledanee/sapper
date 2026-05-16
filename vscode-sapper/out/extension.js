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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const SapperPanel_1 = require("./SapperPanel");
let sapperPanel;
function activate(context) {
    // Register the sidebar WebviewViewProvider — NO authentication required
    sapperPanel = new SapperPanel_1.SapperPanel(context);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(SapperPanel_1.SapperPanel.viewType, sapperPanel, {
        webviewOptions: { retainContextWhenHidden: true },
    }));
    // Command: open the Sapper sidebar panel
    context.subscriptions.push(vscode.commands.registerCommand('sapper.openPanel', () => {
        vscode.commands.executeCommand('sapperPanel.focus');
    }));
    // Command: new session (clear context)
    context.subscriptions.push(vscode.commands.registerCommand('sapper.newSession', () => {
        sapperPanel?.sendContextMessage('/new');
    }));
    // Command: right-click a file in explorer or editor → ask Sapper about it
    context.subscriptions.push(vscode.commands.registerCommand('sapper.askAboutFile', async (uri) => {
        // Resolve file URI — from explorer context or active editor
        const fileUri = uri || vscode.window.activeTextEditor?.document.uri;
        if (!fileUri) {
            vscode.window.showWarningMessage('Sapper: No file selected.');
            return;
        }
        const workspaceFolders = vscode.workspace.workspaceFolders;
        const workingDir = workspaceFolders?.[0]?.uri.fsPath || path.dirname(fileUri.fsPath);
        const relPath = path.relative(workingDir, fileUri.fsPath);
        // If there's a text selection, include it
        const editor = vscode.window.activeTextEditor;
        const selection = editor?.selection;
        const selectedText = (editor && selection && !selection.isEmpty)
            ? editor.document.getText(selection)
            : null;
        let message = `Please read and analyze this file: ${relPath}`;
        if (selectedText) {
            message += `\n\nFocus on this selected code:\n\`\`\`\n${selectedText.substring(0, 2000)}\n\`\`\``;
        }
        await vscode.commands.executeCommand('sapperPanel.focus');
        sapperPanel?.sendContextMessage(message);
    }));
    // Ensure .sapper directory structure exists in workspace on activation
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
        const sapperDir = path.join(folders[0].uri.fsPath, '.sapper');
        ensureSapperStructure(sapperDir);
    }
}
function deactivate() { }
function ensureSapperStructure(sapperDir) {
    try {
        ['agents', 'skills', 'logs'].forEach((sub) => {
            const dir = path.join(sapperDir, sub);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        });
    }
    catch (_) { /* silent — workspace may be read-only */ }
}
//# sourceMappingURL=extension.js.map