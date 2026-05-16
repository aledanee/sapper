import * as fs from 'fs';
import * as path from 'path';

export interface AgentMeta {
  name: string;
  description: string;
  tools: string[] | null;
  argumentHint: string | null;
}

export interface Agent extends AgentMeta {
  file: string;
  content: string;
}

export interface Skill {
  name: string;
  description: string;
  content: string;
  argumentHint: string | null;
}

const TOOL_NAME_MAP: Record<string, string> = {
  read: 'READ', write: 'WRITE', edit: 'PATCH', patch: 'PATCH',
  list: 'LIST', ls: 'LS', search: 'SEARCH', grep: 'GREP',
  find: 'FIND', shell: 'SHELL', mkdir: 'MKDIR', rmdir: 'RMDIR',
  cd: 'CD', pwd: 'PWD', cat: 'CAT', head: 'HEAD', tail: 'TAIL',
  changes: 'CHANGES', diff: 'CHANGES', fetch: 'FETCH', web: 'FETCH',
  memory: 'MEMORY', recall: 'MEMORY', open: 'OPEN',
};

export function normalizeToolName(toolName: string): string {
  const n = toolName.trim();
  return TOOL_NAME_MAP[n.toLowerCase()] || n.toUpperCase();
}

export function normalizeToolList(toolsValue: string | string[] | null | undefined): string[] | null {
  if (!toolsValue) { return null; }
  if (typeof toolsValue === 'string') {
    toolsValue = toolsValue.split(',').map((s) => s.trim());
  }
  if (!Array.isArray(toolsValue)) { return null; }
  return [...new Set(toolsValue.map(normalizeToolName).filter(Boolean))];
}

export function parseFrontmatter(rawContent: string): { meta: Record<string, string | string[]>; body: string } {
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
  const meta: Record<string, string | string[]> = {};
  for (const line of fmBlock.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) { continue; }
    const key = line.substring(0, colonIdx).trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
    let value: string = line.substring(colonIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value.startsWith('[') && value.endsWith(']')) {
      meta[key] = value.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else {
      meta[key] = value;
    }
  }
  if (!meta.name) {
    const heading = body.match(/^#\s+(.+)/m);
    meta.name = heading ? heading[1].trim() : 'Unnamed';
  }
  return { meta, body };
}

export function loadAgents(sapperDir: string): Record<string, Agent> {
  const agentsDir = path.join(sapperDir, 'agents');
  const agents: Record<string, Agent> = {};
  if (!fs.existsSync(agentsDir)) { return agents; }
  try {
    for (const file of fs.readdirSync(agentsDir)) {
      if (!file.endsWith('.md')) { continue; }
      const name = file.replace('.md', '').toLowerCase();
      const raw = fs.readFileSync(path.join(agentsDir, file), 'utf8');
      const { meta, body } = parseFrontmatter(raw);
      agents[name] = {
        name: (meta.name as string) || name,
        file,
        content: body,
        description: (meta.description as string) || (meta.name as string) || name,
        tools: normalizeToolList(meta.tools as string | string[] | null),
        argumentHint: (meta['argument-hint'] as string) || null,
      };
    }
  } catch (_) { /* silent */ }
  return agents;
}

export function loadSkills(sapperDir: string): Record<string, Skill> {
  const skillsDir = path.join(sapperDir, 'skills');
  const skills: Record<string, Skill> = {};
  if (!fs.existsSync(skillsDir)) { return skills; }
  try {
    for (const file of fs.readdirSync(skillsDir)) {
      if (!file.endsWith('.md')) { continue; }
      const name = file.replace('.md', '').toLowerCase();
      const raw = fs.readFileSync(path.join(skillsDir, file), 'utf8');
      const { meta, body } = parseFrontmatter(raw);
      skills[name] = {
        name: (meta.name as string) || name,
        description: (meta.description as string) || (meta.name as string) || name,
        content: body,
        argumentHint: (meta['argument-hint'] as string) || null,
      };
    }
  } catch (_) { /* silent */ }
  return skills;
}
