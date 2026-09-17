import { AcpKernel, makeSessionRef, parseSessionRef, type SessionRef } from "../acp/kernel.js";
import { DeliveryLadder, type DeliveryPref } from "../delivery/ladder.js";
import { DelegationBroker } from "../broker/delegate.js";
import { SessionGraph } from "../graph/sessionGraph.js";
import { ReaderRegistry } from "../read/registry.js";
import { paginate, TranscriptCache } from "../read/paging.js";
import { DescriptorCache } from "../descriptor/cache.js";
import { TurnSnapshotStore } from "../git/snapshot.js";
import { bootstrapFor, listBootstrap, resolveCommand } from "../descriptor/registry.js";
import { ApprovalHub, type ApprovalDecision } from "./approvals.js";
import { MethodRouter, type ClientSession } from "./rpc.js";
import { ErrorCode, RpcError, invalidParams, notFound } from "../errors.js";

export interface MethodDeps {
  kernel: AcpKernel;
  graph: SessionGraph;
  ladder: DeliveryLadder;
  broker: DelegationBroker;
  readers: ReaderRegistry;
  approvals: ApprovalHub;
  transcripts: TranscriptCache;
  descriptors: DescriptorCache;
  turns: TurnSnapshotStore;
  env: NodeJS.ProcessEnv;
  version: string;
  transports: () => { socketPath: string | null; wsPort: number | null };
  shutdown: () => Promise<void>;
}

/** 可订阅的推送主题。 */
export const TOPICS = [
  "session/update",
  "task/update",
  "permission/requested",
  "elicitation/requested",
  "agent/exit",
] as const;
export type Topic = (typeof TOPICS)[number];

function obj(params: unknown): Record<string, unknown> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw invalidParams("params 必须是对象");
  }
  return params as Record<string, unknown>;
}

function str(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  if (typeof v !== "string" || !v) throw invalidParams(`${key} 必须是非空字符串`);
  return v;
}

function optStr(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw invalidParams(`${key} 必须是字符串`);
  return v;
}

function optDelivery(params: Record<string, unknown>): DeliveryPref {
  const d = params.delivery;
  if (d === undefined || d === null) return {};
  if (typeof d !== "object" || Array.isArray(d)) throw invalidParams("delivery 必须是对象");
  return d as DeliveryPref;
}

function contentBlocks(params: Record<string, unknown>): unknown[] {
  if (Array.isArray(params.prompt)) return params.prompt;
  const text = params.text ?? params.message;
  if (typeof text === "string") return [{ type: "text", text }];
  throw invalidParams("要给 prompt（ContentBlock[]）或 text（字符串）");
}

export function buildRouter(deps: MethodDeps): MethodRouter {
  const r = new MethodRouter();

  // ── 基础 ──────────────────────────────────────────────────────────
  r.register("core/info", () => ({
    name: "@liangai/pulpo-core",
    version: deps.version,
    protocol: 1,
    pid: process.pid,
    transports: deps.transports(),
    topics: [...TOPICS],
  }));

  r.register("core/methods", () => ({ methods: r.list() }));

  r.register("core/shutdown", async () => {
    setTimeout(() => void deps.shutdown(), 10).unref();
    return { ok: true };
  });

  // ── 订阅 ──────────────────────────────────────────────────────────
  r.register("subscribe", (params, client: ClientSession) => {
    const p = obj(params);
    const topics = Array.isArray(p.topics) ? (p.topics as string[]) : [...TOPICS];
    for (const t of topics) {
      if (!(TOPICS as readonly string[]).includes(t)) {
        throw invalidParams(`未知主题：${t}。可选：${TOPICS.join(", ")}`);
      }
      client.subscriptions.add(t);
    }
    return { subscribed: [...client.subscriptions] };
  });

  r.register("unsubscribe", (params, client: ClientSession) => {
    const p = obj(params);
    const topics = Array.isArray(p.topics) ? (p.topics as string[]) : [...client.subscriptions];
    for (const t of topics) client.subscriptions.delete(t);
    return { subscribed: [...client.subscriptions] };
  });

  // ── agent / descriptor ───────────────────────────────────────────
  r.register("agent/list", () =>
    listBootstrap().map((b) => ({
      agentId: b.agentId,
      label: b.label,
      command: resolveCommand(b, { env: deps.env }),
      args: b.args,
      reader: b.reader,
      storage: b.storage,
    })),
  );

  // descriptor 三条来源，优先级 live > cached > probed。
  // 返回里一定带 `source`——UI 得知道这份能力是"此刻的"还是"上次的"。
  r.register("agent/descriptor", async (params) => {
    const p = obj(params);
    const agentId = str(p, "agentId");
    const boot = bootstrapFor(agentId);
    if (!boot) throw notFound(`未知 agent：${agentId}`);
    const open = deps.kernel
      .openSessions()
      .filter((h) => h.agentId === agentId)
      .sort((a, b) => b.createdAt - a.createdAt);
    const handle = p.sessionRef ? deps.kernel.require(str(p, "sessionRef")) : open[0];
    if (handle) return { ...handle.descriptor, source: "live" as const };

    const cached = deps.descriptors.get(agentId);
    if (cached && p.refresh !== true) {
      return { ...cached.descriptor, source: "cached" as const, cachedAt: cached.cachedAt };
    }
    // 连缓存都没有 → 现探一次：开一条会话读自描述、立刻关掉。
    const cwd = optStr(p, "cwd") ?? cached?.cwd;
    if (!cwd) {
      throw invalidParams(
        `${agentId} 既没有活动会话也没有缓存的自描述——请给 cwd，core 会现开一条会话探一次再关掉`,
      );
    }
    const descriptor = await deps.kernel.probeDescriptor(agentId, cwd);
    return { ...descriptor, source: "probed" as const };
  });

  // ── companion 身份 ───────────────────────────────────────────────
  // 注入进 agent 会话的 companion 用一次性令牌换"我在哪条会话里"。
  // 一层熔断靠这条：companion 拿到 sessionRef 之后，派活时如实填 callerRef。
  r.register("companion/identify", async (params) => {
    const p = obj(params);
    const token = str(p, "token");
    // 令牌可能比登记先到（注入发生在 session/new 应答之前）→ 等一小会儿。
    // 默认 30s，调用方可以压短（测试、或壳里的交互式探测）。
    const waitRaw = p.waitMs;
    if (waitRaw !== undefined && typeof waitRaw !== "number") {
      throw invalidParams("waitMs 必须是数字（毫秒）");
    }
    const waitMs = Math.max(0, Math.min(30_000, (waitRaw as number) ?? 30_000));
    const id = await deps.kernel.resolveCompanionToken(token, waitMs);
    if (!id) {
      throw notFound(
        `没有这个 companion 令牌（或它所在的会话还没建成）：${token.slice(0, 8)}…`,
      );
    }
    return { sessionRef: id.sessionRef, agentId: id.agentId, cwd: id.cwd };
  });

  // ── 会话生命周期 ──────────────────────────────────────────────────
  r.register("session/new", async (params) => {
    const p = obj(params);
    const handle = await deps.kernel.newSession({
      agentId: str(p, "agentId"),
      cwd: str(p, "cwd"),
      ...(Array.isArray(p.mcpServers) ? { mcpServers: p.mcpServers } : {}),
    });
    deps.graph.upsertNode({
      id: handle.ref,
      kind: "root",
      agentId: handle.agentId,
      sessionId: handle.sessionId,
      cwd: handle.cwd,
    });
    deps.graph.save();
    return {
      sessionRef: handle.ref,
      sessionId: handle.sessionId,
      agentId: handle.agentId,
      cwd: handle.cwd,
      descriptor: handle.descriptor,
      raw: handle.newSessionResponse,
    };
  });

  r.register("session/list", async (params) => {
    const p = obj(params);
    const sessions = await deps.kernel.listSessions({
      agentId: str(p, "agentId"),
      cwd: str(p, "cwd"),
    });
    return { sessions };
  });

  r.register("session/load", async (params) => {
    const p = obj(params);
    return deps.kernel.loadSession({
      agentId: str(p, "agentId"),
      sessionId: str(p, "sessionId"),
      cwd: str(p, "cwd"),
    });
  });

  r.register("session/resume", async (params) => {
    const p = obj(params);
    const ref = optStr(p, "sessionRef");
    const parsed = ref ? parseSessionRef(ref) : null;
    const handle = await deps.kernel.resumeSession({
      agentId: parsed?.agentId ?? str(p, "agentId"),
      sessionId: parsed?.sessionId ?? str(p, "sessionId"),
      cwd: str(p, "cwd"),
    });
    deps.graph.upsertNode({
      id: handle.ref,
      kind: deps.graph.getNode(handle.ref)?.kind ?? "root",
      agentId: handle.agentId,
      sessionId: handle.sessionId,
      cwd: handle.cwd,
    });
    deps.graph.save();
    return {
      sessionRef: handle.ref,
      descriptor: handle.descriptor,
      raw: handle.newSessionResponse,
    };
  });

  r.register("session/fork", async (params) => {
    const p = obj(params);
    return deps.kernel.forkSession(str(p, "sessionRef"));
  });

  r.register("session/close", async (params) => {
    const p = obj(params);
    await deps.kernel.closeSession(str(p, "sessionRef"));
    return { ok: true };
  });

  r.register("session/open", () =>
    deps.kernel.openSessions().map((h) => ({
      sessionRef: h.ref,
      agentId: h.agentId,
      sessionId: h.sessionId,
      cwd: h.cwd,
      turnActive: h.turnActive,
      createdAt: h.createdAt,
    })),
  );

  // ── 回合 ─────────────────────────────────────────────────────────
  r.register("session/prompt", async (params) => {
    const p = obj(params);
    return deps.kernel.prompt(str(p, "sessionRef"), contentBlocks(p));
  });

  r.register("session/cancel", async (params) => {
    const p = obj(params);
    const ref = str(p, "sessionRef");
    await deps.kernel.cancel(ref);
    deps.approvals.cancelForSession(ref);
    return { ok: true };
  });

  r.register("session/set_mode", async (params) => {
    const p = obj(params);
    return deps.kernel.setMode(str(p, "sessionRef"), str(p, "modeId"));
  });

  r.register("session/set_config_option", async (params) => {
    const p = obj(params);
    return deps.kernel.setConfigOption(str(p, "sessionRef"), str(p, "configId"), str(p, "value"));
  });

  r.register("session/request", async (params) => {
    const p = obj(params);
    const extra = (p.params ?? {}) as Record<string, unknown>;
    return deps.kernel.sessionRequest(str(p, "sessionRef"), str(p, "method"), extra);
  });

  // ── 投递阶梯 ─────────────────────────────────────────────────────
  r.register("delivery/send", async (params) => {
    const p = obj(params);
    const ref = str(p, "sessionRef");
    const receipt = await deps.ladder.deliver(ref, contentBlocks(p), optDelivery(p));
    const supplement: Parameters<SessionGraph["addSupplement"]>[0] = {
      from: optStr(p, "fromSessionRef") ?? null,
      to: ref,
      tier: receipt.tier,
      outcome: receipt.outcome,
    };
    const attribution = optStr(p, "attribution");
    if (attribution) supplement.attribution = attribution;
    deps.graph.addSupplement(supplement);
    deps.graph.save();
    return receipt;
  });

  r.register("delivery/queue", (params) => {
    const p = obj(params);
    return { queued: deps.ladder.queueFor(str(p, "sessionRef")) };
  });

  // ── 会话图 ───────────────────────────────────────────────────────
  r.register("graph/nodes", () => ({ nodes: deps.graph.listNodes() }));

  r.register("graph/edges", (params) => {
    const p = obj(params ?? {});
    const filter: Parameters<SessionGraph["listEdges"]>[0] = {};
    const kind = optStr(p, "kind");
    if (kind) filter.kind = kind as "delegate" | "supplement" | "result";
    const from = optStr(p, "from");
    if (from) filter.from = from;
    const to = optStr(p, "to");
    if (to) filter.to = to;
    const taskId = optStr(p, "taskId");
    if (taskId) filter.taskId = taskId;
    return { edges: deps.graph.listEdges(filter) };
  });

  r.register("graph/tree", (params) => {
    const p = obj(params);
    const tree = deps.graph.tree(str(p, "sessionRef"));
    if (!tree) throw notFound(`会话图里没有这个节点：${p.sessionRef}`);
    return tree;
  });

  // ── 读取层（只读、读穿）────────────────────────────────────────────
  r.register("read/list", async (params) => {
    const p = obj(params);
    const agentId = str(p, "agentId");
    const boot = bootstrapFor(agentId);
    if (!boot?.reader) throw new RpcError(ErrorCode.Unsupported, `${agentId} 没有读取器`);
    const cwd = str(p, "cwd");
    const reader = deps.readers.get(boot.reader, cwd);
    const limit = typeof p.limit === "number" ? p.limit : undefined;
    return {
      sessions: await reader.list({
        cwd,
        ...(limit === undefined ? {} : { limit }),
      }),
    };
  });

  // 分页。ZCode 读一条会话要 resume→read→close，几秒起步，所以
  // **一次读全量、内存里切页**，再加一个短 TTL 缓存让连续翻页不重复付这个代价。
  r.register("read/transcript", async (params) => {
    const p = obj(params);
    const ref = optStr(p, "sessionRef");
    const parsed = ref ? parseSessionRef(ref) : null;
    const agentId = parsed?.agentId ?? str(p, "agentId");
    const sessionId = parsed?.sessionId ?? str(p, "sessionId");
    const boot = bootstrapFor(agentId);
    if (!boot?.reader) throw new RpcError(ErrorCode.Unsupported, `${agentId} 没有读取器`);
    const cwd = str(p, "cwd");
    if (p.limit !== undefined && typeof p.limit !== "number") {
      throw invalidParams("limit 必须是数字");
    }
    const before = optStr(p, "before");
    const key = `${boot.reader}#${agentId}#${sessionId}#${cwd}`;
    const { transcript, cached } = await deps.transcripts.get(key, () =>
      deps.readers.get(boot.reader!, cwd).read(sessionId, { cwd }),
    );
    return paginate(
      transcript,
      {
        ...(p.limit === undefined ? {} : { limit: p.limit as number }),
        ...(before === undefined ? {} : { before }),
      },
      cached,
    );
  });

  // ── 派活 broker ──────────────────────────────────────────────────
  r.register("task/delegate", async (params) => {
    const p = obj(params);
    const args: Parameters<DelegationBroker["delegate"]>[0] = {
      agentId: str(p, "agentId"),
      task: str(p, "task"),
      cwd: str(p, "cwd"),
      delivery: optDelivery(p),
    };
    const modelId = optStr(p, "modelId");
    if (modelId) args.modelId = modelId;
    const effort = optStr(p, "effort");
    if (effort) args.effort = effort;
    const callerRef = optStr(p, "callerRef");
    if (callerRef) args.callerRef = callerRef;
    // 人从壳里派活时，壳把"当时打开的那条会话"填进来，右栏就能把派活层
    // 画在它下面。这不构成熔断关系。
    const fromSessionRef = optStr(p, "fromSessionRef");
    if (fromSessionRef) args.fromSessionRef = fromSessionRef;
    return deps.broker.delegate(args);
  });

  r.register("task/get", (params) => {
    const p = obj(params);
    return deps.broker.getTask(str(p, "taskId"));
  });

  r.register("task/list", (params) => {
    const p = obj(params ?? {});
    const filter: Parameters<DelegationBroker["listTasks"]>[0] = {};
    const status = optStr(p, "status");
    if (status) filter.status = status as Parameters<DelegationBroker["listTasks"]>[0] extends infer F ? F extends { status?: infer S } ? S : never : never;
    const parentRef = optStr(p, "parentRef");
    if (parentRef) filter.parentRef = parentRef;
    return { tasks: deps.broker.listTasks(filter) };
  });

  r.register("task/cancel", async (params) => {
    const p = obj(params);
    return deps.broker.cancelTask(str(p, "taskId"));
  });

  r.register("task/send_input", async (params) => {
    const p = obj(params);
    const taskId = optStr(p, "taskId");
    const sessionRef = optStr(p, "sessionRef");
    const target: { taskId?: string; sessionRef?: SessionRef } = {};
    if (taskId) target.taskId = taskId;
    if (sessionRef) target.sessionRef = sessionRef;
    const message = str(p, "message");
    return deps.broker.sendInput(target, message, optDelivery(p), optStr(p, "attribution"));
  });

  // ── 审批 ─────────────────────────────────────────────────────────
  r.register("permission/pending", () => ({ pending: deps.approvals.list() }));

  r.register("permission/respond", (params) => {
    const p = obj(params);
    const requestId = str(p, "requestId");
    const outcome = str(p, "outcome");
    let decision: ApprovalDecision;
    if (outcome === "selected") decision = { outcome: "selected", optionId: str(p, "optionId") };
    else if (outcome === "cancelled") decision = { outcome: "cancelled" };
    else throw invalidParams(`outcome 只能是 "selected" 或 "cancelled"，收到 ${outcome}`);
    const ok = deps.approvals.respond(requestId, decision);
    if (!ok) {
      throw new RpcError(
        ErrorCode.ApprovalTimeout,
        `审批请求 ${requestId} 已经结算过了（超时按默认拒绝，或已被其他客户端应答）`,
      );
    }
    return { ok: true };
  });

  // elicitation 的应答。和 permission/respond 分开：agent 问的是
  // 结构化问题，`content` 要原样回给它，只回一个 optionId 是答不全的。
  r.register("elicitation/respond", (params) => {
    const p = obj(params);
    const requestId = str(p, "requestId");
    const action = str(p, "action");
    if (action !== "accept" && action !== "decline" && action !== "cancel") {
      throw invalidParams(`action 只能是 accept / decline / cancel，收到 ${action}`);
    }
    const decision: ApprovalDecision =
      p.content === undefined
        ? { outcome: "elicit", action }
        : { outcome: "elicit", action, content: p.content };
    const ok = deps.approvals.respond(requestId, decision);
    if (!ok) {
      throw new RpcError(
        ErrorCode.ApprovalTimeout,
        `提问 ${requestId} 已经结算过了（超时按拒绝，或已被其他客户端应答）`,
      );
    }
    return { ok: true };
  });

  // ── 回合级文件改动 ────────────────────────────────────────────────
  r.register("session/changes", async (params) => {
    const p = obj(params);
    const sessionRef = str(p, "sessionRef");
    const args: Parameters<TurnSnapshotStore["changes"]>[0] = { sessionRef };
    const turnId = optStr(p, "turnId");
    if (turnId) args.turnId = turnId;
    if (p.all === true) args.all = true;
    if (p.includeDiff === true) args.includeDiff = true;
    if (Array.isArray(p.paths)) args.paths = p.paths.map((x) => String(x));
    return deps.turns.changes(args);
  });

  r.register("session/revert", async (params) => {
    const p = obj(params);
    const sessionRef = str(p, "sessionRef");
    const turnId = optStr(p, "turnId") ?? deps.turns.latest(sessionRef)?.turnId;
    if (!turnId) throw notFound(`这条会话没有任何回合快照：${sessionRef}`);
    const args: Parameters<TurnSnapshotStore["revert"]>[0] = { sessionRef, turnId };
    if (Array.isArray(p.paths)) args.paths = p.paths.map((x) => String(x));
    return deps.turns.revert(args);
  });

  return r;
}

export { makeSessionRef };
