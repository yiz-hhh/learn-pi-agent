/**
 * 07 章测试（Phase 1）：Agent 封装（状态机/prompt/continue/subscribe）与线性 JSONL 会话脚手架。
 * Entry 树会话的测试见 session-tree.test.ts（Phase 2）。
 * 流式 mock LLM 驱动（离线）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent.ts";
import { appendToSession, clearSession, loadSession } from "../src/session.ts";
import type { LLMAdapter } from "../../00-minimal-llm-call/src/index.ts";
import type { AgentEvent, AssistantMessage, AssistantMessageEvent, Message } from "../../00-minimal-llm-call/src/index.ts";
import { createCalculatorTool } from "../../00-minimal-llm-call/src/index.ts";

/** 流式 mock LLM：步骤用尽后重复最后一步。 */
class ScriptedLlm implements LLMAdapter {
  private steps: (AssistantMessageEvent[])[];
  private next = 0;

  constructor(steps: (AssistantMessageEvent[])[]) {
    this.steps = steps;
  }

  async *complete(): AsyncIterable<AssistantMessageEvent> {
    const events = this.steps[Math.min(this.next, this.steps.length - 1)];
    this.next++;
    yield* events;
  }
}

function textStream(text: string): AssistantMessageEvent[] {
  return [
    { type: "start", partial: { role: "assistant", stopReason: "end_turn" } },
    { type: "done", partial: { role: "assistant", stopReason: "end_turn", text } },
  ];
}

function toolStream(calls: { id: string; name: string; args: Record<string, unknown> }[]): AssistantMessageEvent[] {
  const partial: AssistantMessage = {
    role: "assistant",
    stopReason: "tool_use",
    toolCalls: calls.map((c) => ({ id: c.id, name: c.name, arguments: c.args })),
  };
  return [
    { type: "start", partial },
    ...calls.map((c) => ({ type: "toolcall_start" as const, partial })),
    { type: "done", partial },
  ];
}

function makeAgent(llm: LLMAdapter, initialMessages?: Message[]): Agent {
  return new Agent({
    systemPrompt: "助手",
    tools: [createCalculatorTool()],
    llm,
    config: { model: "m" },
    initialMessages,
  });
}

/** 临时会话文件。 */
function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), "lpia-07-")), "session.jsonl");
}

describe("Agent 封装（07 章）", () => {
  it("prompt 后 state.messages 完整累积（事件驱动，Pi processEvents）", async () => {
    const agent = makeAgent(new ScriptedLlm([toolStream([{ id: "c1", name: "calculator", args: { a: 1, b: 2 } }]), textStream("3")]));
    await agent.prompt("算 1+2");

    expect(agent.state.messages.length).toBe(4); // user + assistant(tool_use) + toolResult + assistant
    expect(agent.state.messages[3]).toMatchObject({ role: "assistant", text: "3" });
    expect(agent.state.isStreaming).toBe(false);
    expect(agent.state.errorMessage).toBeUndefined();
  });

  it("isStreaming 生命周期：run 期间为 true，结束后 false", async () => {
    const agent = makeAgent(new ScriptedLlm([textStream("完成")]));
    const streamingStates: boolean[] = [];
    agent.subscribe((event) => {
      if (event.type === "message_start") streamingStates.push(agent.state.isStreaming);
    });
    await agent.prompt("hi");

    expect(streamingStates).toEqual([true, true]); // prompt 消息 + assistant 消息都在 run 期间
    expect(agent.state.isStreaming).toBe(false);
  });

  it("streamingMessage 生命周期：message_start 有值，message_end 清空", async () => {
    const agent = makeAgent(new ScriptedLlm([textStream("完成")]));
    const seen: (Message | undefined)[] = [];
    agent.subscribe((event) => {
      if (event.type === "message_start" || event.type === "message_end") {
        seen.push(agent.state.streamingMessage);
      }
    });
    await agent.prompt("hi");

    expect(seen[0]).toBeDefined(); // message_start 时 streamingMessage 有值
    expect(seen[1]).toBeUndefined(); // message_end 时清空
  });

  it("pendingToolCalls：tool_execution_start/end 维护集合", async () => {
    const agent = makeAgent(new ScriptedLlm([toolStream([{ id: "c1", name: "calculator", args: { a: 1, b: 2 } }]), textStream("3")]));
    const states: number[] = [];
    agent.subscribe((event) => {
      if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
        states.push(agent.state.pendingToolCalls.size);
      }
    });
    await agent.prompt("算");

    expect(states).toEqual([1, 0]); // start 时 1 个 pending，end 后 0 个
  });

  it("continue：末条 user/toolResult 可继续；末条 assistant 抛错（Pi L74-76）", async () => {
    const agent = makeAgent(new ScriptedLlm([textStream("第一轮"), textStream("第二轮")]));
    await agent.prompt("任务");
    // 末条是 assistant → continue 抛错
    await expect(agent.continue()).rejects.toThrow("assistant");
  });

  it("continue 语义：从 toolResult 末条继续（重试工具场景）", async () => {
    // 场景：工具结果 terminate=true → 循环停在 toolResult 末条 → continue 可继续（Pi L361-410）
    const stopping = {
      ...createCalculatorTool(),
      async execute(args: { a: number; b: number }) {
        return { content: String(args.a + args.b), terminate: true };
      },
    };
    const llm = new ScriptedLlm([toolStream([{ id: "c1", name: "calculator", args: { a: 1, b: 2 } }]), textStream("继续后回答")]);
    const agent = new Agent({
      systemPrompt: "助手",
      tools: [stopping],
      llm,
      config: { model: "m" },
    });
    await agent.prompt("算");
    // 末条是 toolResult（terminate 停在工具结果后）
    expect(agent.state.messages.at(-1)?.role).toBe("toolResult");
    // continue：从 toolResult 末条重新询问模型
    const results = await agent.continue();
    expect(results.at(-1)).toMatchObject({ role: "assistant", text: "继续后回答" });
  });

  it("错误可观测：turn_end errorMessage → state.errorMessage", async () => {
    const errorStep: AssistantMessageEvent[] = [
      { type: "start", partial: { role: "assistant", stopReason: "error", errorMessage: "API 失败" } },
      { type: "done", partial: { role: "assistant", stopReason: "error", errorMessage: "API 失败" } },
    ];
    const agent = makeAgent(new ScriptedLlm([errorStep]));
    await agent.prompt("hi");

    expect(agent.state.errorMessage).toBe("API 失败");
  });

  it("运行失败 → handleRunFailure：失败消息入历史、errorMessage 设置、状态复位（Pi L512-526）", async () => {
    const crashingLlm: LLMAdapter = {
      async *complete(): AsyncIterable<AssistantMessageEvent> {
        throw new Error("LLM 网络中断");
      },
    };
    const agent = makeAgent(crashingLlm);
    const result = await agent.prompt("hi");
    expect(result).toEqual([]);
    expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });
    expect(agent.state.errorMessage).toContain("LLM 网络中断");
    expect(agent.state.isStreaming).toBe(false);
    expect(agent.state.pendingToolCalls.size).toBe(0);
    // continue 约束生效：失败回合末条为 assistant → 抛错（不静默放行）
    await expect(agent.continue()).rejects.toThrow("assistant");
  });

  it("并发保护：prompt 进行中再次 prompt 抛错（Pi L352-356）", async () => {
    let resolveFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const llm: LLMAdapter = {
      async *complete() {
        await gate; // 挂起第一个 run
        yield { type: "start", partial: { role: "assistant", stopReason: "end_turn" } };
        yield { type: "done", partial: { role: "assistant", stopReason: "end_turn", text: "完成" } };
      },
    };
    const agent = makeAgent(llm);
    const first = agent.prompt("任务一");
    await expect(agent.prompt("任务二")).rejects.toThrow("正在处理中");
    resolveFirst();
    await first;
  });
});

describe("JSONL 会话持久化（07 章）", () => {
  it("append 后 load 恢复完整（含工具结果与 assistant 回复）", async () => {
    const file = tempFile();
    appendToSession(file, { version: 1, systemPrompt: "助手", model: "m" }, [
      { role: "user", text: "算 1+2" },
      { role: "assistant", text: "3" },
    ]);

    const loaded = loadSession(file);
    expect(loaded?.header).toMatchObject({ systemPrompt: "助手", model: "m" });
    expect(loaded?.messages).toHaveLength(2);
    expect(loaded?.messages[1]).toMatchObject({ role: "assistant", text: "3" });
  });

  it("追加语义：多次 append 不覆盖已有内容", async () => {
    const file = tempFile();
    appendToSession(file, { version: 1, systemPrompt: "助手", model: "m" }, [{ role: "user", text: "第一轮" }]);
    appendToSession(file, { version: 1, systemPrompt: "助手", model: "m" }, [{ role: "assistant", text: "回复" }]);

    const loaded = loadSession(file);
    expect(loaded?.messages.map((m) => m.text)).toEqual(["第一轮", "回复"]);
  });

  it("恢复后继续对话：load → Agent(initialMessages) → prompt 多轮", async () => {
    const file = tempFile();
    appendToSession(file, { version: 1, systemPrompt: "助手", model: "m" }, [
      { role: "user", text: "算 1+2" },
      { role: "assistant", text: "3" },
    ]);

    const loaded = loadSession(file);
    expect(loaded).not.toBeNull();
    const agent = makeAgent(new ScriptedLlm([textStream("历史已看到")]), loaded?.messages);
    await agent.prompt("再来一轮");
    expect(agent.state.messages.length).toBe(4); // 恢复 2 条 + 新 prompt + 新回复
    expect(agent.state.messages[0]).toMatchObject({ text: "算 1+2" });
  });

  it("JSONL 容错：中间损坏行跳过、缺尾换行 append 先补换行", async () => {
    const file = tempFile();
    appendToSession(file, { version: 1, systemPrompt: "助手", model: "m" }, [
      { role: "user", text: "第一条" },
      { role: "assistant", text: "第二条" },
    ]);
    const raw = readFileSync(file, "utf8");
    // 破坏中间行：单行损坏不杀死整个会话
    const lines = raw.split("\n").filter((l) => l);
    writeFileSync(file, [lines[0], "{{{broken json", ...lines.slice(1)].join("\n") + "\n", "utf8");
    const loaded = loadSession(file);
    expect(loaded?.messages.map((m) => m.text)).toEqual(["第一条", "第二条"]);  // 损坏行跳过，其余完整恢复
    // 缺尾换行：外部写入后无换行 → append 先补换行，不合并损坏
    writeFileSync(file, raw.trimEnd(), "utf8");
    appendToSession(file, { version: 1, systemPrompt: "助手", model: "m" }, [{ role: "user", text: "第三条" }]);
    const loaded2 = loadSession(file);
    expect(loaded2?.messages.map((m) => m.text)).toEqual(["第一条", "第二条", "第三条"]);
  });

  it("文件不存在时 loadSession 返回 null；clearSession 清空", async () => {
    const file = tempFile();
    expect(loadSession(file)).toBeNull();
    appendToSession(file, { version: 1, systemPrompt: "助手", model: "m" }, [{ role: "user", text: "x" }]);
    clearSession(file);
    expect(loadSession(file)).toBeNull();
  });

  afterEach(() => {
    // 清理临时目录
    rmSync(join(tmpdir(), "lpia-07-"), { recursive: true, force: true });
  });
});
