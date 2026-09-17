// `session/update` 流 → 聊天消息模型。
//
// core 原样透传 agent 的 ACP SessionUpdate（PROTOCOL.md §5），所以归并的活在壳里做：
// 逐 token 的正文/思考要合并成一条，工具卡要按 toolCallId 走三段式状态机，
// 认不出来的片段照样留住原文，不丢。

import type {
  ChangeStat,
  ConfigOption,
  Derived,
  TurnChanges,
  ContentBlock,
  DeliveryReceipt,
  SessionUpdate,
  ToolCallContent,
} from "./protocol";

export type ToolStatus = "pending" | "in_progress" | "completed" | "failed";

export interface ToolCard {
  callId: string;
  /** 首卡给的标题（ZCode 实测是具体命令，如 `cat note.txt`），后续 update 不覆盖它 */
  title: string;
  /** update 里带的工具名（如 `Bash` / `Write`），首卡通常没有 */
  toolName: string | null;
  kind: string | null;
  status: ToolStatus;
  rawInput: unknown;
  rawOutput: unknown;
  content: ContentBlock[];
  locations: Array<{ path?: string; line?: number }>;
  /** core 读取层派生的行数统计。没有这个字段就按"算不出来"处理，不补 0。 */
  changeStat?: ChangeStat[];
  /** agent 在 `_meta` 里塞的自有字段（工具名等），原样留着 */
  meta?: unknown;
  /**
   * ACP 之外的两个本地态：`denied` = 审批被拒，`stopped` = 用户 session/cancel。
   * ACP 的 status 字段里没有它们，所以单独一格，不覆盖 agent 说的那个。
   */
  local?: "denied" | "stopped";
  /**
   * 有没有收到过首卡（`sessionUpdate: "tool_call"`）。
   * 只收到 `tool_call_update` 时兜底建卡，并把这一位标成 false——UI 要能说清
   * "这张卡是从中途拼出来的"，而不是假装什么都没发生。
   */
  sawFirstCard: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface PlanEntry {
  content?: string;
  status?: string;
  priority?: string;
}

export interface Usage {
  used: number;
  size: number;
  cost?: { amount?: number; currency?: string };
}

export type ChatItem =
  | { kind: "user"; id: string; text: string; at: number; receipt?: DeliveryReceipt }
  | {
      kind: "turn-end";
      id: string;
      turnId: string;
      stopReason?: string;
      at: number;
      /**
       * 本回合的文件改动**摘要**（`turn_finished.changes`，只有计数）。
       * 逐文件明细展开时才调 `session/changes`。字段缺失 = core 没给，
       * 卡按"不渲染统计"处理，绝不补 0。
       */
      changes?: TurnChanges;
      reverted?: boolean;
      startedAt?: number;
    }
  | { kind: "assistant"; id: string; text: string; at: number }
  | { kind: "thought"; id: string; text: string; at: number }
  | { kind: "tool"; id: string; card: ToolCard }
  | { kind: "plan"; id: string; entries: PlanEntry[]; at: number }
  | { kind: "notice"; id: string; text: string; tone: "info" | "warn" | "bad"; at: number }
  | { kind: "unknown"; id: string; sessionUpdate: string; raw: SessionUpdate; at: number };

export interface SubagentRef {
  subagentSessionId: string;
  label: string;
  state: string;
  at: number;
}

export interface Turn {
  turnId: string;
  startedAt: number;
  endedAt: number | null;
  stopReason?: string;
}

export interface ChatState {
  items: ChatItem[];
  /** toolCallId → items 下标 */
  toolIndex: Record<string, number>;
  usage: Usage | null;
  currentModeId: string | null;
  configOptions: ConfigOption[] | null;
  availableCommands: Array<{ name: string; description?: string }> | null;
  subagents: SubagentRef[];
  /** 回合边界。没有 turn 通知的老 core 上这里一直是空的，不影响其余渲染。 */
  turns: Turn[];
  /** 自增的本地 id 计数器，保证 key 稳定 */
  seq: number;
}

export function emptyChat(): ChatState {
  return {
    items: [],
    toolIndex: {},
    usage: null,
    currentModeId: null,
    configOptions: null,
    availableCommands: null,
    subagents: [],
    turns: [],
    seq: 0,
  };
}

const TOOL_STATUSES: ToolStatus[] = ["pending", "in_progress", "completed", "failed"];

function toStatus(value: unknown, fallback: ToolStatus): ToolStatus {
  return TOOL_STATUSES.includes(value as ToolStatus) ? (value as ToolStatus) : fallback;
}

/**
 * `tool_call_update` 到达但**没带 status** 时，按有没有回参推断，不要当成 completed
 * （Codeg 的实用默认值）。把没结束的当成结束，段就会提前自动收起。
 */
function inferStatus(update: SessionUpdate, fallback: ToolStatus): ToolStatus {
  if (TOOL_STATUSES.includes(update.status as ToolStatus)) return update.status as ToolStatus;
  // 卡已经在更靠后的状态上了就保留它——推断只用来给"还什么都不知道"的卡定初值，
  // 不能把一张已经在跑的卡倒推回 pending。
  if (fallback !== "pending") return fallback;
  const raw = update.rawOutput;
  const hasOutput =
    (typeof raw === "string" && raw.length > 0) ||
    (Array.isArray(raw) && raw.length > 0) ||
    (raw !== null && raw !== undefined && typeof raw === "object" && Object.keys(raw).length > 0) ||
    (Array.isArray(update.content) && update.content.length > 0);
  return hasOutput ? "in_progress" : "pending";
}

function textOf(content: SessionUpdate["content"]): string {
  if (!content || Array.isArray(content)) return "";
  return typeof content.text === "string" ? content.text : "";
}

/** 追加一条本地消息（用户自己发的，不在 agent 的流里） */
export function appendUser(state: ChatState, text: string, at: number): ChatState {
  const seq = state.seq + 1;
  return {
    ...state,
    seq,
    items: [...state.items, { kind: "user", id: `u${seq}`, text, at }],
  };
}

/** 给最近一条用户消息挂上投递回执 */
export function attachReceipt(state: ChatState, itemId: string, receipt: DeliveryReceipt): ChatState {
  const index = state.items.findIndex((it) => it.id === itemId);
  if (index < 0) return state;
  const item = state.items[index];
  if (!item || item.kind !== "user") return state;
  const items = state.items.slice();
  items[index] = { ...item, receipt };
  return { ...state, items };
}

export function appendNotice(
  state: ChatState,
  text: string,
  tone: "info" | "warn" | "bad",
  at: number,
): ChatState {
  const seq = state.seq + 1;
  return {
    ...state,
    seq,
    items: [...state.items, { kind: "notice", id: `n${seq}`, text, tone, at }],
  };
}

/**
 * 把一条 `session/update` 并进聊天状态。纯函数，返回新对象。
 * 认不出来的 `sessionUpdate` 落成 `unknown` 项并留住原文——core 不丢，壳也不丢。
 */
export function applyUpdate(
  state: ChatState,
  update: SessionUpdate,
  at: number,
  derived?: Derived,
): ChatState {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return appendChunk(state, "assistant", textOf(update.content), at);
    case "agent_thought_chunk":
      return appendChunk(state, "thought", textOf(update.content), at);
    case "user_message_chunk":
      return appendChunk(state, "user", textOf(update.content), at);
    case "tool_call":
      return upsertTool(state, update, at, true, derived);
    case "tool_call_update":
      return upsertTool(state, update, at, false, derived);
    case "plan": {
      const seq = state.seq + 1;
      const entries = Array.isArray(update.entries) ? update.entries : [];
      // 计划是整份替换的：同一轮里后一份覆盖前一份，不堆一串
      const lastPlan = state.items.findLastIndex((it) => it.kind === "plan");
      if (lastPlan >= 0) {
        const items = state.items.slice();
        items[lastPlan] = { kind: "plan", id: state.items[lastPlan]!.id, entries, at };
        return { ...state, items };
      }
      return { ...state, seq, items: [...state.items, { kind: "plan", id: `p${seq}`, entries, at }] };
    }
    case "usage_update":
      return {
        ...state,
        usage: {
          used: typeof update.used === "number" ? update.used : 0,
          size: typeof update.size === "number" ? update.size : 0,
          ...(update.cost ? { cost: update.cost } : {}),
        },
      };
    case "current_mode_update":
      return { ...state, currentModeId: update.currentModeId ?? state.currentModeId };
    case "config_option_update":
      return {
        ...state,
        configOptions: Array.isArray(update.configOptions)
          ? update.configOptions
          : state.configOptions,
        currentModeId:
          update.configOptions?.find((o) => o.id === "mode")?.currentValue ?? state.currentModeId,
      };
    case "available_commands_update":
      return {
        ...state,
        availableCommands: Array.isArray(update.availableCommands)
          ? (update.availableCommands as Array<{ name: string; description?: string }>)
          : state.availableCommands,
      };
    case "subagent_spawned": {
      const id = update.subagentSessionId;
      if (!id) return state;
      if (state.subagents.some((s) => s.subagentSessionId === id)) return state;
      const label = typeof update.title === "string" ? update.title : id;
      return {
        ...state,
        subagents: [...state.subagents, { subagentSessionId: id, label, state: "running", at }],
      };
    }
    case "subagent_state_update": {
      const id = update.subagentSessionId;
      if (!id) return state;
      const next = state.subagents.map((s) =>
        s.subagentSessionId === id
          ? { ...s, state: typeof update.status === "string" ? update.status : s.state, at }
          : s,
      );
      return { ...state, subagents: next };
    }
    default: {
      const seq = state.seq + 1;
      return {
        ...state,
        seq,
        items: [
          ...state.items,
          { kind: "unknown", id: `x${seq}`, sessionUpdate: update.sessionUpdate, raw: update, at },
        ],
      };
    }
  }
}

function appendChunk(
  state: ChatState,
  kind: "assistant" | "thought" | "user",
  text: string,
  at: number,
): ChatState {
  if (!text) return state;
  const last = state.items.at(-1);
  if (last && last.kind === kind) {
    const items = state.items.slice();
    items[items.length - 1] = { ...last, text: last.text + text, at } as ChatItem;
    return { ...state, items };
  }
  const seq = state.seq + 1;
  const prefix = kind === "assistant" ? "a" : kind === "thought" ? "t" : "u";
  return {
    ...state,
    seq,
    items: [...state.items, { kind, id: `${prefix}${seq}`, text, at } as ChatItem],
  };
}

function upsertTool(
  state: ChatState,
  update: SessionUpdate,
  at: number,
  isFirstCard: boolean,
  derived?: Derived,
): ChatState {
  // `derived.changeStat` 是 core 算的旁路字段，只出现在**结算那一条**通知上。
  const changeStat = derived?.changeStat;
  const callId = update.toolCallId;
  if (!callId) return state;

  const existingIndex = state.toolIndex[callId];
  const existingItem =
    existingIndex === undefined ? undefined : state.items[existingIndex];
  const existing =
    existingItem && existingItem.kind === "tool" ? existingItem.card : undefined;

  // 工具卡的输出是 `[{ type: "content", content: {...} }]` 这种带壳形状，
  // 也可能直接就是内容块——两种都收，不认识的原样留着。
  const incomingContent: ContentBlock[] = Array.isArray(update.content)
    ? update.content
        .map((entry: ToolCallContent) => (entry.content ?? (entry as ContentBlock)) as ContentBlock)
        .filter((c): c is ContentBlock => Boolean(c))
    : [];

  if (!existing) {
    // 兜底：只收到 update 没收到首卡时照样建卡，并记下 sawFirstCard=false。
    const card: ToolCard = {
      callId,
      title: update.title ?? callId,
      toolName: isFirstCard ? null : (update.title ?? null),
      kind: update.kind ?? null,
      status: isFirstCard
        ? toStatus(update.status, "pending")
        : inferStatus(update, "pending"),
      rawInput: update.rawInput ?? null,
      rawOutput: update.rawOutput ?? null,
      content: incomingContent,
      locations: Array.isArray(update.locations) ? update.locations : [],
      ...(changeStat?.length ? { changeStat } : {}),
      ...(update._meta !== undefined ? { meta: update._meta } : {}),
      sawFirstCard: isFirstCard,
      createdAt: at,
      updatedAt: at,
    };
    const seq = state.seq + 1;
    return {
      ...state,
      seq,
      items: [...state.items, { kind: "tool", id: `c${seq}`, card }],
      toolIndex: { ...state.toolIndex, [callId]: state.items.length },
    };
  }

  const card: ToolCard = {
    ...existing,
    // 首卡的标题最具体（实测是完整命令），后续 update 的 title 是工具名，另存一格
    title: isFirstCard ? (update.title ?? existing.title) : existing.title,
    toolName: isFirstCard ? existing.toolName : (update.title ?? existing.toolName),
    kind: update.kind ?? existing.kind,
    status: inferStatus(update, existing.status),
    rawInput: update.rawInput ?? existing.rawInput,
    rawOutput: update.rawOutput ?? existing.rawOutput,
    content: incomingContent.length ? [...existing.content, ...incomingContent] : existing.content,
    locations: Array.isArray(update.locations) ? update.locations : existing.locations,
    ...(changeStat?.length
      ? { changeStat }
      : existing.changeStat
        ? { changeStat: existing.changeStat }
        : {}),
    ...(update._meta !== undefined ? { meta: update._meta } : existing.meta !== undefined ? { meta: existing.meta } : {}),
    sawFirstCard: existing.sawFirstCard || isFirstCard,
    updatedAt: at,
  };
  const items = state.items.slice();
  items[existingIndex!] = { kind: "tool", id: existingItem!.id, card };
  return { ...state, items };
}

// ── 回合边界 ──────────────────────────────────────────────

/** `turn_started` 通知。老 core 没有这条时，store 在发 prompt 的那一刻本地补一条。 */
export function beginTurn(state: ChatState, turnId: string, startedAt: number): ChatState {
  if (state.turns.some((t) => t.turnId === turnId)) return state;
  return { ...state, turns: [...state.turns, { turnId, startedAt, endedAt: null }] };
}

/**
 * `turn_finished` 通知。落一条 `turn-end` 项：stopReason 按白名单渲染，
 * `changes` 有就挂文件改动汇总卡；**字段缺失就不挂卡**，不显示 0 个文件。
 */
export function endTurn(
  state: ChatState,
  input: { turnId: string; stopReason?: string; endedAt: number; changes?: TurnChanges },
): ChatState {
  const seq = state.seq + 1;
  const turn = state.turns.find((t) => t.turnId === input.turnId);
  const turns = turn
    ? state.turns.map((t) =>
        t.turnId === input.turnId
          ? { ...t, endedAt: input.endedAt, ...(input.stopReason ? { stopReason: input.stopReason } : {}) }
          : t,
      )
    : [
        ...state.turns,
        {
          turnId: input.turnId,
          startedAt: input.endedAt,
          endedAt: input.endedAt,
          ...(input.stopReason ? { stopReason: input.stopReason } : {}),
        },
      ];
  return {
    ...state,
    seq,
    turns,
    items: [
      ...state.items,
      {
        kind: "turn-end",
        id: `e${seq}`,
        turnId: input.turnId,
        at: input.endedAt,
        ...(input.stopReason ? { stopReason: input.stopReason } : {}),
        ...(input.changes ? { changes: input.changes } : {}),
        ...(turn ? { startedAt: turn.startedAt } : {}),
      },
    ],
  };
}

/** 汇总卡被撤销之后把那条 turn-end 标成 reverted（卡上换「已撤销」标签，藏起撤销按钮） */
export function markReverted(state: ChatState, turnId: string): ChatState {
  return {
    ...state,
    items: state.items.map((it) =>
      it.kind === "turn-end" && it.turnId === turnId ? { ...it, reverted: true } : it,
    ),
  };
}

/** 审批被拒 → 那张工具卡进 `denied` 本地态（ACP 的 status 里没有这个值） */
export function markToolDenied(state: ChatState, toolCallId: string): ChatState {
  const index = state.toolIndex[toolCallId];
  if (index === undefined) return state;
  const item = state.items[index];
  if (!item || item.kind !== "tool") return state;
  const items = state.items.slice();
  items[index] = { kind: "tool", id: item.id, card: { ...item.card, local: "denied" } };
  return { ...state, items };
}

/** 用户 `session/cancel` → 还在跑的工具卡全部进 `stopped` 本地态 */
export function markRunningStopped(state: ChatState): ChatState {
  let changed = false;
  const items = state.items.map((item) => {
    if (item.kind !== "tool") return item;
    if (item.card.status !== "pending" && item.card.status !== "in_progress") return item;
    if (item.card.local) return item;
    changed = true;
    return { kind: "tool" as const, id: item.id, card: { ...item.card, local: "stopped" as const } };
  });
  return changed ? { ...state, items } : state;
}
