---
title: "Chapter 12：Coding Agent"
description: "现在给 Agent 一个具体任务："
head: [["link",{"rel":"canonical","href":"https://yiz-hhh.github.io/learn-pi-agent/chapters/12-coding-agent"}]]
---
# Chapter 12：Coding Agent

现在给 Agent 一个具体任务：

```text
修复 calculator.ts 中的 bug，并运行测试确认修复结果。
```

前面的章节已经有：

```text
LLM Call
Tool Runtime
Parallel Tool Execution
Session
Context
Compaction
Skills
Extensions
```

这一章把这些东西放进一个真实的代码修改任务里。

Coding Agent 需要的工具也很具体：

```text
read_file
write_file
edit
grep
bash
```

再加上：

```text
coding prompt
skills
extensions
workspace
```

没有新的 Agent Loop。

这些能力继续进入前面已经建立的 Runtime。

## 组装一个 Coding Agent

入口可以集中在一个 `createCodingAgent()`：

```ts
const tools = [
  ...createProductTools(cwd),
  ...extraTools,
];

const systemPrompt = buildProductPrompt(
  prefix,
  skills,
  tools,
);

const session = new TreeSession();

const runner = new ExtensionRunner({
  cwd,
  config,
  session,
});

await runner.load(extensions);

const hooks =
  createExtensionAwareConfig(runner);

const agent = new Agent({
  systemPrompt,
  tools,
  llm,
  config: {
    model,
    beforeToolCall:
      hooks.beforeToolCall,
    transformContext:
      hooks.transformContext,
    loadTools:
      hooks.loadTools,
  },
  initialMessages,
});
```

这里仍然是前面的几个对象：

```text
Agent
TreeSession
ExtensionRunner
Tool[]
```

Coding Tool 放进 `tools`。

Skill 参与 system prompt。

Extension 接到已有的运行时 Hook。

已有 Session 可以先恢复成 `initialMessages`，再创建 Agent。

产品层做的事情主要是把这些部分接起来。

几个文件 Tool 共用同一个 `cwd`。

路径统一经过：

```ts
resolveToolPath(cwd, path)
```

例如：

```text
src/calculator.ts
```

会以当前 workspace 为基点解析。

但 `cwd` 不是 sandbox。

像：

```text
../outside.txt
```

仍然可能解析到 workspace 之外。

绝对路径也不会因为经过这个 resolver 就自动被限制。

所以：

```text
path resolution
```

只负责确定文件在哪里。

项目 Trust、文件访问策略和进程隔离属于另外的边界。

## Coding Tool 继续走原来的 Tool Runtime

这一章加入：

```text
read_file
write_file
edit
grep
bash
```

模型调用它们以后，执行路径没有变化：

```text
Tool Call
    ↓
prepare / validate
    ↓
beforeToolCall
    ↓
execute
    ↓
ToolResult
```

文件不存在、参数错误、命令失败，最后都会变成模型能看到的 Tool Result。

Agent Loop 不需要知道：

```text
read_file 是文件工具

bash 会启动 shell

edit 会修改源码
```

它只处理 Tool Call 和 Tool Result。

### `edit` 负责把修改落到确定的位置

模型很适合判断：

```text
哪段代码有问题
应该改成什么
```

但真正修改文件时，最好不要让模型自己计算字符 offset。

这一章的 `edit` 接收：

```text
path
oldText
newText
```

例如当前代码：

```ts
export function add(
  a: number,
  b: number,
) {
  return a - b;
}
```

模型提交：

```text
oldText = "return a - b;"
newText = "return a + b;"
```

程序再检查这段文本是否能唯一定位：

```text
oldText 没找到
→ fail

oldText 出现一次
→ replace

oldText 出现多次
→ fail
```

一次调用里包含多组 edit 时，匹配都基于修改前的文件内容，并检查替换区间是否重叠。

模型负责语义判断。

程序负责确定性落位。

这和前面一直保留的边界是一致的：能明确由程序完成的工作，不需要重新交给模型猜。

### `bash` 只执行命令

`bash` Tool 负责：

```text
cwd
timeout
AbortSignal
stdout
stderr
exit code
```

至于：

```text
这个命令能不能执行
```

不放进 `bash.execute()`。

Chapter 11 的 Permission Extension 可以在 Tool 真正进入 shell 前拦截：

```text
bash("rm -rf keep/")
    ↓
tool_call
    ↓
permission extension
    ↓
block
```

被 block 后，Runtime 仍然返回失败 Tool Result。

而：

```text
bash("npm test")
```

可以继续按普通 Tool execution 执行。

所以同一个 `bash` Tool 可以运行在不同策略下。

产品层决定加载什么 Extension。

Tool 自己保持相同的执行职责。

## Skill 在任务需要时进入 Context

Coding Agent 启动时，Skill catalog 会进入 system prompt。

例如：

```text
name: verify
description: 修改代码后运行测试确认结果
location: skills/verify.md
```

正文仍然在文件里。

模型看到当前任务：

```text
修复 calculator.ts 中的 bug，
并运行测试确认修复结果。
```

判断 `verify` 有关以后，可以调用：

```text
read_file("skills/verify.md")
```

然后正文作为普通 Tool Result 进入当前 run。

后面的流程没有 Skill 专用分支：

```text
read Skill
    ↓
ToolResult
    ↓
model continues
    ↓
grep / read / edit / bash
```

Skill 负责提供这类任务应该怎么做。

真正的执行继续交给已有 Tool。

这一章可以只加载 Permission Gate。

Chapter 11 已经验证过 Plan Mode 和 Subagent 可以由 Extension Runtime 组合出来，这里没有必要为了“完整”把所有 Extension 都打开。

产品入口只选择当前需要的能力。

## Session 和 Compaction 继续沿原来的路径

代码修改任务也会产生普通运行历史：

```text
user
assistant
toolResult
assistant
toolResult
...
```

Session 不需要额外保存：

```text
code-edit entry
grep entry
test entry
```

`grep` 是 Tool Call。

`edit` 是 Tool Call。

`npm test` 还是 Tool Call。

运行结束以后，它们都已经通过 Message / Tool Result 留在 Session 中。

如果 Session 很长，Compaction 仍然使用 Chapter 08 的路径：

```text
Session Tree
    ↓
CompactionEntry
    ↓
buildSessionContext()
    ↓
Agent messages
    ↓
transformContext()
    ↓
LLM
```

Compaction 先决定从持久化 Session 重建出什么 canonical messages。

Extension 的 Context handler 仍然发生在调用模型之前。

这两层没有因为进入 Coding Agent 就合并。

## 跑一次完整的 Bug Fix

fixture 里的测试要求：

```text
add(2, 3) = 5
```

源码现在却是：

```ts
return a - b;
```

用户输入：

```text
修复 calculator.ts 中的 bug，
并运行测试确认修复结果。
```

一次运行可能这样展开。

先出现一个危险命令：

```text
bash("rm -rf keep/")
```

Permission Extension 在 `tool_call` 阶段 block：

```text
bash
 ↓
permission extension
 ↓
block
 ↓
error ToolResult
```

模型看到拒绝原因以后继续。

接着读取验证 Skill：

```text
read_file("skills/verify.md")
```

再查找目标代码：

```text
grep("function add", "src")
```

读取文件：

```text
read_file("src/calculator.ts")
```

先运行测试：

```text
bash("npm test")
```

测试失败。

Bash Tool 把非零退出码作为执行失败抛出，Tool Runtime 再转成：

```text
ToolResult(isError = true)
```

模型拿到真实测试输出以后，继续修改代码：

```text
edit(
  oldText = "return a - b;",
  newText = "return a + b;"
)
```

然后再次执行：

```text
bash("npm test")
```

这次测试通过。

整个过程可以写成：

```text
user
│
│  修复 calculator.ts，并运行测试
│
├─ bash("rm -rf keep/")
│    ↓
│  permission extension blocks
│    ↓
│  error ToolResult
│
├─ read_file("skills/verify.md")
│
├─ grep("function add", "src")
│
├─ read_file("src/calculator.ts")
│
├─ bash("npm test")
│    ↓
│  test fails
│    ↓
│  error ToolResult
│
├─ edit(
│    oldText = "return a - b;",
│    newText = "return a + b;"
│  )
│
├─ bash("npm test")
│    ↓
│  test passes
│
└─ final answer
```

这里的文件读取、源码修改和测试都是真实执行。

模型不需要提前知道整个流程会走几步。

它每一轮只根据当前 history 和最新 Tool Result 决定下一步。

run 结束以后，新消息继续追加到 Session。

重新启动时：

```text
load TreeSession
    ↓
buildSessionContext()
    ↓
restore messages
    ↓
create Agent
    ↓
continue
```

恢复后的 Coding Agent 仍然使用同一套：

```text
Agent Loop
Tool Runtime
Context
Extension
```

没有单独的“Coding Session”或“Coding Loop”。

Pi 的完整 Coding Agent 当然还有更多东西：

```text
更多文件工具
更完整的 edit
资源加载
进程管理
Trust
CLI / TUI
```

这一章没有把它们全部搬进来。

我们只取了一个能够从头跑到尾的任务：

```text
用户提出修改
    ↓
Skill 提供任务说明
    ↓
Tool 探索和修改代码
    ↓
Extension 控制执行策略
    ↓
真实测试验证结果
    ↓
Session 保存执行历史
```

前面拆开的机制，到这里第一次作为一个 Coding Agent 同时工作。

更值得留下的也正是这一点：

一个具体产品可以不断增加能力，但前面那条 Agent Loop 没有因此被重新写一遍。
