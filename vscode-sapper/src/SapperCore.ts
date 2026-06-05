import * as vscode from 'vscode';
import { Ollama } from 'ollama';
import { Message, loadContext, saveContext, addEmbedding } from './memory';
import { loadAgents, loadSkills } from './agents';
import { getEffectiveConfig } from './config';
import {
  toolList, toolLs, toolRead, toolCat, toolHead, toolTail,
  toolWrite, toolPatch, toolMkdir, toolRmdir, toolPwd, toolFind,
  toolSearch, toolGrep, toolChanges, toolShell, toolFetchWeb,
  toolMemoryRecall, toolMemoryNote,
} from './tools';

// Match [TOOL:TYPE]path]content[/TOOL] or [TOOL:TYPE]path[/TOOL]
const TOOL_REGEX = /\[TOOL:([A-Z_]+)\]([\s\S]*?)(?:\]([\s\S]*?))?\[\/TOOL\]/g;

export type SendChunk = (text: string) => void;
export type SendStatus = (status: string) => void;

export interface SapperCoreOptions {
  workingDir: string;
  sapperDir: string;
  ollamaHost?: string;
  model: string;
  toolRoundLimit?: number;
  shellEnabled?: boolean;
  disabledTools?: string[];
  systemPromptOverride?: string;
  maxContextTokens?: number;   // trim when estimated tokens exceed this (default: 0 = no limit)
  mode?: 'ask' | 'edit' | 'agent';  // current interaction mode
  onChunk: SendChunk;
  onStatus: SendStatus;
  onToolStart: (tool: string, path: string) => void;
  onToolEnd: (tool: string, path: string, success: boolean, result: string) => void;
  onFileChange?: (action: 'create' | 'edit' | 'delete', path: string) => void;
  /** Called before executing SHELL commands. Resolve true to allow, false to deny. */
  onShellApprovalRequired?: (cmd: string) => Promise<boolean>;
}

export class SapperCore {
  private options: SapperCoreOptions;
  private messages: Message[];
  private ollama: Ollama;
  private aborted = false;
  private currentAgent: string | null = null;
  private currentAgentTools: string[] | null = null;
  private loadedSkillNames: string[] = [];

  constructor(options: SapperCoreOptions) {
    this.options = options;
    this.ollama = new Ollama({ host: options.ollamaHost || 'http://127.0.0.1:11434' });
    this.messages = loadContext(options.sapperDir);
  }

  get context(): Message[] { return this.messages; }

  clearContext(): void {
    this.messages = [];
    saveContext(this.options.sapperDir, this.messages);
  }

  /** Remove the last user+assistant message pair (undo last turn). Returns true if anything was removed. */
  popLastTurn(): boolean {
    const msgs = this.messages.filter(m => m.role !== 'system');
    if (msgs.length < 1) { return false; }
    // Remove trailing assistant message and the user message before it
    let removed = 0;
    while (this.messages.length > 0 && removed < 2) {
      const last = this.messages[this.messages.length - 1];
      if (last.role === 'system') break;
      if (removed === 0 && last.role !== 'assistant') break; // nothing to undo
      this.messages.pop();
      removed++;
    }
    if (removed > 0) { saveContext(this.options.sapperDir, this.messages); }
    return removed > 0;
  }

  /** Update options (e.g. mode) without recreating the core */
  updateOptions(patch: Partial<SapperCoreOptions>): void {
    this.options = { ...this.options, ...patch };
  }

  /** Load a named session from .sapper/sessions/{name}.json */
  loadSession(name: string): boolean {
    const fs = require('fs') as typeof import('fs');
    const sessionPath = require('path').join(this.options.sapperDir, 'sessions', `${name}.json`);
    try {
      const data = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
      if (Array.isArray(data)) { this.messages = data; return true; }
    } catch { /* not found */ }
    return false;
  }

  /** Save current session under a name to .sapper/sessions/{name}.json */
  saveSession(name: string): void {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const dir = path.join(this.options.sapperDir, 'sessions');
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(this.messages, null, 2));
  }

  /** List saved sessions */
  static listSessions(sapperDir: string): Array<{ name: string; messageCount: number; savedAt: string }> {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const dir = path.join(sapperDir, 'sessions');
    if (!fs.existsSync(dir)) { return []; }
    return fs.readdirSync(dir)
      .filter((f: string) => f.endsWith('.json'))
      .map((f: string) => {
        const filePath = path.join(dir, f);
        let messageCount = 0;
        let savedAt = '';
        try {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          messageCount = Array.isArray(data) ? data.filter((m: any) => m.role !== 'system').length : 0;
          savedAt = fs.statSync(filePath).mtime.toISOString();
        } catch { /* ignore */ }
        return { name: f.replace(/\.json$/, ''), messageCount, savedAt };
      })
      .sort((a: any, b: any) => b.savedAt.localeCompare(a.savedAt));
  }

  /** Delete a saved session */
  static deleteSession(sapperDir: string, name: string): void {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    try { fs.unlinkSync(path.join(sapperDir, 'sessions', `${name}.json`)); } catch { /* ignore */ }
  }

  private lastPromptTokens = 0;
  private lastEvalTokens = 0;

  getContextStats(): {
    messages: number; estimatedTokens: number; rawBytes: number; rawKB: number;
    lastPromptTokens: number; lastEvalTokens: number; contextLimit: number;
  } {
    const conv = this.messages.filter(m => m.role !== 'system');
    const rawBytes = this.messages.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : 0), 0);
    // estimateTokens: code blocks at /3.5, rest at /4
    const estimatedTokens = this.messages.reduce((total, m) => {
      const text = typeof m.content === 'string' ? m.content : '';
      const codeBlocks = text.match(/```[\s\S]*?```/g) || [];
      const codeChars = codeBlocks.reduce((s, b) => s + b.length, 0);
      const textChars = text.length - codeChars;
      return total + 4 + Math.ceil(textChars / 4 + codeChars / 3.5);
    }, 0);
    return {
      messages: conv.length,
      estimatedTokens,
      rawBytes,
      rawKB: Math.round(rawBytes / 1024),
      lastPromptTokens: this.lastPromptTokens,
      lastEvalTokens: this.lastEvalTokens,
      contextLimit: this.options.maxContextTokens || 0,
    };
  }

  /** Estimate tokens for a single message (same formula as getContextStats) */
  private estimateMessageTokens(msg: Message): number {
    const text = typeof msg.content === 'string' ? msg.content : '';
    const codeBlocks = text.match(/```[\s\S]*?```/g) || [];
    const codeChars = codeBlocks.reduce((s, b) => s + b.length, 0);
    const textChars = text.length - codeChars;
    return 4 + Math.ceil(textChars / 4 + codeChars / 3.5);
  }

  private trimContext(): void {
    const maxTokens = this.options.maxContextTokens;
    if (!maxTokens || maxTokens <= 0) return;

    const sysMsg = this.messages[0]?.role === 'system' ? this.messages[0] : null;
    const sysTokens = sysMsg ? this.estimateMessageTokens(sysMsg) : 0;
    const rest = this.messages.filter(m => m.role !== 'system');

    // Trim from oldest until we fit within the token budget (keep system message)
    while (rest.length > 0) {
      const total = sysTokens + rest.reduce((s, m) => s + this.estimateMessageTokens(m), 0);
      if (total <= maxTokens) break;
      rest.shift(); // drop oldest non-system message
    }

    this.messages = sysMsg ? [sysMsg, ...rest] : rest;
  }

  static buildWorkspaceIndex(workingDir: string): { fileCount: number; byDir: Record<string, string[]>; indexedAt: string } {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const IGNORE = new Set(['node_modules', '.git', '.sapper', 'dist', 'build', '.cache', '__pycache__', '.next', 'out', '.DS_Store']);
    const CODE_EXTS = new Set(['js', 'mjs', 'jsx', 'ts', 'tsx', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'cs', 'rb', 'php', 'swift', 'kt', 'sh', 'md', 'json', 'yaml', 'yml', 'toml', 'html', 'css', 'vue', 'svelte']);
    const byDir: Record<string, string[]> = {};
    let fileCount = 0;

    function scan(dir: string, depth = 0) {
      if (depth > 5) return;
      let entries: any[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (IGNORE.has(e.name) || e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        const rel = path.relative(workingDir, full);
        if (e.isDirectory()) {
          scan(full, depth + 1);
        } else {
          const ext = e.name.split('.').pop()?.toLowerCase() || '';
          if (!CODE_EXTS.has(ext)) continue;
          const dir2 = path.dirname(rel) || '.';
          if (!byDir[dir2]) byDir[dir2] = [];
          if (byDir[dir2].length < 30) { byDir[dir2].push(e.name); fileCount++; }
        }
      }
    }
    scan(workingDir);
    return { fileCount, byDir, indexedAt: new Date().toISOString() };
  }

  setAgent(agentName: string | null): string {
    const { workingDir, sapperDir } = this.options;
    if (!agentName) {
      this.currentAgent = null;
      this.currentAgentTools = null;
      return 'Switched to default Sapper mode.';
    }
    const agents = loadAgents(sapperDir);
    const key = agentName.toLowerCase();
    if (!agents[key]) { return `Agent "${agentName}" not found.`; }
    this.currentAgent = key;
    this.currentAgentTools = agents[key].tools;
    return `Agent "${agents[key].name}" activated.`;
  }

  addSkill(skillName: string): string {
    const { sapperDir } = this.options;
    const skills = loadSkills(sapperDir);
    const key = skillName.toLowerCase();
    if (!skills[key]) { return `Skill "${skillName}" not found.`; }
    if (!this.loadedSkillNames.includes(key)) { this.loadedSkillNames.push(key); }
    return `Skill "${skills[key].name}" loaded.`;
  }

  abort(): void { this.aborted = true; }

  private buildSystemPrompt(): string {
    const { workingDir, sapperDir, systemPromptOverride } = this.options;
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

    // Use custom prompt if set, with variable substitution
    if (systemPromptOverride && systemPromptOverride.trim()) {
      return systemPromptOverride
        .replace(/\{workingDir\}/g, workingDir)
        .replace(/\{date\}/g, dateStr)
        .replace(/\{time\}/g, timeStr);
    }

    let prompt = `You are Sapper — an expert AI coding assistant embedded in Visual Studio Code.
You operate on a local codebase using a set of tools. You are proactive, precise, and tool-first.

━━━ ENVIRONMENT ━━━
Working Directory : ${workingDir}
Date / Time       : ${dateStr}, ${timeStr}
Platform          : macOS / Linux

━━━ CORE BEHAVIOUR ━━━
• You are an AGENT. When the user asks you to do something, you DO it — you don't just describe it.
• Always prefer TOOLS over explanation. Use READ before editing. Use WRITE/PATCH to make real changes.
• After making changes, briefly confirm what you did (1–3 lines). Never re-print a whole file.
• Be honest: if you are unsure about a file's contents, READ it first — never guess.
• Use relative paths from the working directory unless the user specifies absolute paths.
• For complex tasks, plan step-by-step, then execute each step with the appropriate tool.

━━━ FILE OPERATIONS — MANDATORY RULES ━━━
◆ CREATE a file       → [TOOL:WRITE] — NEVER output file content in the chat
◆ EDIT a file         → [TOOL:PATCH] after reading it first with [TOOL:READ]
◆ DELETE / RENAME     → [TOOL:SHELL] with rm / mv
◆ VERIFY after write  → [TOOL:READ] to confirm correctness
◆ IF you write code in a chat bubble WITHOUT calling WRITE/PATCH, that is WRONG.

━━━ SLASH COMMAND BEHAVIOURS ━━━
/explain   → Read the relevant file/function, then explain it clearly with examples
/fix       → Read the file, identify the bug, PATCH it, confirm the fix
/refactor  → Read the file, reason about improvements, apply them with PATCH/WRITE
/tests     → Read the source, generate a test file, WRITE it alongside the source
/docs      → Generate or update documentation comments inline using PATCH
/review    → Read the file(s), provide a structured code review with specific suggestions
/commit    → Run [TOOL:CHANGES], then [TOOL:SHELL] git commit -m "..." with a good message
/new       → Create a new file or scaffold a project structure

━━━ TOOL REFERENCE ━━━
[TOOL:LIST]path[/TOOL]                          list directory contents
[TOOL:READ]file_path[/TOOL]                     read entire file
[TOOL:HEAD]file_path[/TOOL]                     read first 50 lines
[TOOL:TAIL]file_path[/TOOL]                     read last 50 lines
[TOOL:WRITE]file_path]content[/TOOL]            write (create or overwrite) a file
[TOOL:PATCH]file_path]old|||new[/TOOL]          replace exact text in a file
[TOOL:PATCH]file_path]LINE:N|||new text[/TOOL]  replace a specific line (preferred)
[TOOL:SHELL]command[/TOOL]                      run a shell command
[TOOL:MKDIR]path[/TOOL]                         create a directory
[TOOL:FIND]glob_pattern[/TOOL]                  find files by name
[TOOL:SEARCH]regex_pattern[/TOOL]               search file contents (grep)
[TOOL:CHANGES][/TOOL]                           show git status and diff
[TOOL:FETCH]https://url[/TOOL]                  fetch a URL
[TOOL:MEMORY]query[/TOOL]                       search session memory

━━━ RESPONSE FORMAT ━━━
• Use markdown for explanations, code reviews, and multi-step plans.
• For file operations: state what you're about to do, call the tool, confirm done.
• For errors: show the exact error, diagnose the root cause, apply the fix.
• Keep responses focused and concise. Skip preamble like "Great question!" or "Certainly!".`;

    // Mode-specific behaviour addendum
    const mode = this.options.mode || 'agent';
    if (mode === 'ask') {
      prompt += `\n\n━━━ MODE: ASK ━━━\nYou are in Ask mode. Provide explanations, answers, and analysis. Avoid making file changes unless explicitly asked. Use READ tools to look up code but prefer concise written answers.`;
    } else if (mode === 'edit') {
      prompt += `\n\n━━━ MODE: EDIT ━━━\nYou are in Edit mode. The user wants direct code edits. Focus on the provided file context. Use PATCH/WRITE tools immediately — do not over-explain. After editing, show a brief summary of what changed.`;
    } else {
      prompt += `\n\n━━━ MODE: AGENT ━━━\nYou are in Agent mode. Full autonomy. Plan multi-step tasks, use all tools, iterate until the task is complete. Ask only if truly ambiguous.`;
    }

    if (this.currentAgent) {
      const agents = loadAgents(sapperDir);
      const agent = agents[this.currentAgent];
      if (agent) {
        prompt += `\n\n═══ ACTIVE AGENT: ${agent.name} ═══\n${agent.content}\n═══ END AGENT ═══`;
        if (this.currentAgentTools && this.currentAgentTools.length > 0) {
          const forbidden = ['READ', 'WRITE', 'PATCH', 'LIST', 'SEARCH', 'SHELL', 'MKDIR', 'FIND', 'FETCH']
            .filter((t) => !this.currentAgentTools!.includes(t));
          prompt += `\nTOOL RESTRICTION: ONLY use: ${this.currentAgentTools.join(', ')}. FORBIDDEN: ${forbidden.join(', ')}.`;
        }
      }
    }

    if (this.loadedSkillNames.length > 0) {
      const skills = loadSkills(sapperDir);
      const skillBlocks = this.loadedSkillNames
        .filter((n) => skills[n])
        .map((n) => skills[n].content);
      if (skillBlocks.length > 0) {
        prompt += `\n\n═══ SKILLS ═══\n${skillBlocks.join('\n---\n')}\n═══ END SKILLS ═══`;
      }
    }

    return prompt;
  }

  private isToolAllowed(toolType: string): boolean {
    // Canonical aliases (e.g. CAT → READ) for disabled-tools check
    const CANONICAL: Record<string, string> = {
      CAT: 'READ', HEAD: 'READ', TAIL: 'READ',
      LS: 'LIST',
      GREP: 'SEARCH',
    };
    const canonical = CANONICAL[toolType] || toolType;
    if (this.options.disabledTools && this.options.disabledTools.includes(canonical)) {
      return false;
    }
    if (!this.currentAgentTools || this.currentAgentTools.length === 0) { return true; }
    const aliases: Record<string, string[]> = {
      READ: ['READ', 'CAT', 'HEAD', 'TAIL'], CAT: ['READ'], HEAD: ['READ'], TAIL: ['READ'],
      LIST: ['LIST', 'LS'], LS: ['LIST'],
      SEARCH: ['SEARCH', 'GREP'], GREP: ['SEARCH'],
      WRITE: ['WRITE'], PATCH: ['PATCH'], MKDIR: ['MKDIR'],
      RMDIR: ['RMDIR', 'SHELL'], SHELL: ['SHELL'],
      CHANGES: ['CHANGES', 'SHELL'], FETCH: ['FETCH', 'SHELL'],
      MEMORY: ['MEMORY'], FIND: ['FIND'], OPEN: ['OPEN', 'SHELL'],
    };
    const allowed = aliases[toolType] || [toolType];
    return allowed.some((a) => this.currentAgentTools!.includes(a));
  }

  private async executeTool(type: string, pathArg: string, content: string): Promise<string> {
    const { workingDir, sapperDir, shellEnabled } = this.options;
    const t = type.toUpperCase();

    if (!this.isToolAllowed(t)) {
      return `Error: Tool ${t} is not allowed for the current agent. Allowed: ${this.currentAgentTools!.join(', ')}.`;
    }

    this.options.onToolStart(t, pathArg);
    let result = '';
    let success = true;

    // Detect whether target file existed before the tool ran (for create/edit detection)
    const fullPath = pathArg && !pathArg.startsWith('/') ? require('path').resolve(workingDir, pathArg) : pathArg;
    const existedBefore = (() => {
      try { return require('fs').existsSync(fullPath); } catch (_) { return false; }
    })();

    try {
      switch (t) {
        case 'LIST': result = toolList(workingDir, pathArg); break;
        case 'LS':   result = toolLs(workingDir, pathArg); break;
        case 'READ': result = toolRead(workingDir, pathArg); break;
        case 'CAT':  result = toolCat(workingDir, pathArg); break;
        case 'HEAD': result = toolHead(workingDir, pathArg); break;
        case 'TAIL': result = toolTail(workingDir, pathArg); break;
        case 'WRITE':
          if (!content || content.trim() === '') {
            result = 'Error: WRITE requires content.'; success = false;
          } else {
            result = await toolWrite(workingDir, pathArg, content);
            success = result.startsWith('Successfully');
          }
          break;
        case 'PATCH': {
          const sep = content?.indexOf('|||');
          if (sep === -1 || sep === undefined) {
            result = 'Error: PATCH requires format path]old|||new[/TOOL]'; success = false;
          } else {
            const oldText = content.substring(0, sep);
            const newText = content.substring(sep + 3);
            result = await toolPatch(workingDir, pathArg, oldText, newText);
            success = result.startsWith('Successfully') || result.startsWith('Patched');
          }
          break;
        }
        case 'MKDIR':   result = toolMkdir(workingDir, pathArg); break;
        case 'RMDIR':   result = await toolRmdir(workingDir, pathArg); break;
        case 'PWD':     result = toolPwd(workingDir); break;
        case 'FIND':    result = toolFind(workingDir, pathArg, content); break;
        case 'SEARCH':  result = await toolSearch(workingDir, pathArg); break;
        case 'GREP':    result = await toolGrep(workingDir, pathArg); break;
        case 'CHANGES': result = await toolChanges(workingDir); break;
        case 'FETCH':   result = await toolFetchWeb(pathArg); break;
        case 'MEMORY':  result = toolMemoryRecall(sapperDir, pathArg); break;
        case 'MEMORY_NOTE_SAVE': result = toolMemoryNote(sapperDir, pathArg); break;
        case 'SHELL':
          if (!shellEnabled) {
            result = 'Error: Shell execution is disabled in extension settings.'; success = false;
          } else if (this.options.onShellApprovalRequired) {
            const approved = await this.options.onShellApprovalRequired(pathArg);
            if (!approved) {
              result = 'Shell command denied by user.'; success = false;
            } else {
              result = await toolShell(workingDir, pathArg, (chunk) => this.options.onChunk(`\`\`\`\n${chunk}\n\`\`\``));
              success = !result.includes('[Exit code: ') || result.includes('[Exit code: 0]');
            }
          } else {
            result = await toolShell(workingDir, pathArg, (chunk) => this.options.onChunk(`\`\`\`\n${chunk}\n\`\`\``));
            success = !result.includes('[Exit code: ') || result.includes('[Exit code: 0]');
          }
          break;
        default:
          result = `Error: Unknown tool type: ${t}`; success = false;
      }
    } catch (e: any) {
      result = `Error: ${e.message}`; success = false;
    }

    this.options.onToolEnd(t, pathArg, success, result);

    // Notify about file changes
    if (this.options.onFileChange && success) {
      if (t === 'WRITE') {
        this.options.onFileChange(existedBefore ? 'edit' : 'create', pathArg);
      } else if (t === 'PATCH') {
        this.options.onFileChange('edit', pathArg);
      } else if (t === 'MKDIR') {
        this.options.onFileChange('create', pathArg);
      } else if (t === 'RMDIR') {
        this.options.onFileChange('delete', pathArg);
      }
    }

    return result;
  }

  async chat(userMessage: string, attachedContext?: string): Promise<void> {
    this.aborted = false;
    const { model, sapperDir } = this.options;

    // Prepend any attached file/folder context
    const fullUserMsg = attachedContext && attachedContext.trim()
      ? `${attachedContext}\n\n---\n\nUser: ${userMessage}`
      : userMessage;

    // Ensure system prompt is current
    if (this.messages.length === 0 || this.messages[0].role !== 'system') {
      this.messages.unshift({ role: 'system', content: this.buildSystemPrompt() } as Message);
    } else {
      this.messages[0].content = this.buildSystemPrompt();
    }

    this.messages.push({ role: 'user', content: fullUserMsg });

    // Embed user message for memory
    addEmbedding(sapperDir, userMessage);

    const maxRounds = this.options.toolRoundLimit || 40;
    let toolRounds = 0;
    let active = true;

    while (active && !this.aborted) {
      this.trimContext();
      let fullResponse = '';
      this.options.onStatus('thinking');

      try {
        const stream = await this.ollama.chat({
          model,
          messages: this.messages as any[],
          stream: true,
        });

        for await (const chunk of stream) {
          if (this.aborted) { break; }
          const text = chunk.message?.content || '';
          if (text) {
            fullResponse += text;
            this.options.onChunk(text);
          }
          // Capture token usage from final chunk
          if (chunk.done) {
            if (chunk.prompt_eval_count) { this.lastPromptTokens = chunk.prompt_eval_count; }
            if (chunk.eval_count) { this.lastEvalTokens = chunk.eval_count; }
          }
          if (fullResponse.length > 100000) { break; }
        }
      } catch (e: any) {
        this.options.onStatus('error');
        this.options.onChunk(`\n\n❌ **Error talking to Ollama:** ${e.message}\n\nMake sure Ollama is running at \`${this.options.ollamaHost || 'http://127.0.0.1:11434'}\`.`);
        active = false;
        break;
      }

      if (this.aborted) { active = false; break; }

      this.messages.push({ role: 'assistant', content: fullResponse });
      addEmbedding(sapperDir, fullResponse.substring(0, 1000));
      saveContext(sapperDir, this.messages);

      // Parse tool calls
      const toolMatches: Array<[string, string, string, string]> = [];
      let match: RegExpExecArray | null;
      const re = new RegExp(TOOL_REGEX.source, TOOL_REGEX.flags);
      while ((match = re.exec(fullResponse)) !== null) {
        const [full, toolType, pathPart, contentPart] = match;
        toolMatches.push([full, toolType, pathPart?.trim() || '', contentPart?.trim() || '']);
      }

      // Also handle [TOOL:WRITE]path]content[/TOOL] multi-part format
      const writeRe = /\[TOOL:WRITE\]([\s\S]+?)\]([\s\S]+?)\[\/TOOL\]/g;
      let wm: RegExpExecArray | null;
      while ((wm = writeRe.exec(fullResponse)) !== null) {
        const alreadyCaptured = toolMatches.some((m) => m[0] === wm![0]);
        if (!alreadyCaptured) {
          toolMatches.push([wm[0], 'WRITE', wm[1].trim(), wm[2]]);
        }
      }

      if (toolMatches.length > 0 && toolRounds < maxRounds) {
        toolRounds++;
        this.options.onStatus(`Running ${toolMatches.length} tool${toolMatches.length > 1 ? 's' : ''}…`);

        for (const [, toolType, pathArg, content] of toolMatches) {
          if (this.aborted) { break; }
          const result = await this.executeTool(toolType, pathArg, content);
          this.messages.push({ role: 'user', content: `RESULT (${pathArg || toolType}): ${result}` });
        }
        saveContext(sapperDir, this.messages);
        this.options.onStatus('thinking');
      } else if (toolMatches.length > 0 && toolRounds >= maxRounds) {
        this.options.onChunk(`\n\n⚠️ Tool limit (${maxRounds} rounds) reached.`);
        this.messages.push({ role: 'user', content: 'STOP using tools now. Provide your final answer based on what you have gathered.' });
        saveContext(sapperDir, this.messages);
        this.options.onStatus('thinking');
        // One more round without tool processing
        let finalResp = '';
        try {
          const stream = await this.ollama.chat({ model, messages: this.messages as any[], stream: true });
          for await (const chunk of stream) {
            if (this.aborted) { break; }
            const text = chunk.message?.content || '';
            finalResp += text;
            this.options.onChunk(text);
          }
        } catch (_) { /* ignore */ }
        if (finalResp) {
          this.messages.push({ role: 'assistant', content: finalResp });
          saveContext(sapperDir, this.messages);
        }
        active = false;
      } else {
        active = false;
      }
    }

    this.options.onStatus('idle');
  }

  async listModels(): Promise<string[]> {
    try {
      const res = await this.ollama.list();
      return res.models.map((m: any) => m.name).sort();
    } catch (_) { return []; }
  }
}
