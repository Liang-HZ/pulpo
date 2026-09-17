// 三条纯策略：stopReason 白名单、未读判定、访问模式危险等级。
// 都是壳内实现，都不猜——缺字段就按"没说"处理。

import type { ModeRisk } from "./protocol";

// ── stopReason 的 UI 语义 ───────────────────────────────────────────────────
export type StopTone = "silent" | "muted" | "warning" | "danger";

export interface StopNotice {
  tone: StopTone;
  text: string;
  /** 有行动按钮时给一个 actionId；没有就是 null */
  action: "continue" | null;
  /** 是不是白名单里的取值。false = 原样显示 agent 的字符串 */
  known: boolean;
}

/**
 * PROTOCOL §4.5 说 `stopReason` 的取值由 agent 决定。
 * UI 按白名单渲染，**其余一律显示原始字符串**，不 fallback 成「完成」——
 * 把没见过的收尾说成"完成"就是编造 agent 的意思。
 */
export function stopNotice(reason: string | null | undefined): StopNotice | null {
  if (!reason) return null;
  switch (reason) {
    case "end_turn":
      return { tone: "silent", text: "", action: null, known: true };
    case "cancelled":
      return { tone: "muted", text: "已停止", action: null, known: true };
    case "max_tokens":
      return { tone: "warning", text: "达到输出上限", action: "continue", known: true };
    case "refusal":
      return { tone: "danger", text: "agent 拒绝了这次请求：refusal", action: null, known: true };
    default:
      return { tone: "muted", text: `回合结束：${reason}`, action: null, known: false };
  }
}

// ── 未读游标 ────────────────────────────────────────────────────────────────
/**
 * `read/list` 有 `status`，但没有"我上次看到哪"。这个游标是**客户端视图状态**，
 * 不是会话内容，壳自己存不违反零副本。
 */
export function isUnread(
  updatedAt: number | null | undefined,
  lastSeenAt: number | null | undefined,
): boolean {
  if (typeof updatedAt !== "number") return false;
  if (typeof lastSeenAt !== "number") return false;
  return updatedAt > lastSeenAt;
}

// ── 访问模式的危险等级 → chip 变体 ──────────────────────────────────────────
export type ChipVariant = "neutral" | "outline" | "warn" | "brand";

/**
 * **绝不能在 UI 里 `if (modeId.includes("yolo"))`**。等级只来自 descriptor 的
 * `modes[].risk`；agent 没自报、core 也没覆盖时字段缺失，按 neutral 渲染，
 * 名字仍然原样显示 agent 给的 `modes[].name`。
 */
export function riskVariant(risk: ModeRisk | undefined | null): ChipVariant {
  switch (risk) {
    case "full":
      return "warn";
    case "elevated":
      return "outline";
    case "safe":
      return "neutral";
    default:
      return "neutral";
  }
}

/** chip 上要不要挂警示图标。全屏唯一的橙色就在这里。 */
export function riskWarns(risk: ModeRisk | undefined | null): boolean {
  return risk === "full";
}

// ── 记忆 / 规则文件变更的 UI 侧推断 ─────────────────────────────────────────
const MEMORY_FILES = [
  "CLAUDE.md",
  "AGENTS.md",
  "AGENT.md",
  ".cursorrules",
  ".windsurfrules",
  "GEMINI.md",
  "QWEN.md",
  "copilot-instructions.md",
];

/**
 * 没有 `memory_updated` 通知之前，按工具卡里的路径命中约定文件名来推断。
 * 这是 UI 侧推断，右栏那行文案也如实这么写。
 */
export function isMemoryPath(path: string | null | undefined): boolean {
  if (!path) return false;
  const name = path.replace(/\\/g, "/").split("/").pop() ?? "";
  return MEMORY_FILES.some((f) => f.toLowerCase() === name.toLowerCase());
}

// ── 上下文用量的三档配色 ────────────────────────────────────────────────────
export type UsageLevel = "normal" | "warning" | "danger";

/** >80% 变 warning，>95% 变 danger，并且**必须**同时给出百分比文字。 */
export function usageLevel(used: number, total: number): UsageLevel {
  if (!total || total <= 0) return "normal";
  const ratio = used / total;
  if (ratio > 0.95) return "danger";
  if (ratio > 0.8) return "warning";
  return "normal";
}
