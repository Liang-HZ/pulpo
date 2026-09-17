// 工作段折叠的两层判定。两家各解决了一半，合起来才完整。
//
// 第一层 —— 段的边界（Claude 桌面端的做法）：把消息流走一遍，输出交替的 `content`（正文与
//   卡片类，内联渲染）与 `timeline`（思考 + 工具调用，这就是折叠段）。
//   规则只有一条：**遇到非空的正文就把当前 timeline 冲刷掉**。
//   所以一段 = 两段可见正文之间那一整串连续的思考/工具，
//   既不是"按回合"也不是"按工具名"。
//
// 第二层 —— 段内怎么归类（ZCode 的做法）：段内部再按**连续同类**分桶。
//   中间插进一条别类工具，桶就断开。

import type { ChatItem, ToolCard } from "./chat";
import { aggregateChanges } from "./changes";
import { duration } from "./format";
import { effectiveKind, toolState } from "./tools";

export type Bucket = "changes" | "terminal" | "explore" | "think" | "other";

export const BUCKET_LABEL: Record<Bucket, string> = {
  changes: "更改",
  terminal: "终端",
  explore: "探索",
  think: "思考",
  other: "工具",
};

export interface Group {
  bucket: Bucket;
  items: ChatItem[];
}

export type Block =
  | { kind: "content"; id: string; item: ChatItem }
  | { kind: "segment"; id: string; items: ChatItem[]; groups: Group[] };

/** 这条聊天项属于折叠段，还是必须内联显示的正文 / 卡片？ */
export function isTimelineItem(item: ChatItem): boolean {
  if (item.kind === "thought") return true;
  if (item.kind === "tool") return true;
  return false;
}

export function bucketOf(item: ChatItem): Bucket {
  if (item.kind === "thought") return "think";
  if (item.kind !== "tool") return "other";
  switch (effectiveKind(item.card)) {
    case "edit":
    case "delete":
    case "move":
      return "changes";
    case "execute":
      return "terminal";
    case "read":
    case "search":
    case "fetch":
      return "explore";
    case "think":
      return "think";
    default:
      return "other";
  }
}

/** 第二层：段内按**连续同类**分桶。只有连续的才合并。 */
export function bucketize(items: ChatItem[]): Group[] {
  const groups: Group[] = [];
  for (const item of items) {
    const bucket = bucketOf(item);
    const last = groups[groups.length - 1];
    if (last && last.bucket === bucket) last.items.push(item);
    else groups.push({ bucket, items: [item] });
  }
  return groups;
}

/**
 * 第一层：切段。空的 assistant 正文（流式刚开头还没有字）**不断段**——
 * 否则每收到一个空 chunk 就会把段劈碎。
 */
export function splitBlocks(items: ChatItem[]): Block[] {
  const blocks: Block[] = [];
  let pending: ChatItem[] = [];

  const flush = (): void => {
    if (pending.length === 0) return;
    if (pending.length === 1 && pending[0]!.kind === "tool") {
      // 单条**工具**不成段：直接渲染成普通工具卡，不套折叠壳。
      // 思考不在此列——思考段是单独一类（「思考中…」/「已思考 {n} 秒」），
      // 一段思考也要折起来，否则整屏都是 agent 的内心戏。
      blocks.push({ kind: "content", id: pending[0]!.id, item: pending[0]! });
    } else {
      // 段的记忆 key 取**首个子项的稳定标识**：工具卡用 ACP 的 toolCallId
      // （全局唯一，展开记忆就靠它），思考用 item id。
      const first = pending[0]!;
      const anchor = first.kind === "tool" ? first.card.callId : first.id;
      blocks.push({
        kind: "segment",
        id: `seg-${anchor}`,
        items: pending,
        groups: bucketize(pending),
      });
    }
    pending = [];
  };

  for (const item of items) {
    if (isTimelineItem(item)) {
      pending.push(item);
      continue;
    }
    if ((item.kind === "assistant" || item.kind === "user") && item.text.trim() === "") continue;
    flush();
    blocks.push({ kind: "content", id: item.id, item });
  }
  flush();
  return blocks;
}

/** 一张工具卡算不算"已结算"——已有结果或已被拒的才进标签，否则标签会跟着跳字。 */
export function isSettled(card: ToolCard): boolean {
  const state = toolState(card);
  return state === "completed" || state === "failed" || state === "denied" || state === "stopped";
}

/**
 * 流式中只用已结算的工具算标签；取消的、被拒且无结果的先剔除；
 * 剔空了就保留最后一个。这几条是"标签不闪"的全部原因，别省。
 */
export function labelCards(items: ChatItem[]): ToolCard[] {
  const cards = items.filter((i): i is Extract<ChatItem, { kind: "tool" }> => i.kind === "tool");
  const settled = cards.filter((i) => isSettled(i.card)).map((i) => i.card);
  if (settled.length > 0) return settled;
  const last = cards[cards.length - 1];
  return last ? [last.card] : [];
}

function uniquePaths(cards: ToolCard[]): number {
  const paths = new Set<string>();
  let pathless = 0;
  for (const card of cards) {
    const stats = card.locations.map((l) => l.path).filter((p): p is string => Boolean(p));
    if (stats.length === 0) {
      pathless += 1;
      continue;
    }
    for (const p of stats) paths.add(p.replace(/\\/g, "/"));
  }
  return paths.size + pathless;
}

export interface GroupSummary {
  bucket: Bucket;
  /** 摘要文案，如「更改 3 个文件」「终端 5 个命令, 失败 1」 */
  text: string;
  count: number;
}

/** 单个桶的摘要文案 */
export function groupSummary(group: Group): GroupSummary {
  const cards = group.items
    .filter((i): i is Extract<ChatItem, { kind: "tool" }> => i.kind === "tool")
    .map((i) => i.card);
  const n = group.items.length;

  if (group.bucket === "changes") {
    const withPath = cards.filter((c) => c.locations.some((l) => l.path));
    const files = withPath.length ? uniquePaths(cards) : 0;
    // 一个文件都没解析出来时退回「{n} 个工具」——不编一个文件数出来
    const text = files > 0 ? `更改 ${files} 个文件` : `更改 ${n} 个工具`;
    return { bucket: group.bucket, text, count: n };
  }
  if (group.bucket === "terminal") {
    const failed = cards.filter((c) => toolState(c) === "failed").length;
    const stopped = cards.filter((c) => toolState(c) === "stopped").length;
    let text = `终端 ${n} 个命令`;
    if (failed > 0) text += `, 失败 ${failed}`;
    if (stopped > 0) text += `, 已停止 ${stopped}`;
    return { bucket: group.bucket, text, count: n };
  }
  if (group.bucket === "explore") {
    return { bucket: group.bucket, text: `探索 ${n} 个工具`, count: n };
  }
  if (group.bucket === "think") {
    return { bucket: group.bucket, text: `思考 ${n} 段`, count: n };
  }
  return { bucket: group.bucket, text: `用了 ${n} 个工具`, count: n };
}

export interface SegmentLabel {
  /**
   * 折叠行最左边那截：`已工作 12秒` / `工作中 12秒`。
   * **算不出耗时就是 null**（读穿的历史里没有逐条时间戳）——
   * 那就不写这一截，让桶摘要顶上，而不是写一句「已工作 0秒」。
   */
  kindLabel: string | null;
  /** 中间的桶摘要，已按条数降序取前 N 个 */
  parts: string[];
  /** 剩下的桶收成一句 */
  rest: string | null;
  running: boolean;
  failed: number;
  /** 三条路都算不出来时是 null——**不渲染统计**，不显示 0 */
  added: number | null;
  removed: number | null;
}

/**
 * 折叠行的完整标签。
 * compact 密度下桶只取前 **2** 个，剩下的收成「…，以及另外 {n} 个工具」。
 */
export function segmentLabel(
  groups: Group[],
  opts: { running: boolean; startedAt: number; endedAt: number; maxParts?: number },
): SegmentLabel {
  const maxParts = opts.maxParts ?? 2;
  const summaries = groups.map(groupSummary).sort((a, b) => b.count - a.count);
  const head = summaries.slice(0, maxParts);
  const tail = summaries.slice(maxParts);
  const restCount = tail.reduce((n, s) => n + s.count, 0);

  const allCards = groups.flatMap((g) => labelCards(g.items));
  const failed = allCards.filter((c) => toolState(c) === "failed").length;
  const stat = aggregateChanges(allCards);
  const hasStat = stat.files.length > 0;

  const span = Math.max(0, opts.endedAt - opts.startedAt);
  // 不足一秒（或读穿的历史里根本没有逐条时间戳）就不写这一截：
  // 「已工作 0秒」既不好看也没信息量，让桶摘要顶上。
  return {
    kindLabel:
      span < 1000 && !opts.running
        ? null
        : opts.running
          ? `工作中 ${duration(span)}`
          : `已工作 ${duration(span)}`,
    parts: head.map((s) => s.text),
    rest: restCount > 0 ? `以及另外 ${restCount} 个工具` : null,
    running: opts.running,
    failed,
    added: hasStat ? stat.added : null,
    removed: hasStat ? stat.removed : null,
  };
}

/** 段跑完了没有：任一子工具还在 pending / in_progress 就算在跑 */
export function segmentRunning(items: ChatItem[]): boolean {
  return items.some((i) => {
    if (i.kind !== "tool") return false;
    const state = toolState(i.card);
    return state === "pending" || state === "in_progress";
  });
}

/** 段里有失败子项时**不自动收起**——失败被自动藏起来是 bug，不是特性。 */
export function segmentHasFailure(items: ChatItem[]): boolean {
  return items.some((i) => i.kind === "tool" && toolState(i.card) === "failed");
}

export function segmentSpan(items: ChatItem[]): { startedAt: number; endedAt: number } {
  let startedAt = Number.POSITIVE_INFINITY;
  let endedAt = 0;
  for (const item of items) {
    const from = item.kind === "tool" ? item.card.createdAt : item.at;
    const to = item.kind === "tool" ? item.card.updatedAt : item.at;
    if (from && from < startedAt) startedAt = from;
    if (to && to > endedAt) endedAt = to;
  }
  if (!Number.isFinite(startedAt)) startedAt = endedAt;
  return { startedAt, endedAt };
}
