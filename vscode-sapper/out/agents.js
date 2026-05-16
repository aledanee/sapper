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
exports.normalizeToolName = normalizeToolName;
exports.normalizeToolList = normalizeToolList;
exports.parseFrontmatter = parseFrontmatter;
exports.loadAgents = loadAgents;
exports.loadSkills = loadSkills;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const TOOL_NAME_MAP = {
    read: 'READ', write: 'WRITE', edit: 'PATCH', patch: 'PATCH',
    list: 'LIST', ls: 'LS', search: 'SEARCH', grep: 'GREP',
    find: 'FIND', shell: 'SHELL', mkdir: 'MKDIR', rmdir: 'RMDIR',
    cd: 'CD', pwd: 'PWD', cat: 'CAT', head: 'HEAD', tail: 'TAIL',
    changes: 'CHANGES', diff: 'CHANGES', fetch: 'FETCH', web: 'FETCH',
    memory: 'MEMORY', recall: 'MEMORY', open: 'OPEN',
};
function normalizeToolName(toolName) {
    const n = toolName.trim();
    return TOOL_NAME_MAP[n.toLowerCase()] || n.toUpperCase();
}
function normalizeToolList(toolsValue) {
    if (!toolsValue) {
        return null;
    }
    if (typeof toolsValue === 'string') {
        toolsValue = toolsValue.split(',').map((s) => s.trim());
    }
    if (!Array.isArray(toolsValue)) {
        return null;
    }
    return [...new Set(toolsValue.map(normalizeToolName).filter(Boolean))];
}
function parseFrontmatter(rawContent) {
    const content = rawContent.trim();
    if (!content.startsWith('---')) {
        const firstLine = content.split('\n')[0].replace(/^#\s*/, '').trim();
        return { meta: { name: firstLine, description: firstLine }, body: content };
    }
    const endIndex = content.indexOf('---', 3);
    if (endIndex === -1) {
        const firstLine = content.split('\n')[0].replace(/^#\s*/, '').replace(/^---\s*/, '').trim();
        return { meta: { name: firstLine }, body: content };
    }
    const fmBlock = content.substring(3, endIndex).trim();
    const body = content.substring(endIndex + 3).trim();
    const meta = {};
    for (const line of fmBlock.split('\n')) {
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) {
            continue;
        }
        const key = line.substring(0, colonIdx).trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
        let value = line.substring(colonIdx + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (value.startsWith('[') && value.endsWith(']')) {
            meta[key] = value.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
        }
        else {
            meta[key] = value;
        }
    }
    if (!meta.name) {
        const heading = body.match(/^#\s+(.+)/m);
        meta.name = heading ? heading[1].trim() : 'Unnamed';
    }
    return { meta, body };
}
function loadAgents(sapperDir) {
    const agentsDir = path.join(sapperDir, 'agents');
    const agents = {};
    if (!fs.existsSync(agentsDir)) {
        return agents;
    }
    try {
        for (const file of fs.readdirSync(agentsDir)) {
            if (!file.endsWith('.md')) {
                continue;
            }
            const name = file.replace('.md', '').toLowerCase();
            const raw = fs.readFileSync(path.join(agentsDir, file), 'utf8');
            const { meta, body } = parseFrontmatter(raw);
            agents[name] = {
                name: meta.name || name,
                file,
                content: body,
                description: meta.description || meta.name || name,
                tools: normalizeToolList(meta.tools),
                argumentHint: meta['argument-hint'] || null,
            };
        }
    }
    catch (_) { /* silent */ }
    return agents;
}
function loadSkills(sapperDir) {
    const skillsDir = path.join(sapperDir, 'skills');
    const skills = {};
    if (!fs.existsSync(skillsDir)) {
        return skills;
    }
    try {
        for (const file of fs.readdirSync(skillsDir)) {
            if (!file.endsWith('.md')) {
                continue;
            }
            const name = file.replace('.md', '').toLowerCase();
            const raw = fs.readFileSync(path.join(skillsDir, file), 'utf8');
            const { meta, body } = parseFrontmatter(raw);
            skills[name] = {
                name: meta.name || name,
                description: meta.description || meta.name || name,
                content: body,
                argumentHint: meta['argument-hint'] || null,
            };
        }
    }
    catch (_) { /* silent */ }
    return skills;
}
//# sourceMappingURL=agents.js.map