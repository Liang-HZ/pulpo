// core 的 JSON-RPC 2.0 客户端。壳只有这一种传输：127.0.0.1 的 WebSocket
// （PROTOCOL.md §1）。桌面端与浏览器端跑的是同一份代码，移动端将来也是。

import type { SessionRef } from "./protocol";

export type ConnectionPhase = "connecting" | "open" | "reconnecting" | "closed";

export interface ConnectionState {
  phase: ConnectionPhase;
  /** 连续失败次数；连上后归零 */
  attempt: number;
  /** 断开原因，如实显示给用户，不静默 */
  lastError: string | null;
  /** 下一次重连的时刻（毫秒时间戳），phase=reconnecting 时有值 */
  retryAt: number | null;
}

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface RpcClientOptions {
  url: string;
  /** 注入 WebSocket 构造器，测试用；默认取全局 */
  WebSocketCtor?: typeof WebSocket;
  /** 重连退避的基数与上限（毫秒） */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** 注入定时器，测试用 */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  now?: () => number;
}

type NotificationHandler = (params: never) => void;

const DEFAULT_BACKOFF_BASE = 500;
const DEFAULT_BACKOFF_MAX = 10_000;

export class RpcClient {
  private ws: WebSocket | null = null;
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void; method: string }
  >();
  private readonly notificationHandlers = new Map<string, Set<NotificationHandler>>();
  private readonly stateListeners = new Set<(s: ConnectionState) => void>();
  private state: ConnectionState = { phase: "connecting", attempt: 0, lastError: null, retryAt: null };
  private retryHandle: unknown = null;
  private disposed = false;

  private readonly Ctor: typeof WebSocket;
  private readonly backoffBase: number;
  private readonly backoffMax: number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private readonly now: () => number;

  constructor(private readonly options: RpcClientOptions) {
    const ctor = options.WebSocketCtor ?? globalThis.WebSocket;
    if (typeof ctor !== "function") throw new Error("环境里没有 WebSocket");
    this.Ctor = ctor;
    this.backoffBase = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE;
    this.backoffMax = options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX;
    this.setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((h) => clearTimeout(h as never));
    this.now = options.now ?? (() => Date.now());
  }

  getState(): ConnectionState {
    return this.state;
  }

  onStateChange(listener: (s: ConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** 订阅一类通知。core 的通知是标准 JSON-RPC 通知（无 id）。 */
  on<P>(method: string, handler: (params: P) => void): () => void {
    let set = this.notificationHandlers.get(method);
    if (!set) {
      set = new Set();
      this.notificationHandlers.set(method, set);
    }
    set.add(handler as NotificationHandler);
    return () => set.delete(handler as NotificationHandler);
  }

  /**
   * 连上（或重新连上）。`close()` 之后再调它会重新启用这个客户端——
   * React 的 StrictMode 会把 effect 跑两遍（mount→cleanup→mount），
   * 如果 close 是不可逆的，第二遍就永远停在 closed 上。
   */
  connect(): void {
    this.disposed = false;
    this.openSocket();
  }

  private openSocket(): void {
    this.clearRetry();
    const phase: ConnectionPhase = this.state.attempt > 0 ? "reconnecting" : "connecting";
    this.setState({ phase, retryAt: null });

    let ws: WebSocket;
    try {
      ws = new this.Ctor(this.options.url);
    } catch (err) {
      this.handleDown(describe(err));
      return;
    }
    this.ws = ws;

    ws.addEventListener("open", () => {
      if (this.ws !== ws) return;
      this.setState({ phase: "open", attempt: 0, lastError: null, retryAt: null });
    });
    ws.addEventListener("message", (ev: MessageEvent) => {
      if (this.ws !== ws) return;
      this.handleFrame(typeof ev.data === "string" ? ev.data : String(ev.data));
    });
    ws.addEventListener("error", () => {
      // close 事件必然随后到达，统一在那里处理，避免重复降级
    });
    ws.addEventListener("close", (ev: CloseEvent) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.handleDown(
        `与 core 的连接断开（code=${ev?.code ?? "?"}${ev?.reason ? `, ${ev.reason}` : ""}）`,
      );
    });
  }

  private handleDown(reason: string): void {
    // 挂起的请求全部当场失败。session/prompt 是长请求，连接没了就是没了，
    // 不能让调用方无限等下去。
    for (const [, entry] of this.pending) {
      entry.reject(new RpcError(-32003_000, `${entry.method} 未完成：${reason}`));
    }
    this.pending.clear();

    if (this.disposed) {
      this.setState({ phase: "closed", lastError: reason, retryAt: null });
      return;
    }
    const attempt = this.state.attempt + 1;
    const delay = Math.min(this.backoffMax, this.backoffBase * 2 ** (attempt - 1));
    this.setState({
      phase: "reconnecting",
      attempt,
      lastError: reason,
      retryAt: this.now() + delay,
    });
    this.retryHandle = this.setTimeoutFn(() => {
      this.retryHandle = null;
      this.openSocket();
    }, delay);
  }

  private handleFrame(text: string): void {
    let parsed: JsonRpcResponse | JsonRpcResponse[];
    try {
      parsed = JSON.parse(text) as JsonRpcResponse | JsonRpcResponse[];
    } catch {
      return; // 非法帧丢弃：core 不会发，发了也不该拖垮 UI
    }
    for (const msg of Array.isArray(parsed) ? parsed : [parsed]) {
      this.handleMessage(msg);
    }
  }

  private handleMessage(msg: JsonRpcResponse): void {
    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const entry = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
      else entry.resolve(msg.result);
      return;
    }
    if (msg.method && msg.id === undefined) {
      for (const handler of this.notificationHandlers.get(msg.method) ?? []) {
        (handler as (p: unknown) => void)(msg.params);
      }
    }
  }

  call<R = unknown>(method: string, params?: Record<string, unknown>): Promise<R> {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) {
      return Promise.reject(new RpcError(-32003_001, `${method} 发不出去：与 core 未连接`));
    }
    const id = ++this.nextId;
    return new Promise<R>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method });
      try {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }));
      } catch (err) {
        this.pending.delete(id);
        reject(new RpcError(-32003_002, `${method} 发送失败：${describe(err)}`));
      }
    });
  }

  close(): void {
    this.disposed = true;
    this.clearRetry();
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      /* 已经关了 */
    }
    for (const [, entry] of this.pending) {
      entry.reject(new RpcError(-32003_003, `${entry.method} 未完成：客户端主动关闭`));
    }
    this.pending.clear();
    this.setState({ phase: "closed", retryAt: null });
  }

  /** 当前挂起的请求数，测试用 */
  get pendingCount(): number {
    return this.pending.size;
  }

  private clearRetry(): void {
    if (this.retryHandle !== null) {
      this.clearTimeoutFn(this.retryHandle);
      this.retryHandle = null;
    }
  }

  private setState(patch: Partial<ConnectionState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.stateListeners) listener(this.state);
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** 把 `<agentId>#<sessionId>` 拆开。`#` 之后原样就是 agent 自己的 id。 */
export function splitRef(ref: SessionRef): { agentId: string; sessionId: string } {
  const at = ref.indexOf("#");
  if (at < 0) return { agentId: ref, sessionId: "" };
  return { agentId: ref.slice(0, at), sessionId: ref.slice(at + 1) };
}
