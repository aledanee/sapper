import * as fs from 'fs';
import * as path from 'path';

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

// ── Context (conversation history) ────────────────────────────

export function loadContext(sapperDir: string): Message[] {
  const file = path.join(sapperDir, 'context.json');
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (_) { /* ignore */ }
  return [];
}

export function saveContext(sapperDir: string, messages: Message[]): void {
  try {
    fs.mkdirSync(sapperDir, { recursive: true });
    fs.writeFileSync(path.join(sapperDir, 'context.json'), JSON.stringify(messages, null, 2));
  } catch (_) { /* silent */ }
}

export function clearContext(sapperDir: string): void {
  const file = path.join(sapperDir, 'context.json');
  try { if (fs.existsSync(file)) { fs.unlinkSync(file); } } catch (_) { /* silent */ }
}

// ── Long-term memory notes ─────────────────────────────────────

export function readLongMemory(sapperDir: string): string {
  const file = path.join(sapperDir, 'long-memory.md');
  try { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''; } catch (_) { return ''; }
}

export function appendLongMemory(sapperDir: string, note: string): void {
  const file = path.join(sapperDir, 'long-memory.md');
  try {
    fs.mkdirSync(sapperDir, { recursive: true });
    const timestamp = new Date().toISOString();
    fs.appendFileSync(file, `\n---\n${timestamp}\n${note.trim()}\n`);
  } catch (_) { /* silent */ }
}

// ── Simple cosine-similarity vector recall ─────────────────────

interface EmbeddingChunk {
  text: string;
  vector: number[];
  timestamp: string;
}

function dotProduct(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { s += a[i] * b[i]; }
  return s;
}

function magnitude(v: number[]): number {
  return Math.sqrt(v.reduce((s, x) => s + x * x, 0));
}

function cosine(a: number[], b: number[]): number {
  const ma = magnitude(a);
  const mb = magnitude(b);
  if (ma === 0 || mb === 0) { return 0; }
  return dotProduct(a, b) / (ma * mb);
}

/** Cheap bag-of-words vector (no external model needed for fallback recall). */
function bagOfWordsVector(text: string, vocab: string[]): number[] {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/);
  const wordSet = new Set(words);
  return vocab.map((w) => (wordSet.has(w) ? 1 : 0));
}

export function loadEmbeddings(sapperDir: string): EmbeddingChunk[] {
  const file = path.join(sapperDir, 'embeddings.json');
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []; } catch (_) { return []; }
}

export function saveEmbeddings(sapperDir: string, chunks: EmbeddingChunk[]): void {
  try {
    fs.mkdirSync(sapperDir, { recursive: true });
    const trimmed = chunks.slice(-100);
    fs.writeFileSync(path.join(sapperDir, 'embeddings.json'), JSON.stringify(trimmed, null, 2));
  } catch (_) { /* silent */ }
}

export function addEmbedding(sapperDir: string, text: string): void {
  if (!text || text.trim().length < 50) { return; }
  const chunks = loadEmbeddings(sapperDir);
  const vocab = buildVocab([text, ...chunks.map((c) => c.text)]);
  const vector = bagOfWordsVector(text, vocab);
  chunks.push({ text: text.substring(0, 2000), vector, timestamp: new Date().toISOString() });
  saveEmbeddings(sapperDir, chunks);
}

export function recallMemory(sapperDir: string, query: string, topK = 3): string {
  const chunks = loadEmbeddings(sapperDir);
  if (chunks.length === 0) { return 'No memory chunks found.'; }
  const vocab = buildVocab([query, ...chunks.map((c) => c.text)]);
  const qv = bagOfWordsVector(query, vocab);
  const scored = chunks.map((c) => {
    const cv = bagOfWordsVector(c.text, vocab);
    return { text: c.text, score: cosine(qv, cv) };
  }).filter((r) => r.score > 0.3).sort((a, b) => b.score - a.score).slice(0, topK);
  if (scored.length === 0) { return 'No relevant memories found.'; }
  return scored.map((r, i) => `[${i + 1}] (score: ${r.score.toFixed(2)})\n${r.text.substring(0, 300)}`).join('\n\n');
}

function buildVocab(texts: string[]): string[] {
  const freq: Record<string, number> = {};
  for (const t of texts) {
    for (const w of t.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)) {
      if (w.length > 2) { freq[w] = (freq[w] || 0) + 1; }
    }
  }
  return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 500).map(([w]) => w);
}
