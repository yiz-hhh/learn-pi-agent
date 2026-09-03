# Chapter 10：Extension Runtime

Chapter 09 里的扩展主要还是数据。

Skill 是文件。

Custom Message 是消息。

`addedToolNames` 也是一组名字。

现在换一个需求。

我们希望加载一段真正的代码：

```text
delete_file 执行前做权限检查

message_end 时记录状态

注册一个新的 hello Tool

增加一个 /todos 命令
```

最直接的写法可以是：

```ts
import extension from "./my-extension";

extension({
  agent,
  session,
  tools,
  config,
  eventBus,
});
```

功能很快就能接进去。

但 Extension 也从这一刻开始知道 Harness 的内部结构。

它可以直接改 `agent.state`，直接操作 Session，也可以依赖 Tool Registry 当前使用的具体数据结构。

Harness 内部稍微重构一下，这些 Extension 就可能一起失效。

所以真正需要解决的并不是“怎么动态 import 一个模块”。

而是：

```text
外部代码可以使用 Harness 的哪些能力？
这些能力加载以后怎样继续存在？
运行时又怎样进入原来的 Agent 路径？
```

## Extension 只拿到一组可注册的能力

Pi Extension 最基本的形式是一个 module factory：

```ts
export default function (pi: ExtensionAPI) {
  // ...
}
```

factory 也可以是 async。

Extension 不直接拿完整的 `AgentSession` 或内部 Registry。

它拿到的是 `ExtensionAPI`：

```ts
export default function (pi: ExtensionAPI) {
  pi.registerTool(helloTool);

  pi.registerCommand("todos", ...);

  pi.on("tool_call", async (event, ctx) => {
    // ...
  });
}
```

这段 factory 的职责只是注册。

例如：

```ts
export default function (pi: ExtensionAPI) {
  pi.registerTool(helloTool);
}
```

module 加载时，factory 执行一次。

执行结束以后，真正留下来的不是这个函数，而是：

```text
helloTool registration
```

以后模型调用：

```text
hello(...)
```

不会重新执行 Extension factory。

Runtime 直接找到已经注册好的 Tool。

Handler 和 Command 也是一样。

加载阶段：

```text
extension module
      ↓
factory(api)
      ↓
register tool
register handler
register command
```

运行阶段：

```text
Tool Call
→ registered tool

Agent Event
→ registered handler

/todos
→ registered command
```

Extension module 声明自己要加入什么。

Extension Runtime 保存这些 registration，并在后面的运行过程中使用它们。

这个区分很重要。

如果把“加载 Extension”和“执行 Extension 行为”混在一起，Runtime 很快会变成每次触发能力时重新解释整个 module。

Pi 留下的是一组已经注册好的能力。

## 一个 Extension 要完整加载，或者完全不留下

factory 本身也是外部代码。

例如：

```ts
export default function (pi: ExtensionAPI) {
  pi.registerTool(toolA);

  throw new Error("boom");
}
```

如果 `registerTool()` 一调用就直接修改全局 Runtime，那么执行到这里以后会出现一个很尴尬的状态：

```text
toolA 已经注册

Extension 加载失败
```

这时系统里留下了半个 Extension。

所以加载过程不能边执行 factory，边直接提交最终 registration。

更稳妥的顺序是：

```text
create temporary registrations
        ↓
run factory
        ↓
success?
```

成功：

```text
commit registrations
```

失败：

```text
discard registrations
```

这样一个 Extension 加载失败，不会残留半套 Tool、Handler 或 Command。

其他 Extension 也可以继续加载。

Pi 的完整 loader 还要处理 module loading、package、cache、reload 等问题。

这些属于更外层的资源加载。

这一章只保留一个运行时约束：

```text
一次 factory 执行产生的一组 registration
要么全部进入 Runtime
要么全部不进入
```

## Extension Tool 最后还是普通 Tool

`registerTool()` 并没有给 Agent Loop 增加：

```text
executeExtensionTool()
```

注册完成以后，Extension Tool 会进入 Agent 已经在使用的 Tool 集合。

Loop 看到的仍然是：

```text
context.tools
```

模型发出：

```text
assistant
└── toolCall: hello(...)
```

后面仍然走 Chapter 03 已经建立的路径：

```text
lookup
prepare
validate
beforeToolCall
execute
afterToolCall
normalize
```

Chapter 04 的 parallel / sequential batch 语义也继续有效。

从 Agent Loop 的角度，内置 Tool 和 Extension Tool 没有两套执行模型。

Extension Tool 运行时有时还需要 Harness 提供一些上下文，例如：

```text
当前工作目录
当前 Session
当前 active tools
```

这些信息可以由 Runtime 在真正执行 Tool 时构造一份 `ExtensionContext` 再传进去。

Extension 不需要通过全局变量去寻找当前 Session，也不需要知道 Harness 内部怎样保存这些状态。

新的能力进入了系统。

原来的 Tool Runtime 没有因此被绕开。

## Handler 的注册顺序就是执行顺序

一个 Extension 只有一个 handler 时，直接调用就够了。

多个 Extension 同时存在以后，需要先确定组合规则。

假设加载顺序是：

```text
Extension A
  handler 1
  handler 2

Extension B
  handler 1
```

Runtime 按注册顺序逐个 dispatch：

```text
A.handler1
A.handler2
B.handler1
```

每个 handler 都会被 `await`。

这里没有像 Parallel Tool Execution 那样直接 `Promise.all()`。

原因可以从 `context` handler 看出来。

假设初始消息是：

```text
messages0
```

A 先做一次转换：

```text
messages0
    ↓ A
messages1
```

然后 B 应该接着处理：

```text
messages1
    ↓ B
messages2
```

而不是让 A 和 B 同时拿到 `messages0`，最后再决定保留谁的结果。

所以 Context interception 是一条链。

Chapter 06 已经有：

```text
transformContext()
```

Extension Runtime 只需要把注册的 context handler 接进这个位置：

```text
messages
   ↓
handler A
   ↓
handler B
   ↓
transform 后的 messages
   ↓
LLM
```

Core 已经有 Context seam。

Extension 只是在这个位置继续注册行为。

## 不同 Handler 有不同的合并方式

有些 Handler 只是观察事件。

例如：

```text
message_end
turn_end
agent_end
```

它们收到事件后记录日志或状态即可。

`tool_call` 不一样。

假设一个 Permission Guard 收到：

```text
delete_file(...)
```

然后返回：

```ts
{
  block: true,
  reason: "禁止删除文件",
}
```

这时候后面的 `tool_call` handler 不应该继续执行。

Runtime 可以直接 short-circuit：

```ts
for (const handler of handlers) {
  const result = await handler(event, ctx);

  if (result?.block) {
    return result;
  }
}
```

所以 Extension Runtime 不是一个只负责：

```text
emit(event)
```

的 EventEmitter。

不同 seam 有自己的组合语义：

```text
context
→ 前一个输出继续交给后一个

tool_call
→ block 后立即停止

message_end
→ 按顺序通知
```

这些规则固定下来以后，Extension 才能在同一个 Runtime 里稳定组合。

## Extension 出错不应该拖垮其他 Extension

Extension 是外部代码。

Handler 迟早会抛异常。

假设：

```text
Extension A handler
→ throw
```

如果整个 dispatch 直接跟着失败：

```text
A throws
↓
B 不执行
C 不执行
Agent run 也中断
```

一个 Extension 的错误就会扩大成整个 Harness 的错误。

Pi 会在单个 handler 周围隔离异常。

所以运行可以继续：

```text
A throws
   ↓
report error
   ↓
B still runs
```

这和 Tool error 不是同一层问题。

Extension 注册的 Tool 如果在 `execute()` 中抛错，仍然走 Chapter 03 的路径：

```text
Tool throws
    ↓
ToolResult(isError = true)
    ↓
模型看到失败
```

而 `message_end`、`tool_call` 这一类 Handler 自己抛错，是 Extension Runtime 内部的扩展代码故障。

Runner 记录错误，然后继续其他 handler。

## Extension 最后接回原来的 Harness

把前面的注册行为放回已有机制里，可以看到几条路径。

注册 Tool：

```text
registerTool
    ↓
active tools
    ↓
Tool Runtime
```

处理 Context：

```text
on("context")
    ↓
transformContext
    ↓
LLM call
```

拦截 Tool Call：

```text
on("tool_call")
    ↓
beforeToolCall
    ↓
Tool Runtime
```

监听 Agent 运行：

```text
on("message_end")
    ↓
Agent Event
```

保存扩展状态：

```text
appendEntry
    ↓
Session
```

Extension Runtime 自己并没有再造：

```text
Extension Agent Loop
Extension Tool Loop
Extension Session
Extension Context
```

它主要保存两样东西：

```text
外部 module 能注册什么
```

以及：

```text
这些 registration 在原有 seam 上怎样执行
```

Agent Loop 仍然不知道 Extension module 的存在。

这时候 Pi 的 Core 边界已经比较明显了。

Permission、Plan Mode、Sub-agent 这类能力当然可以直接写进 Agent Runtime。

但现在已经有：

```text
Tool registration
Tool interception
Context interception
Event handlers
Commands
Session entries
```

更有意思的问题是，这些现成的 primitive 已经能组合到什么程度。

Chapter 11 从这里继续。
