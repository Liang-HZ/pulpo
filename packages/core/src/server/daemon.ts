import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { WebSocketServer, type WebSocket } from "ws";
import { AcpKernel } from "../acp/kernel.js";
import { DeliveryLadder } from "../delivery/ladder.js";
import { DelegationBroker } from "../broker/delegate.js";
import { SessionGraph } from "../graph/sessionGraph.js";
import { ReaderRegistry } from "../read/registry.js";
import { TranscriptCache } from "../read/paging.js";
import { DescriptorCache } from "../descriptor/cache.js";
import { TurnSnapshotStore } from "../git/snapshot.js";
import { ChangeStatTracker, type ChangeStat } from "../derive/changeStat.js";
import { ApprovalHub, type ApprovalPolicy } from "./approvals.js";
import { buildRouter, TOPICS } from "./methods.js";
import {
  decodeFrame,
  encodeFrame,
  notification,
  type ClientSession,
  type MethodRouter,
} from "./rpc.js";
import {
  assertSocketPathFits,
  ensureDir,
  runDir,
  socketPath as defaultSocketPath,
  stateDir,
  wsPort as defaultWsPort,
} from "../paths.js";

export interface DaemonOptions {
  env?: NodeJS.ProcessEnv;
  /** unix socket 路径。null = 不开这条传输。 */
  socketPath?: string | null;
  /** WebSocket 端口（只绑 127.0.0.1）。0 = 随机空闲端口；null = 不开。 */
  wsPort?: number | null;
  commandOverrides?: Record<string, string>;
  approvalTimeoutMs?: number;
  approvalPolicy?: ApprovalPolicy;
  version?: string;
  onLog?: (line: string) => void;
}

interface Conn extends ClientSession {
  send(msg: unknown): void;
  close(): void;
}

/**
 * pulpo core daemon。
 *
 * 两条传输跑**同一套** JSON-RPC 2.0：
 *  - unix socket：换行分隔，一行一条消息；
 *  - WebSocket（127.0.0.1）：一条文本帧一条消息。
 * 方法表、参数、返回、通知、错误码完全一致，见 PROTOCOL.md。
 */
export class PulpoDaemon extends EventEmitter {
  readonly kernel: AcpKernel;
  readonly graph: SessionGraph;
  readonly ladder: DeliveryLadder;
  readonly broker: DelegationBroker;
  readonly readers: ReaderRegistry;
  readonly approvals: ApprovalHub;
  readonly transcripts: TranscriptCache;
  readonly descriptors: DescriptorCache;
  readonly turns: TurnSnapshotStore;

  /** 每条会话一个 changeStat 暂存器（内存态，会话关掉就丢）。 */
  private readonly changeStats = new Map<string, ChangeStatTracker>();

  private readonly env: NodeJS.ProcessEnv;
  private readonly router: MethodRouter;
  private readonly conns = new Set<Conn>();
  private unixServer: net.Server | null = null;
  private wss: WebSocketServer | null = null;
  private httpPort: number | null = null;
  private resolvedSocketPath: string | null = null;
  private stopping = false;

  constructor(private readonly opts: DaemonOptions = {}) {
    super();
    this.env = opts.env ?? process.env;
    ensureDir(stateDir(this.env));
    ensureDir(runDir(this.env));

    this.kernel = new AcpKernel({
      env: this.env,
      // companion 注入要知道 core 的地址，而地址在 start() 之后才确定 → 回调取。
      companionContext: () => ({
        socketPath: this.resolvedSocketPath,
        wsPort: this.httpPort,
      }),
      ...(opts.commandOverrides ? { commandOverrides: opts.commandOverrides } : {}),
      // 回合快照必须拍在 prompt 发出去之前。
      onTurnStart: async (t) => {
        this.turnOf.set(t.sessionRef, t.turnId);
        await this.turns.begin({ sessionRef: t.sessionRef, turnId: t.turnId, cwd: t.cwd });
      },
      // agent 每次自描述都存一份（没有活动会话时也要答得出 descriptor）。
      onDescriptor: (agentId, cwd, descriptor) => this.descriptors.put(agentId, cwd, descriptor),
      onStderr: (agentId, chunk) => this.log(`[${agentId}] ${chunk.trimEnd()}`),
    });
    this.descriptors = new DescriptorCache({ env: this.env });
    this.transcripts = new TranscriptCache();
    this.turns = new TurnSnapshotStore({ env: this.env });
    this.graph = new SessionGraph({ env: this.env });
    this.ladder = new DeliveryLadder(this.kernel);
    this.broker = new DelegationBroker({
      kernel: this.kernel,
      graph: this.graph,
      ladder: this.ladder,
      env: this.env,
    });
    this.readers = new ReaderRegistry(this.env);
    this.approvals = new ApprovalHub({
      ...(opts.approvalTimeoutMs === undefined ? {} : { timeoutMs: opts.approvalTimeoutMs }),
      ...(opts.approvalPolicy ? { policy: opts.approvalPolicy } : {}),
    });

    this.router = buildRouter({
      kernel: this.kernel,
      graph: this.graph,
      ladder: this.ladder,
      broker: this.broker,
      readers: this.readers,
      approvals: this.approvals,
      transcripts: this.transcripts,
      descriptors: this.descriptors,
      turns: this.turns,
      env: this.env,
      version: opts.version ?? "0.1.0",
      transports: () => ({ socketPath: this.resolvedSocketPath, wsPort: this.httpPort }),
      shutdown: () => this.stop(),
    });

    this.wireEvents();
  }

  get methods(): string[] {
    return this.router.list();
  }

  get socketPath(): string | null {
    return this.resolvedSocketPath;
  }

  /** 实际监听到的 WS 端口（传 0 时是内核分配的那个）。 */
  get wsPort(): number | null {
    return this.httpPort;
  }

  get clientCount(): number {
    return this.conns.size;
  }

  private log(line: string): void {
    this.opts.onLog?.(line);
  }

  /** 会话当前那个回合的 id（快照账本按 turnId 记）。 */
  private readonly turnOf = new Map<string, string>();

  private trackerFor(sessionRef: string): ChangeStatTracker {
    let t = this.changeStats.get(sessionRef);
    if (!t) {
      t = new ChangeStatTracker();
      this.changeStats.set(sessionRef, t);
    }
    return t;
  }

  /**
   * 壳内合成的会话事件（turn 边界等）。
   *
   * 走 `session/update` 这条订阅通道，但**不冒充 agent 的 update**：
   * 这类通知没有 `update` 字段，只有 `derived`。客户端按
   * 「有 `update` = agent 原文 / 有 `derived.event` = 壳内合成」区分。
   */
  private emitDerived(
    sessionRef: string,
    agentId: string,
    sessionId: string,
    derived: Record<string, unknown>,
  ): void {
    this.broadcast("session/update", { sessionRef, agentId, sessionId, derived });
  }

  private wireEvents(): void {
    this.kernel.on("turn_started", (e: {
      sessionRef: string;
      agentId: string;
      sessionId: string;
      turnId: string;
      startedAt: number;
    }) => {
      this.turnOf.set(e.sessionRef, e.turnId);
      this.emitDerived(e.sessionRef, e.agentId, e.sessionId, {
        event: "turn_started",
        turnId: e.turnId,
        startedAt: e.startedAt,
      });
    });

    this.kernel.on("turn_finished", (e: {
      sessionRef: string;
      agentId: string;
      sessionId: string;
      turnId: string;
      startedAt: number;
      endedAt: number;
      stopReason: string;
      error?: string;
    }) => {
      // 收尾快照要读磁盘，异步做；做完再推 turn_finished，让通知自带改动摘要。
      void this.turns
        .finish(e.turnId)
        .catch(() => undefined)
        .then(() => {
          if (this.turnOf.get(e.sessionRef) === e.turnId) this.turnOf.delete(e.sessionRef);
          const changes = this.turns.summary(e.turnId);
          this.emitDerived(e.sessionRef, e.agentId, e.sessionId, {
            event: "turn_finished",
            turnId: e.turnId,
            startedAt: e.startedAt,
            endedAt: e.endedAt,
            stopReason: e.stopReason,
            ...(e.error ? { error: e.error } : {}),
            ...(changes ? { changes } : {}),
          });
        });
    });

    this.kernel.on("session_closed", (e: { sessionRef?: string }) => {
      if (e.sessionRef) {
        this.changeStats.delete(e.sessionRef);
        this.turnOf.delete(e.sessionRef);
      }
    });

    this.kernel.on("session_update", (e: { agentId: string; sessionId: string; update: unknown }) => {
      const sessionRef = `${e.agentId}#${e.sessionId}`;
      // 原生 subagent：agent 在会话流里自己报，读取层不必再猜父子关系。
      const u = e.update as { sessionUpdate?: string; subagentSessionId?: string; name?: string } | undefined;
      if (u?.sessionUpdate === "subagent_spawned" && u.subagentSessionId) {
        const childRef = `${e.agentId}#${u.subagentSessionId}`;
        this.graph.registerNativeSubagent(sessionRef, childRef, {
          agentId: e.agentId,
          sessionId: u.subagentSessionId,
          ...(u.name ? { title: u.name } : {}),
        });
        this.graph.save();
      }
      // 派生的 `+N −N`。入参到手先暂存，等结果回来且非 error 才提交——
      // 失败的编辑一行都不算。提交的那一条通知带上 `derived.changeStat`，
      // agent 的 `update` 原文一个字节都不改（PROTOCOL §5）。
      const stats: ChangeStat[] | undefined = this.trackerFor(sessionRef).onUpdate(e.update);
      if (stats) {
        const turnId = this.turnOf.get(sessionRef);
        if (turnId) this.turns.noteTouched(turnId, stats.map((x) => x.path));
      }
      this.broadcast("session/update", {
        sessionRef,
        ...e,
        ...(stats ? { derived: { changeStat: stats } } : {}),
      });
    });

    this.kernel.on("permission_request", (e: {
      agentId: string;
      sessionId: string;
      params: unknown;
      respond: (v: unknown) => void;
      reject: (v: unknown) => void;
    }) => {
      const sessionRef = `${e.agentId}#${e.sessionId}`;
      this.broker.markAwaitingApproval(sessionRef, true);
      this.approvals
        .request({ sessionRef, agentId: e.agentId, request: e.params })
        .then((res) => e.respond(res))
        .catch((err) => e.reject(err))
        .finally(() => this.broker.markAwaitingApproval(sessionRef, false));
    });

    this.kernel.on("elicitation", (e: {
      agentId: string;
      sessionId: string | null;
      params: unknown;
      respond: (v: unknown) => void;
    }) => {
      // elicitation 也走审批通道：agent 反过来问用户，没人答就按取消结算。
      // 通知带 requestId（不给 id 就没法回答），应答走
      // `elicitation/respond`，content 原样回给 agent。
      const sessionRef = `${e.agentId}#${e.sessionId ?? ""}`;
      this.approvals
        .request({ sessionRef, agentId: e.agentId, request: e.params, kind: "elicitation" })
        .then((res) => e.respond(toElicitationResponse(res.outcome)))
        .catch(() => e.respond({ action: "decline" }));
    });

    this.kernel.on("agent_exit", (e: unknown) => this.broadcast("agent/exit", e));
    this.broker.on("task_update", (t: unknown) => this.broadcast("task/update", t));
    this.approvals.on("requested", (a: unknown) => this.broadcast("permission/requested", a));
    this.approvals.on("elicitation_requested", (a: {
      requestId: string;
      sessionRef: string;
      agentId: string;
      request: unknown;
      createdAt: number;
      expiresAt: number;
    }) =>
      this.broadcast("elicitation/requested", {
        requestId: a.requestId,
        sessionRef: a.sessionRef,
        agentId: a.agentId,
        params: a.request,
        createdAt: a.createdAt,
        expiresAt: a.expiresAt,
      }),
    );
  }

  private broadcast(topic: string, params: unknown): void {
    if (!(TOPICS as readonly string[]).includes(topic)) return;
    for (const c of this.conns) {
      if (c.closed || !c.subscriptions.has(topic)) continue;
      c.notify(topic, params);
    }
  }

  async start(): Promise<{ socketPath: string | null; wsPort: number | null }> {
    const wantSocket = this.opts.socketPath !== null;
    if (wantSocket) {
      const p = this.opts.socketPath ?? defaultSocketPath(this.env);
      assertSocketPathFits(p);
      ensureDir(path.dirname(p));
      // 残留 socket 文件当场清掉：如果没人在听，它就是上次没善终的垃圾。
      await this.clearStaleSocket(p);
      this.unixServer = net.createServer((sock) => this.attachUnix(sock));
      await new Promise<void>((resolve, reject) => {
        this.unixServer!.once("error", reject);
        this.unixServer!.listen(p, () => {
          this.unixServer!.off("error", reject);
          resolve();
        });
      });
      fs.chmodSync(p, 0o600);
      this.resolvedSocketPath = p;
      this.log(`unix socket 监听：${p}`);
    }

    const wantWs = this.opts.wsPort !== null;
    if (wantWs) {
      const port = this.opts.wsPort ?? defaultWsPort(this.env);
      // 只绑 loopback：不对外暴露。
      this.wss = new WebSocketServer({ host: "127.0.0.1", port });
      await new Promise<void>((resolve, reject) => {
        this.wss!.once("error", reject);
        this.wss!.once("listening", () => {
          this.wss!.off("error", reject);
          resolve();
        });
      });
      const addr = this.wss.address();
      this.httpPort = typeof addr === "object" && addr ? addr.port : port;
      this.wss.on("connection", (ws) => this.attachWs(ws));
      this.log(`websocket 监听：ws://127.0.0.1:${this.httpPort}`);
    }

    return { socketPath: this.resolvedSocketPath, wsPort: this.httpPort };
  }

  /**
   * 残留 socket 文件处理：先试着连一下。连得上说明已有 daemon 在跑（报错，
   * 不抢）；连不上（ECONNREFUSED / ENOENT）就是上次崩溃留下的，直接删。
   */
  private async clearStaleSocket(p: string): Promise<void> {
    if (!fs.existsSync(p)) return;
    const alive = await new Promise<boolean>((resolve) => {
      const probe = net.connect(p);
      const done = (v: boolean) => {
        probe.destroy();
        resolve(v);
      };
      probe.once("connect", () => done(true));
      probe.once("error", () => done(false));
      setTimeout(() => done(false), 1000).unref();
    });
    if (alive) {
      throw new Error(`${p} 上已经有一个 pulpo-core 在跑。先停掉它，或换 PULPO_HOME / PULPO_SOCKET。`);
    }
    fs.unlinkSync(p);
    this.log(`清掉残留 socket：${p}`);
  }

  private makeConn(send: (text: string) => void, close: () => void): Conn {
    const conn: Conn = {
      id: randomUUID(),
      subscriptions: new Set<string>(),
      closed: false,
      send: (msg: unknown) => {
        if (conn.closed) return;
        send(encodeFrame(msg as never));
      },
      notify: (method: string, params?: unknown) => conn.send(notification(method, params)),
      close,
    };
    return conn;
  }

  private async onFrame(conn: Conn, text: string): Promise<void> {
    const decoded = decodeFrame(text);
    if ("error" in decoded) {
      conn.send(decoded.error);
      return;
    }
    // JSON-RPC 2.0 批量请求：数组进、数组出。
    if (Array.isArray(decoded.msg)) {
      const out = [];
      for (const m of decoded.msg) {
        const res = await this.router.handle(m, conn);
        if (res) out.push(res);
      }
      if (out.length) conn.send(out);
      return;
    }
    const res = await this.router.handle(decoded.msg, conn);
    if (res) conn.send(res);
  }

  private attachUnix(sock: net.Socket): void {
    sock.setEncoding("utf8");
    const conn = this.makeConn(
      (text) => sock.write(`${text}\n`),
      () => sock.end(),
    );
    this.conns.add(conn);
    let buf = "";
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) void this.onFrame(conn, line);
      }
    });
    const drop = () => {
      (conn as { closed: boolean }).closed = true;
      this.conns.delete(conn);
    };
    sock.on("close", drop);
    sock.on("error", drop);
  }

  private attachWs(ws: WebSocket): void {
    const conn = this.makeConn(
      (text) => ws.send(text),
      () => ws.close(),
    );
    this.conns.add(conn);
    ws.on("message", (data) => {
      // 一帧一条消息；二进制帧按 UTF-8 文本解。
      void this.onFrame(conn, data.toString());
    });
    const drop = () => {
      (conn as { closed: boolean }).closed = true;
      this.conns.delete(conn);
    };
    ws.on("close", drop);
    ws.on("error", drop);
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.approvals.shutdown();
    for (const c of this.conns) {
      try {
        c.close();
      } catch {
        /* 已经断了 */
      }
    }
    this.conns.clear();
    await new Promise<void>((resolve) => {
      if (!this.unixServer) return resolve();
      this.unixServer.close(() => resolve());
    });
    if (this.resolvedSocketPath && fs.existsSync(this.resolvedSocketPath)) {
      try {
        fs.unlinkSync(this.resolvedSocketPath);
      } catch {
        /* 别人可能已经清了 */
      }
    }
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
      for (const c of this.wss.clients) c.terminate();
    });
    this.transcripts.clear();
    this.changeStats.clear();
    await this.readers.disposeAll();
    await this.kernel.shutdown();
    this.graph.save();
    this.broker.save();
    this.turns.save();
    this.emit("stopped");
  }
}

/** 审批通道的裁决 → ACP elicitation 应答形状。 */
export function toElicitationResponse(decision: {
  outcome: string;
  optionId?: string;
  action?: string;
  content?: unknown;
}): { action: string; content?: unknown } {
  if (decision.outcome === "elicit") {
    const action = decision.action ?? "decline";
    return action === "accept" && decision.content !== undefined
      ? { action, content: decision.content }
      : { action };
  }
  // 老路径：用 permission/respond 答的 elicitation。
  if (decision.outcome === "selected") {
    return { action: "accept", content: { optionId: decision.optionId } };
  }
  return { action: "decline" };
}
