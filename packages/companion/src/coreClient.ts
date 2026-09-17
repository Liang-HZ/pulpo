import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

/**
 * core 的 JSON-RPC 客户端。
 *
 * 两条传输跑同一套方法表（PROTOCOL.md §1）：unix socket（换行分帧）与
 * WebSocket（一帧一条）。companion 默认走 unix socket——它和 core 永远同机；
 * core 以 `--no-socket` 起时才回落到 loopback WebSocket。
 */
export interface CoreAddress {
  socketPath?: string;
  wsPort?: number;
}

export class CoreRpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "CoreRpcError";
    this.code = code;
    this.data = data;
  }
}

/** socket 路径解析，与 core 的 `paths.ts` 同一套规则。 */
export function resolveCoreAddress(env: NodeJS.ProcessEnv = process.env): CoreAddress {
  const explicitSocket = env.PULPO_SOCKET?.trim();
  if (explicitSocket) return { socketPath: path.resolve(explicitSocket) };
  const home = env.PULPO_HOME?.trim();
  const socketPath = home
    ? path.join(path.resolve(home), "run", "core.sock")
    : path.join(os.homedir(), ".pulpo", "run", "core.sock");
  if (fs.existsSync(socketPath)) return { socketPath };
  const wsRaw = env.PULPO_CORE_WS?.trim() ?? env.PULPO_WS_PORT?.trim();
  const wsPort = wsRaw ? Number.parseInt(wsRaw, 10) : NaN;
  if (Number.isInteger(wsPort) && wsPort > 0) return { wsPort };
  // socket 还没起来也回 socket 路径：连接时报的错里带路径，比"没配地址"好定位。
  return { socketPath };
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

/**
 * 一条长连接的 JSON-RPC 客户端。断线后下一次调用自动重连（core 重启、
 * 或 agent 会话活得比 core 久时都会遇到）。
 */
export class CoreClient {
  private id = 0;
  private readonly pending = new Map<number, Pending>();
  private conn: { write: (t: string) => void; close: () => void } | null = null;
  private connecting: Promise<void> | null = null;

  constructor(
    private readonly address: CoreAddress,
    private readonly defaultTimeoutMs = 600_000,
  ) {}

  get describeAddress(): string {
    return this.address.socketPath
      ? `unix:${this.address.socketPath}`
      : `ws://127.0.0.1:${this.address.wsPort}`;
  }

  private async connect(): Promise<void> {
    if (this.conn) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      if (this.address.socketPath) await this.connectUnix(this.address.socketPath);
      else if (this.address.wsPort) await this.connectWs(this.address.wsPort);
      else throw new Error("没有可用的 core 地址（PULPO_SOCKET / PULPO_HOME / PULPO_CORE_WS 都没给）");
    })();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private connectUnix(socketPath: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const sock = net.connect(socketPath);
      sock.setEncoding("utf8");
      let buf = "";
      sock.on("data", (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line.trim()) this.onMessage(line);
        }
      });
      const drop = (why: string) => () => this.onDisconnect(why);
      sock.on("close", drop("core 连接已关闭"));
      sock.once("error", (err) => {
        reject(new Error(`连不上 core（${socketPath}）：${err.message}`));
      });
      sock.once("connect", () => {
        sock.removeAllListeners("error");
        sock.on("error", () => this.onDisconnect("core 连接出错"));
        this.conn = { write: (t) => sock.write(`${t}\n`), close: () => sock.destroy() };
        resolve();
      });
    });
  }

  private connectWs(port: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      ws.on("message", (data) => this.onMessage(data.toString()));
      ws.on("close", () => this.onDisconnect("core WebSocket 已关闭"));
      ws.once("error", (err) => reject(new Error(`连不上 core（ws:${port}）：${err.message}`)));
      ws.once("open", () => {
        ws.removeAllListeners("error");
        ws.on("error", () => this.onDisconnect("core WebSocket 出错"));
        this.conn = { write: (t) => ws.send(t), close: () => ws.close() };
        resolve();
      });
    });
  }

  private onDisconnect(why: string): void {
    this.conn = null;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(new Error(why));
    }
  }

  private onMessage(text: string): void {
    let m: { id?: number; result?: unknown; error?: { code: number; message: string; data?: unknown } };
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (m.id === undefined) return; // 通知：companion 不订阅任何主题
    const p = this.pending.get(m.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(m.id);
    if (m.error) p.reject(new CoreRpcError(m.error.code, m.error.message, m.error.data));
    else p.resolve(m.result);
  }

  async call<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    await this.connect();
    const id = ++this.id;
    const limit = timeoutMs ?? this.defaultTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`core 请求超时 ${limit}ms：${method}`));
      }, limit);
      timer.unref?.();
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.conn!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }));
    });
  }

  close(): void {
    this.conn?.close();
    this.conn = null;
  }
}
