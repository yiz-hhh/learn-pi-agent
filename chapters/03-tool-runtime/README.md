# Chapter 03：Tool Runtime

Chapter 02 以后，Agent Loop 已经能把自己的运行过程暴露出来。

工具执行还很简单：

```ts
const tool = context.tools?.find(
  (t) => t.name === toolCall.name,
);

try {
  const result = await tool.execute(
    toolCall.arguments,
  );

  return createToolResult(result);
} catch (error) {
  return createErrorResult(error);
}
```

对于：

```text
calculator({ a: 12, b: 30 })
```

这完全够用。

但模型也可能生成：

```text
calculator({
  a: "twelve",
  b: 30
})
```

`calculator` 明明要求 `a` 是 number。

如果 Runtime 仍然直接调用 `execute()`，参数检查只能重新散到每个 Tool 里面。

还有一些调用参数本身没问题，但执行前需要做额外判断：

```text
write_file(...)
    ↓
permission check
    ↓
execute
```

工具执行以后，也可能需要补充 metadata、调整结果，或者告诉 Loop 当前任务已经完成。

`tool.execute(args)` 周围开始出现越来越多事情。

这些事情不需要继续堆进 Agent Loop。

## Tool Call 在执行前还要经过什么

先把真正执行 Tool 之前的步骤排开：

```text
tool call
   ↓
lookup
   ↓
prepare
   ↓
validate
   ↓
beforeToolCall
   ↓
execute
```

第一步是 lookup。

模型只给出 Tool 名：

```text
calculator
```

Runtime 要从当前可用工具中找到实现。

如果找不到：

```text
toolCall("weather")
      ↓
lookup
      ↓
not found
      ↓
error ToolResult
```

这次调用到这里就结束，不会继续进入 Tool。

找到 Tool 以后，模型给出的参数还可以先经过 `prepare`。

```text
model arguments
      ↓
prepare
      ↓
tool arguments
```

这一步可以处理模型侧参数和 Tool 实际输入之间的转换。

随后再做 schema validation。

假设 Tool 声明：

```text
a: number
b: number
```

模型却返回：

```text
a: "twelve"
b: 30
```

这次调用会直接在 Runtime 中失败，`calculator.execute()` 根本不会被调用。

参数有效以后，还有一个执行前的拦截点：

```text
validated arguments
        ↓
beforeToolCall
        ↓
   allow / block
```

权限、调用限制这类策略可以挂在这里。

如果被 block，Runtime 仍然生成一条失败的 Tool Result，让模型下一轮看到原因。

到真正执行 Tool 时，这次调用已经经过：

```text
lookup
  ↓
prepare
  ↓
validate
  ↓
beforeToolCall
  ↓
execute
```

Agent Loop 不需要分别知道这些阶段为什么失败。

它最后只接收一条 Tool Result。

## Tool Execution 也需要事件

Chapter 02 已经暴露了：

```text
agent
turn
message
```

Tool 本身也可能执行很久。

所以 Runtime 继续增加：

```text
tool_execution_start
tool_execution_update
tool_execution_end
```

`tool_execution_start` 有一个重要的时间点：它发生在 lookup 之前。

例如模型请求了一个根本不存在的 Tool：

```text
tool_execution_start
        ↓
      lookup
        ↓
     not found
        ↓
tool_execution_end
```

这里的 `start` 表示：

```text
Runtime 开始处理这次 Tool Call
```

不是：

```text
Tool 的 execute() 已经开始运行
```

因此 lookup 失败、参数非法、执行前被 block、Tool 自身抛错，都能落进同一段 Tool Call 生命周期。

长时间运行的 Tool 还可以主动报告进度：

```ts
await tool.execute(
  args,
  (partialResult) => {
    emit({
      type: "tool_execution_update",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments,
      partialResult,
    });
  },
);
```

例如：

```text
tool_execution_start

tool_execution_update  10%
tool_execution_update  40%
tool_execution_update  80%

tool_execution_end
```

这些 update 只描述当前执行状态，不进入消息历史。

真正写回 history 的仍然只有最终 Tool Result。

## Tool 返回值最后统一成 Tool Result

Tool 自己的返回值可以比 Agent Message 丰富：

```ts
{
  content,
  details,
  usage,
  terminate,
  addedToolNames,
}
```

Agent Loop 不需要理解每个 Tool 各自的返回结构。

所以 Tool 执行以后还要经过：

```text
execute
   ↓
afterToolCall
   ↓
normalize
   ↓
ToolResult
```

`afterToolCall` 给执行结果最后一次处理机会。

`normalize` 再把结果整理成统一的 `ToolResultMessage`：

```text
ToolResultMessage
├── role
├── toolCallId
├── toolName
├── text
├── details
├── usage
├── terminate
└── isError
```

这样 Loop 看到的路径始终还是：

```text
assistant(toolCall)
        ↓
    Tool Runtime
        ↓
    toolResult
```

错误也走同一个出口。

Tool 不存在：

```text
lookup
  ↓
ToolResult(isError = true)
```

参数错误：

```text
validate
  ↓
ToolResult(isError = true)
```

Tool 自己抛异常：

```text
execute
  ↓
throw
  ↓
ToolResult(isError = true)
```

Tool 可以继续用异常表达执行失败。

Runtime 负责把这些不同阶段的失败统一整理成模型下一轮能够看到的结果。

## Pi 怎样拆这条执行路径

Pi 没有把这一整段逻辑塞进一个越来越大的 `executeToolCall()`。

主要阶段被拆成：

```text
prepareToolCall

  lookup
  prepare
  validate
  beforeToolCall

        ↓

executePreparedToolCall

  execute
  onUpdate

        ↓

finalizeExecutedToolCall

  afterToolCall

        ↓

createToolResultMessage

  normalize
```

Chapter 03 没有照搬 Pi 的函数拆分，但保留了相同的执行阶段。

这里可以看出一个比函数名更重要的边界：

Agent Loop 只决定：

```text
现在有一批 Tool Call
→ 执行它们
→ 把结果写回 history
```

Tool Runtime 决定：

```text
这个调用是否存在
参数是否有效
执行前能不能继续
Tool 怎样运行
结果最后长什么样
```

Tool 相关的复杂度增长以后，没有继续要求 Loop 一起增长。

这一层还有一个会影响 Loop 的字段：

```ts
terminate: true
```

它表示某个 Tool 认为当前任务可以结束。

但一次 assistant message 可能同时请求多个 Tool：

```text
tool A
tool B
tool C
```

因此单个 Tool 返回 `terminate: true`，不能立刻结束整个 batch。

Pi 会等这一批全部完成以后再判断：

```ts
finalizedCalls.length > 0 &&
finalizedCalls.every(
  (call) => call.result.terminate === true,
)
```

例如：

```text
A  true
B  true
C  true

→ stop
```

而：

```text
A  true
B  false
C  true

→ continue
```

单个 Tool 只描述自己的执行结果。

是否停止后续 Loop，由整批结果共同决定。

运行：

```bash
npm run demo
```

一次正常 Tool Call 现在会经过：

```text
assistant(toolCall)
        ↓
tool_execution_start
        ↓
lookup
prepare
validate
beforeToolCall
        ↓
execute
        ↓
afterToolCall
normalize
        ↓
tool_execution_end
        ↓
toolResult
```

Agent Loop 最后仍然只处理 Tool Call 和 Tool Result。

但同一轮如果出现多个互不依赖的 Tool Call，目前还是：

```ts
for (const call of toolCalls) {
  outcomes.push(
    await executeToolCall(call),
  );
}
```

三个 Tool 的耗时会直接相加。

Chapter 04 从这个问题继续。
