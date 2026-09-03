# Chapter 02：Agent Runtime

Chapter 01 的调用方式还是：

```ts
const messages = await agentLoop(...);
```

只要 `agentLoop()` 没有返回，外面就不知道里面发生到了哪一步。

一次任务可能已经走过：

```text
第一次 LLM 调用
        ↓
    Tool Call
        ↓
     Tool 执行
        ↓
    Tool Result
        ↓
第二次 LLM 调用
```

如果其中某个 Tool 跑了十几秒，调用方看到的仍然只是一个没有结束的 Promise。

Chapter 00 的 LLMAdapter 已经在持续产生流式事件：

```text
start
text_delta
text_delta
...
done
```

Chapter 01 只取了最后的 `done`。

现在需要把 Agent Loop 自己的执行过程也暴露出来。

## 把 Loop 的过程变成事件

最简单的办法是继续往 `agentLoop()` 里加 callback：

```ts
agentLoop({
  onTextDelta(delta) {
    render(delta);
  },
});
```

只显示模型文本时，这样没什么问题。

但 Tool-driven Loop 里还有很多别的时间点：

```text
一次 run 开始

一轮 LLM 调用开始

一条 assistant message 开始生成

一条 message 更新

Tool Result 写入 history

这一轮结束

整个 run 结束
```

如果 UI、日志、Tracing 各自需要一套 callback，Loop 很快就会开始知道这些消费者分别需要什么。

Pi 把运行中的这些状态变化统一成 `AgentEvent`。

Chapter 02 先用最基础的几种：

```text
agent_start
agent_end

turn_start
turn_end

message_start
message_update
message_end
```

一次包含 Tool Call 的运行大致会产生：

```text
agent_start

turn_start

message_start(user)
message_end(user)

message_start(assistant)
message_update(assistant)
message_update(assistant)
message_end(assistant)

message_start(toolResult)
message_end(toolResult)

turn_end

turn_start

message_start(assistant)
message_update(assistant)
message_end(assistant)

turn_end

agent_end
```

`turn` 对应 Loop 的一轮。

模型返回 Tool Call 后，Tool 执行和对应的 Tool Result 仍然属于这一轮。结果写回 history 以后，下一次 LLM 调用才进入新的 turn。

原来的控制流没有变化：

```text
LLM
 ↓
assistant
 ↓
tool
 ↓
toolResult
 ↓
LLM
```

只是原来藏在函数内部的几个时间点，现在会进入 `EventStream`。

调用方可以直接消费：

```ts
const stream = agentLoop(...);

for await (const event of stream) {
  console.log(event);
}
```

UI、日志和 Tracing 看到的是同一条 Runtime event stream。Agent Loop 不需要分别维护三套通知方式。

Tool 自己什么时候开始执行、什么时候更新进度、什么时候结束，先不放到这一章。Chapter 03 会在 Tool Runtime 成形以后补上这些事件。

## `message_update` 表示当前消息状态

`message_start` 和 `message_end` 很直接。

比较容易出问题的是 `message_update`。

假设模型依次生成：

```text
"12"
" + 30"
" = 42"
```

一种做法是只往外发原始 delta：

```text
message_update("12")
message_update(" + 30")
message_update(" = 42")
```

这样消费者必须自己维护：

```ts
text += delta;
```

只有文本时还算简单。

Assistant Message 里还可能同时出现 Tool Call：

```text
assistant
├── text
└── toolCall
    ├── name
    └── arguments
```

Tool Call 的参数也可能处于生成中的状态。

如果 Runtime 只往外丢字符片段，那么每一个消费者都要重新拼出“这条 Assistant Message 现在长什么样”。

Pi 的 LLM stream 已经在事件里带着当前 `partial` Assistant Message。

Runtime 收到更新后，直接用最新 partial 替换 context 中正在生成的 assistant：

```ts
partialMessage = event.partial;

context.messages[
  context.messages.length - 1
] = partialMessage;
```

然后把当前状态发出去：

```ts
await emit({
  type: "message_update",
  message: { ...partialMessage },
  assistantMessageEvent: event,
});
```

所以消费者拿到的是：

```text
message_update
└── "12"

message_update
└── "12 + 30"

message_update
└── "12 + 30 = 42"
```

而不是三段互相依赖的字符增量。

漏掉中间一次更新也不会影响后面的状态，因为下一次事件仍然带着当前完整 partial。

正在形成的 Tool Call 也按同样的方式处理。

这里还有一个执行上的边界。

Assistant Message 出现 Tool Call，不代表它一定可以执行。

如果模型因为 token limit 在中途结束：

```text
write_file({
  path: "config.json",
  content: "...
```

Runtime 里可能已经形成了一个不完整的 Tool Call。

Pi 会看 Assistant Message 的 `stopReason`。

正常结束或正常产生 Tool Call时，继续原来的流程。

如果是：

```text
error
aborted
```

当前 run 直接结束。

如果是：

```text
length
```

已经生成出来的 Tool Call 不会直接执行，而是转成失败的 Tool Result：

```text
assistant
stopReason = length
      ↓
不执行 Tool Call
      ↓
toolResult(isError = true)
      ↓
history
      ↓
下一轮 LLM
```

模型下一轮可以根据失败原因重新生成一次完整调用。

Runtime 可以保存一条尚未正常结束的 partial Assistant Message；真正执行 Tool Call 还要等这条消息以可执行的状态完成。

## `agent_end` 收口一次运行

`agentLoop()` 现在返回的是 `EventStream`。

创建 stream 时，`agent_end` 被指定为完成事件：

```ts
const stream = new EventStream<AgentEvent, Message[]>(
  (event) => event.type === "agent_end",
  (event) =>
    event.type === "agent_end"
      ? event.messages
      : [],
);
```

同一次运行因此有两种消费方式。

持续读取事件：

```ts
for await (const event of stream) {
  // render / logging / tracing
}
```

或者只等待最终结果：

```ts
const messages = await stream.result();
```

`agent_end` 发出以后，事件流结束，`result()` 得到这次 run 新产生的消息。

这里不是完整 history。

假设进入 Loop 前已经有：

```text
A
B
```

本次运行新增：

```text
C  user
D  assistant
E  toolResult
F  assistant
```

最终返回的是：

```text
C
D
E
F
```

原来的 `A B` 仍然由调用方持有。

Agent Loop 只报告这次 run 产生了什么。完整历史以后怎样保存、怎样恢复，还不是这一层要处理的问题。

Pi 的 Agent Runtime 也是沿着这条边界工作：Loop 在运行中持续发 `AgentEvent`，结束时再通过 `agent_end` 返回本次新增消息。

运行：

```bash
npm run demo
```

可以看到类似：

```text
== agent_start

-- turn_start

   user: 请计算 12 + 30 等于多少？

   assistant: calculator(...)

   toolResult: 42

-- turn_end

-- turn_start

   assistant: 12
   assistant: 12 + 30
   assistant: 12 + 30 = 42

-- turn_end

== agent_end
```

Chapter 01 的 Tool Loop 没有换掉。

现在只是可以从外面看到它正在做什么。

不过 Tool 执行本身还是一句：

```ts
await tool.execute(...)
```

参数什么时候校验、执行前能不能拦截、长时间运行的 Tool 怎样报告进度，这些问题还留在里面。

Chapter 03 从这个问题继续。
