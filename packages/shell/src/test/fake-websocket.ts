// 一个够用的 WebSocket 替身：能收发帧、能按脚本断开，方便把重连与请求配对
// 放在纯 node 环境里断言，不拖一个浏览器进来。

type Listener = (ev: unknown) => void;

export class FakeWebSocket {
  static readonly instances: FakeWebSocket[] = [];
  static last(): FakeWebSocket {
    const ws = FakeWebSocket.instances.at(-1);
    if (!ws) throw new Error("还没有创建过 FakeWebSocket");
    return ws;
  }
  static reset(): void {
    FakeWebSocket.instances.length = 0;
  }

  readyState = 0;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("socket 没开，发不出去");
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", { code: 1000, reason: "client closed" });
  }

  // ── 测试驱动 ──────────────────────────────────────────────────────────────
  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  /** 服务端推一帧 */
  deliver(message: unknown): void {
    this.emit("message", { data: JSON.stringify(message) });
  }

  /** 服务端推一帧原始文本（用来测非法 JSON） */
  deliverRaw(text: string): void {
    this.emit("message", { data: text });
  }

  /** 模拟连接被对端掐断 */
  drop(code = 1006, reason = "abnormal closure"): void {
    this.readyState = 3;
    this.emit("close", { code, reason });
  }

  /** 读出客户端发过的全部请求 */
  requests(): Array<{ id?: number; method?: string; params?: unknown }> {
    return this.sent.map((raw) => JSON.parse(raw) as { id?: number; method?: string });
  }

  /** 读出客户端发过的第 n 个请求 */
  request(index: number): { id?: number; method?: string; params?: unknown } {
    const raw = this.sent[index];
    if (!raw) throw new Error(`没有第 ${index} 个请求`);
    return JSON.parse(raw) as { id?: number; method?: string; params?: unknown };
  }

  private emit(type: string, ev: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(ev);
  }
}

/** 假定时器：手动推进，重连退避不必真的等 */
export class FakeClock {
  private seq = 0;
  private readonly timers = new Map<number, { fn: () => void; at: number }>();
  private current = 0;

  setTimeout = (fn: () => void, ms: number): unknown => {
    const handle = ++this.seq;
    this.timers.set(handle, { fn, at: this.current + ms });
    return handle;
  };

  clearTimeout = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  now = (): number => this.current;

  /** 推进时间并跑掉到期的定时器 */
  advance(ms: number): void {
    this.current += ms;
    for (const [handle, timer] of [...this.timers]) {
      if (timer.at <= this.current) {
        this.timers.delete(handle);
        timer.fn();
      }
    }
  }

  get pending(): number {
    return this.timers.size;
  }
}
