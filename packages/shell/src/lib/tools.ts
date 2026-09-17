// 工具卡的认读层。
//
// ACP 的 `kind` 只有十个值，七个渠道的工具远不止，所以 kind 不够用时按 rawInput 的
// **形状**嗅。嗅出来的结果只影响图标与标题，**不影响任何行为**——不认识的工具照样
// 原样渲染，不会被当成别的东西执行。

import type { ToolCard } from "./chat";
import { basename, relativePath } from "./format";

export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

const KINDS: ToolKind[] = [
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
];

/** kind → 标签。`other` 的标签由调用方换成工具名原文。 */
export const KIND_LABEL: Record<ToolKind, string> = {
  read: "读取",
  edit: "编辑",
  delete: "删除",
  move: "移动",
  search: "搜索",
  execute: "终端",
  think: "思考",
  fetch: "抓取",
  switch_mode: "切换模式",
  other: "工具",
};

/** 六态：ACP 的四态 + 两个本地态（用户中断、审批拒绝） */
export type ToolState = "pending" | "in_progress" | "completed" | "failed" | "denied" | "stopped";

export const STATE_TEXT: Record<ToolState, string> = {
  pending: "等待中",
  in_progress: "执行中",
  completed: "已执行",
  failed: "执行失败",
  denied: "已拒绝",
  stopped: "已停止",
};

export function toolState(card: ToolCard): ToolState {
  if (card.local) return card.local;
  return card.status;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * `_meta` 里各家自己塞的工具名（`inferLiveToolName` 的第一步）。
 * ZCode / Claude Code / xAI 都往这里塞，读到就直接用，不用猜。
 */
export function metaToolName(card: ToolCard): string | null {
  const meta = record(card.meta);
  if (!meta) return null;
  for (const key of ["claudeCode", "qoder", "zcode"]) {
    const scoped = record(meta[key]);
    const name = scoped ? str(scoped["toolName"]) : null;
    if (name) return name;
  }
  const xai = record(meta["x.ai/tool"]);
  const kind = xai ? str(xai["kind"]) : null;
  return kind;
}

/** 按 rawInput 的形状嗅工具（顺序照抄 Codeg）。只影响图标与标题。 */
export function sniffKind(card: ToolCard): ToolKind | null {
  const input = record(card.rawInput);
  if (!input) return null;
  const patch = str(input["patch"]) ?? str(input["input"]);
  if (patch?.includes("*** Begin Patch")) return "edit";
  if (input["command"] || input["cmd"] || input["script"] || input["argv"]) return "execute";
  if (input["old_string"] !== undefined || input["new_string"] !== undefined) return "edit";
  if (input["content"] !== undefined && input["file_path"] !== undefined) return "edit";
  if (input["new_source"] !== undefined) return "edit";
  if (Array.isArray(input["edits"])) return "edit";
  if (Array.isArray(input["todos"])) return "other";
  if (input["url"]) return "fetch";
  if (input["pattern"] || input["query"]) return "search";
  if (input["subagent_type"]) return "other";
  if (input["file_path"] !== undefined || input["notebook_path"] !== undefined) return "read";
  return null;
}

/** agent 给的 kind 优先；给不出或给了表外的值才嗅形状；都没有就是 other。 */
export function effectiveKind(card: ToolCard): ToolKind {
  const declared = card.kind as ToolKind | null;
  if (declared && KINDS.includes(declared)) return declared;
  return sniffKind(card) ?? "other";
}

/** 工具涉及的第一个路径。取值顺序：locations → rawInput 的四个字段。 */
export function toolPath(card: ToolCard): string | null {
  const fromLocation = card.locations.find((l) => l.path)?.path;
  if (fromLocation) return fromLocation.replace(/\\/g, "/");
  const input = record(card.rawInput);
  if (!input) return null;
  for (const key of ["file_path", "notebook_path", "path", "display_file_path"]) {
    const value = str(input[key]);
    if (value) return value.replace(/\\/g, "/");
  }
  return null;
}

/** 抓取类工具引用的 URL（右栏「来源」用）。没有就当没有，不猜。 */
export function toolUrl(card: ToolCard): string | null {
  const input = record(card.rawInput);
  return input ? str(input["url"]) : null;
}

/** 终端命令首行、搜索查询串、抓取的域名——摘要行取的那一句。 */
export function toolSubject(card: ToolCard, cwd?: string | null): string | null {
  const kind = effectiveKind(card);
  const input = record(card.rawInput);
  if (kind === "execute" && input) {
    const command = str(input["command"]) ?? str(input["cmd"]) ?? str(input["script"]);
    if (command) return command.split("\n")[0] ?? command;
  }
  if (kind === "search" && input) {
    return str(input["pattern"]) ?? str(input["query"]);
  }
  if (kind === "fetch" && input) {
    const url = str(input["url"]);
    if (url) {
      try {
        return new URL(url).host;
      } catch {
        return url;
      }
    }
  }
  if (kind === "move" && input) {
    const from = str(input["source"]) ?? str(input["old_path"]);
    const to = str(input["destination"]) ?? str(input["new_path"]);
    if (from && to) return `${basename(from)} → ${basename(to)}`;
  }
  const path = toolPath(card);
  if (path) return relativePath(path, cwd);
  return null;
}

/**
 * 标题随状态换时态（Claude 桌面端的做法）。
 * 优先级：agent 给的 title > 错误/取消的覆盖文案 > 按 kind 生成的默认句 > 「使用了工具」。
 */
export function toolTitle(card: ToolCard, cwd?: string | null): string {
  const state = toolState(card);
  const subject = toolSubject(card, cwd);
  const kind = effectiveKind(card);
  const verb = KIND_LABEL[kind];

  if (state === "stopped") return subject ? `已停止${verb} ${subject}` : `已停止${verb}`;
  if (state === "denied") return subject ? `未执行：${subject}` : "未执行这次调用";
  if (state === "failed") return subject ? `${verb} ${subject} 失败` : `${verb}失败`;

  // agent 自己给的标题最具体（实测 ZCode 首卡给的是完整命令），有就**原样**用：
  // 前面已经有一个 kind 标签了，再套一层「正在编辑」就成了「编辑 正在编辑 Write a.txt」。
  // 时态由左边的状态词承担。
  if (card.title && card.title !== card.callId) {
    // agent 给的标题有时只是工具名（读穿历史时实测就是 `Write` / `Edit`）。
    // 补上路径/命令这一截，但只在标题里还没有的时候补——不重复、不改写。
    if (subject && !card.title.includes(subject) && !subject.includes(card.title)) {
      return `${card.title} ${subject}`;
    }
    return card.title;
  }
  if (!subject) return state === "in_progress" ? `正在使用工具` : "使用了工具";
  return state === "in_progress" ? `正在${verb} ${subject}` : `已${verb} ${subject}`;
}

/** 工具卡输出里的纯文本（终端回显、读到的内容）。diff 块另走一条路。 */
export function toolText(card: ToolCard): string {
  return card.content
    .map((c) => (typeof c.text === "string" ? c.text : ""))
    .filter(Boolean)
    .join("\n");
}

export interface DiffBlock {
  path: string | null;
  oldText: string;
  newText: string;
}

/** ACP 的 diff 内容块：`{ type: "diff", path, oldText, newText }` */
export function diffBlocks(card: ToolCard): DiffBlock[] {
  const out: DiffBlock[] = [];
  for (const block of card.content) {
    if (block.type !== "diff") continue;
    out.push({
      path: str(block["path"]),
      oldText: typeof block["oldText"] === "string" ? block["oldText"] : "",
      newText: typeof block["newText"] === "string" ? block["newText"] : "",
    });
  }
  return out;
}
