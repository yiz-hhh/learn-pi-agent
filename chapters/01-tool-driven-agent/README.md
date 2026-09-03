# Chapter 01：Tool-driven Agent

用户问：

> 请计算 12 + 30 等于多少？

如果模型直接回答文本，一次 LLM 调用就结束了。

但现在给模型一个 `calculator` Tool。

模型第一次返回的可能不是答案，而是：

```text
assistant
└── calculator({ a: 12, b: 30 })
```

程序执行工具，得到：

```text
42
```

这时候任务还没有完成。

`42` 只存在于程序这一侧。模型只知道自己刚才请求了 `calculator`，并不知道工具实际返回了什么。

要让模型继续回答，这条结果必须进入消息历史，再调用一次模型：

```text
user
assistant(toolCall: calculator)
toolResult("42")
        ↓
       LLM
        ↓
assistant("12 + 30 = 42")
```

如果下一轮模型又请求另一个 Tool，同样的过程继续。

## Tool Result 把一次调用变成了循环

沿着刚才的过程写下来，控制逻辑很短：

```ts
let hasMoreToolCalls = true;

while (hasMoreToolCalls) {
  const assistantMessage = await callLlm(messages);
  messages.push(assistantMessage);

  hasMoreToolCalls = false;

  for (const toolCall of assistantMessage.toolCalls ?? []) {
    const result = await executeToolCall(toolCall);
    messages.push(result);
    hasMoreToolCalls = true;
  }
}
```

模型没有请求 Tool，这一轮回复就是最终结果。

模型请求了 Tool，就执行它，把结果追加到 history，然后把更新后的 history 再交给模型。

一段多步执行于是会自然长成：

```text
user

assistant
└── toolCall A

toolResult A

assistant
└── toolCall B

toolResult B

assistant
└── final text
```

Loop 不需要提前知道模型要走几步，也不需要先写好一张固定 Workflow。

每一轮只处理当前已经发生的事情：

```text
调用模型
   ↓
执行本轮 Tool Call
   ↓
把结果写回 history
   ↓
再次调用模型
```

下一步做什么，继续由模型根据新的消息决定。

Chapter 00 已经把 LLM 接口定义成流式返回，所以实际的 `agentLoop()` 会遍历事件，但这一章只取最终的 `done`：

```ts
let hasMoreToolCalls = true;

while (hasMoreToolCalls) {
  let assistantMessage;

  for await (const event of llm.complete({
    model,
    systemPrompt,
    messages: context.messages,
    tools: context.tools,
  })) {
    if (event.type === "done") {
      assistantMessage = event.partial;
      break;
    }
  }

  if (!assistantMessage) {
    throw new Error("LLM stream ended without a done event");
  }

  context.messages.push(assistantMessage);
  hasMoreToolCalls = false;

  for (const toolCall of assistantMessage.toolCalls ?? []) {
    const result = await executeToolCall(context, toolCall);
    context.messages.push(result);
    hasMoreToolCalls = true;
  }
}
```

这里有两次 history 写入：

```ts
context.messages.push(assistantMessage);
```

记录模型刚才请求了什么。

随后：

```ts
context.messages.push(result);
```

记录这个请求执行以后发生了什么。

下一次模型调用同时看到两者，才能把 Tool Call 和 Tool Result 对应起来。

## 工具失败也要回到模型

成功的 Tool Call 很直接：

```text
calculator({ a: 12, b: 30 })
        ↓
       42
        ↓
toolResult("42")
```

但 Tool 也可能不存在：

```text
assistant
└── weather(...)
```

或者执行过程中抛出异常：

```text
database_query(...)
        ↓
throw Error("connection timeout")
```

如果这里直接让异常结束整个 Loop，模型看到的最后一条消息仍然是自己的 Tool Call。

它不知道工具为什么没有返回结果，也没有机会根据失败原因换一种做法。

所以这一章先做一个很小的处理：把 Tool execution 的失败也变成 `toolResult`。

```ts
async function executeToolCall(context, toolCall) {
  const tool = context.tools?.find(
    (t) => t.name === toolCall.name,
  );

  if (!tool) {
    return {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      text: `Tool ${toolCall.name} not found`,
      isError: true,
    };
  }

  try {
    const result = await tool.execute(toolCall.arguments);

    return {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      text: result.content ?? "",
      isError: false,
    };
  } catch (error) {
    return {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      text:
        error instanceof Error
          ? error.message
          : String(error),
      isError: true,
    };
  }
}
```

成功时：

```text
toolResult
├── text: "42"
└── isError: false
```

失败时：

```text
toolResult
├── text: "connection timeout"
└── isError: true
```

两种结果都会进入 history。

Tool 仍然可以用异常表示执行失败；Loop 只负责把这次失败整理成模型下一轮能够读到的消息。

于是模型可以修改参数、换一个 Tool，或者直接告诉用户当前操作失败。

参数准备、Schema 校验、权限检查这些问题先不放进这里。等 `executeToolCall()` 本身开始承担更多职责时，再单独处理 Tool Runtime。

## Pi 里的主循环

Pi 的主循环也是沿着同一条反馈链推进。

模型先产生 assistant message，其中可能包含 Tool Call：

```text
assistant message
      ↓
tool calls
      ↓
execute
```

工具执行完成以后，结果继续写回当前消息历史：

```ts
currentContext.messages.push(...toolResults);
newMessages.push(...toolResults);
```

下一次 LLM 调用自然会看到这些结果。

对这一章来说，最重要的部分只有：

```text
LLM
 ↓
tool call
 ↓
tool
 ↓
tool result
 ↓
LLM
```

Pi 后面还会在 Tool execution 周围增加参数准备、校验、生命周期事件和其他处理。

那些东西没有改变这条最基本的反馈路径。

运行：

```bash
npm run demo
```

一次最简单的输出类似：

```text
[user]
请计算 12 + 30 等于多少？

[assistant]
calculator({"a":12,"b":30})

[toolResult]
42

[assistant]
12 + 30 = 42
```

现在模型已经可以根据 Tool Result 持续往下执行。

不过 `agentLoop()` 仍然是一次完整的异步调用。

在它返回之前，外面看不到模型什么时候开始回复、Tool 什么时候执行，也不知道当前已经进行到哪一轮。

Chapter 02 从这个问题继续。
