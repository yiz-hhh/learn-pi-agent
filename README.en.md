# learn-pi-agent

[简体中文](./README.md) | English

A learning project that rebuilds the Agent Harness of [Pi](https://github.com/earendil-works/pi) from the ground up.

Pi is a minimal and highly extensible Coding Agent Harness: it does not prescribe a workflow, and the capabilities you need are composed by the user. The project starts from a single LLM call, then gradually adds Tool Calling, Runtime, Context, Sessions, Compaction, Skills, and Extensions before assembling a working Coding Agent.

📖 [Documentation](https://yiz-hhh.github.io/learn-pi-agent/)

> The documentation is currently written in Chinese.

## Why Pi

Pi does not try to bake common Coding Agent workflows into the default product. MCP, Subagents, Permission Popups, Plan Mode, Todo, and Background Bash are not built in directly; when needed, they can be composed through CLI tools, Skills, Extensions, or third-party Packages.

That makes Pi a useful system for studying Agent Harness design: the core mechanisms are complete without being wrapped in a large set of predefined workflows. This project rebuilds those mechanisms from source to understand how they work and where the surrounding complexity is placed.

## Chapters

| Chapter | Topic |
| --- | --- |
| [00 · Minimal LLM Call](./chapters/00-minimal-llm-call) | LLM calls and the Provider Boundary |
| [01 · Tool-driven Agent](./chapters/01-tool-driven-agent) | Tool Results and the minimal Agent Loop |
| [02 · Agent Runtime](./chapters/02-agent-runtime) | Turns, EventStream, and streaming execution |
| [03 · Tool Runtime](./chapters/03-tool-runtime) | Tool preparation, validation, execution, and result normalization |
| [04 · Parallel Tool Execution](./chapters/04-parallel-tools) | Parallel Tools, completion order, and message order |
| [05 · Steering & Follow-up](./chapters/05-steering-followup) | New input during a run and Follow-up |
| [06 · Context Transformation](./chapters/06-context-transform) | Runtime History and per-call LLM Context |
| [07 · Session Tree](./chapters/07-session-tree) | Session persistence, branching, and recovery |
| [08 · Context Compaction](./chapters/08-context-compaction) | CompactionEntry and Context Reconstruction |
| [09 · Skills](./chapters/09-skills) | Skill Discovery and on-demand loading |
| [10 · Extension Runtime](./chapters/10-extension-runtime) | Loading, registering, and running Extensions |
| [11 · Extension Composition](./chapters/11-extension-composition) | Permission Gate, Plan Mode, and Subagent |
| [12 · Coding Agent](./chapters/12-coding-agent) | Coding Tools and final assembly |

The chapters are meant to be read in order. Each one continues from a problem left by the previous chapter while keeping its own runnable implementation and tests.

## Reference

This project primarily follows the Agent Core and Coding Agent implementation of [Pi](https://github.com/earendil-works/pi).

## Getting Started

This repository uses npm workspaces. Install dependencies from the repository root:

```bash
npm install

# Type-check and test all chapters
npm run build
npm test
```

Each chapter can also be run on its own:

```bash
cd chapters/01-tool-driven-agent

npm run build
npm test
```

Run the documentation site locally:

```bash
cd website
npm install
npm run docs:dev
```

## Repository Structure

```text
learn-pi-agent/
├── chapters/
│   ├── 00-minimal-llm-call/
│   ├── ...
│   └── 12-coding-agent/
├── website/
├── README.md
└── README.en.md
```

## License

[MIT](./LICENSE)
