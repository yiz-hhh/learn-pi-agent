---
title: "Chapter 07：Session Tree"
description: "到 Chapter 06，Agent 里的历史仍然是一条线性的 messages[]："
head: [["link",{"rel":"canonical","href":"https://yiz-hhh.github.io/learn-pi-agent/chapters/07-session-tree"}]]
---
# Chapter 07：Session Tree

到 Chapter 06，Agent 里的历史仍然是一条线性的 `messages[]`：

```text
U1
A1
U2
A2
U3
A3
```

只要一直沿着当前对话往后走，这个结构没有问题。

但如果用户想回到 `A1`，从那里重新开始呢？

原来的历史是：

```text
U1 → A1 → U2 → A2 → U3 → A3
```

现在希望得到另一条路径：

```text
U1 → A1 → U2'
```

最直接的办法是把 `A1` 后面的消息截掉。

这样新路径有了，但：

```text
U2 → A2 → U3 → A3
```

也一起消失。

也可以复制一份新的 `messages[]`。

不过一旦这么做，还得额外记录：

```text
这两份 history 原来从哪里分开？
哪一份是当前分支？
之后怎么切回旧分支？
```

问题已经不再只是“Agent 当前有哪些 messages”。

它开始变成“历史本身怎么保存”。

## 每条 Entry 只记住自己的父节点

Pi 的 Session 没有继续扩展 `messages[]`。

它把会话历史保存成 Entry。

每条 Entry 都带：

```ts
type Entry = {
  id: string;
  parentId: string | null;
  timestamp: string;
  type: string;
};
```

Message 只是其中一种 Entry。

后面还可以出现：

```text
model change
custom entry
compaction
...
```

先只看 Message。

普通对话：

```text
U1 → A1 → U2 → A2
```

可以保存成：

```text
U1
id = 1
parentId = null

A1
id = 2
parentId = 1

U2
id = 3
parentId = 2

A2
id = 4
parentId = 3
```

Session 再维护一个当前的 `leafId`：

```ts
private _leafId: string | null;
```

新增 Entry 时，parent 就指向当前 leaf：

```ts
const entry = {
  ...input,
  id: generateId(),
  parentId: this._leafId,
  timestamp: new Date().toISOString(),
};

this.entries.push(entry);
this.byId.set(entry.id, entry);

this._leafId = entry.id;
```

如果一直正常追加，它看起来仍然只是一条链：

```text
U1 → A1 → U2 → A2
                   ↑
                  leaf
```

真正的变化发生在 leaf 可以移动以后。

假设 Session 里已经有：

```text
U1 → A1 → U2 → A2 → U3 → A3
```

把 leaf 移回 `A1`：

```ts
branch(a1Id);
```

然后继续追加 `U2'` 和 `A2'`：

```text
U1
 │
 A1
  ├── U2 ── A2 ── U3 ── A3
  │
  └── U2' ── A2'
               ↑
              leaf
```

原来的 Entry 一个都没有被修改。

`U2'` 只是多了一条关系：

```text
parentId = A1
```

`branch()` 本身也很轻：

```ts
this._leafId = entryId;
```

它只改变“下一条历史从哪里继续”。

已有历史保持原样。

## 当前 Agent 仍然只看到一条线

Session 可以保存多个分支。

但模型每次调用仍然只接受一条线性的消息序列。

当前 leaf 在 `A2'` 时，Agent 需要的是：

```text
U1 → A1 → U2' → A2'
```

而不是整棵 Session Tree。

所以 `getBranch()` 从当前 leaf 开始，沿着 `parentId` 一直往上找到 root：

```ts
getBranch(fromId = this._leafId) {
  const path = [];

  let current = this.byId.get(fromId);

  while (current) {
    path.push(current);

    current = current.parentId
      ? this.byId.get(current.parentId)
      : undefined;
  }

  path.reverse();
  return path;
}
```

向上找时得到：

```text
A2'
 ↑
U2'
 ↑
A1
 ↑
U1
```

反转以后就是当前 active branch：

```text
U1 → A1 → U2' → A2'
```

旧分支：

```text
U2 → A2 → U3 → A3
```

仍然保存在 Session 中，只是不会进入这一次 Agent Context。

还有一层转换。

因为：

```text
SessionEntry ≠ AgentMessage
```

Session 里保存的不只有 Message。

所以恢复当前分支以后，还要把真正需要交给 Agent 的消息投影出来：

```ts
return this.getBranch()
  .filter((entry) => entry.type === "message")
  .map((entry) => entry.message);
```

于是两边的职责很清楚。

Session 保存：

```text
所有 Entry
parent relation
当前 leaf
其他历史分支
```

Agent 拿到：

```text
当前 active branch 上的 Message[]
```

Agent Loop 不需要知道：

```text
parentId
leafId
branch()
Session Tree
```

它仍然只处理一条普通的 `messages[]`。

## 为什么 Session 不进入 Agent Loop

如果直接让 Agent Runtime 自己承担历史管理，它很快就要同时处理：

```text
当前消息
历史分支
回退
恢复
持久化
当前 leaf
```

这些事情都和“会话历史”有关，但不是一次 Agent run 本身必须理解的执行语义。

Pi 把 Session 放在 Loop 外面。

恢复会话时：

```text
load session
    ↓
reconstruct active branch
    ↓
get Message[]
    ↓
restore Agent state
    ↓
run Agent
```

一次 run 结束以后，新产生的 Message 再保存为新的 Session Entry。

所以 Chapter 00–06 建起来的 Agent Loop 不需要增加 Session API。

它继续处理：

```text
AgentContext
messages
tools
model
```

Session 只负责决定：

```text
这些 messages 从哪条历史路径恢复出来
```

这也是 Chapter 06 和 Chapter 07 的区别。

Session Tree 先决定：

```text
当前是哪条 branch
```

恢复出：

```text
U1
A1
U2'
A2'
```

到了真正调用模型前，`transformContext()` 仍然可以继续决定：

```text
这四条消息里
这一轮到底发哪些给模型
```

所以执行顺序是：

```text
Session Tree
    ↓
active branch
    ↓
Message[]
    ↓
transformContext()
    ↓
current LLM input
```

Session 管历史结构。

`transformContext()` 管单次模型调用的 Context view。

它们没有被合成同一个机制。

## Session 怎样持久化

Pi coding-agent 的 v3 Session 使用 JSONL。

磁盘上仍然是一条条记录：

```text
header
entry
entry
entry
...
```

每条 Entry 自己保存：

```text
id
parentId
```

所以文件里不需要维护嵌套的 `children`。

加载以后重新建立：

```text
entries[]
byId
```

需要 active branch 时，再从 leaf 沿 `parentId` 回溯。

这种格式也适合持续追加。

新 Entry 直接写到文件末尾，不需要每次重写整棵树。

v3 还有一个和 leaf 有关的细节。

Runtime 中有：

```text
_leafId
```

但文件里没有单独保存：

```json
{"leafId": "..."}
```

重新加载时，最后一条有效 Entry 会成为当前 leaf。

因此如果只是：

```ts
branch(oldEntryId);
```

然后直接退出，并不会把这个 leaf 变化单独持久化。

如果 branch 以后继续产生新历史：

```text
branch(A1)
   ↓
append(U2')
   ↓
append(A2')
```

文件最后一条已经是 `A2'`。

下一次加载时，自然会恢复到新分支。

`resetLeaf()` 同样不会删除旧历史：

```ts
resetLeaf() {
  this._leafId = null;
}
```

之后追加的新 Entry 会得到：

```text
parentId = null
```

于是同一个 Session 中可以出现另一条 root path：

```text
U1
└─ A1
   └─ ...

U1'
└─ A1'
   └─ ...
```

旧 Entry 仍然存在。

变化的只是当前路径从哪里继续。

运行：

```bash
npm run demo
```

可以先建立：

```text
U: 12 + 30
└─ A: 42
```

然后把 leaf 移到历史位置，再继续：

```text
U: 12 + 30
└─ A: 42
   ├─ U: 原来的后续
   │  └─ ...
   │
   └─ U: 新的问题
      └─ ...
```

切换 leaf 后，`getMessages()` 只恢复当前路径。

其他分支仍然完整保存在 Session 里。

到这里，历史可以分支，也可以恢复。

但 active branch 自己仍然会不断增长。

Session 可以完整保存几百条 Entry，模型的 Context Window 却不能无限增长。

Chapter 08 从这个问题继续。
