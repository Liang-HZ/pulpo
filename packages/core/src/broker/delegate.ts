import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AcpKernel, SessionRef } from "../acp/kernel.js";
import type { DeliveryLadder, DeliveryPref, DeliveryReceipt } from "../delivery/ladder.js";
import { HUMAN_NODE, type SessionGraph } from "../graph/sessionGraph.js";
import type { CapabilityDescriptor } from "../descriptor/types.js";
import { ensureDir, stateDir } from "../paths.js";
import { ErrorCode, RpcError, invalidParams, notFound, recursionBlocked } from "../errors.js";

export type TaskStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "done"
  | "failed"
  | "cancelled";

/**
 * 任务用量。
 *
 * 来源两处：**agent 自己报的** `usage_update`（ZCode adapter 实测推
 * `{used, size, cost}`）+ core 自己数的工具调用次数。
 * **拿不到的字段一律省略**——右栏宁可整块不渲染，也不显示 `0 tok`。
 */
export interface TaskUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** 本回合里出现过的不同 `toolCallId` 数（core 数的）。 */
  toolCalls?: number;
  contextUsed?: number;
  contextTotal?: number;
}

export interface TaskRecord {
  taskId: string;
  agentId: string;
  sessionRef: SessionRef;
  /** 派活方会话；人直接从壳里派活时为 null（一层熔断只认这个）。 */
  parentRef: SessionRef | null;
  /**
   * 派活的发起方节点：agent 派活 = 它所在的会话；人从壳里派活 =
   * 壳当时打开的会话（`fromSessionRef`），都没有就是伪节点 `human`。
   * 会话图上的 delegate / result 边就挂在它上面（A）。
   */
  originRef: SessionRef;
  /** 谁发起的。`human` 不构成熔断关系。 */
  caller: "human" | "agent";
  task: string;
  cwd: string;
  modelId?: string;
  effort?: string;
  status: TaskStatus;
  /** 目标 agent 的最终回答（结论）。不存转录——转录读穿。 */
  summary?: string;
  /** agent 回的 stopReason。 */
  stopReason?: string;
  error?: string;
  /** 用量。没有任何一项时整个字段不给。 */
  usage?: TaskUsage;
  createdAt: number;
  updatedAt: number;
}

export interface DelegateResult {
  taskId: string;
  sessionRef: SessionRef;
  /** 目标会话的能力契约——派活回执带着它，调用方据此决定后续怎么投递。 */
  capabilityRef: CapabilityDescriptor;
}

interface TasksFile {
  version: 1;
  tasks: TaskRecord[];
}

/**
 * 派活 broker。
 *
 * 语义对齐原生四件套：spawn / send_input / poll / close。
 * **一层熔断**：调用方自己就是被派活的会话时，拒绝再往外派——错误码
 * `-32003`，`data.legacyExitCode = 3`（一层熔断的退出码）。
 */
export class DelegationBroker extends EventEmitter {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly file: string;

  constructor(
    private readonly deps: {
      kernel: AcpKernel;
      graph: SessionGraph;
      ladder: DeliveryLadder;
      env?: NodeJS.ProcessEnv;
      stateFile?: string;
    },
  ) {
    super();
    this.file =
      deps.stateFile ?? path.join(stateDir(deps.env ?? process.env), "tasks.json");
    this.load();
  }

  get filePath(): string {
    return this.file;
  }

  private load(): void {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, "utf8")) as TasksFile;
      if (j?.version === 1 && Array.isArray(j.tasks)) {
        for (const t of j.tasks) {
          // 上次 daemon 没善终留下的 running 任务，重启后不可能再收到结果。
          // 如实标成 failed，不装作还在跑。
          if (t.status === "running" || t.status === "queued" || t.status === "awaiting_approval") {
            t.status = "failed";
            t.error = "core 重启，任务状态丢失（薄状态不持有回合）";
          }
          // 旧格式（没有 originRef / caller）补齐，语义不变。
          if (!t.originRef) t.originRef = t.parentRef ?? HUMAN_NODE;
          if (!t.caller) t.caller = t.parentRef ? "agent" : "human";
          this.tasks.set(t.taskId, t);
        }
      }
    } catch {
      /* 没有文件就是没有历史任务 */
    }
  }

  save(): void {
    ensureDir(path.dirname(this.file));
    const payload: TasksFile = { version: 1, tasks: [...this.tasks.values()] };
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /**
   * 一层熔断判据。`callerRef` 是发起派活的那条会话。
   * 它若出现在任何一条 delegate 边的 child 位置，就是被派活方 → 拒绝。
   */
  assertMayDelegate(callerRef: SessionRef | null | undefined): void {
    if (!callerRef) return; // 人从壳里直接派活，不受限。
    if (this.deps.graph.isDelegationChild(callerRef)) throw recursionBlocked(callerRef);
  }

  async delegate(params: {
    agentId: string;
    task: string;
    cwd: string;
    modelId?: string;
    effort?: string;
    delivery?: DeliveryPref;
    /** 发起方会话。由 companion 填自己所在的会话，人直接派活时不填。 */
    callerRef?: SessionRef | null;
    /**
     * 人从壳里派活时，壳当时打开的那条会话。只用来把 delegate / result 边
     * 挂对地方（右栏画得出派活层），**不构成熔断关系**。
     */
    fromSessionRef?: SessionRef | null;
  }): Promise<DelegateResult> {
    if (!params.task?.trim()) throw invalidParams("task 不能为空");
    if (!path.isAbsolute(params.cwd)) throw invalidParams(`cwd 必须是绝对路径：${params.cwd}`);
    this.assertMayDelegate(params.callerRef);

    const handle = await this.deps.kernel.newSession({
      agentId: params.agentId,
      cwd: params.cwd,
    });

    // 模型与思考强度都走 agent 自己的 configOptions；壳不翻译、不兜底默认值。
    if (params.modelId) {
      const known = handle.descriptor.models.some((m) => m.id === params.modelId);
      if (!known) {
        await this.deps.kernel.closeSession(handle.ref);
        throw invalidParams(
          `${params.agentId} 不认识模型 ${params.modelId}；它自报的可选项：` +
            handle.descriptor.models.map((m) => m.id).join(", "),
        );
      }
      await this.deps.kernel.setConfigOption(handle.ref, "model", params.modelId);
    }
    if (params.effort) {
      const configId = handle.effortConfigId;
      if (!configId) {
        await this.deps.kernel.closeSession(handle.ref);
        throw new RpcError(
          ErrorCode.Unsupported,
          `${params.agentId} 没暴露思考强度配置项，无法按 effort=${params.effort} 派活`,
        );
      }
      if (handle.descriptor.efforts.length && !handle.descriptor.efforts.includes(params.effort)) {
        await this.deps.kernel.closeSession(handle.ref);
        throw invalidParams(
          `${params.agentId} 不认识思考强度 ${params.effort}；它自报的可选项：` +
            handle.descriptor.efforts.join(", "),
        );
      }
      await this.deps.kernel.setConfigOption(handle.ref, configId, params.effort);
    }

    const taskId = randomUUID();
    const now = Date.now();
    const caller: "human" | "agent" = params.callerRef ? "agent" : "human";
    const originRef: SessionRef = params.callerRef ?? params.fromSessionRef ?? HUMAN_NODE;
    const record: TaskRecord = {
      taskId,
      agentId: params.agentId,
      sessionRef: handle.ref,
      parentRef: params.callerRef ?? null,
      originRef,
      caller,
      task: params.task,
      cwd: params.cwd,
      status: "running",
      createdAt: now,
      updatedAt: now,
    };
    if (params.modelId) record.modelId = params.modelId;
    if (params.effort) record.effort = params.effort;
    this.tasks.set(taskId, record);

    // 会话图：目标节点 + delegate 边。**人派活也建边**（A）——右栏要画得出
    // 派活层。区别只在 `via`：`human` 的边不构成熔断关系，所以人派出来的
    // 会话自己还能再派（一层熔断只管 agent 之间）。
    if (caller === "human" && originRef === HUMAN_NODE && !this.deps.graph.getNode(HUMAN_NODE)) {
      this.deps.graph.upsertNode({
        id: HUMAN_NODE,
        kind: "root",
        agentId: "human",
        sessionId: HUMAN_NODE,
        title: "人（从壳里派活）",
      });
    }
    this.deps.graph.upsertNode({
      id: handle.ref,
      kind: "delegation-child",
      agentId: params.agentId,
      sessionId: handle.sessionId,
      cwd: params.cwd,
      title: params.task.slice(0, 60),
    });
    {
      const edge: Parameters<SessionGraph["addDelegate"]>[0] = {
        from: originRef,
        to: handle.ref,
        via: caller,
        taskId,
        task: params.task,
      };
      if (params.modelId) edge.modelId = params.modelId;
      if (params.effort) edge.effort = params.effort;
      this.deps.graph.addDelegate(edge);
    }
    this.deps.graph.save();
    this.save();
    this.emitTask(record);

    // 回合异步跑：delegate 立刻返回 taskId，结论由 getTask 轮询或订阅拿。
    void this.runTurn(taskId, handle.ref, params.task);

    return { taskId, sessionRef: handle.ref, capabilityRef: handle.descriptor };
  }

  private async runTurn(taskId: string, ref: SessionRef, text: string): Promise<void> {
    const chunks: string[] = [];
    const toolCallIds = new Set<string>();
    const onUpdate = (e: { sessionRef?: string; sessionId?: string; agentId?: string; update?: unknown }) => {
      const evRef = e.sessionRef ?? `${e.agentId}#${e.sessionId}`;
      if (evRef !== ref) return;
      const u = e.update as
        | {
            sessionUpdate?: string;
            content?: { text?: string };
            toolCallId?: string;
            used?: unknown;
            size?: unknown;
            inputTokens?: unknown;
            outputTokens?: unknown;
            usage?: Record<string, unknown>;
          }
        | undefined;
      if (u?.sessionUpdate === "agent_message_chunk" && typeof u.content?.text === "string") {
        chunks.push(u.content.text);
      }
      // 工具调用次数由 core 自己数（按不同的 toolCallId 去重）。
      if (
        (u?.sessionUpdate === "tool_call" || u?.sessionUpdate === "tool_call_update") &&
        typeof u.toolCallId === "string"
      ) {
        toolCallIds.add(u.toolCallId);
        this.mergeUsage(taskId, { toolCalls: toolCallIds.size });
      }
      // agent 自己报的用量。ZCode adapter 推的是 `usage_update {used,size,cost}`；
      // 别家给 inputTokens/outputTokens 的也照收。拿不到的字段不补 0。
      if (u?.sessionUpdate === "usage_update") {
        this.mergeUsage(taskId, readUsage(u));
      }
    };
    this.deps.kernel.on("session_update", onUpdate);
    try {
      const res = await this.deps.kernel.prompt(ref, [{ type: "text", text }]);
      const stopReason = String((res as { stopReason?: unknown })?.stopReason ?? "");
      this.update(taskId, {
        status: stopReason === "cancelled" ? "cancelled" : "done",
        stopReason,
        summary: chunks.join(""),
      });
      const t = this.tasks.get(taskId);
      if (t) {
        const resultEdge: Parameters<SessionGraph["addResult"]>[0] = {
          from: ref,
          to: t.originRef,
          taskId,
          status: stopReason === "cancelled" ? "cancelled" : "done",
          nativeSessionRef: ref,
        };
        if (t.summary) resultEdge.summary = t.summary;
        this.deps.graph.addResult(resultEdge);
        this.deps.graph.save();
      }
    } catch (err) {
      this.update(taskId, { status: "failed", error: (err as Error).message });
    } finally {
      this.deps.kernel.off("session_update", onUpdate);
      // 回合结束 → drain 排队的补充消息（档 5 的 drainAt: turnEnd）。
      const queued = this.deps.ladder.drain(ref);
      for (const q of queued) {
        void this.deps.ladder.deliver(ref, q.content, { startTurnIfIdle: true }).catch(() => undefined);
      }
    }
  }

  /**
   * 合并一份用量。**空字段不写**——`undefined` 表示"没拿到"，
   * 不是 0。改的是登记里的记录本身，`task/get` 随时读到最新值。
   */
  private mergeUsage(taskId: string, patch: TaskUsage): void {
    const t = this.tasks.get(taskId);
    if (!t) return;
    const next: TaskUsage = { ...(t.usage ?? {}) };
    let changed = false;
    for (const [k, v] of Object.entries(patch) as [keyof TaskUsage, number | undefined][]) {
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      if (next[k] === v) continue;
      next[k] = v;
      changed = true;
    }
    if (!changed) return;
    t.usage = next;
    t.updatedAt = Date.now();
  }

  private update(taskId: string, patch: Partial<TaskRecord>): void {
    const t = this.tasks.get(taskId);
    if (!t) return;
    Object.assign(t, patch, { updatedAt: Date.now() });
    this.save();
    this.emitTask(t);
  }

  /** 审批挂起 / 解除时由上层调用，让 getTask 的状态如实。 */
  markAwaitingApproval(ref: SessionRef, awaiting: boolean): void {
    for (const t of this.tasks.values()) {
      if (t.sessionRef !== ref) continue;
      if (awaiting && t.status === "running") this.update(t.taskId, { status: "awaiting_approval" });
      else if (!awaiting && t.status === "awaiting_approval") this.update(t.taskId, { status: "running" });
    }
  }

  private emitTask(t: TaskRecord): void {
    this.emit("task_update", { ...t });
  }

  getTask(taskId: string): TaskRecord {
    const t = this.tasks.get(taskId);
    if (!t) throw notFound(`没有这个任务：${taskId}`);
    return { ...t };
  }

  listTasks(filter?: { status?: TaskStatus; parentRef?: SessionRef }): TaskRecord[] {
    return [...this.tasks.values()]
      .filter((t) => (filter?.status ? t.status === filter.status : true))
      .filter((t) => (filter?.parentRef ? t.parentRef === filter.parentRef : true))
      .map((t) => ({ ...t }));
  }

  async cancelTask(taskId: string): Promise<{ ok: boolean }> {
    const t = this.tasks.get(taskId);
    if (!t) throw notFound(`没有这个任务：${taskId}`);
    if (t.status === "done" || t.status === "failed" || t.status === "cancelled") {
      return { ok: false };
    }
    await this.deps.kernel.cancel(t.sessionRef);
    this.update(taskId, { status: "cancelled" });
    return { ok: true };
  }

  /** 给任务所在会话补一条消息，走投递阶梯，回执如实。 */
  async sendInput(
    target: { taskId?: string; sessionRef?: SessionRef },
    message: string,
    delivery?: DeliveryPref,
    attribution?: string,
  ): Promise<DeliveryReceipt> {
    let ref: SessionRef | undefined = target.sessionRef;
    let parentRef: SessionRef | null = null;
    if (target.taskId) {
      const t = this.tasks.get(target.taskId);
      if (!t) throw notFound(`没有这个任务：${target.taskId}`);
      ref = t.sessionRef;
      // 补充消息的来源：agent 派活时是派活方会话，人派活时是发起节点（`human`
      // 或壳当时打开的会话）——两种都要记，右栏才画得全。
      parentRef = t.parentRef ?? t.originRef;
    }
    if (!ref) throw invalidParams("要给 taskId 或 sessionRef 其中之一");

    // 归属标注：补充消息写进目标会话时标明来源，原生端可见。
    const text = attribution ? `[${attribution}]\n${message}` : message;
    const receipt = await this.deps.ladder.deliver(ref, [{ type: "text", text }], delivery ?? {});
    const supplement: Parameters<SessionGraph["addSupplement"]>[0] = {
      from: parentRef,
      to: ref,
      tier: receipt.tier,
      outcome: receipt.outcome,
    };
    if (attribution) supplement.attribution = attribution;
    this.deps.graph.addSupplement(supplement);
    this.deps.graph.save();
    return receipt;
  }
}

/**
 * agent 的 `usage_update` → `TaskUsage`。认不出来的字段一律不给。
 *
 * **0 一律当"没报"丢掉**，这不是保守，是实测：zcode-acp 的 `_fetch_usage()`
 * 写的是 `used = u.get("totalTokens", 0)`，`_send_usage()` 写的是
 * `"used": u.get("used", 0)` —— 引擎没给数时会原样推一个字面量 0 上来。
 * 真回合不可能消耗 0 token，所以这个 0 的含义是"没拿到"，不是"测到 0"。
 * 把它收进 usage 就会让右栏显示 `0 tok`，而这是不允许出现的东西。
 */
export function readUsage(update: Record<string, unknown>): TaskUsage {
  const u = (update.usage as Record<string, unknown> | undefined) ?? update;
  const out: TaskUsage = {};
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
  const contextUsed = num(u.used) ?? num(u.contextUsed) ?? num(u.totalTokens);
  const contextTotal = num(u.size) ?? num(u.contextTotal) ?? num(u.contextWindow);
  const inputTokens = num(u.inputTokens) ?? num(u.input);
  const outputTokens = num(u.outputTokens) ?? num(u.output);
  if (contextUsed !== undefined) out.contextUsed = contextUsed;
  if (contextTotal !== undefined) out.contextTotal = contextTotal;
  if (inputTokens !== undefined) out.inputTokens = inputTokens;
  if (outputTokens !== undefined) out.outputTokens = outputTokens;
  return out;
}
