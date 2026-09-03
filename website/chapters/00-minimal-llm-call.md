---
title: "Chapter 00：Minimal LLM Call"
description: "最简单的聊天程序只需要维护一组消息，然后把它们交给模型。"
head: [["link",{"rel":"canonical","href":"https://yiz-hhh.github.io/learn-pi-agent/chapters/00-minimal-llm-call"}]]
---
# Chapter 00：Minimal LLM Call

最简单的聊天程序只需要维护一组消息，然后把它们交给模型。

```ts
const response = await anthropic.messages.create({
  model,
  system,
  messages,
});
```

如果只有普通的 `user` 和 `assistant` 文本，这样已经够用了。消息可以直接使用 Provider SDK 的类型，返回结果也可以继续放回历史。

这时候还看不出有必要再设计一套自己的 Message。

Tool Calling 出现以后，情况开始变化。

## Tool Calling 让 Provider 差异进入 Runtime

假设用户问：

```text
新加坡现在天气怎么样？
```

模型决定调用：

```text
get_weather({ city: "Singapore" })
```

Anthropic 会把这次调用放在 assistant message 的 `tool_use` block 中：

```ts
{
  role: "assistant",
  content: [
    {
      type: "tool_use",
      id: "call_123",
      name: "get_weather",
      input: {
        city: "Singapore"
      }
    }
  ]
}
```

程序执行工具，得到：

```text
31°C, cloudy
```

结果交回 Anthropic 时，要构造一条 `user` message，再放入一个 `tool_result` block：

```ts
{
  role: "user",
  content: [
    {
      type: "tool_result",
      tool_use_id: "call_123",
      content: "31°C, cloudy"
    }
  ]
}
```

这里的 `role: "user"` 是 Anthropic Messages API 的协议表示。真正说明这是一条工具结果的是里面的 `tool_result`。

换成 OpenAI Responses API，同样的过程长得不一样。

模型请求工具时返回：

```ts
{
  type: "function_call",
  call_id: "call_123",
  name: "get_weather",
  arguments: "{\"city\":\"Singapore\"}"
}
```

工具执行完成以后，再传回：

```ts
{
  type: "function_call_output",
  call_id: "call_123",
  output: "31°C, cloudy"
}
```

两边表达的其实是同一件事：

```text
模型请求 get_weather
        ↓
程序执行工具
        ↓
返回 "31°C, cloudy"
```

但 API 里的表示已经明显不同：

| | Anthropic Messages | OpenAI Responses |
| --- | --- | --- |
| Tool Call | `tool_use` content block | `function_call` item |
| 调用参数 | `input` object | `arguments` JSON string |
| 调用 ID | `id` | `call_id` |
| Tool Result | `tool_result` content block | `function_call_output` item |
| 结果关联 | `tool_use_id` | `call_id` |
| 结果所在位置 | `role: "user"` message 内 | 独立 input item |

普通文本消息还能比较直接地对应。到了 Tool Calling，差异已经不只是换几个字段名。

如果 Runtime 内部直接保存 Anthropic 的消息格式，那么工具执行完成以后，Tool Runtime 也得知道：

```text
role: user
content:
  type: tool_result
  tool_use_id: ...
```

以后接入 OpenAI，这部分又要认识：

```text
type: function_call_output
call_id
output
```

这样 Provider 协议就离开了模型调用这一处，继续进入 Tool Runtime。

再往后，Session 保存的也是 Provider Message，Context 处理操作的还是 Provider Message。原本只是模型接入方式不同，最后却会影响整条运行链路。

到这里，才有必要把两边分开。

## 给 Agent 自己一套消息

从 Agent Runtime 的角度，它不需要知道 Anthropic 为什么用 `tool_result`，也不需要知道 OpenAI 为什么叫 `function_call_output`。

模型请求了哪个工具：

```ts
{
  role: "assistant",
  toolCalls: [
    {
      id: "call_123",
      name: "get_weather",
      arguments: {
        city: "Singapore"
      }
    }
  ]
}
```

工具执行以后发生了什么：

```ts
{
  role: "toolResult",
  toolCallId: "call_123",
  toolName: "get_weather",
  text: "31°C, cloudy",
  isError: false
}
```

这些信息已经够后面的 Runtime 使用了。

所以历史记录可以保存 Agent 自己的 `Message`：

```text
Message
├── user
├── assistant
│   ├── text
│   └── toolCalls
└── toolResult
    ├── toolCallId
    ├── toolName
    ├── text
    └── isError
```

真正准备调用 Provider 时，再把它转换成对应的协议。

以 Anthropic adapter 为例：

```text
Message[]
    ↓
convertToLlm()
    ↓
Anthropic Message[]
    ↓
LLM
```

一条 Runtime 中的 `toolResult`：

```text
toolResult
toolCallId = call_123
text = "31°C, cloudy"
```

到了 adapter 才变成 Anthropic 的：

```text
user
└── tool_result
    └── tool_use_id = call_123
```

对应的转换代码大致是：

```ts
case "toolResult":
  pendingToolResults.push({
    type: "tool_result",
    tool_use_id: m.toolCallId ?? "",
    content: m.text ?? "",
    is_error: m.isError ?? false,
  });
  break;
```

以后如果增加 OpenAI adapter，同一条 Runtime Message 可以在另一个 adapter 中变成：

```text
function_call_output
└── call_id = call_123
```

Agent Loop 不需要跟着一起修改。

Provider 的差异到 `convertToLlm()` 为止。

普通文本阶段，我们没有为了“可能以后支持更多 Provider”提前加这一层。直到 Tool Calling 让协议开始进入 Runtime，自己的 Message 才真正有了作用。

## Pi 把转换留在 LLM call boundary

Pi 的 Agent Loop 也一直处理自己的 `AgentMessage`。

`agent-loop.ts` 里有一句很直接的注释：

> “Agent loop that works with AgentMessage throughout. Transforms to Message[] only at the LLM call boundary.”

调用模型前的路径是：

```text
AgentMessage[]
      ↓
transformContext()
      ↓
convertToLlm()
      ↓
Message[]
      ↓
LLM
```

具体 Provider 的协议继续留在后面的实现里。Agent Loop 看到的仍然是统一的 `user`、`assistant`、`toolResult` 等消息。

Chapter 00 只保留其中最小的一段：

```text
Agent Message
      ↓
Anthropic adapter
      ↓
Anthropic API
```

现在还只有 Anthropic adapter，但内部 Message 没有因此直接采用 Anthropic Message。

代码里还留了一个流式接口：

```ts
interface LLMAdapter {
  complete(
    input: LLMRequest,
    signal?: AbortSignal,
  ): AsyncIterable<AssistantMessageEvent>;
}
```

一次流式调用可能陆续产生：

```text
start
text_delta
text_delta
...
done
```

这一章只需要最终的 `AssistantMessage`，所以先消费 `done`。增量事件暂时不用往 Runtime 里继续扩展，后面真正需要观察 Agent 执行过程时再处理。

运行：

```bash
npm run demo
```

目前整条调用链仍然很短：

```text
Message[]
   ↓
convertToLlm()
   ↓
Provider
   ↓
AssistantMessage
```

普通文本回复拿回来以后，一次调用就结束了。

Tool Call 不一样。

```text
LLM
 ↓
tool call
 ↓
execute
 ↓
tool result
```

程序已经知道工具返回了什么，模型还不知道。

这条 Tool Result 还得回到下一次模型调用里。

Chapter 01 从这个问题继续。