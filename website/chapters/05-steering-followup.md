---
title: "Chapter 05：Steering & Follow-up"
description: "模型已经返回三个 Tool Call，当前 batch 正在执行。"
head: [["link",{"rel":"canonical","href":"https://yiz-hhh.github.io/learn-pi-agent/chapters/05-steering-followup"}]]
---
# Chapter 05：Steering & Follow-up

用户先发来：

```text
查一下 A、B、C
```

模型已经返回三个 Tool Call，当前 batch 正在执行。

这时用户又补了一句：

```text
B 不用查了，改查 D
```

这条消息什么时候交给模型？

如果现在就插进当前 turn，问题会立刻变多：

```text
已经开始执行的 Tool 要不要取消？

正在生成的 Assistant Message 怎么处理？

当前 history 应该从哪里发生变化？
```

Pi 没有让新消息去抢占当前 turn。

已经开始的 Tool Call 继续执行，结果正常写回 history。

等这一轮结束以后，新消息再参与下一次 LLM 调用。

## Steering 只改变下一轮

假设当前 Assistant Message 已经请求：

```text
toolCall A
toolCall B
toolCall C
```

Steering 在这三个 Tool 执行期间到达。

当前 turn 仍然完整走完：

```text
assistant
    ↓
tool batch
    ↓
tool results
    ↓
turn_end
    ↓
check steering
    ↓
next turn
```

所以 history 最后会先变成：

```text
user:
查一下 A、B、C

assistant:
  toolCall A
  toolCall B
  toolCall C

toolResult A
toolResult B
toolResult C
```

然后才追加新的 user message：

```text
user:
B 不用查了，改查 D
```

下一次模型调用会同时看到：

```text
上一轮已经发生的结果
+
用户刚刚补充的新要求
```

Steering 改变的是下一次 LLM 调用的输入。

它不会撤回已经生成的 Assistant Message，也不会取消已经开始的 Tool execution。

原来的 Loop 只有一种继续执行的理由：

```ts
while (hasMoreToolCalls) {
  ...
}
```

加入 Steering 后，又多了一种：

```ts
while (
  hasMoreToolCalls ||
  pendingMessages.length > 0
) {
  ...
}
```

每个 turn 完整结束以后，再读取一次 Steering：

```ts
pendingMessages =
  (await config.getSteeringMessages?.()) ?? [];
```

如果没有新消息，Loop 按原来的条件退出。

如果有，就在下一轮开始时把它们写进 history：

```ts
for (const message of pendingMessages) {
  await emit({
    type: "message_start",
    message: { ...message },
  });

  await emit({
    type: "message_end",
    message: { ...message },
  });

  context.messages.push(message);
  newMessages.push(message);
}

pendingMessages = [];
```

这里没有专门的：

```text
role: steering
```

模型最终看到的仍然是一条普通 user message。

所谓 Steering，只描述这条消息是在 run 的哪个时间点进入 Loop。

## Follow-up 出现在更晚的位置

还有另一种情况。

模型已经完成回答：

```text
assistant:
任务已经完成。
```

当前没有 Tool Call，也没有等待处理的 Steering。

按照内层 Loop 的条件，这次 run 已经可以结束。

就在这个时候，用户又发来：

```text
再帮我总结成三点
```

这条消息来得比 Steering 更晚。

如果只在每个 turn 结束后检查消息，这时候已经错过了检查点。

所以正常结束之前，还需要再看一次：

```ts
const followUpMessages =
  (await config.getFollowUpMessages?.()) ?? [];

if (followUpMessages.length > 0) {
  pendingMessages = followUpMessages;
  continue;
}

break;
```

没有 Follow-up：

```text
current task finished
        ↓
follow-up = []
        ↓
agent_end
```

有 Follow-up：

```text
current task finished
        ↓
follow-up exists
        ↓
pendingMessages = follow-up
        ↓
next turn
```

Follow-up 进入 history 的方式和 Steering 没有区别。

最终还是：

```text
user message
```

区别只在检查位置。

Steering：

```text
turn_end
    ↓
check steering
    ↓
continue current run
```

Follow-up：

```text
inner loop would stop
    ↓
check follow-up
    ↓
continue instead of agent_end
```

这两个入口如果强行合成一个随时读取的 `getPendingMessages()`，时序就会变得模糊。

每个 turn 都读取，原本应该等到 run 即将结束的 Follow-up 会提前进入。

只在最后读取，Steering 又无法及时影响下一次 LLM 调用。

这里真正需要保留的是两个不同的 checkpoint。

## Pi 里的双层循环

有了这两个检查点，Loop 自然多出一层：

```ts
pendingMessages =
  await getSteeringMessages();

while (true) {

  while (
    hasMoreToolCalls ||
    pendingMessages.length > 0
  ) {

    // inject pending messages
    // call LLM
    // execute tools
    // turn_end

    pendingMessages =
      await getSteeringMessages();
  }

  const followUpMessages =
    await getFollowUpMessages();

  if (followUpMessages.length > 0) {
    pendingMessages = followUpMessages;
    continue;
  }

  break;
}

agent_end
```

内层循环处理当前正在推进的任务。

每个 turn 结束以后，Steering 可以让下一轮继续。

当内层已经没有 Tool Call，也没有待处理 Steering 时，外层再检查 Follow-up。

只有这里也没有新消息，才真正发出 `agent_end`。

还有一个边界没有改变。

如果 Assistant Message 以：

```text
error
aborted
```

结束，当前 run 直接终止。

这时不会再查询 Steering 或 Follow-up。

Follow-up 能接住一次正常准备结束的 run，但不会把一个已经 abort 的 run 重新启动。

运行：

```bash
npm run demo
```

第一条消息可以在一个完整 turn 结束以后进入：

```text
turn 1
  user: 请计算 12 + 30
  calculator → 42
turn_end

steering:
  顺便把 hello 回显给我

turn 2
  user: 顺便把 hello 回显给我
  echo → hello
```

另一条则发生在 run 原本已经准备结束的时候：

```text
assistant final response
    ↓
no tool call
no steering
    ↓
follow-up:
  再算一下 100 - 40
    ↓
new turn
```

两条消息最后都只是普通 user message。

它们对 Loop 的影响来自进入时间。

到这里，一次 run 的输入已经不再只由启动时那批 messages 决定。

下一次调用模型之前，Runtime 还可以对已经积累起来的 Context 做什么处理？

Chapter 06 从这个问题继续。
