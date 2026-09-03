---
title: "Chapter 06：Context Transformation"
description: "一次 Agent run 持续得越久，context.messages 就会越长。"
head: [["link",{"rel":"canonical","href":"https://yiz-hhh.github.io/learn-pi-agent/chapters/06-context-transform"}]]
---
# Chapter 06：Context Transformation

一次 Agent run 持续得越久，`context.messages` 就会越长。

例如：

```text
U1
A1
Tool1
U2
A2
Tool2
U3
```

这些消息都已经发生过。

后面可能还要用它们恢复 Session、排查执行过程，或者继续从当前状态往下走。

但下一次调用模型时，未必还需要把全部 history 都发送出去。

最直接的办法是：

```ts
context.messages =
  context.messages.slice(-2);
```

模型输入确实变短了。

代价也很直接：Runtime 自己保存的历史一起被裁掉了。

如果我们只是想改变这一轮模型看到的内容，就不应该顺手改掉已经发生过的 history。

## Runtime history 和 LLM input 是两回事

Pi 在真正调用模型之前，先取出当前 messages：

```ts
let messages = context.messages;

if (config.transformContext) {
  messages = await config.transformContext(
    messages,
    signal,
  );
}
```

后面的 LLM 调用使用局部变量 `messages`。

例如：

```ts
transformContext: async (messages) => {
  return messages.slice(-2);
}
```

假设 Runtime 原本保存：

```text
U1
A1
Tool1
U2
A2
Tool2
U3
```

这一轮模型只会收到：

```text
Tool2
U3
```

但 `context.messages` 仍然是：

```text
U1
A1
Tool1
U2
A2
Tool2
U3
```

模型生成新的 Assistant Message 以后，也会继续追加到这份完整 history。

所以这里有两份用途不同的数据：

```text
context.messages
→ Runtime 当前保存的历史

transformContext(...) 的返回值
→ 这一轮 LLM call 的输入
```

它们没有必要始终相同。

这层处理发生在 LLM call boundary 上。

Chapter 00 已经在这里处理过另一件事：

```text
Agent Message
    ↓
Provider Message
```

现在调用顺序变成：

```text
Runtime history
      ↓
transformContext()
      ↓
current LLM context
      ↓
convertToLlm()
      ↓
Provider messages
```

一条 `toolResult` 在 `transformContext()` 阶段仍然是 Agent Message。

真正进入 `convertToLlm()` 以后，才会变成 Anthropic 的 `tool_result`、OpenAI 的 `function_call_output` 等 Provider 表示。

Context policy 和 Provider protocol 因此停在两个不同的边界。

## `transformContext()` 不拥有 history

这里有一个容易踩坑的地方。

Pi 传给 `transformContext()` 的是 `context.messages` 原始数组引用。

所以：

```ts
transformContext: async (messages) => {
  return messages.slice(-2);
}
```

不会修改原 history，因为 `slice()` 返回了新数组。

但：

```ts
transformContext: async (messages) => {
  messages.splice(0, 3);
  return messages;
}
```

会直接改掉 `context.messages`。

Pi 没有在调用 Hook 之前复制或 freeze 这份数组。

因此这里真正成立的保证是：

> Runtime 不会因为 `transformContext()` 返回了一份新 messages，就自动用它替换 `context.messages`。

Hook 自己如果原地修改输入，仍然能够改变 Runtime history。

如果目标只是生成这一轮的模型输入，就应该返回一份新的数组。

还有一个问题也不能被 `slice(-n)` 掩盖。

消息之间可能存在协议关系：

```text
assistant(toolCall)
toolResult
```

如果窗口恰好从 `toolResult` 开始：

```text
toolResult
user
assistant
```

最后送给 Provider 的上下文可能已经失去合法的 Tool Call / Tool Result 对应关系。

所以：

```ts
messages.slice(-n)
```

只适合演示“Runtime history 和当前 LLM context 可以不同”。

真正的 Context 策略还要理解消息边界。

## 为什么不直接让 Loop 管 Context 策略

Context 处理很容易继续长出更多规则。

有人只想保留最近几轮：

```ts
return messages.slice(-n);
```

有人需要过滤内部消息。

有人希望在调用模型之前临时加入项目背景。

长会话还可能需要做 Compaction。

这些策略都发生在同一个位置：

```text
Runtime 已经拥有 history
        ↓
准备调用 LLM
```

但具体策略并不稳定。

如果 Agent Loop 自己开始认识：

```text
sliding window
summary
project context
message filtering
compaction
```

每增加一种 Context policy，Loop 都要继续变化。

Pi 在这里保留的是一个介入点：

```ts
transformContext(messages)
```

至于这一轮到底删什么、加什么、保留多少，留给调用方决定。

这里开始能看到 Pi 对 Core 边界的一种选择。

Loop 需要知道“调用模型之前可以准备 Context”。

它不需要知道“Context 应该怎样准备”。

后面真正做长会话 Compaction 时，我们会再碰到这个边界。

## Turn 结束后还有另一种修改

`transformContext()` 只改变当前 LLM call 的视图。

如果下一轮 Runtime 本身就需要换一份状态，Pi 还有另一个入口：

```ts
prepareNextTurn
```

它可以返回：

```ts
return {
  context: nextContext,
  model: nextModel,
};
```

Runtime 会真正更新：

```ts
currentContext =
  nextTurn.context ?? currentContext;
```

从下一轮开始，Steering、模型调用和 Tool execution 都会基于新的 `currentContext`。

所以这两个 Hook 处理的是不同层次的问题。

`transformContext()`：

```text
当前 Runtime history
        ↓
这一轮模型看什么
```

`prepareNextTurn()`：

```text
当前 turn 已结束
        ↓
下一轮 Runtime 从什么状态继续
```

前者只生成一次调用视图。

后者可以真正替换 Runtime state。

Pi 在 turn 结束后的顺序是：

```text
turn_end
prepareNextTurn
shouldStopAfterTurn
getSteeringMessages
```

也就是说，先更新下一轮状态，再决定 run 是否继续。

如果：

```ts
shouldStopAfterTurn(...) === true
```

当前 run 直接结束，不再继续读取 Steering 或 Follow-up。

否则才回到 Chapter 05 的消息处理逻辑。

运行：

```bash
npm run demo
```

可以看到：

```text
Runtime history: 3 messages
LLM input:       1 message
```

模型没有看到的旧消息仍然留在 Runtime history 中。

到这里，Agent 已经开始区分：

```text
发生过什么
```

和：

```text
这一轮模型需要看到什么
```

但 `context.messages` 仍然是一条线性的数组。

如果 run 结束以后还要恢复旧会话，或者从某条历史记录处分出新的执行路径，仅靠这条数组就不够了。

Chapter 07 从这个问题继续。
