# learn-pi-agent

简体中文 | [English](./README.en.md)

一个从零拆解并重建 [Pi](https://github.com/earendil-works/pi) Agent Harness 的学习项目。

Pi 是一个极简且高度可扩展的 Coding Agent Harness：不预设工作流，需要的能力由使用者自行组合。项目从一次 LLM 调用开始，逐步实现 Tool Calling、Runtime、Context、Session、Compaction、Skills 和 Extensions，最后组装成一个可运行的 Coding Agent。

📖 [在线文档](https://yiz-hhh.github.io/learn-pi-agent/)

## Why Pi

Pi 不试图把常见的 Coding Agent 工作流全部做进默认产品。MCP、Subagent、Permission Popup、Plan Mode、Todo、Background Bash 都没有被直接内置；需要时，可以通过 CLI、Skills、Extensions 或第三方 Package 组合出来。

这种取舍让 Pi 很适合拿来学习 Agent Harness：核心机制足够完整，同时又没有被具体工作流包住。这个项目沿着源码把这些机制重新实现一遍，重点看清它们怎样工作，以及复杂度最终被放在了哪里。

## Chapters

| Chapter | Topic |
| --- | --- |
| [00 · Minimal LLM Call](./chapters/00-minimal-llm-call) | LLM 调用与 Provider Boundary |
| [01 · Tool-driven Agent](./chapters/01-tool-driven-agent) | Tool Result 与最小 Agent Loop |
| [02 · Agent Runtime](./chapters/02-agent-runtime) | Turn、EventStream 与流式运行 |
| [03 · Tool Runtime](./chapters/03-tool-runtime) | Tool 的准备、校验、执行与结果归一化 |
| [04 · Parallel Tool Execution](./chapters/04-parallel-tools) | 并行 Tool、完成顺序与消息顺序 |
| [05 · Steering & Follow-up](./chapters/05-steering-followup) | 运行中的新输入与 Follow-up |
| [06 · Context Transformation](./chapters/06-context-transform) | Runtime History 与单次 LLM Context |
| [07 · Session Tree](./chapters/07-session-tree) | Session 持久化、分支与恢复 |
| [08 · Context Compaction](./chapters/08-context-compaction) | CompactionEntry 与 Context Reconstruction |
| [09 · Skills](./chapters/09-skills) | Skill Discovery 与按需读取 |
| [10 · Extension Runtime](./chapters/10-extension-runtime) | Extension 的加载、注册与运行 |
| [11 · Extension Composition](./chapters/11-extension-composition) | Permission Gate、Plan Mode 与 Subagent |
| [12 · Coding Agent](./chapters/12-coding-agent) | Coding Tools 与最终组装 |

章节按顺序演进。每一章都从上一章留下的问题继续，同时保留独立的实现和测试。

## Reference

本项目主要对照 [Pi](https://github.com/earendil-works/pi) 的 Agent Core 与 Coding Agent 实现。

## Getting Started

项目使用 npm workspaces。先在仓库根目录安装依赖：

```bash
npm install

# 全部章节类型检查与测试
npm run build
npm test
```

每个章节也可以单独运行：

```bash
cd chapters/01-tool-driven-agent

npm run build
npm test
```

本地启动文档站：

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
