---
title: "Chapter 09：Skills"
description: "到 Chapter 08，Session 和 Context 已经能长期运行。"
head: [["link",{"rel":"canonical","href":"https://yiz-hhh.github.io/learn-pi-agent/chapters/09-skills"}]]
---
# Chapter 09：Skills

到 Chapter 08，Session 和 Context 已经能长期运行。

但 Agent 遇到某类问题时应该怎么做，很多时候还写在程序里。

假设现在做一个数据库排障 Agent，希望告诉它：

```text
遇到连接问题先检查实例状态
慢 SQL 先看执行计划
出现阻塞时再检查锁等待
证据不足时不要直接判断根因
```

最直接的办法是继续修改 `systemPrompt`。

一个项目当然没问题。

但如果 Agent 后面还要处理：

```text
database debugging
payment debugging
deployment debugging
code review
...
```

把所有规则正文都拼进 Prompt，很快会变成：

```text
database debugging 全文

payment debugging 全文

deployment debugging 全文

code review 全文

...
```

而用户这一次可能只问：

```text
数据库连接一直超时，帮我排查一下
```

模型没有必要每次都重新读取所有领域说明。

## 先让模型知道有哪些 Skill

把数据库排障说明放进一个文件：

```text
database-debugging/SKILL.md
```

例如：

```markdown
---
name: database-debugging
description: 排查数据库连接、慢查询与锁等待问题
---

排查数据库问题时：

1. 先确认连接与实例状态；
2. 再检查慢 SQL；
3. 最后检查锁等待与事务阻塞；
4. 不要在缺少证据时直接判断根因。
```

启动 Agent 时，当然可以直接读取整个文件。

Pi 没这么做。

进入 system prompt 的只有 Skill metadata：

```text
name
description
location
```

例如：

```text
database-debugging

排查数据库连接、慢查询与锁等待问题

/project/skills/database-debugging/SKILL.md
```

最终 Prompt 中可以出现：

```xml
<available_skills>
  <skill>
    <name>database-debugging</name>
    <description>
      排查数据库连接、慢查询与锁等待问题
    </description>
    <location>
      /project/skills/database-debugging/SKILL.md
    </location>
  </skill>
</available_skills>
```

这里没有 Skill 正文。

模型先知道：

```text
有哪些 Skill
各自处理什么问题
正文在哪里
```

Skill 在启动阶段已经被发现。

真正延迟的是正文进入 Context 的时间。

## 正文需要时再读

现在用户问：

```text
数据库连接一直超时，帮我排查一下
```

模型看到 catalog 后，可以判断：

```text
database-debugging
```

和当前任务有关。

然后调用已经存在的 `read` 工具：

```text
read(
  /project/skills/database-debugging/SKILL.md
)
```

正文作为普通 Tool Result 回到当前 run：

```text
先确认连接与实例状态
再检查慢 SQL
最后检查锁等待
...
```

接下来 Agent 继续使用已有工具排查。

整条过程仍然是：

```text
system prompt
└── database-debugging metadata

user
└── 数据库连接一直超时

assistant
└── read(SKILL.md)

toolResult
└── Skill 正文

assistant
└── 根据 Skill 继续调用已有工具
```

Agent Loop 没有增加：

```text
loadSkill()
executeSkill()
```

Skill 本身也没有：

```ts
execute()
```

它提供的是任务相关的说明和流程。

真正执行操作的仍然是 Tool。

例如 Skill 可以写：

```text
先使用 sql 工具检查慢查询，
再使用 shell 工具确认实例状态。
```

这里的 `sql` 和 `shell` 仍然按照 Chapter 03 建立的 Tool Runtime 执行。

Skill 正文只是通过已有的 `read → ToolResult → Message` 路径进入 Agent。

## Skill 不跟着 Session 一起保存

Skill 文件来自当前项目环境。

发现：

```text
database-debugging
```

不会在 Session Tree 里新增：

```text
SkillEntry
```

重新打开旧 Session 时，Harness 会重新从当前环境发现 Skill。

所以这两部分数据有不同来源：

```text
Skill catalog
→ 当前项目环境

Session
→ 已经发生过的对话和执行历史
```

这也影响 Compaction。

Skill catalog 可以在每次构造 system prompt 时重新生成。

Chapter 08 的 Session Compaction 不需要保存或摘要它。

但模型真正读取 Skill 文件以后：

```text
read(SKILL.md)
    ↓
toolResult
```

这条 Tool Result 已经属于当前 run。

它会像普通工具结果一样进入 Session，以后也可能被 Compaction 摘要。

所以：

```text
Skill file
```

长期留在 Session 外。

而：

```text
本次运行实际读取到的 Skill 内容
```

会成为执行历史的一部分。

这里继续沿用了前面已经存在的边界。

Session 不需要理解 Skill。

Compaction 不需要理解 Skill。

Agent Loop 也不需要理解 Skill。

它们看到的仍然只是已经存在的 Message 和 Tool Result。

## 新能力先尝试沿已有边界进入

Skill 是这一章最完整的例子。

Pi 里还有一些更小的扩展位置，也能说明同一件事。

例如应用可能需要一条只给 UI 使用的内部消息：

```text
U1
A1
PROGRESS
U2
```

`PROGRESS` 对 Runtime 有意义，但不应该交给 Provider。

Chapter 00 已经有 `convertToLlm()`。

所以 Runtime 可以保留：

```text
U1
A1
PROGRESS
U2
```

而真正进入 Provider 时过滤掉：

```text
U1
A1
U2
```

Pi 在类型层提供了 `CustomAgentMessages`，应用可以通过 TypeScript declaration merging 扩展 `AgentMessage`。

Provider 最终是否看到这条消息，仍然由 `convertToLlm()` 决定。

另一个例子出现在 Tool Result。

某个 Tool 执行以后，可能让新的 Tool 从下一轮开始可用。

例如认证前只有：

```text
login
```

认证成功后增加：

```text
write_file
deploy
```

Tool 可以返回：

```ts
addedToolNames = [
  "write_file",
  "deploy",
];
```

Harness 再根据这些名字更新后续轮次使用的 Tool 集合。

这里有一个明确的时间边界。

如果同一个 Assistant Message 一次请求：

```text
login()
deploy()
```

而 `deploy` 在这一轮开始时还不存在，那么它不会因为 `login()` 即将成功就在当前 batch 中突然变成可用。

这一批结束后再更新工具集。

下一轮模型才能真正看到新的 Tool。

这两个机制都没有要求重新设计 Agent Loop。

现有 Message boundary 和 Tool boundary 已经能够接住它们。

## Pi 的 Skill 最终只留下很短一条运行路径

Pi coding-agent 会从项目、用户配置和 package 等位置发现 Skill，还会处理 frontmatter、同名冲突、优先级和诊断信息。

这些属于资源发现层。

真正进入 Agent 以后，路径很短：

```text
Skill file
    ↓
metadata catalog
    ↓
system prompt
    ↓
model chooses Skill
    ↓
read Skill body
    ↓
existing Tool / Message loop
```

所以新增：

```text
database debugging
payment debugging
code review
```

这些领域能力时，不需要给 Agent Loop 分别增加：

```text
if (database) ...
if (payment) ...
if (codeReview) ...
```

它们先以文件和 metadata 的形式存在于 Core 外部。

真正需要时，再借已经存在的 Prompt、Tool 和 Message 边界进入当前运行。

运行：

```bash
npm run demo
```

启动以后可以先看到 Skill catalog：

```xml
<available_skills>
  <skill
    name="calc"
    location=".../skills/calc.md">

    <description>
      处理算术计算
    </description>
  </skill>
</available_skills>
```

里面没有完整 Skill 正文。

模型判断当前任务需要 `calc` 时，再去读取对应文件。

到这里，很多领域知识已经可以留在 Harness 外面。

但 Skill 仍然只是文件，Custom Message 和 `addedToolNames` 也只是数据。

如果希望加载一段真正的代码，让它注册 Tool、监听事件、拦截调用，单靠这些数据入口就不够了。

Chapter 10 从这个问题继续。
