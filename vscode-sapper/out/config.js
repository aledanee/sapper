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
exports.loadConfig = loadConfig;
exports.saveConfig = saveConfig;
exports.getEffectiveConfig = getEffectiveConfig;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const DEFAULT_CONFIG = {
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
function loadConfig(sapperDir) {
    const configFile = path.join(sapperDir, 'config.json');
    try {
        if (fs.existsSync(configFile)) {
            const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
            return { ...DEFAULT_CONFIG, ...raw, shell: { ...DEFAULT_CONFIG.shell, ...(raw.shell || {}) } };
        }
    }
    catch (_) { /* use defaults */ }
    return { ...DEFAULT_CONFIG };
}
function saveConfig(sapperDir, config) {
    try {
        fs.mkdirSync(sapperDir, { recursive: true });
        fs.writeFileSync(path.join(sapperDir, 'config.json'), JSON.stringify(config, null, 2));
    }
    catch (_) { /* silent */ }
}
/** Merge VS Code workspace settings on top of .sapper/config.json */
function getEffectiveConfig(sapperDir) {
    const base = loadConfig(sapperDir);
    const ws = vscode.workspace.getConfiguration('sapper');
    return {
        ...base,
        defaultModel: ws.get('defaultModel') || base.defaultModel,
        toolRoundLimit: ws.get('toolRoundLimit') ?? base.toolRoundLimit,
        autoAttach: ws.get('autoAttach') ?? base.autoAttach,
    };
}
//# sourceMappingURL=config.js.map