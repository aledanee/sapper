import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SapperPanel } from './SapperPanel';

let sapperPanel: SapperPanel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  // Register the sidebar WebviewViewProvider — NO authentication required
  sapperPanel = new SapperPanel(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SapperPanel.viewType, sapperPanel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // Command: open the Sapper sidebar panel
  context.subscriptions.push(
    vscode.commands.registerCommand('sapper.openPanel', () => {
      vscode.commands.executeCommand('sapperPanel.focus');
    }),
  );

  // Command: new session (clear context)
  context.subscriptions.push(
    vscode.commands.registerCommand('sapper.newSession', () => {
      sapperPanel?.sendContextMessage('/new');
    }),
  );

  // Command: right-click a file in explorer or editor → ask Sapper about it
  context.subscriptions.push(
    vscode.commands.registerCommand('sapper.askAboutFile', async (uri?: vscode.Uri) => {
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
    }),
  );

  // Ensure .sapper directory structure exists in workspace on activation
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    const sapperDir = path.join(folders[0].uri.fsPath, '.sapper');
    ensureSapperStructure(sapperDir);
  }
}

export function deactivate(): void { /* nothing to clean up */ }

function ensureSapperStructure(sapperDir: string): void {
  try {
    ['agents', 'skills', 'logs'].forEach((sub) => {
      const dir = path.join(sapperDir, sub);
      if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
    });
  } catch (_) { /* silent — workspace may be read-only */ }
}
