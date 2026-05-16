# Sapper Work Report

Status: corrected workspace-backed report  
Date: 2026-05-12  
Workspace: `/Users/ibrahimihsan/Documents/sapper`

## Executive Summary

Sapper in this repository is a terminal-first local AI coding assistant packaged as `sapper-iq`. The current repo confirms that it connects to local Ollama models, builds layered prompts, exposes file/shell/git/web tools, stores project-local runtime state in `.sapper/`, supports agents and skills, and writes markdown session logs.

The earlier report was useful conceptually, but it included evidence from a different workspace. This corrected report only describes what is present in the current Sapper package repository.

## Evidence Reviewed

| Evidence | Current finding |
| --- | --- |
| [package.json](package.json) | Confirms package name `sapper-iq`, version `1.1.39`, Node module entry points, dependencies, scripts, repository metadata, and CLI bin mapping. |
| [README.md](README.md) | Documents Sapper as a terminal-first Ollama-based coding assistant with tools, context management, agents, skills, configuration, session memory, and logs. |
| [sapper.mjs](sapper.mjs) | Main runtime implementation. Defines `.sapper/` state paths, default configuration, prompt sections, tool definitions, logging, memory, shell behavior, and command handling. |
| [sapper-ui.mjs](sapper-ui.mjs) | UI entry point exists in the package and is exposed through the `sapper-ui` bin. |
| [.sapper/config.json](.sapper/config.json) | Runtime config exists and currently sets `contextLimit` to `35000`, tool limit to `40`, shell background mode to `auto`, and summarization trigger to `65`. |
| [.sapper/workspace.json](.sapper/workspace.json) | Workspace index exists with five indexed files and a small graph. It appears stale because it references package version `1.1.36` while [package.json](package.json) is `1.1.39`. |
| [.sapper/logs](.sapper/logs) | Logs folder exists with two session logs: `session-2026-04-06T06-20-07.md` and `session-2026-05-01T07-43-18.md`. |
| [.sapper/agents](.sapper/agents) | Agents folder exists and contains `reviewer.md`, `sapper-it.md`, and `writer.md`. This report did not audit their contents. |
| [.sapper/skills](.sapper/skills) | Skills folder exists and contains `git-workflow.md` and `node-project.md`. This report did not audit their contents. |

## Confirmed By Current Repo

### Package Identity

The package is named `sapper-iq` and is currently version `1.1.39`. It is an ES module package with these public entry points:

- `sapper.mjs` as the main runtime
- `sapper.mjs` as the `sapper` CLI bin
- `sapper-ui.mjs` as the `sapper-ui` CLI bin

The package depends on Ollama and terminal/UI libraries including `ollama`, `chalk`, `ora`, `marked`, `marked-terminal`, `cli-highlight`, and `acorn`.

### Product Description

[README.md](README.md) describes Sapper as a terminal-first AI coding assistant for local developer workflows. It connects to locally running Ollama models and can inspect files, edit files, search, run shell commands, manage git, browse web content, and keep session state.

The README also documents startup UI, model selection, context display, `.sapper/` state files, tool catalog, agents, skills, configuration, and memory behavior.

### Runtime State Folder

The current workspace contains a `.sapper/` folder with:

- [config.json](.sapper/config.json)
- [workspace.json](.sapper/workspace.json)
- [logs](.sapper/logs)
- [agents](.sapper/agents)
- [skills](.sapper/skills)

This confirms that Sapper stores project-local runtime state under `.sapper/`.

### Current Runtime Configuration

[.sapper/config.json](.sapper/config.json) currently confirms:

- `autoAttach: true`
- `contextLimit: 35000`
- `toolRoundLimit: 40`
- `patchRetries: 3`
- `maxFileSize: 100000`
- `maxScanSize: 1000000`
- `maxUrlSize: 200000`
- `summaryPhases: true`
- `summarizeTriggerPercent: 65`
- shell output streaming enabled
- shell background mode set to `auto`
- shell background handoff after `8` seconds
- shell output chunks set to `4000` characters
- streaming phase status and heartbeat enabled
- thinking mode set to `auto`

This supports the claim that Sapper is configurable through runtime files rather than being a fixed chat wrapper.

### Prompt And Tool Layers

[sapper.mjs](sapper.mjs) defines default prompt sections for core behavior, native tool instructions, legacy tool syntax, important workspace context, active agent wrappers, agent restriction wrappers, loaded skills, UI labels, and interactive questions.

The runtime also defines tools for filesystem work, searching, shell execution, git-oriented status/diff operations, web fetching, URL opening, memory recall, durable memory notes, and directory operations.

### Session Logging

The logs folder currently contains two session logs:

- `.sapper/logs/session-2026-04-06T06-20-07.md`
- `.sapper/logs/session-2026-05-01T07-43-18.md`

The April log records a simple session started from `/Users/ibrahimihsan/Downloads/sapper`, using model `gemma4:e4b-it-q4_K_M`, with one user input and one assistant response. The May log records a session start in `/Users/ibrahimihsan/Documents/sapper` using model `gemma4:e4b-mlx-bf16`.

These logs confirm the markdown log structure and session metadata, but the current logs do not contain the May 12 ClinicFlow actions described in the earlier report.

### Workspace Index

[.sapper/workspace.json](.sapper/workspace.json) is present and contains an indexed timestamp plus five indexed files:

- `.gitignore`
- `PUBLISHING.md`
- `README.md`
- `package-lock.json`
- `package.json`

The graph section includes those same files with empty dependency arrays. This is not a full current project graph. It also appears stale because the index summary for [package.json](package.json) references version `1.1.36`, while the current package version is `1.1.39`.

### Agents And Skills Folders

The `.sapper/agents` and `.sapper/skills` folders exist and contain markdown files. Their presence supports the claim that this workspace has local agent and skill definitions available to Sapper.

This report only confirmed their filenames. It did not inspect whether those files are valid, loaded, or active in any session.

## Not Present In Current Workspace

### No Current Context File

`.sapper/context.json` is not present in the current workspace. The README and source code describe this file as the place where resumable conversation state is stored, but there is no active context file to inspect right now.

### No Current Embeddings File

`.sapper/embeddings.json` is not present in the current workspace. The README and source code describe embedding-based recall, but no current embeddings store exists here.

### No Current Long-Memory File

`.sapper/long-memory.md` is not present in the current workspace. The source code and README describe durable markdown notes, but no durable memory note file exists here at the moment.

### No May 12 ClinicFlow Logs

The current logs folder does not contain these files from the earlier report:

- `.sapper/logs/session-2026-05-12T04-10-26.md`
- `.sapper/logs/session-2026-05-12T04-25-38.md`
- `.sapper/logs/session-2026-05-12T04-34-39.md`

### No ClinicFlow Project Artifacts

The current Sapper package workspace does not contain the ClinicFlow files referenced by the earlier report, including:

- `clinicflow-crm/architect.md`
- `clinicflow-crm/API_DOCS.md`
- `clinicflow-crm/FEATURES.md`
- `clinicflow-crm/docs/README.md`
- `clinicflow-crm/backend/src`
- `brd.md`

Those claims likely came from another workspace and should not be treated as evidence for this repository.

## Corrected Interpretation Of Sapper

Sapper can be accurately described as a local AI workspace assistant and CLI runtime. In this repository, it is implemented as a Node.js package that combines:

- local Ollama model selection
- a layered prompt builder
- file, shell, git, web, and memory tools
- `.sapper/` runtime state
- session logging
- project-local agents and skills
- context and summarization settings
- approval-oriented workflows for higher-impact operations

The current workspace confirms the architecture and runtime infrastructure. It does not currently confirm active long-memory content, active conversation context, populated embeddings, or the ClinicFlow documentation work described in the earlier report.

## Current Workspace Summary

| Area | Current status |
| --- | --- |
| Package | Present as `sapper-iq` version `1.1.39`. |
| Main runtime | Present in [sapper.mjs](sapper.mjs). |
| UI runtime | Present in [sapper-ui.mjs](sapper-ui.mjs). |
| README documentation | Present and detailed. |
| Runtime config | Present in [.sapper/config.json](.sapper/config.json). |
| Context file | Not present. |
| Embeddings file | Not present. |
| Durable long memory | Not present. |
| Session logs | Present, with two logs. |
| Workspace index | Present, small, and likely stale. |
| Agents folder | Present with three markdown files. |
| Skills folder | Present with two markdown files. |
| ClinicFlow artifacts | Not present in this workspace. |

## What This Report Should Not Claim

This report should not claim that:

- `.sapper/context.json` currently exists.
- `.sapper/long-memory.md` currently exists.
- `.sapper/embeddings.json` currently exists.
- The workspace graph is complete or current.
- May 12 ClinicFlow sessions are present in this repo.
- ClinicFlow documentation or backend files exist in this repo.
- Custom agents or skills are active without inspecting session state or their file contents.
- The current config uses a `16000` token context limit.

## Recommended Next Steps

1. Refresh the Sapper workspace index so [.sapper/workspace.json](.sapper/workspace.json) reflects the current package version and file tree.
2. Run Sapper once if active session state is needed, so `.sapper/context.json` can be created and inspected.
3. Create or save a durable memory note only if there is project knowledge worth preserving, which will create `.sapper/long-memory.md`.
4. Audit [.sapper/agents](.sapper/agents) and [.sapper/skills](.sapper/skills) separately before documenting their behavior as active capabilities.
5. Keep this report focused on the Sapper package repo; document ClinicFlow or other application work in that project workspace instead.

## Final Assessment

The corrected repo-backed conclusion is: Sapper is functioning as a configurable local AI coding assistant package with runtime config, tool definitions, prompt layers, logs, and local agent/skill folders. The current workspace does not contain the ClinicFlow evidence, May 12 logs, active context file, embeddings store, or long-memory file described in the earlier report.

This report is now safe to use as a Sapper-package workspace audit rather than a mixed audit of another project.
