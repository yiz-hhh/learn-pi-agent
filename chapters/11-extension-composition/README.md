# Chapter 11：Extension Composition

Chapter 10 已经让 Extension 能够：

```text
register Tool
register Command
listen Agent Event
intercept Tool Call
transform Context
```

这些接口单独看都不复杂。

真正值得验证的是另一件事。

如果需求已经开始改变 Agent 的工作方式，比如：

```text
危险命令需要权限判断

进入 Plan Mode 后只能分析，不能修改

主 Agent 可以把任务交给另一个 Agent
```

这些能力还要不要继续进入 Agent Core？

先从最小的一个开始。

## Permission Gate

假设 Agent 已经有普通的 `bash` Tool：

```text
bash("ls -la")
bash("rm -rf /tmp/demo")
```

如果把权限判断直接写进 `bash.execute()`：

```ts
if (isDangerous(command)) {
  return deny();
}
```

那么 `bash` 同时开始负责：

```text
怎样执行命令
```

以及：

```text
当前环境允许执行什么
```

第二件事通常不是 Tool 自己能决定的。

不同运行环境可能有不同策略：

```text
直接禁止

弹出确认

只允许白名单

已经在隔离环境中，直接执行
```

Chapter 10 已经有 `tool_call` interception。

Permission Extension 只需要检查 `bash` 的参数：

```ts
export default function permissionGate(
  pi: ExtensionAPI,
): void {
  pi.on("tool_call", async (event) => {
    if (event.toolCall.name !== "bash") {
      return;
    }

    const command =
      (event.args as { command?: string })
        .command ?? "";

    const verdict =
      decidePermission(command);

    if (verdict.block) {
      return {
        block: true,
        reason: verdict.reason,
      };
    }
  });
}
```

如果允许，原来的 Tool Runtime 继续执行。

如果 block：

```text
assistant
    ↓
toolCall: bash(...)
    ↓
Permission Extension
    ↓
block
    ↓
ToolResult(isError = true)
    ↓
LLM
```

`bash` Tool 不需要知道 Permission Extension 的存在。

Agent Loop 也没有增加：

```ts
if (permissionMode) {
  ...
}
```

被拒绝的调用最后仍然按照 Chapter 03 的失败语义回到模型。

Permission Gate 只改了一次 Tool Call。

Plan Mode 会更麻烦一些。

## Plan Mode

进入 Plan Mode 后，我们希望 Agent 持续保持一组约束：

```text
write / edit 暂时不可用

bash 只允许只读命令

模型知道当前应该先分析和制定计划
```

如果把这些逻辑直接写进 Agent Runtime，很容易变成：

```ts
if (mode === "plan") {
  tools = planTools;
  systemPrompt += PLAN_MODE_PROMPT;
  blockWriteCommands();
}
```

从这一刻开始，Agent Core 自己认识了：

```text
plan mode
```

但 Chapter 10 已经有几条可以组合的 seam。

Plan Mode 自己只需要保存状态：

```ts
let enabled = false;

let toolsBeforePlanMode: string[] = [];
```

进入 `/plan` 时，先保存当前 Tool 集合：

```text
current active tools
        ↓
save
```

然后切换成允许在 Plan Mode 使用的 Tool：

```text
remove write
remove edit
remove other mutation tools
        ↓
setActiveTools(plan-safe tools)
```

退出时恢复：

```text
setActiveTools(toolsBeforePlanMode)
```

这里不能恢复一份写死的：

```text
NORMAL_TOOLS
```

因为进入 Plan Mode 之前，其他 Extension 可能已经改变过 active tools。

例如：

```text
Extension A 增加了 tool-x

Extension B 隐藏了 tool-y

然后进入 Plan Mode
```

退出时如果直接恢复某套固定默认值，前面的扩展状态会一起被覆盖。

所以需要保存并恢复进入 Plan Mode 前真实的 active tools。

`setActiveTools()` 也必须真正作用到当前运行中的 Agent。

下一次 LLM call 使用的是 Agent 此刻持有的 Tool 集合。

所以路径是：

```text
Plan Mode Extension
        ↓
setActiveTools(...)
        ↓
Extension Runtime
        ↓
running Agent tools
        ↓
next LLM call
```

不需要重新创建 Agent。

### 同一个状态继续控制 bash

Plan Mode 里不能简单把 `bash` 整个移除。

这些命令仍然很有用：

```text
pwd
ls
cat
grep
```

但下面这些可能需要禁止：

```text
rm
mv
sudo
chmod
output redirection
```

所以同一个：

```ts
enabled
```

还可以驱动 `tool_call` interception。

当 Plan Mode 开启时：

```text
bash(command)
    ↓
check readonly policy
    ↓
allow / block
```

Permission Gate 用过的 seam，在这里继续复用。

### 模型还要知道当前处于 Plan Mode

只改变 Tool 集合还不够。

模型需要知道：

```text
当前任务先分析
先制定计划
暂时不要尝试修改文件
```

Chapter 10 已经能注册 `context` handler：

```ts
pi.on("context", async (event) => {
  if (!enabled) {
    return event.messages;
  }

  return [
    ...event.messages,
    createPlanModeMessage(),
  ];
});
```

于是同一份状态：

```text
enabled
```

同时影响：

```text
active tools

bash policy

LLM context
```

这些变化分别进入前面已经存在的三个位置：

```text
setActiveTools

tool_call

context
```

Agent Loop 本身没有增加 Plan Mode 分支。

Pi 的完整 Plan Mode 示例还会处理更多产品层细节，例如 Session 恢复、`before_agent_start`、快捷键、UI 状态和待办项。

这一章不需要把这些都复制进来。

这里先确认一个更基础的事实：

```text
一个持续存在的 mode
可以由 Extension 自己保存状态，
再通过已有 seam 改变当前 Agent。
```

再往前一步。

## Subagent

如果主 Agent 想把一个独立任务交给另一个 Agent，很容易直接在 Parent Loop 里增加：

```ts
if (needsSubagent) {
  runChildAgent();
}
```

这样 Parent Runtime 从此就需要认识：

```text
child agent
delegation
child session
child lifecycle
```

Pi 的 Subagent 示例从 Parent 一侧看起来要简单得多。

它注册的是一个普通 Tool：

```text
subagent
```

Parent 仍然只走：

```text
Parent Agent
    ↓
toolCall: subagent
    ↓
Tool Runtime
    ↓
child execution
    ↓
ToolResult
    ↓
Parent Agent continues
```

Parent Loop 不需要增加新的控制路径。

这一章的实现可以在 `subagent` Tool 内创建独立的 Agent 和 Session：

```ts
const subSession =
  new TreeSession();

const subAgent =
  new Agent({
    systemPrompt,
    tools,
    llm,
    config: { model },
  });
```

Child 有自己的：

```text
messages
tools
systemPrompt
session
```

它内部产生的：

```text
assistant
toolCall
toolResult
```

都属于 Child 自己的运行。

Parent history 只留下：

```text
assistant
    ↓
subagent Tool Call
    ↓
ToolResult: child final answer
    ↓
assistant continues
```

如果 Child 失败，`subagent` Tool 可以直接抛错。

然后 Chapter 03 的 Tool Runtime 会把它转成：

```text
ToolResult(isError = true)
```

对 Parent 来说，Child Runtime 的内部失败最终仍然表现为一次普通 Tool execution failure。

### 并发也不需要重新设计

因为 `subagent` 最后仍然是 Tool，同一轮如果模型发出：

```text
subagent(task A)
subagent(task B)
```

Chapter 04 的 batch execution 可以直接接住它们。

两个 Child 各自维护自己的 Agent state 和 Session，同时运行。

Parent 不需要额外增加一套：

```text
Subagent Scheduler
```

Pi 官方 Subagent 示例在隔离上做得更彻底：它会启动独立的 `pi` 进程。

这一章使用进程内 Agent，运行方式不同。

Parent 一侧的边界没有变化：

```text
task
 ↓
child execution
 ↓
final ToolResult
```

Parent 只关心最终 Tool Result。

## 三个例子最后回到了同一组 seam

现在再看这三个能力。

Permission Gate：

```text
tool_call
    ↓
allow / block
```

Plan Mode：

```text
state
 ├─ setActiveTools
 ├─ tool_call
 └─ context
```

Subagent：

```text
registerTool("subagent")
    ↓
Tool Runtime
    ↓
child execution
    ↓
ToolResult
```

它们改变 Agent 的范围逐渐变大。

但实现最后都落回了前面已经存在的机制：

```text
Permission
→ Tool interception

Plan Mode
→ active tools
→ Context interception
→ Tool interception

Subagent
→ Tool registration
→ Tool Runtime
→ parallel batch
```

到这里，Agent Core 仍然没有新增：

```text
permission
planMode
subagent
```

这也是 Extension Runtime 到这一章才真正显示出价值的地方。

Chapter 10 里那些 API 单独看只是注册接口。

组合起来以后，它们已经能表达会持续改变 Agent 行为的功能。

Pi README 会把 permission popup、plan mode、sub-agent 这类行为留在默认工作流之外。

这些功能没有唯一正确的产品形态。

不同 Harness 可以继续使用同一组 Core primitive，组合出自己的实现。

运行：

```bash
npm run demo
```

可以分别观察：

```text
dangerous bash
→ Permission Gate block
→ error ToolResult
```

进入 `/plan` 后：

```text
active tools changed

bash readonly policy enabled

Plan Mode context injected
```

退出时恢复进入模式前的 Tool 集合。

Parent 调用 `subagent` 时：

```text
Parent
→ subagent Tool
→ independent Child
→ ToolResult
→ Parent continues
```

Child 的内部消息不会混进 Parent Session。

到这里，Extension Runtime 已经不只是“给 Harness 加几个插件”。

它已经能组合出完整的 Agent 行为，而 Agent Loop 本身仍然保持原来的形状。

最后还剩一个问题。

把：

```text
read
write
edit
grep
bash

Workspace

Session
Compaction

Skills
Extensions
```

真正组装成一个 Coding Agent 以后，这些边界还能不能继续成立？

Chapter 12 从这里继续。
