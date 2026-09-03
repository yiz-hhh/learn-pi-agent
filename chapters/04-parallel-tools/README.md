# Chapter 04：Parallel Tool Execution

Chapter 03 以后，一次 Tool Call 已经有了完整的执行路径。

但同一轮里出现多个 Tool Call 时，目前还是一个接一个执行。

假设模型一次返回三个互不依赖的调用：

```text
A = 300ms
B = 50ms
C = 150ms
```

串行执行时：

```text
A  ─────────────── 300ms
                   B ── 50ms
                        C ─────── 150ms

total ≈ 500ms
```

B 和 C 并不依赖 A，却因为排在后面一直等待。

最直接的想法是：

```ts
await Promise.all(
  toolCalls.map((call) =>
    executeToolCall(call),
  ),
);
```

但 Chapter 03 的 `executeToolCall()` 已经不只是调用一个函数。

## 并发只发生在 execute 阶段

一次 Tool Call 真正执行前还会经过：

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

如果把整条路径直接扔进 `Promise.all()`，前面的 prepare 阶段也会一起并发。

这不一定合适。

`beforeToolCall` 可能需要做权限判断，也可能等待用户确认。多个 Tool Call 同时进入这里，会让这些外部交互一起发生。

Pi 的 parallel path 把这条链拆成两段。

先按模型给出的顺序 prepare：

```text
prepare A
prepare B
prepare C
```

然后只把准备成功的调用放到并发执行阶段：

```text
execute A ───────────────
execute B ──
execute C ───────
```

因此并发从 `execute` 开始。

前面的：

```text
lookup
prepare
validate
beforeToolCall
```

仍然保持 source order。

prepare 失败的调用也不能从 batch 中消失。

假设模型返回：

```text
A  B  C
```

其中 B 请求了一个不存在的 Tool。

B 在 prepare 阶段已经得到错误结果：

```text
B
↓
lookup
↓
not found
↓
error result
```

真正进入并发执行的只有 A 和 C。

但这一批仍然保留原来的三个位置：

```text
0 → execute A
1 → immediate error B
2 → execute C
```

等整个 batch 结束以后，B 的错误结果仍然要回到第二个位置。

## 并发以后出现了两种顺序

还是同一个 batch：

```text
source order:

A → B → C
```

假设执行时间是：

```text
A = 300ms
B = 50ms
C = 150ms
```

如果三个 Tool 同时开始，实际完成顺序会是：

```text
B → C → A
```

`tool_execution_end` 应该跟着真实执行过程发生：

```text
end B
end C
end A
```

B 已经结束了，就没有必要为了等 A 而延迟它的事件。

UI、日志和 tracing 关心的是“现在发生了什么”。

所以 execution event 保持 completion order。

消息历史是另一回事。

如果 Tool Result 也按照完成速度写入：

```text
toolResult B
toolResult C
toolResult A
```

那么同一个 assistant message：

```text
assistant
├── toolCall A
├── toolCall B
└── toolCall C
```

在不同机器、不同负载下，可能留下不同顺序的 history。

这里没有这个必要。

模型原来按照：

```text
A → B → C
```

发出了 Tool Call，结果写回时继续保持：

```text
toolResult A
toolResult B
toolResult C
```

于是 parallel batch 里同时存在两种顺序：

```text
execution events
B → C → A

message history
A → B → C
```

前一个记录实际完成时间。

后一个保持模型原始 Tool Call 的排列。

这两个顺序本来就服务于不同目的。

实现上仍然可以使用 `Promise.all()`。

它返回的结果会保持输入 Promise 的位置，所以所有调用 settle 以后，可以重新按 source index 提交结果：

```ts
const outcomes = await Promise.all(
  entries.map((entry) => execute(entry)),
);

for (let i = 0; i < entries.length; i++) {
  // commit Tool Result in source order
}
```

而 `tool_execution_end` 在每个执行真正结束时立即发送，自然就是 completion order。

## Pi 的 parallel batch

Pi 的 `executeToolCallsParallel` 也是这套结构。

前半段按顺序 prepare：

```text
tool calls
    ↓
prepare A
prepare B
prepare C
```

准备完成以后，再并发执行：

```text
execute A ─────────
execute B ──
execute C ─────
```

等 batch settle 后，结果按照原来的 Tool Call 顺序写回。prepare 阶段已经失败的调用也会继续占据原来的位置。

Pi 同时保留了 sequential path。

如果全局配置要求串行，或者这一批中有任意 Tool 声明自己必须 sequential，这一批就不进入 parallel path：

```text
A → B → C
```

Tool Runtime 不需要换一套实现。

batch 只是在开始之前决定：

```text
sequential
```

还是：

```text
parallel execute
```

## `terminate` 不负责取消并发任务

Chapter 03 里已经有：

```ts
terminate: true
```

到了并发执行以后，这个字段仍然只是某个 Tool 的结果。

假设 B 最先结束：

```text
B
↓
terminate = true
```

A 和 C 不会因此被立即取消。

Runtime 会继续等待当前 batch 完成。

等所有结果都 settle 后，再判断：

```ts
outcomes.every(
  (outcome) =>
    outcome.terminate === true,
)
```

只有：

```text
A  true
B  true
C  true

→ stop
```

才会结束后续 Loop。

如果是：

```text
A  true
B  false
C  true

→ continue
```

就继续下一轮。

`terminate` 表达的是 Tool Result 对后续 Loop 的建议。

中途取消正在执行的 Tool，仍然属于 `AbortSignal` 这一类控制。

运行：

```bash
npm run demo
```

当模型在同一轮生成多个 Tool Call 时，可以看到执行发生重叠：

```text
start A
start B
start C

end B
end C
end A
```

而写回 history 的 Tool Result 仍然是：

```text
A
B
C
```

到这里，一轮里的多个 Tool Call 已经可以一起执行。

但 Loop 只会处理这一轮开始时已经进入 context 的消息。

如果 Tool 还在执行，用户又发来新的输入，当前 Loop 不会因此改变正在进行的这一轮。

Chapter 05 从这个问题继续。
