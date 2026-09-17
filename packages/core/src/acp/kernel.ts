import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { AgentProcess, type AgentProcessOptions } from "./agent.js";
import {
  companionAvailable,
  companionEnabled,
  companionMcpServer,
  type CompanionInjectionContext,
  type CompanionMcpServer,
} from "../companion/inject.js";
import {
  bootstrapFor,
  resolveCommand,
  type AgentBootstrap,
} from "../descriptor/registry.js";
import {
  descriptorFromInitialize,
  effortConfigId,
  mergeSessionSelfDescription,
} from "../descriptor/build.js";
import { applyStaticCorrections } from "../descriptor/overrides.js";
import type { CapabilityDescriptor, RevertCapability } from "../descriptor/types.js";
import { gitRoot } from "../git/snapshot.js";
import { ErrorCode, RpcError, invalidParams, notFound } from "../errors.js";

/** 会话引用：`<agentId>#<agent 原生 sessionId>`。跨进程稳定，可直接进 URL / JSON。 */
export type SessionRef = string;

export function makeSessionRef(agentId: string, sessionId: string): SessionRef {
  return `${agentId}#${sessionId}`;
}

export function parseSessionRef(ref: SessionRef): { agentId: string; sessionId: string } {
  const i = ref.indexOf("#");
  if (i <= 0) throw invalidParams(`sessionRef 格式错误：${ref}（应为 <agentId>#<sessionId>）`);
  return { agentId: ref.slice(0, i), sessionId: ref.slice(i + 1) };
}

/**
 * 一个进行中的回合（回合边界的事实源）。
 *
 * `injectable` 是 D 那条空窗的解法：`session/prompt` 发出之后，目标往往还要
 * 几百毫秒才真正开跑，这段时间里 core 自报 `turnActive=true` 而目标对
 * steering 回 `promptRequired`——自相矛盾。所以这里另记一个"目标已经开口"
 * 的位：**收到本回合第一条 `session/update` 才置 true**，投递阶梯用它等。
 */
export interface TurnInfo {
  turnId: string;
  sessionRef: SessionRef;
  startedAt: number;
  injectable: boolean;
}

export interface SessionHandle {
  ref: SessionRef;
  agentId: string;
  sessionId: string;
  cwd: string;
  proc: AgentProcess;
  descriptor: CapabilityDescriptor;
  /** session/new 或 session/resume 的原始应答。 */
  newSessionResponse: unknown;
  /** 当前是否有进行中的回合。投递阶梯据此裁决档位。 */
  turnActive: boolean;
  /** 进行中的回合（并发投递会有第二个）。 */
  turns: Map<string, TurnInfo>;
  /** 本会话的 effort 配置项 id（set_config_option 用），来自 configOptions。 */
  effortConfigId?: string;
  createdAt: number;
}

/** companion 令牌登记：token → 它被注入进的那条会话。 */
export interface CompanionIdentity {
  sessionRef: SessionRef;
  agentId: string;
  cwd: string;
}

export interface KernelOptions {
  env?: NodeJS.ProcessEnv;
  /**
   * companion 注入上下文（core 的 socket 路径 / ws 端口）。daemon 起完才知道，
   * 所以是个回调。返回 null / 不给 = 用环境变量里的地址。
   */
  companionContext?: () => CompanionInjectionContext;
  /** agent id → 可执行文件覆盖（测试把 adapter 指到别处用）。 */
  commandOverrides?: Record<string, string>;
  /** 每聚合出一份 descriptor 就回调一次（缓存用）。 */
  onDescriptor?: (agentId: string, cwd: string, descriptor: CapabilityDescriptor) => void;
  /**
   * 回合开始钩子，**在 prompt 真正发出去之前 await**（文件快照必须
   * 拍在 agent 动手之前，晚一毫秒都可能漏掉第一个写入）。
   */
  onTurnStart?: (turn: {
    sessionRef: SessionRef;
    agentId: string;
    sessionId: string;
    cwd: string;
    turnId: string;
    startedAt: number;
  }) => Promise<void> | void;
  onStderr?: (agentId: string, chunk: string) => void;
}

/**
 * ACP 内核：以 client 身份管理多个 agent 子进程与多个会话。
 *
 * 进程模型：**一会话一进程**。理由是实测的——ZCode adapter 的进程状态里
 * 只有一份活动会话（`session/new` 会顶掉上一份），多会话共进程会互相踩。
 * 只读查询（`session/list`）复用同 (agentId, cwd) 下已有的进程；没有时才
 * 起一个常驻的控制进程。
 */
export class AcpKernel extends EventEmitter {
  private readonly sessions = new Map<SessionRef, SessionHandle>();
  private readonly controls = new Map<string, AgentProcess>();
  private readonly all = new Set<AgentProcess>();
  private readonly companionTokens = new Map<string, CompanionIdentity>();
  private readonly companionWaiters = new Map<string, ((id: CompanionIdentity) => void)[]>();
  private shuttingDown = false;

  constructor(private readonly opts: KernelOptions = {}) {
    super();
  }

  get env(): NodeJS.ProcessEnv {
    return this.opts.env ?? process.env;
  }

  bootstrap(agentId: string): AgentBootstrap {
    const boot = bootstrapFor(agentId);
    if (!boot) throw notFound(`未知 agent：${agentId}（引导表里没有）`);
    return boot;
  }

  commandFor(agentId: string): { command: string; args: string[] } {
    const boot = this.bootstrap(agentId);
    return {
      command: resolveCommand(boot, {
        override: this.opts.commandOverrides?.[agentId],
        env: this.env,
      }),
      args: boot.args,
    };
  }

  private async spawnProcess(agentId: string, cwd: string): Promise<AgentProcess> {
    if (this.shuttingDown) throw new RpcError(ErrorCode.ShuttingDown, "core 正在关停");
    const boot = this.bootstrap(agentId);
    const { command, args } = this.commandFor(agentId);
    const options: AgentProcessOptions = {
      agentId,
      command,
      args,
      cwd,
      // 子进程继承 daemon 自己的环境（测试的 PULPO_HOME / TMPDIR /
      // ZCODE_ACP_LOG_DIR 靠它隔离），引导表的 env 再覆盖在上面。
      env: { ...this.env, ...boot.env },
      protocolVersion: 1,
      onStderr: (chunk) => this.opts.onStderr?.(agentId, chunk),
    };
    const proc = new AgentProcess(options);
    proc.on("session_update", (e) => {
      // 目标开口了 → 本会话所有进行中的回合都算"可注入"（关掉 turnActive 空窗）。
      const ev = e as { agentId?: string; sessionId?: string };
      this.markInjectable(makeSessionRef(String(ev.agentId ?? agentId), String(ev.sessionId ?? "")));
      this.emit("session_update", e);
    });
    proc.on("permission_request", (e) => this.emit("permission_request", e));
    proc.on("elicitation", (e) => this.emit("elicitation", e));
    proc.on("exit", (e) => {
      this.all.delete(proc);
      for (const [ref, h] of this.sessions) {
        if (h.proc === proc) {
          this.sessions.delete(ref);
          this.emit("session_closed", { sessionRef: ref, reason: "agent_exit", ...e });
        }
      }
      for (const [k, p] of this.controls) if (p === proc) this.controls.delete(k);
      this.emit("agent_exit", e);
    });
    proc.on("error", (err) => this.emit("agent_error", { agentId, error: err }));
    this.all.add(proc);
    await proc.start();
    return proc;
  }

  /** 只读查询用的常驻进程（按 agentId+cwd）。优先复用已有的会话进程。 */
  private async controlProcess(agentId: string, cwd: string): Promise<AgentProcess> {
    for (const h of this.sessions.values()) {
      if (h.agentId === agentId && h.cwd === cwd && h.proc.alive && !h.turnActive) {
        return h.proc;
      }
    }
    const key = `${agentId}#${cwd}`;
    const existing = this.controls.get(key);
    if (existing?.alive) return existing;
    const proc = await this.spawnProcess(agentId, cwd);
    this.controls.set(key, proc);
    return proc;
  }

  /**
   * 为一次 session/new / session/resume 生成 companion 注入记录。
   * 关掉（`PULPO_COMPANION=off`）或 companion 没构建过时回 null。
   */
  private companionInjection(): { token: string; entry: CompanionMcpServer } | null {
    const env = this.env;
    if (!companionEnabled(env) || !companionAvailable(env)) return null;
    const token = randomUUID();
    return { token, entry: companionMcpServer(token, env, this.opts.companionContext?.() ?? {}) };
  }

  private registerCompanionToken(token: string, id: CompanionIdentity): void {
    this.companionTokens.set(token, id);
    const waiters = this.companionWaiters.get(token);
    if (waiters) {
      this.companionWaiters.delete(token);
      for (const w of waiters) w(id);
    }
  }

  /**
   * 令牌换身份。注入发生在 session/new 应答之前，所以令牌可能比登记先到——
   * 等一小会儿而不是立刻报 NotFound。
   */
  async resolveCompanionToken(
    token: string,
    timeoutMs = 30_000,
  ): Promise<CompanionIdentity | undefined> {
    const known = this.companionTokens.get(token);
    if (known) return known;
    return new Promise<CompanionIdentity | undefined>((resolve) => {
      const list = this.companionWaiters.get(token) ?? [];
      const onReady = (id: CompanionIdentity) => {
        clearTimeout(timer);
        resolve(id);
      };
      list.push(onReady);
      this.companionWaiters.set(token, list);
      const timer = setTimeout(() => {
        const cur = this.companionWaiters.get(token) ?? [];
        const rest = cur.filter((f) => f !== onReady);
        if (rest.length) this.companionWaiters.set(token, rest);
        else this.companionWaiters.delete(token);
        resolve(undefined);
      }, timeoutMs);
      timer.unref?.();
    });
  }

  /**
   * 聚合一份 descriptor：initialize 自描述 + 本次 session/new 自描述，
   * 再过一遍修正覆盖表（只收紧、带证据），最后补上与 cwd 绑定的撤销能力。
   */
  async aggregateDescriptor(
    agentId: string,
    boot: AgentBootstrap,
    initialize: unknown,
    sessionResponse: unknown,
    cwd: string,
  ): Promise<CapabilityDescriptor> {
    const descriptor = mergeSessionSelfDescription(
      descriptorFromInitialize(agentId, boot, initialize),
      sessionResponse,
    );
    // agent 没自报危险等级时由覆盖表补（只收紧、带实测证据、进 corrections）。
    applyStaticCorrections({ descriptor, probes: {} });
    descriptor.revert = await revertCapabilityFor(cwd);
    this.opts.onDescriptor?.(agentId, cwd, descriptor);
    return descriptor;
  }

  /** 新建会话。descriptor 由 initialize + 本次 session/new 应答聚合而成。 */
  async newSession(params: {
    agentId: string;
    cwd: string;
    mcpServers?: unknown[];
  }): Promise<SessionHandle> {
    const { agentId, cwd } = params;
    const boot = this.bootstrap(agentId);
    const proc = await this.spawnProcess(agentId, cwd);
    const injection = this.companionInjection();
    const mcpServers = [...(params.mcpServers ?? [])];
    if (injection) mcpServers.push(injection.entry);
    let res: unknown;
    try {
      res = await proc.request("session/new", { cwd, mcpServers });
    } catch (err) {
      await proc.stop();
      throw err;
    }
    const sessionId = String((res as { sessionId?: unknown })?.sessionId ?? "");
    if (!sessionId) {
      await proc.stop();
      throw new RpcError(ErrorCode.AgentError, `${agentId} 的 session/new 没给 sessionId`, { response: res });
    }
    const descriptor = await this.aggregateDescriptor(agentId, boot, proc.initialize, res, cwd);
    const handle: SessionHandle = {
      ref: makeSessionRef(agentId, sessionId),
      agentId,
      sessionId,
      cwd,
      proc,
      descriptor,
      newSessionResponse: res,
      turnActive: false,
      turns: new Map(),
      effortConfigId: effortConfigId(res),
      createdAt: Date.now(),
    };
    this.sessions.set(handle.ref, handle);
    if (injection) {
      this.registerCompanionToken(injection.token, { sessionRef: handle.ref, agentId, cwd });
    }
    this.emit("session_opened", { sessionRef: handle.ref, agentId, cwd });
    return handle;
  }

  /** 恢复一条 agent 原生会话（`session/resume`）。 */
  async resumeSession(params: {
    agentId: string;
    sessionId: string;
    cwd: string;
  }): Promise<SessionHandle> {
    const { agentId, sessionId, cwd } = params;
    const existing = this.sessions.get(makeSessionRef(agentId, sessionId));
    if (existing?.proc.alive) return existing;
    const boot = this.bootstrap(agentId);
    const proc = await this.spawnProcess(agentId, cwd);
    const injection = this.companionInjection();
    let res: unknown;
    try {
      res = await proc.request("session/resume", {
        sessionId,
        cwd,
        ...(injection ? { mcpServers: [injection.entry] } : {}),
      });
    } catch (err) {
      await proc.stop();
      throw err;
    }
    const resumedId = String((res as { sessionId?: unknown })?.sessionId ?? sessionId);
    const descriptor = await this.aggregateDescriptor(agentId, boot, proc.initialize, res, cwd);
    const handle: SessionHandle = {
      ref: makeSessionRef(agentId, resumedId),
      agentId,
      sessionId: resumedId,
      cwd,
      proc,
      descriptor,
      newSessionResponse: res,
      turnActive: false,
      turns: new Map(),
      effortConfigId: effortConfigId(res),
      createdAt: Date.now(),
    };
    this.sessions.set(handle.ref, handle);
    if (injection) {
      this.registerCompanionToken(injection.token, { sessionRef: handle.ref, agentId, cwd });
    }
    this.emit("session_opened", { sessionRef: handle.ref, agentId, cwd });
    return handle;
  }

  /**
   * 现探一份 descriptor：开一条会话读自描述，**读完立刻关掉**。
   * 代价是起一次 agent 子进程，所以只在既没有活动会话、也没有缓存时走。
   */
  async probeDescriptor(agentId: string, cwd: string): Promise<CapabilityDescriptor> {
    const handle = await this.newSession({ agentId, cwd });
    const descriptor = handle.descriptor;
    await this.closeSession(handle.ref).catch(() => undefined);
    return descriptor;
  }

  /** `session/load`（agentCapabilities.loadSession）。 */
  async loadSession(params: { agentId: string; sessionId: string; cwd: string }): Promise<unknown> {
    const proc = await this.controlProcess(params.agentId, params.cwd);
    return proc.request("session/load", { sessionId: params.sessionId, cwd: params.cwd });
  }

  /** `session/fork`：从一条会话分叉出新会话。返回新会话的 ref（未挂进程）。 */
  async forkSession(ref: SessionRef): Promise<{ sessionRef: SessionRef; raw: unknown }> {
    const h = this.require(ref);
    const raw = await h.proc.request("session/fork", { sessionId: h.sessionId });
    const forked = String((raw as { sessionId?: unknown })?.sessionId ?? "");
    if (!forked) {
      throw new RpcError(ErrorCode.AgentError, "session/fork 没给新 sessionId", { response: raw });
    }
    return { sessionRef: makeSessionRef(h.agentId, forked), raw };
  }

  async listSessions(params: { agentId: string; cwd: string }): Promise<unknown[]> {
    const proc = await this.controlProcess(params.agentId, params.cwd);
    const res = await proc.request<{ sessions?: unknown[] }>("session/list", {
      cwd: params.cwd,
    });
    return Array.isArray(res?.sessions) ? res.sessions : [];
  }

  async closeSession(ref: SessionRef): Promise<void> {
    const h = this.sessions.get(ref);
    if (!h) return;
    try {
      if (h.descriptor.sessions.close) {
        await h.proc.request("session/close", { sessionId: h.sessionId });
      }
    } finally {
      this.sessions.delete(ref);
      await h.proc.stop();
      this.all.delete(h.proc);
      this.emit("session_closed", { sessionRef: ref, reason: "closed" });
    }
  }

  /**
   * 发一轮 prompt。回合期间 `turnActive=true`，投递阶梯靠它判断有没有活动回合。
   * 流式内容走 `session_update` 事件，这里只回最终的 stopReason。
   */
  async prompt(ref: SessionRef, prompt: unknown[]): Promise<unknown> {
    const h = this.require(ref);
    const turn: TurnInfo = {
      turnId: randomUUID(),
      sessionRef: ref,
      startedAt: Date.now(),
      injectable: false,
    };
    h.turns.set(turn.turnId, turn);
    h.turnActive = true;
    this.emit("turn_state", { sessionRef: ref, turnActive: true });
    // 回合边界是 core 自己知道的事（它在代理这个请求），合成成事件推给
    // 所有订阅者——没发 prompt 的那一端也看得到边界。不落盘。
    this.emit("turn_started", {
      sessionRef: ref,
      agentId: h.agentId,
      sessionId: h.sessionId,
      cwd: h.cwd,
      turnId: turn.turnId,
      startedAt: turn.startedAt,
    });
    let stopReason = "";
    let failure: unknown;
    try {
      // 先把快照拍完再发 prompt——钩子失败不挡回合（撤销不可用会如实标）。
      await Promise.resolve(
        this.opts.onTurnStart?.({
          sessionRef: ref,
          agentId: h.agentId,
          sessionId: h.sessionId,
          cwd: h.cwd,
          turnId: turn.turnId,
          startedAt: turn.startedAt,
        }),
      ).catch(() => undefined);
      const res = await h.proc.request("session/prompt", {
        sessionId: h.sessionId,
        prompt,
      });
      stopReason = String((res as { stopReason?: unknown })?.stopReason ?? "");
      return res;
    } catch (err) {
      failure = err;
      // agent 侧失败也是回合结束，如实报出来，不吞。
      stopReason = "error";
      throw err;
    } finally {
      h.turns.delete(turn.turnId);
      h.turnActive = h.turns.size > 0;
      this.emit("turn_state", { sessionRef: ref, turnActive: h.turnActive });
      this.emit("turn_finished", {
        sessionRef: ref,
        agentId: h.agentId,
        sessionId: h.sessionId,
        cwd: h.cwd,
        turnId: turn.turnId,
        startedAt: turn.startedAt,
        endedAt: Date.now(),
        stopReason,
        ...(failure ? { error: (failure as Error).message } : {}),
      });
    }
  }

  /** 收到会话流 → 该会话进行中的回合都算"目标已开口"。 */
  private markInjectable(ref: SessionRef): void {
    const h = this.sessions.get(ref);
    if (!h) return;
    for (const t of h.turns.values()) t.injectable = true;
  }

  /** 该会话最近开始、仍在跑的那个回合。 */
  currentTurn(ref: SessionRef): TurnInfo | undefined {
    const h = this.sessions.get(ref);
    if (!h) return undefined;
    let best: TurnInfo | undefined;
    for (const t of h.turns.values()) if (!best || t.startedAt > best.startedAt) best = t;
    return best;
  }

  /**
   * 等到目标"可注入"（收到本回合第一条 session/update）。
   * 没有进行中的回合、或等超时都回 false——调用方据此如实记账，不假装。
   */
  async awaitInjectable(ref: SessionRef, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const turn = this.currentTurn(ref);
      if (!turn) return false;
      if (turn.injectable) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => {
        const t = setTimeout(r, 50);
        t.unref?.();
      });
    }
  }

  async cancel(ref: SessionRef): Promise<void> {
    const h = this.require(ref);
    // ACP 的 session/cancel 是通知，不是请求。
    await h.proc.notify("session/cancel", { sessionId: h.sessionId });
  }

  async setMode(ref: SessionRef, modeId: string): Promise<unknown> {
    const h = this.require(ref);
    const res = await h.proc.request("session/set_mode", {
      sessionId: h.sessionId,
      modeId,
    });
    h.descriptor.currentModeId = modeId;
    return res;
  }

  async setConfigOption(ref: SessionRef, configId: string, value: string): Promise<unknown> {
    const h = this.require(ref);
    const res = await h.proc.request("session/set_config_option", {
      sessionId: h.sessionId,
      configId,
      value,
    });
    if (configId === "model") h.descriptor.currentModelId = value;
    if (configId === h.effortConfigId) h.descriptor.currentEffort = value;
    return res;
  }

  /** 任意扩展方法直发（`_session/steering` 等）。 */
  async sessionRequest<T = unknown>(
    ref: SessionRef,
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    const h = this.require(ref);
    return h.proc.request<T>(method, { sessionId: h.sessionId, ...params });
  }

  get(ref: SessionRef): SessionHandle | undefined {
    return this.sessions.get(ref);
  }

  require(ref: SessionRef): SessionHandle {
    const h = this.sessions.get(ref);
    if (!h) throw notFound(`没有这条会话：${ref}`);
    if (!h.proc.alive) throw notFound(`会话 ${ref} 的 agent 进程已退出`);
    return h;
  }

  openSessions(): SessionHandle[] {
    return [...this.sessions.values()];
  }

  /** 关停所有 agent 子进程。按 pid 定位，不用进程名。 */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const procs = [...this.all];
    this.sessions.clear();
    this.controls.clear();
    this.all.clear();
    await Promise.all(procs.map((p) => p.stop().catch(() => undefined)));
  }
}

/** 会话 cwd 在不在 git 仓库里——决定回合级撤销能不能用。 */
export async function revertCapabilityFor(cwd: string): Promise<RevertCapability> {
  const root = await gitRoot(cwd);
  return root
    ? { supported: "available", kind: "shell-git-snapshot" }
    : { supported: "unavailable", kind: "none", reason: "notGitRepo" };
}
