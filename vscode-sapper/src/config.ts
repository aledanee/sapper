import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface SapperConfig {
  defaultModel: string | null;
  defaultAgent: string | null;
  autoAttach: boolean;
  toolRoundLimit: number;
  maxFileSize: number;
  shell: {
    streamToModel: boolean;
    backgroundMode: string;
  };
}

const DEFAULT_CONFIG: SapperConfig = {
  defaultModel: null,
  defaultAgent: null,
  autoAttach: true,
  toolRoundLimit: 40,
  maxFileSize: 100000,
  shell: {
    streamToModel: true,
    backgroundMode: 'auto',
  },
};

export function loadConfig(sapperDir: string): SapperConfig {
  const configFile = path.join(sapperDir, 'config.json');
  try {
    if (fs.existsSync(configFile)) {
      const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      return { ...DEFAULT_CONFIG, ...raw, shell: { ...DEFAULT_CONFIG.shell, ...(raw.shell || {}) } };
    }
  } catch (_) { /* use defaults */ }
  return { ...DEFAULT_CONFIG };
}

export function saveConfig(sapperDir: string, config: SapperConfig): void {
  try {
    fs.mkdirSync(sapperDir, { recursive: true });
    fs.writeFileSync(path.join(sapperDir, 'config.json'), JSON.stringify(config, null, 2));
  } catch (_) { /* silent */ }
}

/** Merge VS Code workspace settings on top of .sapper/config.json */
export function getEffectiveConfig(sapperDir: string): SapperConfig {
  const base = loadConfig(sapperDir);
  const ws = vscode.workspace.getConfiguration('sapper');
  return {
    ...base,
    defaultModel: ws.get<string>('defaultModel') || base.defaultModel,
    toolRoundLimit: ws.get<number>('toolRoundLimit') ?? base.toolRoundLimit,
    autoAttach: ws.get<boolean>('autoAttach') ?? base.autoAttach,
  };
}
