// core 的 JSON-RPC 契约在 packages/core/PROTOCOL.md。这里只声明壳真正读到的字段，
// 其余原文一律保留在 `raw` 里——core 不改写 agent 的自述，壳也不改写 core 的。

export type AgentId = string;
/** `<agentId>#<agent 原生 sessionId>` */
export type SessionRef = string;

export interface AgentEntry {
  agentId: AgentId;
  label: string;
  command: string;
  args: string[];
  reader?: string;
  storage?: { kind?: string; location?: string };
}

export type SteeringTier = "native" | "extension" | "concurrent" | "soft-interrupt" | "queue";

/** 访问模式的危险等级。没有这个字段 = agent 没说，不猜。 */
export type ModeRisk = "safe" | "elevated" | "full";

/**
 * 一次写入涉及的行数。core 的读取层派生，两条兜底都算不出来时
 * **不给这个字段**——壳按"字段缺失 → 不渲染统计"处理，绝不显示 0。
 */
export interface ChangeStat {
  path?: string;
  added: number;
  removed: number;
}

export interface CapabilityDescriptor {
  agentId: AgentId;
  protocolVersion: number;
  delivery: {
    steering: {
      supported: boolean;
      tier: SteeringTier;
      boundary?: "step" | "turn" | "unknown";
      idle?: "promptRequired" | "startsNewTurn" | "unknown";
      settlesOwnerTurn?: boolean;
      method?: string;
    };
    queue: { supported: boolean; drainAt?: string };
  };
  sessions?: Record<string, boolean>;
  models: Array<{
    id: string;
    label?: string;
    efforts?: string[];
    defaultEffort?: string;
    totalContextTokens?: number;
  }>;
  currentModelId?: string;
  efforts?: string[];
  currentEffort?: string;
  /**
   * `risk` 是 core 的 descriptor 补的等级。事实源仍是 agent：
   * agent 自报就用自报的，没自报的走 core 的已知缺陷覆盖表。
   * **壳绝不靠字符串匹配 modeId 判危险**——字段缺失时按"没说"处理。
   */
  modes?: Array<{ id: string; name: string; risk?: ModeRisk }>;
  currentModeId?: string;
  subagents?: Record<string, boolean>;
  /** 这条会话的回合级撤销能力（PROTOCOL §4.12）。unavailable 时两个按钮都不渲染。 */
  revert?: { supported?: "available" | "unavailable"; kind?: string; reason?: string };
  storage?: { kind?: string; location?: string; reader?: string };
  raw?: { initialize?: unknown; newSession?: NewSessionRaw };
  corrections?: Correction[];
  aggregatedAt?: number;
}

export interface Correction {
  id: string;
  path: string;
  from: string;
  to: string;
  reason: string;
  evidence?: string;
  versionCondition?: string;
}

export interface ConfigOption {
  id: string;
  name: string;
  category?: string;
  type?: string;
  currentValue?: string;
  options?: Array<{ value: string; name: string; description?: string }>;
}

export interface NewSessionRaw {
  configOptions?: ConfigOption[];
  modes?: unknown;
  models?: unknown;
  availableCommands?: unknown;
}

export interface NewSessionResult {
  sessionRef: SessionRef;
  sessionId: string;
  agentId: AgentId;
  cwd: string;
  descriptor: CapabilityDescriptor;
  raw?: NewSessionRaw;
}

export interface OpenSession {
  sessionRef: SessionRef;
  agentId: AgentId;
  sessionId: string;
  cwd: string;
  turnActive: boolean;
  createdAt: number;
}

/** `session/list`：agent 自己的原始结果，core 不做归一（`updatedAt` 是 ISO 串） */
export interface AgentSessionInfo {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
}

/** `read/list`：读取层的摘要（`sessionId` 是引擎原生 id，没有 adapter 前缀） */
export interface ReadSessionSummary {
  sessionRef: SessionRef;
  agentId: AgentId;
  sessionId: string;
  title?: string;
  cwd: string;
  updatedAt?: number;
  status?: string;
}

/**
 * PROTOCOL §4.6 的回执枚举。`failed` = 目标收下了这一档的调用、但它自己报了失败
 * （机制在、这次没成）——**不是** `unsupported`，两者不能合并。
 */
export type DeliveryOutcome =
  | "injected"
  | "queued"
  | "no_active_turn"
  | "completed_race"
  | "failed"
  | "unsupported";

export interface DeliveryReceipt {
  outcome: DeliveryOutcome;
  tier: SteeringTier | null;
  requestedTier?: SteeringTier;
  attempts?: Array<{ tier: SteeringTier; status: string; detail?: string }>;
  raw?: unknown;
  turnActive?: boolean;
  sessionRef: SessionRef;
  deliveredAt: number;
}

export type TaskStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "done"
  | "failed"
  | "cancelled";

export interface TaskRecord {
  taskId: string;
  agentId: AgentId;
  sessionRef: SessionRef;
  parentRef: SessionRef | null;
  task: string;
  cwd: string;
  modelId?: string;
  effort?: string;
  status: TaskStatus;
  /** agent 自己报的用量；缺失时右栏整块不渲染 */
  usage?: TaskUsage;
  summary?: string;
  stopReason?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface GraphNode {
  id: SessionRef;
  kind: "root" | "delegation-child" | "native-subagent";
  agentId: AgentId;
  sessionId: string;
  cwd?: string;
  title?: string;
  createdAt: number;
  updatedAt: number;
}

export interface GraphEdge {
  id: string;
  kind: "delegate" | "supplement" | "result";
  from: SessionRef | null;
  to: SessionRef | null;
  createdAt: number;
  taskId?: string;
  task?: string;
  modelId?: string;
  effort?: string;
  tier?: SteeringTier;
  outcome?: DeliveryOutcome;
  attribution?: string;
  status?: string;
  summary?: string;
  nativeSessionRef?: SessionRef;
}

/** `delivery/queue`：壳内排队、还没投出去的补充消息 */
export interface QueuedMessage {
  sessionRef: SessionRef;
  content: unknown;
  queuedAt: number;
}

export interface GraphTreeNode extends GraphNode {
  viaTaskId?: string;
  modelId?: string;
  effort?: string;
  children: GraphTreeNode[];
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export interface PermissionRequested {
  requestId: string;
  sessionRef: SessionRef;
  agentId: AgentId;
  /** `permission/pending` 里区分审批与追问（PROTOCOL §5）：省略 = 审批 */
  kind?: "permission" | "elicitation";
  /** 追问条目带的就是 `elicitation/requested` 的原始参数 */
  params?: ElicitationRequested["params"];
  request?: {
    toolCall?: {
      toolCallId?: string;
      kind?: string;
      title?: string;
      rawInput?: unknown;
      locations?: Array<{ path?: string }>;
    };
    _meta?: { permission?: PermissionMeta };
    [k: string]: unknown;
  };
  options?: PermissionOption[];
  createdAt: number;
  expiresAt?: number;
  /** 还排着几条待审批 */
  queueDepth?: number;
}

/** `elicitation/requested`：agent 反过来问用户，也走 permission/respond 应答 */
export interface ElicitationRequested {
  requestId?: string;
  sessionRef: SessionRef;
  agentId: AgentId;
  params?: {
    message?: string;
    requestedSchema?: {
      properties?: Record<string, { type?: string; title?: string; description?: string }>;
      required?: string[];
    };
    [k: string]: unknown;
  };
}

export interface ContentBlock {
  type: string;
  text?: string;
  [k: string]: unknown;
}

export interface ToolCallContent {
  type?: string;
  content?: ContentBlock;
  [k: string]: unknown;
}

/** ACP 的 SessionUpdate 原文，core 不改写 */
export interface SessionUpdate {
  sessionUpdate: string;
  /** 逐 token 的片段是单个 ContentBlock；工具卡的 content 是一串带壳的条目 */
  content?: ContentBlock | ToolCallContent[];
  toolCallId?: string;
  title?: string;
  kind?: string;
  /** 工具卡用 pending/in_progress/completed/failed；子代理用它自己的词汇，一律不预设 */
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  locations?: Array<{ path?: string; line?: number }>;
  entries?: Array<{ content?: string; status?: string; priority?: string }>;
  used?: number;
  size?: number;
  cost?: { amount?: number; currency?: string };
  currentModeId?: string;
  configOptions?: ConfigOption[];
  subagentSessionId?: string;
  [k: string]: unknown;
}

export interface SessionUpdateNotification {
  sessionRef: SessionRef;
  agentId: AgentId;
  sessionId: string;
  /** 壳内合成事件没有这个字段 */
  update?: SessionUpdate;
  notification?: unknown;
  derived?: Derived;
}

/**
 * 回合边界（PROTOCOL §5「壳内合成事件」）。
 * 它走**同一条 `session/update` 订阅通道**，但**不冒充 agent 的 update**：
 * 这类通知**没有 `update` 字段**，只有 `derived.event`。
 * 客户端按「有 update = agent 原文 / 有 derived.event = 壳内合成」区分。
 */
export interface DerivedEvent {
  event: "turn_started" | "turn_finished";
  turnId: string;
  startedAt?: number;
  endedAt?: number;
  stopReason?: string;
  error?: unknown;
  /** 本回合的文件改动**摘要**（只有计数，逐文件明细要另调 `session/changes`） */
  changes?: TurnChanges;
}

export interface TurnChanges {
  files: number;
  added: number;
  removed: number;
  revert?: "available" | "unavailable";
  reason?: string;
}

/** `derived` 旁路字段：core 算的，永远不进 `update`（agent 原文一个字节都不改） */
export interface Derived {
  event?: DerivedEvent["event"];
  turnId?: string;
  startedAt?: number;
  endedAt?: number;
  stopReason?: string;
  error?: unknown;
  changes?: TurnChanges;
  /** 这次工具调用改了哪些文件、各自几加几减。两级都算不出就没有这个字段。 */
  changeStat?: ChangeStat[];
}

/** `session/changes` 的返回（PROTOCOL §4.12）。路径相对**仓库根**。 */
export interface SessionChanges {
  sessionRef?: SessionRef;
  turnId?: string;
  revert?: "available" | "unavailable";
  reason?: string;
  files: Array<ChangeStat & { status?: "added" | "modified" | "deleted"; afterBlob?: string }>;
  /** 只在 `includeDiff: true` 时有，是一整份 unified diff 文本 */
  diff?: string;
  computedAt?: number;
}

/** `session/revert` 的返回。skipped 必须如实列出，不能吞掉。 */
export interface RevertResult {
  turnId?: string;
  reverted: string[];
  skipped?: Array<{ path: string; reason: string }>;
}

/** `read/transcript` 的分页返回。老 core 只给 messages，另两项按缺失处理。 */
export interface TranscriptPage<T> {
  messages: T[];
  hasMore?: boolean;
  cursor?: string | null;
}

/** `TaskRecord.usage`。没有就整块不渲染，不显示 0 tok。 */
export interface TaskUsage {
  inputTokens?: number;
  outputTokens?: number;
  toolCalls?: number;
  contextUsed?: number;
  contextTotal?: number;
}

/** `permission/requested` 里 agent 自带的 `_meta.permission` */
export interface PermissionMeta {
  version?: string;
  description?: string;
  defaultToNo?: boolean;
  changes?: Array<{
    description?: string;
    lifetime?: { scope?: string; storage?: string };
  }>;
}

export interface AgentExitNotification {
  agentId: AgentId;
  code: number | null;
  signal: string | null;
}

export const ERROR = {
  InvalidParams: -32602,
  AgentError: -32000,
  NotFound: -32001,
  Unsupported: -32002,
  RecursionBlocked: -32003,
  ApprovalTimeout: -32004,
  ShuttingDown: -32005,
} as const;
