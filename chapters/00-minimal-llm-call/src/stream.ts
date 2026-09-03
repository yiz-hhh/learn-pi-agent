/**
 * 00 章共享基座：EventStream（事件队列 + 消费者等待的生产-消费解耦）。
 *
 * 对齐 Pi 的 `EventStream`（pi-ai utils/event-stream.ts，全文件 88 行含 AssistantMessageEventStream；
 * 教学对照纯 EventStream 类 L4-67）全部语义：
 * - queue + waiting（L5-6/L29-35）：生产快于消费 → 排队；消费快于生产 → 挂起等待（不丢事件）
 * - AsyncIterable（L50-62）：`for await` 消费
 * - `isComplete`/`extractResult` 构造参数（L13-19）：结束信号与结果提取
 * - `push` 命中结束信号自动完成（L24-27）；`end(result)` 显式结束（L38-48）；`result()`（L64-66）
 */
export class EventStream<TEvent, TResult> implements AsyncIterable<TEvent> {
  private queue: TEvent[] = [];
  private waiting: ((value: IteratorResult<TEvent>) => void)[] = [];
  private done = false;
  private finalResultPromise: Promise<TResult>;
  private resolveFinalResult!: (result: TResult) => void;
  private isComplete: (event: TEvent) => boolean;
  private extractResult: (event: TEvent) => TResult;

  constructor(isComplete: (event: TEvent) => boolean, extractResult: (event: TEvent) => TResult) {
    this.isComplete = isComplete;
    this.extractResult = extractResult;
    this.finalResultPromise = new Promise((resolve) => {
      this.resolveFinalResult = resolve;
    });
  }

  push(event: TEvent): void {
    if (this.done) return;
    if (this.isComplete(event)) {
      this.done = true;
      this.resolveFinalResult(this.extractResult(event));
    }
    const waiter = this.waiting.shift();
    if (waiter) {
      waiter({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  end(result?: TResult): void {
    this.done = true;
    if (result !== undefined) {
      this.resolveFinalResult(result);
    }
    while (this.waiting.length > 0) {
      const waiter = this.waiting.shift()!;
      waiter({ value: undefined as never, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<TEvent> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
      } else if (this.done) {
        return;
      } else {
        const result = await new Promise<IteratorResult<TEvent>>((resolve) => this.waiting.push(resolve));
        if (result.done) return;
        yield result.value;
      }
    }
  }

  result(): Promise<TResult> {
    return this.finalResultPromise;
  }
}
