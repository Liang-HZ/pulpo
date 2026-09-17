// 壳的全部状态。一个 useSyncExternalStore 的 store 包住 JSON-RPC 客户端——
// 不上状态库、不上路由：整个壳只有一屏，状态就是"core 说了什么"。

import {
  appendNotice,
  appendUser,
  applyUpdate,
  attachReceipt,
  beginTurn,
  emptyChat,
  endTurn,
  markReverted,
  markRunningStopped,
  markToolDenied,
  type ChatItem,
  type ChatState,
} from "./chat";
import { loadSeen, markSeen } from "./viewstate";
import { RpcClient, RpcError, splitRef, type ConnectionState } from "./rpc";
import { coreUrl, loadRememberedCwds, rememberCwd } from "../platform";
import type {
  AgentEntry,
  AgentSessionInfo,
  ChangeStat,
  CapabilityDescriptor,
  ConfigOption,
  DeliveryReceipt,
  ElicitationRequested,
  GraphEdge,
  GraphNode,
  GraphTreeNode,
  QueuedMessage,
  NewSessionResult,
  RevertResult,
  SessionChanges,
  OpenSession,
  PermissionMeta,
  PermissionOption,
  PermissionRequested,
  ReadSessionSummary,
  SessionRef,
  SessionUpdateNotification,
  TaskRecord,
  TranscriptPage,
} from "./protocol";
import { ERROR } from "./protocol";

export type LoadPhase = "idle" | "loading" | "ready" | "error";

export interface DirectoryRow {
  agentId: string;
  cwd: string;
  /** ACP 面的 sessionId（带 adapter 前缀），resume 用这个 */
  acpSessionId: string | null;
  /** 读取层的原生 sessionId（不带前缀），read/transcript 用这个 */
  nativeSessionId: string | null;
  title: string;
  updatedAt: number | null;
  live: boolean;
}

export interface Approval {
  key: string;
  type: "permission" | "elicitation";
  requestId: string | null;
  sessionRef: SessionRef;
  agentId: string;
  title: string;
  /** 这次授权对应的工具卡。拒绝之后那张卡要进 `denied` 本地态。 */
  toolCallId: string | null;
  toolKind: string | null;
  /** 涉及的文件（最多渲染 5 个 chip，多余的收成 +N） */
  files: string[];
  /** agent 自带的 `_meta.permission`：强调哪一项、授权范围说明 */
  meta: PermissionMeta | null;
  /** 还排着几条。没有这个字段就不渲染角标。 */
  queueDepth: number | null;
  rawInput: unknown;
  options: PermissionOption[];
  fields: Array<{ name: string; title: string; description?: string; required: boolean }>;
  message?: string;
  createdAt: number;
  expiresAt: number | null;
}

export interface AppState {
  connection: ConnectionState;
  coreVersion: string | null;
  agents: AgentEntry[];
  agentsPhase: LoadPhase;
  openSessions: OpenSession[];
  cwds: string[];
  /** key 见 dirKey() */
  directories: Record<string, DirectoryRow[]>;
  directoryPhase: Record<string, LoadPhase>;
  directoryError: Record<string, string>;
  activeRef: SessionRef | null;
  chats: Record<SessionRef, ChatState>;
  transcriptPhase: Record<SessionRef, LoadPhase>;
  /**
   * 还有更早的消息时是游标（可能是 null = 有更多但 core 没给游标），
   * 没有更早的就是 undefined。UI 据此决定要不要显示「加载更早消息」。
   */
  transcriptCursor: Record<SessionRef, string | null | undefined>;
  /**
   * `sessionRef` → 读取层的**原生** sessionId。
   * ACP 面的 id 带 adapter 前缀（`zc-sess_x`），读取层要的是原生 id（`sess_x`）——
   * 拿错了 `read/transcript` 会以 `Session not found` 失败。
   */
  nativeIds: Record<SessionRef, string>;
  descriptors: Record<SessionRef, CapabilityDescriptor>;
  /** 每个渠道最近一次拿到的 descriptor（派活表单读模型/强度用） */
  agentDescriptors: Record<string, CapabilityDescriptor>;
  agentDescriptorError: Record<string, string>;
  configOptions: Record<SessionRef, ConfigOption[]>;
  turnActive: Record<SessionRef, boolean>;
  tasks: TaskRecord[];
  trees: Record<SessionRef, GraphTreeNode>;
  /** 轨迹树读失败的原因（-32001 "还没进图"是正常的，不算错）。右栏据此给一行的错误 + 重试。 */
  treeErrors: Record<SessionRef, string>;
  /** 壳内排队、还没投给 agent 的补充消息（`delivery/queue`） */
  queued: Record<SessionRef, QueuedMessage[]>;
  /** 会话图上的边：谁派给谁、每条补充消息的档位与回执、结论落在哪（`graph/edges`） */
  edges: GraphEdge[];
  approvals: Approval[];
  /** taskId → 最近一次补充消息的回执。放 store 里而不是组件里：任务状态一变，
      条目会从「进行中」挪到「已结束」，组件重挂时回执不该跟着消失。 */
  taskReceipts: Record<string, DeliveryReceipt>;
  /** 结算后的审批记录。卡片**不消失**，收成一行「已允许 / 已拒绝 · 12:04」。 */
  approvalLog: Array<{
    key: string;
    sessionRef: SessionRef;
    title: string;
    decision: string;
    at: number;
  }>;
  /** 会话本地的"我上次看到哪"游标。客户端视图状态，不是会话内容。 */
  seen: Record<string, number>;
  /** 展开文件改动汇总卡时才拉的逐文件明细 */
  changes: Record<string, SessionChanges>;
  changesPhase: Record<string, LoadPhase>;
  changesError: Record<string, string>;
  busy: Record<string, boolean>;
  /** 最近一条失败原因，横幅显示，用户可关掉 */
  banner: { text: string; tone: "warn" | "bad" } | null;
}

export const dirKey = (agentId: string, cwd: string): string => `${agentId}::${cwd}`;

function initialState(): AppState {
  return {
    connection: { phase: "connecting", attempt: 0, lastError: null, retryAt: null },
    coreVersion: null,
    agents: [],
    agentsPhase: "idle",
    openSessions: [],
    cwds: loadRememberedCwds(),
    directories: {},
    directoryPhase: {},
    directoryError: {},
    activeRef: null,
    chats: {},
    transcriptPhase: {},
    transcriptCursor: {},
    nativeIds: {},
    descriptors: {},
    agentDescriptors: {},
    agentDescriptorError: {},
    configOptions: {},
    turnActive: {},
    tasks: [],
    trees: {},
    treeErrors: {},
    queued: {},
    edges: [],
    approvals: [],
    taskReceipts: {},
    approvalLog: [],
    seen: loadSeen(),
    changes: {},
    changesPhase: {},
    changesError: {},
    busy: {},
    banner: null,
  };
}

export class AppStore {
  private state = initialState();
  private readonly listeners = new Set<() => void>();
  readonly rpc: RpcClient;

  constructor(url: string = coreUrl(), WebSocketCtor?: typeof WebSocket) {
    this.rpc = new RpcClient({
      url,
      ...(WebSocketCtor ? { WebSocketCtor } : {}),
    });
    this.rpc.onStateChange((connection) => {
      const wasOpen = this.state.connection.phase === "open";
      this.patch({ connection });
      if (connection.phase === "open") void this.bootstrap();
      else if (wasOpen)
        this.patch({ banner: { text: connection.lastError ?? "连接断开", tone: "bad" } });
    });
    this.wireNotifications();
  }

  // ── store 接口 ────────────────────────────────────────────────────────────
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): AppState => this.state;

  private patch(partial: Partial<AppState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener();
  }

  private setBusy(key: string, value: boolean): void {
    this.patch({ busy: { ...this.state.busy, [key]: value } });
  }

  private fail(where: string, err: unknown): void {
    const text =
      err instanceof RpcError
        ? `${where}：${err.message}（code ${err.code}）`
        : err instanceof Error
          ? `${where}：${err.message}`
          : `${where}：${String(err)}`;
    this.patch({ banner: { text, tone: "bad" } });
  }

  dismissBanner = (): void => this.patch({ banner: null });

  start(): void {
    this.rpc.connect();
  }

  stop(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.rpc.close();
  }

  // ── 流式节流 ──────────────────────────────────────────────────────────────
  private pending: SessionUpdateNotification[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * core 有没有发过回合边界通知。发过就以它为准；没发过（老 core）时
   * `send` 在本地合成一对边界——否则「已工作 …」那一行和文件改动汇总卡就没有依附点。
   */
  private sawTurnNotification = false;

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => this.flushUpdates(), 16);
  }

  /** 把押着的 chunk 合并后一次性并进 state。测试与 turn 通知会直接调它。 */
  flushUpdates = (): void => {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pending.length === 0) return;
    const batch = coalesceUpdates(this.pending);
    this.pending = [];
    const at = Date.now();
    const chats = { ...this.state.chats };
    let configOptions = this.state.configOptions;
    const spawned = new Set<SessionRef>();
    for (const item of batch) {
      // 通知可能先于 session/new 的应答到达（实测：available_commands_update 与
      // current_mode_update 在 session/new 返回之前就推过来了），所以按需建槽。
      const next = applyUpdate(
        chats[item.sessionRef] ?? emptyChat(),
        item.update!,
        at,
        item.derived,
      );
      chats[item.sessionRef] = next;
      if (item.update!.sessionUpdate === "subagent_spawned") spawned.add(item.sessionRef);
      if (item.update!.sessionUpdate === "config_option_update" && next.configOptions) {
        configOptions = { ...configOptions, [item.sessionRef]: next.configOptions };
      }
    }
    this.patch({ chats, configOptions });
    for (const ref of spawned) void this.refreshTree(ref);
  };

  /** `derived.event` = `turn_started` / `turn_finished`（PROTOCOL §5） */
  private applyTurnEvent(params: SessionUpdateNotification): void {
    const d = params.derived;
    if (!d?.turnId) return;
    this.sawTurnNotification = true;
    const ref = params.sessionRef;
    const chat = this.state.chats[ref] ?? emptyChat();
    if (d.event === "turn_started") {
      this.patch({
        chats: { ...this.state.chats, [ref]: beginTurn(chat, d.turnId, d.startedAt ?? Date.now()) },
        turnActive: { ...this.state.turnActive, [ref]: true },
      });
      return;
    }
    this.patch({
      chats: {
        ...this.state.chats,
        [ref]: endTurn(chat, {
          turnId: d.turnId,
          ...(d.stopReason ? { stopReason: d.stopReason } : {}),
          endedAt: d.endedAt ?? Date.now(),
          ...(d.changes ? { changes: d.changes } : {}),
        }),
      },
      turnActive: { ...this.state.turnActive, [ref]: false },
    });
  }

  // ── 通知 ──────────────────────────────────────────────────────────────────
  private wireNotifications(): void {
    // 流式节流：chunk 不直接进 state，先押进队列，16ms 一次 flush，
    // 或攒到 256 条立刻 flush；flush 前把**连续的、同 type 同 sessionRef** 的文本 chunk
    // 先字符串拼接。三条缺一不可——只节流不合并，reducer 还是会跑几百次。
    //
    // 回合边界走同一条通道但**没有 `update` 字段**（PROTOCOL §5）：
    // 有 `update` = agent 原文，有 `derived.event` = 壳内合成事件。
    this.rpc.on<SessionUpdateNotification>("session/update", (params) => {
      if (!params?.sessionRef) return;
      if (params.derived?.event) {
        this.flushUpdates();
        this.applyTurnEvent(params);
        return;
      }
      if (!params.update) return;
      this.pending.push(params);
      if (this.pending.length >= 256) this.flushUpdates();
      else this.scheduleFlush();
    });

    this.rpc.on<TaskRecord>("task/update", (task) => {
      if (!task?.taskId) return;
      const rest = this.state.tasks.filter((t) => t.taskId !== task.taskId);
      this.patch({ tasks: [...rest, task].sort((a, b) => a.createdAt - b.createdAt) });
      // 子会话的轨迹树与父会话的轨迹树都要跟着变：状态一变，右栏两处都得重画。
      void this.refreshTree(task.sessionRef);
      if (task.parentRef) void this.refreshTree(task.parentRef);
      if (task.status === "done" || task.status === "failed" || task.status === "cancelled") {
        void this.refreshDirectory(task.agentId, task.cwd);
      }
    });

    this.rpc.on<PermissionRequested>("permission/requested", (params) => {
      if (!params?.requestId) return;
      this.patch({ approvals: [...this.state.approvals, toApproval(params)] });
    });

    this.rpc.on<ElicitationRequested>("elicitation/requested", (params) => {
      if (!params) return;
      void this.absorbElicitation(params);
    });

    this.rpc.on<{ agentId: string; code: number | null; signal: string | null }>(
      "agent/exit",
      (params) => {
        this.patch({
          banner: {
            text: `${params.agentId} 进程已退出（code=${params.code ?? "null"}${
              params.signal ? `, signal=${params.signal}` : ""
            }），它上面的会话已从在册列表里消失`,
            tone: "warn",
          },
        });
        void this.refreshOpen();
      },
    );
  }

  /**
   * `elicitation/requested` 的 params 里不一定带 requestId（PROTOCOL §5 没承诺），
   * 所以拿到通知后回查一次 `permission/pending` 把 requestId 对上——对不上就不渲染
   * 应答按钮，而不是编一个 id 出来。
   */
  private async absorbElicitation(params: ElicitationRequested): Promise<void> {
    let requestId = params.requestId ?? null;
    let options: PermissionOption[] = [];
    try {
      const res = await this.rpc.call<{ pending: PermissionRequested[] }>("permission/pending");
      const match =
        res.pending.find((p) => p.requestId === requestId) ??
        res.pending.find((p) => p.sessionRef === params.sessionRef);
      requestId = match?.requestId ?? requestId;
      options = match?.options ?? [];
    } catch {
      // 查不到就按"没有可选项"渲染，卡片会如实说明只剩拒绝这条路
    }
    this.patch({
      approvals: [
        ...this.state.approvals,
        elicitationApproval({
          requestId,
          sessionRef: params.sessionRef,
          agentId: params.agentId,
          ...(params.params ? { params: params.params } : {}),
          options,
        }),
      ],
    });
  }

  // ── 启动与刷新 ────────────────────────────────────────────────────────────
  /** 每次连上（含重连）都要重跑：订阅是**每连接独立**的，不跨连接共享。 */
  private async bootstrap(): Promise<void> {
    try {
      await this.rpc.call("subscribe");
      const info = await this.rpc.call<{ version: string }>("core/info");
      this.patch({ coreVersion: info.version, agentsPhase: "loading" });
      const agents = await this.rpc.call<AgentEntry[]>("agent/list");
      this.patch({ agents, agentsPhase: "ready" });
      await Promise.all([
        this.refreshOpen(),
        this.refreshTasks(),
        this.refreshApprovals(),
        this.refreshEdges(),
      ]);
      for (const agent of agents) void this.refreshAgentDescriptor(agent.agentId);
      for (const cwd of this.state.cwds) {
        for (const agent of agents) void this.refreshDirectory(agent.agentId, cwd);
      }
    } catch (err) {
      this.patch({ agentsPhase: "error" });
      this.fail("连上 core 后的初始化失败", err);
    }
  }

  private async refreshApprovals(): Promise<void> {
    try {
      const res = await this.rpc.call<{ pending: PermissionRequested[] }>("permission/pending");
      // `permission/pending` 里既有审批也有追问（PROTOCOL §5：`kind: "elicitation"`）。
      // 追问不能按审批渲染——那样会得到一张没有按钮的死卡片。
      const approvals = res.pending.map<Approval>((p) =>
        p.kind === "elicitation"
          ? elicitationApproval({
              requestId: p.requestId,
              sessionRef: p.sessionRef,
              agentId: p.agentId,
              ...(p.params ? { params: p.params } : {}),
              ...(p.options ? { options: p.options } : {}),
              expiresAt: p.expiresAt ?? null,
            })
          : toApproval(p),
      );
      this.patch({ approvals });
    } catch (err) {
      this.fail("读待审批列表失败", err);
    }
  }

  async refreshOpen(): Promise<void> {
    try {
      const [openSessions, graph] = await Promise.all([
        this.rpc.call<OpenSession[]>("session/open"),
        this.rpc.call<{ nodes: GraphNode[] }>("graph/nodes"),
      ]);
      const turnActive: Record<string, boolean> = { ...this.state.turnActive };
      for (const s of openSessions) turnActive[s.sessionRef] = s.turnActive;
      const cwds = dedupe([
        ...openSessions.map((s) => s.cwd),
        ...graph.nodes.map((n) => n.cwd).filter((c): c is string => Boolean(c)),
        ...this.state.cwds,
      ]);
      this.patch({ openSessions, turnActive, cwds });
      // 壳内队列是重连/重开之后也该看得见的东西，跟着在册会话一起刷新
      if (this.state.activeRef) void this.refreshQueue(this.state.activeRef);
    } catch (err) {
      this.fail("读在册会话失败", err);
    }
  }

  async refreshTasks(): Promise<void> {
    try {
      const res = await this.rpc.call<{ tasks: TaskRecord[] }>("task/list");
      this.patch({ tasks: [...res.tasks].sort((a, b) => a.createdAt - b.createdAt) });
    } catch (err) {
      this.fail("读派活任务失败", err);
    }
  }

  async refreshEdges(): Promise<void> {
    try {
      const res = await this.rpc.call<{ edges: GraphEdge[] }>("graph/edges");
      this.patch({ edges: [...res.edges].sort((a, b) => b.createdAt - a.createdAt) });
    } catch (err) {
      this.fail("读会话图的边失败", err);
    }
  }

  /** 壳内队列：`queued` 回执说"还没到 agent"，这里就是那些消息的去处。 */
  async refreshQueue(sessionRef: SessionRef): Promise<void> {
    try {
      const res = await this.rpc.call<{ queued: QueuedMessage[] }>("delivery/queue", {
        sessionRef,
      });
      this.patch({ queued: { ...this.state.queued, [sessionRef]: res.queued } });
    } catch {
      // 会话不在册时报 -32001，属正常，不打扰用户
    }
  }

  async refreshTree(sessionRef: SessionRef): Promise<void> {
    try {
      const tree = await this.rpc.call<GraphTreeNode>("graph/tree", { sessionRef });
      const errors = { ...this.state.treeErrors };
      delete errors[sessionRef];
      this.patch({ trees: { ...this.state.trees, [sessionRef]: tree }, treeErrors: errors });
    } catch (err) {
      // 节点还没进图（-32001）是正常的，不打扰用户；别的错如实记下来，右栏给一行重试。
      if (err instanceof RpcError && err.code === ERROR.NotFound) return;
      this.patch({
        treeErrors: {
          ...this.state.treeErrors,
          [sessionRef]: err instanceof RpcError ? err.message : String(err),
        },
      });
    }
  }

  async refreshAgentDescriptor(agentId: string): Promise<void> {
    try {
      const descriptor = await this.rpc.call<CapabilityDescriptor>("agent/descriptor", { agentId });
      const errors = { ...this.state.agentDescriptorError };
      delete errors[agentId];
      this.patch({
        agentDescriptors: { ...this.state.agentDescriptors, [agentId]: descriptor },
        agentDescriptorError: errors,
      });
    } catch (err) {
      // -32001 = 该渠道还没有活动会话。descriptor 的 models / efforts 来自 session/new
      // 的自描述，没有会话就没有这些事实——如实告诉用户，不编一份默认值出来。
      this.patch({
        agentDescriptorError: {
          ...this.state.agentDescriptorError,
          [agentId]: err instanceof RpcError ? err.message : String(err),
        },
      });
    }
  }

  // ── 会话列表 ──────────────────────────────────────────────────────────────
  addCwd = (cwd: string): void => {
    const trimmed = cwd.trim();
    if (!trimmed) return;
    rememberCwd(trimmed);
    this.patch({ cwds: dedupe([trimmed, ...this.state.cwds]) });
    for (const agent of this.state.agents) void this.refreshDirectory(agent.agentId, trimmed);
  };

  /**
   * 一个目录下的会话列表 = `session/list`（给得出可 resume 的 ACP id）
   * 与 `read/list`（给得出读取层的原生 id、时间戳与状态）按 id 后缀对齐后的并集。
   * 两边的 id 写法不同（ACP 面带 adapter 前缀），这里不建映射表，只按后缀对上。
   */
  async refreshDirectory(agentId: string, cwd: string): Promise<void> {
    const key = dirKey(agentId, cwd);
    this.patch({ directoryPhase: { ...this.state.directoryPhase, [key]: "loading" } });
    const [listed, read] = await Promise.allSettled([
      this.rpc.call<{ sessions: AgentSessionInfo[] }>("session/list", { agentId, cwd }),
      this.rpc.call<{ sessions: ReadSessionSummary[] }>("read/list", { agentId, cwd, limit: 50 }),
    ]);
    if (listed.status === "rejected" && read.status === "rejected") {
      const reason =
        listed.reason instanceof Error ? listed.reason.message : String(listed.reason);
      this.patch({
        directoryPhase: { ...this.state.directoryPhase, [key]: "error" },
        directoryError: { ...this.state.directoryError, [key]: reason },
      });
      return;
    }
    const acp = listed.status === "fulfilled" ? listed.value.sessions : [];
    const native = read.status === "fulfilled" ? read.value.sessions : [];
    const rows = mergeDirectory(agentId, cwd, acp, native, this.state.openSessions);
    const errors = { ...this.state.directoryError };
    delete errors[key];
    const nativeIds = { ...this.state.nativeIds };
    for (const row of rows) {
      if (row.acpSessionId && row.nativeSessionId) {
        nativeIds[`${agentId}#${row.acpSessionId}`] = row.nativeSessionId;
      }
    }
    this.patch({
      nativeIds,
      directories: { ...this.state.directories, [key]: rows },
      directoryPhase: { ...this.state.directoryPhase, [key]: "ready" },
      directoryError: errors,
    });
  }

  // ── 会话生命周期 ──────────────────────────────────────────────────────────
  newSession = async (agentId: string, cwd: string): Promise<SessionRef | null> => {
    this.setBusy("newSession", true);
    try {
      const res = await this.rpc.call<NewSessionResult>("session/new", { agentId, cwd });
      rememberCwd(cwd);
      this.patch({
        agentDescriptorError: omit(this.state.agentDescriptorError, agentId),
        descriptors: { ...this.state.descriptors, [res.sessionRef]: res.descriptor },
        agentDescriptors: { ...this.state.agentDescriptors, [agentId]: res.descriptor },
        configOptions: {
          ...this.state.configOptions,
          [res.sessionRef]: res.raw?.configOptions ?? [],
        },
        chats: {
          ...this.state.chats,
          [res.sessionRef]: this.state.chats[res.sessionRef] ?? emptyChat(),
        },
        transcriptPhase: { ...this.state.transcriptPhase, [res.sessionRef]: "ready" },
        activeRef: res.sessionRef,
        cwds: dedupe([cwd, ...this.state.cwds]),
      });
      await this.refreshOpen();
      void this.refreshDirectory(agentId, cwd);
      void this.refreshTree(res.sessionRef);
      return res.sessionRef;
    } catch (err) {
      this.fail("新建会话失败", err);
      return null;
    } finally {
      this.setBusy("newSession", false);
    }
  };

  /** 打开一条已有会话：先 resume 把它激活，再读穿它的全文。 */
  openSession = async (row: DirectoryRow): Promise<void> => {
    const { agentId, cwd } = row;
    this.setBusy("openSession", true);
    try {
      let ref: SessionRef;
      if (row.acpSessionId) {
        const res = await this.rpc.call<{
          sessionRef: SessionRef;
          descriptor: CapabilityDescriptor;
          raw?: { configOptions?: ConfigOption[] };
        }>("session/resume", { agentId, sessionId: row.acpSessionId, cwd });
        ref = res.sessionRef;
        this.patch({
          agentDescriptorError: omit(this.state.agentDescriptorError, agentId),
          descriptors: { ...this.state.descriptors, [ref]: res.descriptor },
          agentDescriptors: { ...this.state.agentDescriptors, [agentId]: res.descriptor },
          configOptions: {
            ...this.state.configOptions,
            [ref]: res.raw?.configOptions ?? this.state.configOptions[ref] ?? [],
          },
        });
      } else if (row.nativeSessionId) {
        ref = `${agentId}#${row.nativeSessionId}`;
      } else {
        return;
      }
      if (row.nativeSessionId) {
        this.patch({ nativeIds: { ...this.state.nativeIds, [ref]: row.nativeSessionId } });
      }
      this.patch({ activeRef: ref, seen: markSeen(ref, Date.now()) });
      await this.refreshOpen();
      void this.refreshTree(ref);
      if (!this.state.chats[ref]?.items.length) void this.loadTranscript(ref, cwd);
    } catch (err) {
      this.fail("打开会话失败", err);
    } finally {
      this.setBusy("openSession", false);
    }
  };

  /**
   * 切到某条会话。派活子会话的流是实时推过来的，但壳重开之后那份流就没了——
   * 这时按它的 cwd 读穿一次全文，而不是给一句"这条会话还没有内容"。
   */
  selectSession = (ref: SessionRef): void => {
    // 未读游标：看过就记一笔。这是客户端视图状态，不是会话内容。
    this.patch({ activeRef: ref, seen: markSeen(ref, Date.now()) });
    void this.refreshTree(ref);
    if (this.state.chats[ref]?.items.length) return;
    const cwd =
      this.state.openSessions.find((s) => s.sessionRef === ref)?.cwd ??
      this.state.tasks.find((t) => t.sessionRef === ref)?.cwd;
    if (cwd) void this.loadTranscript(ref, cwd);
  };

  /**
   * 读穿一条会话的全文。ZCode 的引擎 `session/read` 只对 active 会话有效，
   * core 会先 resume 再 close 还原，所以一次要几秒——这里按异步处理，界面上有加载态。
   *
   * 分页：不给 `before` 就是最后 50 条；给 `before`（上一页返回的 `cursor`）
   * 就是那条消息**之前**的 50 条。往上翻时把更早的一页插在**前面**，不覆盖已收到的。
   */
  async loadTranscript(ref: SessionRef, cwd: string, before?: string): Promise<void> {
    const { agentId, sessionId } = splitRef(ref);
    // 读取层要的是引擎**原生** id（`sess_x`），不是 ACP 面的（`zc-sess_x`）。
    // 两边的对应关系只在列表里（`session/list` ↔ `read/list` 按后缀对齐）——
    // 没有就先拉一次列表把它对出来，别把 ACP id 直接喂给读取层
    // （实测那样 core 会回 `Session not found: zc-sess_…`，看起来像会话丢了）。
    let readId = this.state.nativeIds[ref];
    if (!readId) {
      await this.refreshDirectory(agentId, cwd);
      readId = this.state.nativeIds[ref];
    }
    if (!before) this.patch({ transcriptPhase: { ...this.state.transcriptPhase, [ref]: "loading" } });
    try {
      // 老 core 不认 `limit` / `before` 就原样返回全文，多给参数不会让它报错；
      // `hasMore` / `cursor` 缺失时按"没有更早的"处理。
      const res = await this.rpc.call<TranscriptPage<TranscriptMessage>>("read/transcript", {
        agentId,
        sessionId: readId ?? sessionId,
        cwd,
        limit: 50,
        ...(before ? { before } : {}),
      });
      const base = this.state.chats[ref] ?? emptyChat();
      const history = transcriptToChat(res.messages ?? []);
      this.patch({
        transcriptCursor: {
          ...this.state.transcriptCursor,
          [ref]: res.hasMore ? (res.cursor ?? null) : undefined,
        },
      });
      // 读穿的历史放在前面，实时流里已经收到的放后面，不互相覆盖
      this.patch({
        chats: {
          ...this.state.chats,
          [ref]: { ...base, items: [...history.items, ...base.items], seq: base.seq + history.seq },
        },
        transcriptPhase: { ...this.state.transcriptPhase, [ref]: "ready" },
      });
    } catch (err) {
      this.patch({ transcriptPhase: { ...this.state.transcriptPhase, [ref]: "error" } });
      this.fail("读穿会话全文失败", err);
    }
  }

  /**
   * 分叉一条会话。ZCode 的 fork 是**工作区检查点分叉**，会话里没真的改过文件时
   * agent 会回 `No workspace checkpoint is available yet.`——core 把这句原样透出，
   * 壳也原样显示，不伪造成功、也不自作主张禁用按钮。
   */
  forkSession = async (ref: SessionRef): Promise<SessionRef | null> => {
    this.setBusy("fork", true);
    try {
      const res = await this.rpc.call<{ sessionRef: SessionRef }>("session/fork", {
        sessionRef: ref,
      });
      await this.refreshOpen();
      this.patch({ activeRef: res.sessionRef });
      return res.sessionRef;
    } catch (err) {
      this.fail("分叉会话失败", err);
      return null;
    } finally {
      this.setBusy("fork", false);
    }
  };

  /**
   * 透传 agent 的 `session/load`。只在 descriptor 说 `sessions.load` 为真时才该调用——
   * agent 不具备这个能力时 core 会报错，壳按能力隐藏入口，不让人白点。
   */
  loadSession = async (agentId: string, sessionId: string, cwd: string): Promise<void> => {
    this.setBusy("load", true);
    try {
      await this.rpc.call("session/load", { agentId, sessionId, cwd });
      await this.refreshOpen();
    } catch (err) {
      this.fail("载入会话失败", err);
    } finally {
      this.setBusy("load", false);
    }
  };

  /** ACP 原生的模式切换。有些渠道把模式放在 configOptions 里，那就走 set_config_option。 */
  setMode = async (ref: SessionRef, modeId: string): Promise<void> => {
    try {
      await this.rpc.call("session/set_mode", { sessionRef: ref, modeId });
      const { agentId } = splitRef(ref);
      void this.refreshAgentDescriptor(agentId);
    } catch (err) {
      this.fail("切换模式失败", err);
    }
  };

  closeSession = async (ref: SessionRef): Promise<void> => {
    try {
      await this.rpc.call("session/close", { sessionRef: ref });
      const chats = { ...this.state.chats };
      delete chats[ref];
      this.patch({ chats, activeRef: this.state.activeRef === ref ? null : this.state.activeRef });
      await this.refreshOpen();
    } catch (err) {
      this.fail("关闭会话失败", err);
    }
  };

  // ── 回合 ──────────────────────────────────────────────────────────────────
  /**
   * 回合空闲 → `session/prompt`；回合进行中 → `delivery/send` 走投递阶梯。
   * 同一个输入框、同一个按钮，只有文案随档位变。
   */
  send = async (ref: SessionRef, text: string): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const at = Date.now();
    const chat = appendUser(this.state.chats[ref] ?? emptyChat(), trimmed, at);
    const itemId = chat.items.at(-1)!.id;
    this.patch({ chats: { ...this.state.chats, [ref]: chat } });

    if (this.state.turnActive[ref]) {
      try {
        const receipt = await this.rpc.call<DeliveryReceipt>("delivery/send", {
          sessionRef: ref,
          text: trimmed,
        });
        this.patch({
          chats: {
            ...this.state.chats,
            [ref]: attachReceipt(this.state.chats[ref] ?? chat, itemId, receipt),
          },
        });
        void this.refreshEdges();
        void this.refreshQueue(ref);
      } catch (err) {
        this.fail("投递补充消息失败", err);
      }
      return;
    }

    // 本地合成的回合 id：core 一旦发过 turn 通知，这一路就整个让位（见 sawTurnNotification）
    const localTurnId = `local-${ref}-${at}`;
    const startedAt = Date.now();
    if (!this.sawTurnNotification) {
      this.patch({
        chats: {
          ...this.state.chats,
          [ref]: beginTurn(this.state.chats[ref] ?? chat, localTurnId, startedAt),
        },
      });
    }
    this.patch({ turnActive: { ...this.state.turnActive, [ref]: true } });
    try {
      // `session/prompt` 是长请求（PROTOCOL §4.5：整轮跑完才返回），**不设超时**。
      const res = await this.rpc.call<{ stopReason?: string }>("session/prompt", {
        sessionRef: ref,
        text: trimmed,
      });
      this.flushUpdates();
      // `turn_finished` 在收尾快照拍完之后推，**可能比 `session/prompt` 的返回稍晚**
      // （PROTOCOL §5 实测几十毫秒）。所以这里等一小会儿再决定要不要本地合成，
      // 否则老 core 与新 core 上会各出一条边界。
      await new Promise((r) => setTimeout(r, 300));
      if (!this.sawTurnNotification) {
        this.patch({
          chats: {
            ...this.state.chats,
            [ref]: endTurn(this.state.chats[ref] ?? chat, {
              turnId: localTurnId,
              ...(res.stopReason ? { stopReason: res.stopReason } : {}),
              endedAt: Date.now(),
            }),
          },
        });
      }
    } catch (err) {
      this.flushUpdates();
      this.patch({
        chats: {
          ...this.state.chats,
          [ref]: appendNotice(
            this.state.chats[ref] ?? chat,
            err instanceof Error ? err.message : String(err),
            "bad",
            Date.now(),
          ),
        },
      });
    } finally {
      this.patch({ turnActive: { ...this.state.turnActive, [ref]: false } });
      void this.refreshOpen();
      // ZCode 的 `session/list` 要等第一轮跑完才给出这条会话（标题是轮次结束时定的），
      // 所以每轮结束都回头刷一次目录，否则刚开的会话在左栏里是空的。
      const cwd = this.state.openSessions.find((s) => s.sessionRef === ref)?.cwd;
      const { agentId } = splitRef(ref);
      if (cwd) void this.refreshDirectory(agentId, cwd);
    }
  };

  cancel = async (ref: SessionRef): Promise<void> => {
    try {
      await this.rpc.call("session/cancel", { sessionRef: ref });
      // ACP 的 status 里没有"被用户停了"这个值，所以还在跑的卡进本地态 `stopped`，
      // 不是把它们留在"执行中"装作还活着。
      this.flushUpdates();
      const chat = this.state.chats[ref];
      if (chat) this.patch({ chats: { ...this.state.chats, [ref]: markRunningStopped(chat) } });
    } catch (err) {
      this.fail("取消回合失败", err);
    }
  };

  // ── 文件改动（PROTOCOL §4.12） ────────────────────────────────────
  /**
   * 逐文件明细**展开时才拉**，不在流式过程中攒。
   * `session/changes` 每次都现拍一棵当前工作区的树再比，报的是**此刻**的差异——
   * 回合结束后人又手改了也会如实出现，这一点要照实转达，不能说成"本回合改了什么"。
   */
  loadChanges = async (
    ref: SessionRef,
    turnId: string,
    includeDiff = false,
  ): Promise<void> => {
    const key = `${ref}::${turnId}`;
    this.patch({ changesPhase: { ...this.state.changesPhase, [key]: "loading" } });
    try {
      const res = await this.rpc.call<SessionChanges>("session/changes", {
        sessionRef: ref,
        turnId,
        ...(includeDiff ? { includeDiff: true } : {}),
      });
      const errors = { ...this.state.changesError };
      delete errors[key];
      this.patch({
        changes: { ...this.state.changes, [key]: res },
        changesPhase: { ...this.state.changesPhase, [key]: "ready" },
        changesError: errors,
      });
    } catch (err) {
      this.patch({
        changesPhase: { ...this.state.changesPhase, [key]: "error" },
        changesError: {
          ...this.state.changesError,
          [key]: err instanceof RpcError ? err.message : String(err),
        },
      });
    }
  };

  /**
   * 撤销一个回合的改动。core 的预检把文件分成"可安全撤销 / 不能安全撤销 / 已忽略"，
   * **有任一不安全就一个文件都不写**。skipped 一定要如实列出来，不能吞掉。
   */
  revertTurn = async (ref: SessionRef, turnId: string): Promise<RevertResult | null> => {
    this.setBusy("revert", true);
    try {
      const res = await this.rpc.call<RevertResult>("session/revert", {
        sessionRef: ref,
        turnId,
      });
      const reverted = res.reverted ?? [];
      const skipped = res.skipped ?? [];
      if (reverted.length > 0) {
        const chat = this.state.chats[ref];
        if (chat) this.patch({ chats: { ...this.state.chats, [ref]: markReverted(chat, turnId) } });
      }
      // skipped 必须如实列出来，连原因一起——吞掉它等于谎报"都撤了"
      if (skipped.length) {
        this.patch({
          banner: {
            text: `已撤销 ${reverted.length} 个文件；跳过 ${skipped.length} 个：${skipped
              .map((f) => `${f.path}（${f.reason}）`)
              .join("；")}`,
            tone: reverted.length ? "warn" : "bad",
          },
        });
      }
      void this.loadChanges(ref, turnId);
      return res;
    } catch (err) {
      this.fail("撤销改动失败", err);
      return null;
    } finally {
      this.setBusy("revert", false);
    }
  };

  setConfigOption = async (ref: SessionRef, configId: string, value: string): Promise<void> => {
    try {
      await this.rpc.call("session/set_config_option", { sessionRef: ref, configId, value });
      const options = this.state.configOptions[ref] ?? [];
      this.patch({
        configOptions: {
          ...this.state.configOptions,
          [ref]: options.map((o) => (o.id === configId ? { ...o, currentValue: value } : o)),
        },
      });
      const { agentId } = splitRef(ref);
      void this.refreshAgentDescriptor(agentId);
    } catch (err) {
      this.fail(`切换 ${configId} 失败`, err);
    }
  };

  // ── 派活 ──────────────────────────────────────────────────────────────────
  delegate = async (input: {
    agentId: string;
    task: string;
    cwd: string;
    modelId?: string;
    effort?: string;
    delivery?: { tier?: string; maxTier?: string; allowInterrupt?: boolean };
  }): Promise<string | null> => {
    this.setBusy("delegate", true);
    try {
      // 人从壳里派活**不填 callerRef**——人不受一层熔断限制（PROTOCOL §4.9）。
      // 但把当前打开的会话作为 `fromSessionRef` 报上去：delegate 边挂它，
      // `graph/tree` 才画得出"这条会话派出去的那一层"（PROTOCOL §4.7）。
      const from = this.state.activeRef;
      const res = await this.rpc.call<{ taskId: string; sessionRef: SessionRef }>("task/delegate", {
        agentId: input.agentId,
        task: input.task,
        cwd: input.cwd,
        ...(input.modelId ? { modelId: input.modelId } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        ...(input.delivery ? { delivery: input.delivery } : {}),
        ...(from ? { fromSessionRef: from } : {}),
      });
      rememberCwd(input.cwd);
      await this.refreshTasks();
      void this.refreshEdges();
      await this.refreshOpen();
      void this.refreshTree(res.sessionRef);
      if (from) void this.refreshTree(from);
      return res.taskId;
    } catch (err) {
      this.fail("派活失败", err);
      return null;
    } finally {
      this.setBusy("delegate", false);
    }
  };

  /** 对"自己派出去的跨 agent 子会话"直发补充消息。原生 subagent 没有这个入口。 */
  sendTaskInput = async (taskId: string, message: string): Promise<DeliveryReceipt | null> => {
    try {
      const receipt = await this.rpc.call<DeliveryReceipt>("task/send_input", {
        taskId,
        message,
        attribution: "来自壳里的人工补充",
      });
      this.patch({ taskReceipts: { ...this.state.taskReceipts, [taskId]: receipt } });
      void this.refreshEdges();
      void this.refreshQueue(receipt.sessionRef);
      return receipt;
    } catch (err) {
      this.fail("给子任务发补充消息失败", err);
      return null;
    }
  };

  cancelTask = async (taskId: string): Promise<void> => {
    try {
      const res = await this.rpc.call<{ ok: boolean }>("task/cancel", { taskId });
      if (!res.ok) this.patch({ banner: { text: "任务已经结束了，取消没有生效", tone: "warn" } });
      await this.refreshTasks();
    } catch (err) {
      this.fail("取消任务失败", err);
    }
  };

  // ── 审批 ──────────────────────────────────────────────────────────────────
  /**
   * `elicitation/respond`：把用户填的内容回传给 agent。
   * core 没有这个方法时报 -32601，卡片就退回"只能拒绝"那条路并如实说明，
   * **不假装提交成功**。
   */
  respondElicitation = async (
    approval: Approval,
    content: Record<string, string>,
  ): Promise<boolean> => {
    if (!approval.requestId) return false;
    try {
      await this.rpc.call("elicitation/respond", {
        requestId: approval.requestId,
        action: "accept",
        content,
      });
      this.patch({ approvals: this.state.approvals.filter((a) => a.key !== approval.key) });
      return true;
    } catch (err) {
      this.fail("回答 agent 的追问失败", err);
      return false;
    }
  };

  respondApproval = async (
    approval: Approval,
    body: { outcome: "selected"; optionId: string } | { outcome: "cancelled" },
  ): Promise<void> => {
    if (!approval.requestId) return;
    const rejected =
      body.outcome === "cancelled" ||
      Boolean(
        approval.options
          .find((o) => o.optionId === body.optionId)
          ?.kind?.startsWith("reject"),
      );
    try {
      await this.rpc.call("permission/respond", { requestId: approval.requestId, ...body });
      if (rejected && approval.toolCallId) {
        const chat = this.state.chats[approval.sessionRef];
        if (chat) {
          this.patch({
            chats: {
              ...this.state.chats,
              [approval.sessionRef]: markToolDenied(chat, approval.toolCallId),
            },
          });
        }
      }
    } catch (err) {
      // -32004 = 已经结算过（超时了，或别的客户端先答了）。按 PROTOCOL 的要求
      // 把卡片收掉，不重试。
      if (err instanceof RpcError && err.code === -32004) {
        this.patch({
          banner: { text: "这条请求已经结算过了（超时或别处已应答），卡片已收起", tone: "warn" },
        });
      } else {
        this.fail("应答审批失败", err);
      }
    } finally {
      const decision =
        body.outcome === "cancelled"
          ? "已拒绝"
          : (approval.options.find((o) => o.optionId === body.optionId)?.name ??
            (rejected ? "已拒绝" : "已允许"));
      this.patch({
        approvals: this.state.approvals.filter((a) => a.key !== approval.key),
        approvalLog: [
          ...this.state.approvalLog,
          {
            key: approval.key,
            sessionRef: approval.sessionRef,
            title: approval.title,
            decision,
            at: Date.now(),
          },
        ],
      });
    }
  };
}

// ── 纯函数（可单测） ────────────────────────────────────────────────────────

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

/**
 * 流式合并。连续的、**同 sessionRef 同 sessionUpdate** 的
 * 文本类 chunk 先拼成一条再 dispatch，reducer 就不会跑几百次。
 * 非文本类（工具卡、模式变更…）原样保留顺序，一条都不吞。
 */
const TEXT_CHUNKS = new Set(["agent_message_chunk", "agent_thought_chunk", "user_message_chunk"]);

export function coalesceUpdates(
  batch: SessionUpdateNotification[],
): SessionUpdateNotification[] {
  const out: SessionUpdateNotification[] = [];
  for (const item of batch) {
    const kind = item.update?.sessionUpdate;
    const prev = out[out.length - 1];
    if (
      kind &&
      prev?.update &&
      item.update &&
      TEXT_CHUNKS.has(kind) &&
      prev.update.sessionUpdate === kind &&
      prev.sessionRef === item.sessionRef &&
      prev.update.content &&
      !Array.isArray(prev.update.content) &&
      item.update.content &&
      !Array.isArray(item.update.content)
    ) {
      const merged = `${prev.update.content.text ?? ""}${item.update.content.text ?? ""}`;
      out[out.length - 1] = {
        ...prev,
        update: { ...prev.update, content: { ...prev.update.content, text: merged } },
      };
      continue;
    }
    out.push(item);
  }
  return out;
}

/** `permission/requested` / `permission/pending` 的条目 → 壳内的审批卡模型 */
export function toApproval(p: PermissionRequested): Approval {
  const toolCall = p.request?.toolCall;
  const files = (toolCall?.locations ?? [])
    .map((l) => l.path)
    .filter((path): path is string => Boolean(path));
  return {
    key: `perm:${p.requestId}`,
    type: "permission",
    requestId: p.requestId,
    sessionRef: p.sessionRef,
    agentId: p.agentId,
    title: toolCall?.title ?? "agent 请求授权",
    toolCallId: toolCall?.toolCallId ?? null,
    toolKind: toolCall?.kind ?? null,
    files,
    meta: p.request?._meta?.permission ?? null,
    queueDepth: typeof p.queueDepth === "number" ? p.queueDepth : null,
    rawInput: toolCall?.rawInput ?? p.request ?? null,
    options: p.options ?? [],
    fields: [],
    createdAt: p.createdAt ?? Date.now(),
    expiresAt: p.expiresAt ?? null,
  };
}

export function dedupe(list: string[]): string[] {
  return [...new Set(list.filter(Boolean))];
}

/** ACP 面的 id 带 adapter 前缀（`zc-sess_x`），读取层是原生 id（`sess_x`）。按后缀对齐。 */
export function sameSession(acpId: string, nativeId: string): boolean {
  return acpId === nativeId || acpId.endsWith(nativeId) || nativeId.endsWith(acpId);
}

/**
 * `elicitation/requested` 通知（或 `permission/pending` 里的追问条目）→ 壳内的追问卡。
 * 结构化表单从 `params.requestedSchema` 来；没有 schema 就只渲染说明文字与裁决按钮。
 */
export function elicitationApproval(input: {
  requestId: string | null;
  sessionRef: SessionRef;
  agentId: string;
  params?: ElicitationRequested["params"];
  options?: PermissionOption[];
  expiresAt?: number | null;
}): Approval {
  const schema = input.params?.requestedSchema;
  const required = new Set(schema?.required ?? []);
  const fields = Object.entries(schema?.properties ?? {}).map(([name, def]) => ({
    name,
    title: def.title ?? name,
    ...(def.description ? { description: def.description } : {}),
    required: required.has(name),
  }));
  return {
    key: `elicit:${input.requestId ?? input.sessionRef}`,
    type: "elicitation",
    requestId: input.requestId,
    sessionRef: input.sessionRef,
    agentId: input.agentId,
    title: "agent 想问你一件事",
    toolCallId: null,
    toolKind: null,
    files: [],
    meta: null,
    queueDepth: null,
    rawInput: input.params ?? null,
    options: input.options ?? [],
    fields,
    ...(input.params?.message ? { message: input.params.message } : {}),
    createdAt: Date.now(),
    expiresAt: input.expiresAt ?? null,
  };
}

export function mergeDirectory(
  agentId: string,
  cwd: string,
  acp: AgentSessionInfo[],
  native: ReadSessionSummary[],
  open: OpenSession[],
): DirectoryRow[] {
  const rows: DirectoryRow[] = [];
  const usedNative = new Set<string>();
  for (const s of acp) {
    const match = native.find((n) => sameSession(s.sessionId, n.sessionId));
    if (match) usedNative.add(match.sessionId);
    rows.push({
      agentId,
      cwd,
      acpSessionId: s.sessionId,
      nativeSessionId: match?.sessionId ?? null,
      title: s.title ?? match?.title ?? s.sessionId,
      updatedAt: match?.updatedAt ?? (s.updatedAt ? Date.parse(s.updatedAt) : null),
      live: open.some((o) => o.agentId === agentId && o.sessionId === s.sessionId),
    });
  }
  for (const n of native) {
    if (usedNative.has(n.sessionId)) continue;
    rows.push({
      agentId,
      cwd,
      acpSessionId: null,
      nativeSessionId: n.sessionId,
      title: n.title ?? n.sessionId,
      updatedAt: n.updatedAt ?? null,
      live: false,
    });
  }
  // 在册但两个列表都还没收录的会话：刚建好的会话 agent 自己的 `session/list`
  // 往往要等第一轮跑完才给出来（ZCode 实测），而 `session/open` 当场就有。
  // 不补这一条，左栏会短暂地对一条刚开的会话显示"这个目录下还没有会话"。
  const known = rows.flatMap((r) => [r.acpSessionId, r.nativeSessionId]).filter((id): id is string => Boolean(id));
  for (const s of open) {
    if (s.agentId !== agentId || s.cwd !== cwd) continue;
    if (known.some((k) => sameSession(s.sessionId, k))) continue;
    rows.push({
      agentId,
      cwd,
      acpSessionId: s.sessionId,
      nativeSessionId: null,
      title: s.sessionId,
      updatedAt: s.createdAt,
      live: true,
    });
  }
  return rows.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

export interface TranscriptPart {
  kind: string;
  text?: string;
  tool?: {
    name?: string;
    callId?: string;
    status?: string;
    input?: unknown;
    output?: string;
    title?: string;
    /** core 读取层的派生字段（PROTOCOL §4.8）；算不出来就没有这个字段 */
    changeStat?: ChangeStat[];
  };
  raw?: unknown;
}

export interface TranscriptMessage {
  messageId: string;
  role: string;
  createdAt?: number;
  parts?: TranscriptPart[];
}

/** 读穿的统一消息模型 → 聊天项。不认识的片段留成 unknown，原文照旧带着。 */
export function transcriptToChat(messages: TranscriptMessage[]): ChatState {
  const items: ChatItem[] = [];
  let seq = 0;
  for (const message of messages) {
    const at = message.createdAt ?? 0;
    for (const part of message.parts ?? []) {
      if (part.kind === "step_start" || part.kind === "step_finish" || part.kind === "timeline") {
        continue; // 结构性片段不占聊天流
      }
      seq += 1;
      if (part.kind === "text") {
        const kind = message.role === "user" ? "user" : "assistant";
        items.push({ kind, id: `h${seq}`, text: part.text ?? "", at });
      } else if (part.kind === "thought") {
        items.push({ kind: "thought", id: `h${seq}`, text: part.text ?? "", at });
      } else if (part.kind === "tool_call") {
        const tool = part.tool ?? {};
        items.push({
          kind: "tool",
          id: `h${seq}`,
          card: {
            callId: tool.callId ?? `h${seq}`,
            title: tool.title ?? tool.name ?? "工具调用",
            toolName: tool.name ?? null,
            kind: null,
            status:
              tool.status === "completed" || tool.status === "failed"
                ? tool.status
                : tool.status === "running"
                  ? "in_progress"
                  : "pending",
            rawInput: tool.input ?? null,
            rawOutput: null,
            content: tool.output ? [{ type: "text", text: tool.output }] : [],
            ...(tool.changeStat?.length ? { changeStat: tool.changeStat } : {}),
            locations: [],
            sawFirstCard: true,
            createdAt: at,
            updatedAt: at,
          },
        });
      } else {
        items.push({
          kind: "unknown",
          id: `h${seq}`,
          sessionUpdate: part.kind,
          raw: { sessionUpdate: part.kind, raw: part.raw },
          at,
        });
      }
    }
  }
  return { ...emptyChat(), items, seq };
}
