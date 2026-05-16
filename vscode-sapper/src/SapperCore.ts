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
  onChunk: SendChunk;
  onStatus: SendStatus;
  onToolStart: (tool: string, path: string) => void;
  onToolEnd: (tool: string, path: string, success: boolean, result: string) => void;
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
    const { workingDir, sapperDir } = this.options;
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

    let prompt = `You are Sapper, an intelligent AI coding assistant running inside Visual Studio Code.
You have access to the local filesystem and can run shell commands.
You help with coding, debugging, refactoring, architecture, documentation, and any development task.

CURRENT DATE AND TIME: ${dateStr}, ${timeStr}
WORKING DIRECTORY: ${workingDir}

RULES:
1. EXPLORE FIRST: Use LIST and READ to understand files before making changes.
2. THINK IN STEPS: Explain what you found and what you plan to do before acting.
3. BE PRECISE: When using PATCH, prefer LINE:number mode.
4. VERIFY: After making changes, read the file back to confirm correctness.
5. NO HALLUCINATIONS: Never guess file contents — always READ first.

TOOL SYNTAX (you MUST use exactly this format — never show as examples, only use for real actions):
[TOOL:LIST]directory_path[/TOOL]          — list directory
[TOOL:READ]file_path[/TOOL]               — read file
[TOOL:WRITE]path]file content here[/TOOL] — write/create file
[TOOL:PATCH]path]old_text|||new_text[/TOOL]         — replace exact text
[TOOL:PATCH]path]LINE:number|||new line text[/TOOL]  — replace line by number (PREFERRED)
[TOOL:SEARCH]regex_pattern[/TOOL]         — search file contents
[TOOL:FIND]filename_pattern[/TOOL]        — find files by name
[TOOL:SHELL]command[/TOOL]                — run shell command
[TOOL:MKDIR]path[/TOOL]                   — create directory
[TOOL:CHANGES][/TOOL]                     — show git status/diff
[TOOL:FETCH]https://url[/TOOL]            — fetch web content
[TOOL:MEMORY]search query[/TOOL]          — search session memory
[TOOL:HEAD]file_path[/TOOL]               — read first 50 lines
[TOOL:TAIL]file_path[/TOOL]               — read last 50 lines`;

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
    return result;
  }

  async chat(userMessage: string): Promise<void> {
    this.aborted = false;
    const { model, sapperDir } = this.options;

    // Ensure system prompt is current
    if (this.messages.length === 0 || this.messages[0].role !== 'system') {
      this.messages.unshift({ role: 'system', content: this.buildSystemPrompt() } as Message);
    } else {
      this.messages[0].content = this.buildSystemPrompt();
    }

    this.messages.push({ role: 'user', content: userMessage });

    // Embed user message for memory
    addEmbedding(sapperDir, userMessage);

    const maxRounds = this.options.toolRoundLimit || 40;
    let toolRounds = 0;
    let active = true;

    while (active && !this.aborted) {
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
