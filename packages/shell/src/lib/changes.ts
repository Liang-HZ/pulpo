// 文件改动的行数统计与聚合。
//
// 三条路，按可信度排序：
//   ① core 读取层派生的 `changeStat`（它能同时看到 diff 与入参，最全）；
//   ② 工具卡自带的 diff 块 → 逐行数 `+` / `-`（**不是 newLines - oldLines**，那是净变化）；
//   ③ 没有 diff 块时按入参数行数——这条不需要 agent 配合，覆盖面最大。
//
// 三条都算不出来就**不给数字**。规则是"字段缺失 → 不渲染该项"，
// 不是显示 0：0 会被读成"改了文件但一行没动"，那是假话。

import type { ChangeStat } from "./protocol";
import type { ChatItem, ToolCard } from "./chat";
import { diffBlocks, effectiveKind, toolPath, toolState } from "./tools";

export interface ChangeSummary {
  /** 按工作区相对路径去重后的逐文件行 */
  files: ChangeStat[];
  added: number;
  removed: number;
  /** 解析不出路径的写入条数——如实计数，不并进某个文件 */
  pathless: number;
}

export const EMPTY_SUMMARY: ChangeSummary = { files: [], added: 0, removed: 0, pathless: 0 };

/** 行数。空串算 0 行；末尾换行不额外算一行。 */
export function lineCount(text: unknown): number {
  if (typeof text !== "string" || text.length === 0) return 0;
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return body.split("\n").length;
}

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 按入参数行数（四条公式）。
 * Write / Edit / MultiEdit / NotebookEdit 各一条，认不出的形状返回 null。
 */
export function statFromInput(input: unknown): { added: number; removed: number } | null {
  const i = rec(input);
  if (!i) return null;
  if (Array.isArray(i["edits"])) {
    let added = 0;
    let removed = 0;
    let hit = false;
    for (const entry of i["edits"] as unknown[]) {
      const e = rec(entry);
      if (!e) continue;
      if (e["new_string"] === undefined && e["old_string"] === undefined) continue;
      hit = true;
      added += lineCount(e["new_string"]);
      removed += lineCount(e["old_string"]);
    }
    return hit ? { added, removed } : null;
  }
  if (i["new_string"] !== undefined || i["old_string"] !== undefined) {
    return { added: lineCount(i["new_string"]), removed: lineCount(i["old_string"]) };
  }
  if (i["new_source"] !== undefined) {
    return { added: lineCount(i["new_source"]), removed: 0 };
  }
  if (i["content"] !== undefined && typeof i["content"] === "string") {
    return { added: lineCount(i["content"]), removed: 0 };
  }
  return null;
}

/**
 * 从 diff 块的 oldText / newText 数加减行。
 * 掐掉公共前后缀之后剩下的就是真正动过的行——比 `newLines - oldLines` 诚实。
 */
export function statFromDiff(oldText: string, newText: string): { added: number; removed: number } {
  const a = oldText.length ? oldText.replace(/\n$/, "").split("\n") : [];
  const b = newText.length ? newText.replace(/\n$/, "").split("\n") : [];
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }
  return { added: b.length - head - tail, removed: a.length - head - tail };
}

/** 统一的路径归一：反斜杠转正斜杠，这是去重的唯一依据 */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

/** 一张工具卡的行数统计。算不出来返回 null（不是 0）。 */
export function cardStat(card: ToolCard): ChangeStat[] | null {
  if (card.changeStat?.length) return card.changeStat;
  const diffs = diffBlocks(card);
  if (diffs.length) {
    return diffs.map((d) => {
      const { added, removed } = statFromDiff(d.oldText, d.newText);
      const path = d.path ?? toolPath(card);
      return path ? { path: normalizePath(path), added, removed } : { added, removed };
    });
  }
  const fromInput = statFromInput(card.rawInput);
  if (!fromInput) return null;
  const path = toolPath(card);
  return [path ? { path: normalizePath(path), ...fromInput } : fromInput];
}

/** 这张卡是不是"已结算的写入"。失败 / 被拒 / 被停的编辑不计入总数。 */
export function countsTowardChanges(card: ToolCard): boolean {
  const state = toolState(card);
  if (state !== "completed") return false;
  const kind = effectiveKind(card);
  return kind === "edit" || kind === "delete" || kind === "move";
}

/**
 * 聚合成一张汇总卡的数字。
 * **文件数 = 去重后的路径数**，不是 edit 调用次数：发生七次 edit 落在三条路径上，
 * 卡上写的是「3 个文件已更改」。
 */
export function aggregateChanges(cards: ToolCard[]): ChangeSummary {
  const byPath = new Map<string, ChangeStat>();
  let pathless = 0;
  let pathlessAdded = 0;
  let pathlessRemoved = 0;

  for (const card of cards) {
    if (!countsTowardChanges(card)) continue;
    const stats = cardStat(card);
    if (!stats) {
      pathless += 1;
      continue;
    }
    for (const stat of stats) {
      if (!stat.path) {
        pathless += 1;
        pathlessAdded += stat.added;
        pathlessRemoved += stat.removed;
        continue;
      }
      const key = normalizePath(stat.path);
      const prev = byPath.get(key);
      if (prev) {
        prev.added += stat.added;
        prev.removed += stat.removed;
      } else {
        byPath.set(key, { path: key, added: stat.added, removed: stat.removed });
      }
    }
  }

  const files = [...byPath.values()].sort(
    (a, b) => b.added + b.removed - (a.added + a.removed) || (a.path ?? "").localeCompare(b.path ?? ""),
  );
  return {
    files,
    added: files.reduce((n, f) => n + f.added, 0) + pathlessAdded,
    removed: files.reduce((n, f) => n + f.removed, 0) + pathlessRemoved,
    pathless,
  };
}

/** core 直接给的 `turn_finished.changes` / `session/changes` 也走同一条去重 */
export function summarizeStats(stats: ChangeStat[], pathless = 0): ChangeSummary {
  const byPath = new Map<string, ChangeStat>();
  let extra = pathless;
  let extraAdded = 0;
  let extraRemoved = 0;
  for (const stat of stats) {
    if (!stat.path) {
      extra += 1;
      extraAdded += stat.added;
      extraRemoved += stat.removed;
      continue;
    }
    const key = normalizePath(stat.path);
    const prev = byPath.get(key);
    if (prev) {
      prev.added += stat.added;
      prev.removed += stat.removed;
    } else {
      byPath.set(key, { path: key, added: stat.added, removed: stat.removed });
    }
  }
  const files = [...byPath.values()].sort(
    (a, b) => b.added + b.removed - (a.added + a.removed) || (a.path ?? "").localeCompare(b.path ?? ""),
  );
  return {
    files,
    added: files.reduce((n, f) => n + f.added, 0) + extraAdded,
    removed: files.reduce((n, f) => n + f.removed, 0) + extraRemoved,
    pathless: extra,
  };
}

/** 汇总卡要不要渲染。`files <= 0` 时整卡不渲染，不显示「0 个文件」。 */
export function hasChanges(summary: ChangeSummary | null | undefined): boolean {
  return Boolean(summary && (summary.files.length > 0 || summary.pathless > 0));
}

/**
 * 每个回合各自的工具卡（按 `turn-end` 标记切段）。
 * 这是汇总卡在 core 还没给 `turn_finished.changes` 时的**本地兜底**来源：
 * 用的是"从 tool.input 直接数行"的同一套公式，数字出处仍然是 agent 自己的入参。
 */
export function cardsByTurn(items: ChatItem[]): Record<string, ToolCard[]> {
  const out: Record<string, ToolCard[]> = {};
  let bucket: ToolCard[] = [];
  for (const item of items) {
    if (item.kind === "tool") {
      bucket.push(item.card);
      continue;
    }
    if (item.kind === "turn-end") {
      out[item.turnId] = bucket;
      bucket = [];
    }
  }
  return out;
}
