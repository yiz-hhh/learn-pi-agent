# Chapter 08：Context Compaction

Chapter 07 已经能完整保存 Session。

现在假设 active branch 越来越长：

```text
U1
A1
Tool1
U2
A2
Tool2
...
U80
A80
```

Session Tree 可以一直保存这些 Entry。

问题出在下一次运行。

沿着 active leaf 重建 branch 时，得到的 `messages` 也会越来越长。Session 希望保留完整历史，模型却不可能永远接收全部内容。

最直接的办法是：

```ts
messages = compact(messages);
```

当前 Context 的确变短了。

但这次压缩只存在于内存里。

程序重启以后，Session 仍然会把旧 branch 完整恢复出来；切到别的 branch 时，也不知道哪一份 summary 应该生效。

所以长会话压缩如果要真正成为 Session 的一部分，就不能只改一份临时 `Message[]`。

## Compaction 也保存成 Entry

Pi 在压缩完成以后，不会删除旧 Entry。

它会在当前 branch 上追加一条新的 `CompactionEntry`：

```ts
type CompactionEntry = {
  type: "compaction";

  id: string;
  parentId: string | null;
  timestamp: string;

  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
};
```

假设当前 branch 是：

```text
U1 → A1 → T1 → U2 → A2 → U3 → A3
```

执行一次 Compaction 以后，原来的 Entry 全都还在：

```text
U1 → A1 → T1 → U2 → A2 → U3 → A3 → C
```

`C` 就是这次 `CompactionEntry`。

它和其他 Entry 一样有：

```text
id
parentId
timestamp
```

也会成为新的 leaf。

Session 本身并没有因此变短。

真正新增的是一条记录：

```text
从这里往后重建 Context 时，
前面一段历史可以用 summary 代替。
```

假设：

```text
U1 → A1 → T1 → U2 → A2
```

被压进 summary，而：

```text
U3 → A3
```

继续保留原文。

那么 `CompactionEntry` 会保存：

```text
summary = "前面的会话完成了……"

firstKeptEntryId = U3.id
```

`firstKeptEntryId` 指向的是：

```text
第一个继续保留原文的 Entry
```

不是最后一个被 summary 覆盖的 Entry。

后面继续产生历史：

```text
U1 → A1 → T1 → U2 → A2 → U3 → A3 → C → U4 → A4
```

Session 里仍然没有任何 Entry 被删除。

短 Context 出现在下一步。

## 重建当前 Context 时才应用 Compaction

Chapter 07 会先沿 active leaf 找到当前 path。

没有 Compaction 时，Message Entry 可以直接投影成 `Message[]`。

如果 active path 上已经出现 `CompactionEntry`，reconstruction 会找到当前路径上最近的一次 Compaction。

假设完整路径是：

```text
U1
A1
T1
U2
A2
U3
A3
C
U4
A4
```

其中：

```text
C.summary = "前面的会话完成了……"
C.firstKeptEntryId = U3
```

重建以后，Agent 不再拿到：

```text
U1
A1
T1
U2
A2
U3
A3
U4
A4
```

而是：

```text
Compaction Summary
U3
A3
U4
A4
```

被压缩掉的 `U1 ~ A2` 仍然存在于 Session 文件中。

只是当前 Context reconstruction 不再把这些 Entry 逐条投影给 Agent。

这里没有第二份：

```text
compacted-session.json
```

也没有把原 Session 改写成摘要后的版本。

Session Tree 继续保存完整历史。

短 Context 只是从这棵树里重新构造出来的工作视图。

这点很重要，因为 branch、恢复、持久化都可以继续沿用 Chapter 07 的结构，不需要为了 Compaction 再维护一套平行状态。

## retained tail 不能从任意位置开始

`firstKeptEntryId` 也不能只按 token 数随便选。

例如 history 里有：

```text
assistant(toolCall)
toolResult
user
assistant
```

如果 cut point 落在：

```text
toolResult
```

那么 retained tail 会变成：

```text
toolResult
user
assistant
```

对应的 Tool Call 已经被 summary 覆盖了。

下一次发送给 Provider 时，这条 Tool Result 就失去了前置调用。

Chapter 06 已经遇到过同一个约束：

```text
Context 可以变短
```

但不能把 Tool Call / Tool Result 的协议关系切坏。

所以 cut point 除了满足 token budget，还必须落在一个安全边界。

例如可以从：

```text
user
```

开始。

或者完整保留：

```text
assistant(toolCall)
toolResult
```

但不能只留下其中的 `toolResult`。

最终写入 Session 的也不是：

```text
array index = 37
```

而是稳定的：

```text
firstKeptEntryId
```

程序重启、重新加载 JSONL 以后，仍然可以用 Entry id 找到 retained tail 的起点。

## Compaction 只属于经过它的 branch

`CompactionEntry` 本身就是 Session Tree 上的一个节点。

因此它天然只影响经过这个节点的路径。

假设：

```text
A → B → C → D → E → C1 → F → G
```

`C1` 是一次 Compaction。

当前 leaf 在 `G` 时，active path 会经过 `C1`。

所以 reconstruction 使用：

```text
C1 summary
+
retained tail
+
later messages
```

但如果后来从更早的 `C` 分出新 branch：

```text
A → B → C → X → Y
```

这条路径根本没有经过 `C1`。

重建 `Y` 时，也就不会使用这次 summary。

不需要额外维护：

```text
session.compacted = true
```

因为“是否发生过 Compaction”不是 Session 的全局属性。

它只是某条历史路径上的一个 Entry。

长会话之后还可以继续出现第二次：

```text
...
C1
...
C2
...
```

旧的 `C1` 仍然留在树中。

如果当前 active path 已经经过 `C2`，reconstruction 使用最近的 Compaction：

```text
C2 summary
retained tail after C2
later messages
```

不需要修改或删除 `C1`。

这也是把 Compaction 放进 Session Tree 后得到的一个直接结果：

branch-local semantics 不需要再额外设计。

它沿用了 `parentId` 已经表达出来的路径关系。

## Compaction 和 `transformContext()` 处理不同层次

Compaction 成功以后，不需要等程序重启才生效。

新的 `CompactionEntry` 写入 Session 后，可以立刻重新构造当前 Context：

```ts
const result = await compactSession(...);

if (result) {
  agent.replaceMessages(result.context);
}
```

下一次 `prompt()` 就从：

```text
summary
retained tail
```

继续。

这里也能看出 Chapter 06 和 Chapter 08 的区别。

`transformContext()` 处理的是：

```text
已经有当前 Agent Context
        ↓
这一次 LLM call 实际发送什么
```

Compaction 处理的是：

```text
完整 Session branch
        ↓
怎样重建出更短的 canonical messages
```

所以顺序是：

```text
Session Tree
    ↓
apply latest CompactionEntry
    ↓
canonical Agent messages
    ↓
transformContext()
    ↓
current LLM input
```

Compaction 不替代 `transformContext()`。

`transformContext()` 也不负责持久化 Compaction。

Pi 在这里仍然没有让 Agent Loop 认识：

```text
summary format
token threshold
retained tail policy
branch compaction state
```

Loop 最后拿到的仍然只是新的 `messages`。

长会话的历史语义继续留在 Session 这一层。

运行：

```bash
npm run demo
```

Compaction 前，Session 可能有 7 条 Entry：

```text
U1
A1
T1
U2
A2
U3
A3
```

执行以后，Session 反而变成 8 条，因为只是多了一条 `CompactionEntry`。

但重建出来的 Context 会缩短成：

```text
Compaction Summary
U3
A3
```

继续对话以后，新消息从这份 canonical Context 往下工作。

原始历史仍然完整保存在 Session Tree 中。

到这里，Session 可以同时保留：

```text
完整历史
```

和：

```text
有限的工作 Context
```

接下来还有另一种复杂度。

不同项目会有自己的领域说明、操作流程和可按需读取的知识。

如果每加入一类知识都继续修改 Harness，本身很快又会开始膨胀。

Chapter 09 从这个问题继续。
