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
exports.loadContext = loadContext;
exports.saveContext = saveContext;
exports.clearContext = clearContext;
exports.readLongMemory = readLongMemory;
exports.appendLongMemory = appendLongMemory;
exports.loadEmbeddings = loadEmbeddings;
exports.saveEmbeddings = saveEmbeddings;
exports.addEmbedding = addEmbedding;
exports.recallMemory = recallMemory;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
// ── Context (conversation history) ────────────────────────────
function loadContext(sapperDir) {
    const file = path.join(sapperDir, 'context.json');
    try {
        if (fs.existsSync(file)) {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        }
    }
    catch (_) { /* ignore */ }
    return [];
}
function saveContext(sapperDir, messages) {
    try {
        fs.mkdirSync(sapperDir, { recursive: true });
        fs.writeFileSync(path.join(sapperDir, 'context.json'), JSON.stringify(messages, null, 2));
    }
    catch (_) { /* silent */ }
}
function clearContext(sapperDir) {
    const file = path.join(sapperDir, 'context.json');
    try {
        if (fs.existsSync(file)) {
            fs.unlinkSync(file);
        }
    }
    catch (_) { /* silent */ }
}
// ── Long-term memory notes ─────────────────────────────────────
function readLongMemory(sapperDir) {
    const file = path.join(sapperDir, 'long-memory.md');
    try {
        return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    }
    catch (_) {
        return '';
    }
}
function appendLongMemory(sapperDir, note) {
    const file = path.join(sapperDir, 'long-memory.md');
    try {
        fs.mkdirSync(sapperDir, { recursive: true });
        const timestamp = new Date().toISOString();
        fs.appendFileSync(file, `\n---\n${timestamp}\n${note.trim()}\n`);
    }
    catch (_) { /* silent */ }
}
function dotProduct(a, b) {
    let s = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
        s += a[i] * b[i];
    }
    return s;
}
function magnitude(v) {
    return Math.sqrt(v.reduce((s, x) => s + x * x, 0));
}
function cosine(a, b) {
    const ma = magnitude(a);
    const mb = magnitude(b);
    if (ma === 0 || mb === 0) {
        return 0;
    }
    return dotProduct(a, b) / (ma * mb);
}
/** Cheap bag-of-words vector (no external model needed for fallback recall). */
function bagOfWordsVector(text, vocab) {
    const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/);
    const wordSet = new Set(words);
    return vocab.map((w) => (wordSet.has(w) ? 1 : 0));
}
function loadEmbeddings(sapperDir) {
    const file = path.join(sapperDir, 'embeddings.json');
    try {
        return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
    }
    catch (_) {
        return [];
    }
}
function saveEmbeddings(sapperDir, chunks) {
    try {
        fs.mkdirSync(sapperDir, { recursive: true });
        const trimmed = chunks.slice(-100);
        fs.writeFileSync(path.join(sapperDir, 'embeddings.json'), JSON.stringify(trimmed, null, 2));
    }
    catch (_) { /* silent */ }
}
function addEmbedding(sapperDir, text) {
    if (!text || text.trim().length < 50) {
        return;
    }
    const chunks = loadEmbeddings(sapperDir);
    const vocab = buildVocab([text, ...chunks.map((c) => c.text)]);
    const vector = bagOfWordsVector(text, vocab);
    chunks.push({ text: text.substring(0, 2000), vector, timestamp: new Date().toISOString() });
    saveEmbeddings(sapperDir, chunks);
}
function recallMemory(sapperDir, query, topK = 3) {
    const chunks = loadEmbeddings(sapperDir);
    if (chunks.length === 0) {
        return 'No memory chunks found.';
    }
    const vocab = buildVocab([query, ...chunks.map((c) => c.text)]);
    const qv = bagOfWordsVector(query, vocab);
    const scored = chunks.map((c) => {
        const cv = bagOfWordsVector(c.text, vocab);
        return { text: c.text, score: cosine(qv, cv) };
    }).filter((r) => r.score > 0.3).sort((a, b) => b.score - a.score).slice(0, topK);
    if (scored.length === 0) {
        return 'No relevant memories found.';
    }
    return scored.map((r, i) => `[${i + 1}] (score: ${r.score.toFixed(2)})\n${r.text.substring(0, 300)}`).join('\n\n');
}
function buildVocab(texts) {
    const freq = {};
    for (const t of texts) {
        for (const w of t.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)) {
            if (w.length > 2) {
                freq[w] = (freq[w] || 0) + 1;
            }
        }
    }
    return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 500).map(([w]) => w);
}
//# sourceMappingURL=memory.js.map