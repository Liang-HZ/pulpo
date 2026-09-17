import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { EventEmitter } from "node:events";
import { client, ndJsonStream, type ClientConnection } from "@agentclientprotocol/sdk";
import { RpcError, ErrorCode } from "../errors.js";

export interface AgentProcessOptions {
  agentId: string;
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  /** 协议版本；ACP 当前是 1。 */
  protocolVersion?: number;
  /** agent 子进程 stderr 的接收者（默认丢弃，避免污染 daemon 输出）。 */
  onStderr?: (chunk: string) => void;
}

export interface SessionUpdateEvent {
  agentId: string;
  sessionId: string;
  update: unknown;
  notification: unknown;
}

export interface PermissionRequestEvent {
  agentId: string;
  sessionId: string;
  params: unknown;
  /** 上层给出决定后调用。 */
  respond: (outcome: unknown) => void;
  reject: (err: unknown) => void;
}

export interface ElicitationEvent {
  agentId: string;
  sessionId: string | null;
  params: unknown;
  respond: (result: unknown) => void;
  reject: (err: unknown) => void;
}

/**
 * 一个 agent 子进程 + 一条 ACP 连接（pulpo 以 **client** 身份连接）。
 *
 * 只负责协议进出与进程生命周期；会话账本、投递决策、审批策略都在上层。
 */
export class AgentProcess extends EventEmitter {
  readonly agentId: string;
  readonly command: string;
  readonly args: string[];
  readonly cwd: string;

  private proc: ChildProcessWithoutNullStreams | null = null;
  private conn: ClientConnection | null = null;
  private initializeResult: unknown = null;
  private closed = false;
  private stderrTail: string[] = [];

  constructor(private readonly opts: AgentProcessOptions) {
    super();
    this.agentId = opts.agentId;
    this.command = opts.command;
    this.args = opts.args;
    this.cwd = opts.cwd;
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  get initialize(): unknown {
    return this.initializeResult;
  }

  get alive(): boolean {
    return !!this.proc && this.proc.exitCode === null && !this.closed;
  }

  /** agent 子进程最近的 stderr（诊断用，最多 50 行）。 */
  get stderr(): string {
    return this.stderrTail.join("");
  }

  async start(): Promise<unknown> {
    if (this.proc) throw new Error(`agent ${this.agentId} 已经启动过了`);
    const env = { ...process.env, ...this.opts.env };
    const proc = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: env as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;

    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      this.stderrTail.push(chunk);
      if (this.stderrTail.length > 50) this.stderrTail.shift();
      this.opts.onStderr?.(chunk);
    });
    proc.on("exit", (code, signal) => {
      this.closed = true;
      this.emit("exit", { agentId: this.agentId, code, signal });
    });
    proc.on("error", (err) => {
      this.closed = true;
      this.emit("error", err);
    });

    const app = client({ name: `pulpo-core/${this.agentId}` })
      .onNotification("session/update", async ({ params }) => {
        const p = params as { sessionId?: string; update?: unknown };
        this.emit("session_update", {
          agentId: this.agentId,
          sessionId: String(p.sessionId ?? ""),
          update: p.update,
          notification: params,
        } satisfies SessionUpdateEvent);
      })
      .onRequest("session/request_permission", async ({ params }) => {
        const p = params as { sessionId?: string };
        return await new Promise<never>((resolve, reject) => {
          this.emit("permission_request", {
            agentId: this.agentId,
            sessionId: String(p.sessionId ?? ""),
            params,
            respond: resolve as (outcome: unknown) => void,
            reject,
          } satisfies PermissionRequestEvent);
        });
      })
      // elicitation：agent 反过来问用户（MCP elicitation 语义）。
      .onRequest(
        "elicitation/create",
        (p: unknown) => p,
        async ({ params }) => {
          const p = (params ?? {}) as { sessionId?: string };
          return await new Promise((resolve, reject) => {
            this.emit("elicitation", {
              agentId: this.agentId,
              sessionId: p.sessionId ? String(p.sessionId) : null,
              params,
              respond: resolve,
              reject,
            } satisfies ElicitationEvent);
          });
        },
      );

    const stream = ndJsonStream(
      Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>,
    );
    this.conn = app.connect(stream);

    this.initializeResult = await this.request("initialize", {
      protocolVersion: this.opts.protocolVersion ?? 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    });
    return this.initializeResult;
  }

  /**
   * 发一个 ACP 请求。标准方法与扩展方法（`_session/steering` 等）走同一条路。
   * agent 侧错误原样包成 RpcError，不做任何"友好化"——回执必须如实。
   */
  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.conn) throw new Error(`agent ${this.agentId} 未启动`);
    try {
      return (await this.conn.agent.request<T>(method, params)) as T;
    } catch (err) {
      throw toRpcError(err, this.agentId, method);
    }
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (!this.conn) throw new Error(`agent ${this.agentId} 未启动`);
    await this.conn.agent.notify(method, params);
  }

  /** 关闭连接并杀掉子进程。按 pid 定位，不用进程名。 */
  async stop(): Promise<void> {
    if (this.closed && !this.proc) return;
    this.closed = true;
    try {
      this.conn?.close();
    } catch {
      /* 连接可能已经断了 */
    }
    const proc = this.proc;
    if (!proc || proc.exitCode !== null) return;
    const pid = proc.pid;
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      proc.once("exit", done);
      try {
        proc.kill("SIGTERM");
      } catch {
        return done();
      }
      setTimeout(() => {
        if (proc.exitCode === null && pid !== undefined) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* 已经没了 */
          }
        }
      }, 3000).unref();
      setTimeout(done, 6000).unref();
    });
  }
}

/** 把 SDK / agent 抛出来的错误统一成 RpcError，保留原始 code 与 data。 */
export function toRpcError(err: unknown, agentId: string, method: string): RpcError {
  if (err instanceof RpcError) return err;
  const e = err as { code?: unknown; message?: unknown; data?: unknown } | null;
  const code = typeof e?.code === "number" ? e.code : ErrorCode.AgentError;
  const message = typeof e?.message === "string" ? e.message : String(err);
  return new RpcError(code, message, {
    agentId,
    method,
    ...(e?.data === undefined ? {} : { cause: e.data }),
  });
}
