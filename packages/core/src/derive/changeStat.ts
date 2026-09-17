/**
 * 派生字段 `changeStat`。
 *
 * UI 要的是「+N −N」。ACP 没规定 agent 必须给 diff，所以这里做**两级兜底**，
 * 两级都在 core 侧算，agent 不需要配合：
 *
 *  ① `tool_call` / `tool_call_update` 的 `content` 里有 `{type:"diff"}` 块
 *     → 就地用 `oldText` / `newText` 合成 unified diff 再数（2 行上下文，
 *     封顶 8 文件 / 1200 行）；
 *  ② 没有 diff 块 → 直接从工具入参数行数（四条公式）。
 *
 * **都算不出就不给字段**——绝不塞 0。UI 按"字段缺失 → 不渲染统计"处理。
 *
 * 派生字段**不落盘**，也不改写 agent 的 update 原文（PROTOCOL §5）：
 * 实时通道上它挂在通知的旁路字段 `derived.changeStat` 上，读取层上挂在
 * `part.tool.changeStat` 上。两处都是读穿时现算的，不进 `$PULPO_HOME`。
 */

export interface ChangeStat {
  /** agent 给的路径，原样保留（只把反斜杠归一成 `/` 用于去重）。 */
  path: string;
  added: number;
  removed: number;
}

/** 合成 unified diff 的上下文行数。 */
export const DIFF_CONTEXT_LINES = 2;
/** 一次统计最多算几个文件。 */
export const MAX_DIFF_FILES = 8;
/** 一个 diff 最多算多少行（含上下文，封顶 1200）。 */
export const MAX_DIFF_LINES = 1200;
/** LCS 的规模闸门：超过这个格子数就不做精确 diff（见 `diffLines`）。 */
export const MAX_LCS_CELLS = 4_000_000;

/** 行数：空串是 0 行；末尾换行不额外算一行（`"a\nb\nc\n"` = 3）。 */
export function countLines(text: unknown): number {
  if (typeof text !== "string" || text === "") return 0;
  return text.replace(/\n$/, "").split("\n").length;
}

/** 路径归一：只把 `\` 换成 `/` 用作去重键，展示仍用原值（与 Claude 桌面端同款）。 */
export function normalizePathKey(p: string): string {
  return p.replace(/\\/g, "/");
}

type DiffOp = { kind: "same" | "add" | "del"; line: string };

/**
 * 行级 diff。先剥掉公共前后缀再做 LCS——真实编辑绝大多数是局部的，
 * 剥完之后规模通常只有几十行。
 *
 * 规模闸门：剥完仍然大到 `MAX_LCS_CELLS` 以上时不做精确匹配，退化成
 * 「旧的全删、新的全加」。这是**如实的上界**，不是猜——而且这种规模的
 * 单次编辑本来就会撞上 `MAX_DIFF_LINES` 封顶。
 */
export function diffLines(oldLines: string[], newLines: string[]): DiffOp[] {
  let head = 0;
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) {
    head++;
  }
  let tail = 0;
  while (
    tail < oldLines.length - head &&
    tail < newLines.length - head &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) {
    tail++;
  }
  const a = oldLines.slice(head, oldLines.length - tail);
  const b = newLines.slice(head, newLines.length - tail);

  const ops: DiffOp[] = [];
  for (let i = 0; i < head; i++) ops.push({ kind: "same", line: oldLines[i]! });

  if (a.length * b.length > MAX_LCS_CELLS) {
    for (const l of a) ops.push({ kind: "del", line: l });
    for (const l of b) ops.push({ kind: "add", line: l });
  } else {
    // 经典 LCS 表。a/b 已经剥过公共前后缀，实测规模很小。
    const m = a.length;
    const n = b.length;
    const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (a[i] === b[j]) {
        ops.push({ kind: "same", line: a[i]! });
        i++;
        j++;
      } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
        ops.push({ kind: "del", line: a[i]! });
        i++;
      } else {
        ops.push({ kind: "add", line: b[j]! });
        j++;
      }
    }
    while (i < m) ops.push({ kind: "del", line: a[i++]! });
    while (j < n) ops.push({ kind: "add", line: b[j++]! });
  }

  for (let k = newLines.length - tail; k < newLines.length; k++) {
    ops.push({ kind: "same", line: newLines[k]! });
  }
  return ops;
}

export interface DiffCount {
  added: number;
  removed: number;
  /** 撞上 `MAX_DIFF_LINES` 封顶，后面的没算。 */
  truncated: boolean;
}

/**
 * 由 `oldText` / `newText` 合成 unified diff（2 行上下文）再数加减行。
 *
 * **不要用 `newLines - oldLines`**——那是净变化，不是加减行数。
 * 只数 diff 里以 `+` / `-` 开头的那些；上下文行只占封顶预算，不进计数。
 */
export function unifiedDiffCount(oldText: string, newText: string): DiffCount {
  const ops = diffLines(splitLines(oldText), splitLines(newText));
  // 标出哪些 same 行会作为上下文进 hunk（距离最近的增删 ≤ 2 行）。
  const inHunk = new Array<boolean>(ops.length).fill(false);
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]!.kind === "same") continue;
    const from = Math.max(0, i - DIFF_CONTEXT_LINES);
    const to = Math.min(ops.length - 1, i + DIFF_CONTEXT_LINES);
    for (let k = from; k <= to; k++) inHunk[k] = true;
  }
  let emitted = 0;
  let added = 0;
  let removed = 0;
  for (let i = 0; i < ops.length; i++) {
    if (!inHunk[i]) continue;
    if (emitted >= MAX_DIFF_LINES) return { added, removed, truncated: true };
    emitted++;
    if (ops[i]!.kind === "add") added++;
    else if (ops[i]!.kind === "del") removed++;
  }
  return { added, removed, truncated: false };
}

function splitLines(text: unknown): string[] {
  if (typeof text !== "string" || text === "") return [];
  return text.replace(/\n$/, "").split("\n");
}

/** 从 ACP 的 `ToolCallContent[]` 里挑出 diff 块并合成统计（第 ① 级）。 */
export function changeStatFromDiffBlocks(content: unknown): ChangeStat[] {
  if (!Array.isArray(content)) return [];
  const out = new Map<string, ChangeStat>();
  for (const block of content) {
    const b = block as { type?: unknown; path?: unknown; oldText?: unknown; newText?: unknown };
    if (b?.type !== "diff") continue;
    const path = typeof b.path === "string" && b.path ? b.path : "";
    if (!path) continue;
    const key = normalizePathKey(path);
    if (!out.has(key) && out.size >= MAX_DIFF_FILES) continue;
    const { added, removed } = unifiedDiffCount(
      typeof b.oldText === "string" ? b.oldText : "",
      typeof b.newText === "string" ? b.newText : "",
    );
    merge(out, key, path, added, removed);
  }
  return [...out.values()];
}

/** 路径取值顺序：第一个有值的算数。 */
const PATH_KEYS = [
  "file_path",
  "notebook_path",
  "path",
  "display_file_path",
  "filePath",
  "notebookPath",
] as const;

export function toolPath(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  for (const k of PATH_KEYS) {
    const v = o[k];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

/**
 * 从工具入参直接数行（第 ② 级，四条公式）。
 *
 * ```
 * Write        → { added: 行数(content),    removed: 0 }
 * Edit         → { added: 行数(new_string), removed: 行数(old_string) }
 * MultiEdit    → 对 edits[] 累加上面这条
 * NotebookEdit → { added: 行数(new_source), removed: 0 }
 * ```
 *
 * 这条不需要 agent 给 diff，覆盖面最大（实测 ZCode adapter 的 `tool_call`
 * 只带 `rawInput`，没有 diff 块，走的就是这一条）。
 */
export function changeStatFromInput(toolName: unknown, input: unknown): ChangeStat[] {
  if (!input || typeof input !== "object") return [];
  const name = normalizeToolName(toolName);
  const o = input as Record<string, unknown>;
  const out = new Map<string, ChangeStat>();
  const path = toolPath(input);
  if (!path) return [];
  const key = normalizePathKey(path);

  switch (name) {
    case "write":
      merge(out, key, path, countLines(o.content ?? o.contents ?? o.text), 0);
      break;
    case "edit":
      merge(out, key, path, countLines(o.new_string ?? o.newString), countLines(o.old_string ?? o.oldString));
      break;
    case "multiedit": {
      const edits = Array.isArray(o.edits) ? o.edits : [];
      for (const e of edits) {
        const ed = (e ?? {}) as Record<string, unknown>;
        // 每条 edit 可以自带路径（少数实现允许跨文件），没有就用顶层的。
        const p = toolPath(ed) ?? path;
        merge(
          out,
          normalizePathKey(p),
          p,
          countLines(ed.new_string ?? ed.newString),
          countLines(ed.old_string ?? ed.oldString),
        );
      }
      break;
    }
    case "notebookedit":
      merge(out, key, path, countLines(o.new_source ?? o.newSource), 0);
      break;
    default:
      return [];
  }
  return [...out.values()].filter((s) => s.added > 0 || s.removed > 0).slice(0, MAX_DIFF_FILES);
}

/** 工具名归一：去掉 MCP 前缀与分隔符，小写。`mcp__x__Edit` → `edit`。 */
export function normalizeToolName(name: unknown): string {
  const s = String(name ?? "");
  const last = s.split("__").pop() ?? s;
  return last.replace(/[\s_-]/g, "").toLowerCase();
}

function merge(out: Map<string, ChangeStat>, key: string, path: string, added: number, removed: number): void {
  const prev = out.get(key);
  if (prev) {
    prev.added += added;
    prev.removed += removed;
    return;
  }
  if (out.size >= MAX_DIFF_FILES) return;
  out.set(key, { path, added, removed });
}

/**
 * 一条 `tool_call` / `tool_call_update` 的候选统计。
 * 有 diff 块就用 diff 块（更准），否则退回入参数行。
 */
export function changeStatOf(update: Record<string, unknown>, toolName?: unknown): ChangeStat[] {
  const fromDiff = changeStatFromDiffBlocks(update.content);
  if (fromDiff.length) return fromDiff;
  const name = toolName ?? update.toolName ?? update.title ?? update.name;
  const input = update.rawInput ?? update.input;
  const byName = changeStatFromInput(name, input);
  if (byName.length) return byName;
  // 标题常常是 `Edit foo.ts` 这种，取第一个词再试一次——ZCode adapter 的
  // `tool_call` 不带工具名字段，名字只在 title 里。
  const title = typeof update.title === "string" ? update.title.split(/\s+/)[0] : undefined;
  return title ? changeStatFromInput(title, input) : [];
}

/** 是不是"失败/报错"的工具结果——失败的编辑不计入。 */
export function isErrorResult(update: Record<string, unknown>): boolean {
  const status = update.status;
  if (status === "failed") return true;
  const rawOutput = update.rawOutput as { is_error?: unknown; isError?: unknown } | undefined;
  return rawOutput?.is_error === true || rawOutput?.isError === true;
}

/**
 * 实时通道上的暂存 / 提交（Claude 桌面端的做法）。
 *
 * **入参到手时先暂存，等结果回来且非 error 才提交**。失败的编辑一行都不算。
 * 内存态，随会话关闭清掉，不落盘。
 */
export class ChangeStatTracker {
  private readonly pending = new Map<string, { stats: ChangeStat[]; toolName?: unknown }>();
  private readonly committed = new Set<string>();

  /**
   * 吃一条 session update。返回值非空 = 这条 update 该带上 `derived.changeStat`。
   * 只在工具结算（且非 error）的那一条上返回，`tool_call` 阶段只暂存。
   */
  onUpdate(update: unknown): ChangeStat[] | undefined {
    if (!update || typeof update !== "object") return undefined;
    const u = update as Record<string, unknown>;
    const kind = u.sessionUpdate;
    if (kind !== "tool_call" && kind !== "tool_call_update") return undefined;
    const id = typeof u.toolCallId === "string" ? u.toolCallId : "";
    if (!id) return undefined;

    if (isErrorResult(u)) {
      // 失败 → 丢掉暂存，绝不提交。
      this.pending.delete(id);
      return undefined;
    }

    const prev = this.pending.get(id);
    const stats = changeStatOf(u, prev?.toolName);
    if (stats.length) {
      const toolName = u.toolName ?? u.title ?? prev?.toolName;
      this.pending.set(id, { stats, ...(toolName === undefined ? {} : { toolName }) });
    }

    const settled = u.status === "completed";
    if (!settled) return undefined;
    const ready = this.pending.get(id);
    this.pending.delete(id);
    if (!ready?.stats.length) return undefined;
    if (this.committed.has(id)) return undefined; // 同一条工具只提交一次
    this.committed.add(id);
    return ready.stats;
  }

  /** 还没结算的工具（诊断用）。 */
  get pendingCount(): number {
    return this.pending.size;
  }

  forget(): void {
    this.pending.clear();
    this.committed.clear();
  }
}

/** 汇总：多条 changeStat 合成一行「N 个文件 +A −R」。 */
export function sumChangeStat(stats: ChangeStat[]): { files: number; added: number; removed: number } {
  const seen = new Set<string>();
  let added = 0;
  let removed = 0;
  for (const s of stats) {
    seen.add(normalizePathKey(s.path));
    added += s.added;
    removed += s.removed;
  }
  return { files: seen.size, added, removed };
}
