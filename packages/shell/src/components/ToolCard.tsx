// 单条工具卡。
//
// 六态：ACP 的 pending / in_progress / completed / failed，加两个本地态
// denied（审批被拒）/ stopped（用户中断）。**橙色不给工具卡**——全屏唯一的橙留给
// 访问模式 chip，所以「已拒绝」是 `text-fg-subtle` + 删除线，不是橙。
//
// 这张卡对工具名不做任何特判：companion 注入的 `mcp__pulpo__*` 与 agent 自己的
// Bash / Write 走的是同一条渲染路径。

import { useState } from "react";
import type { ToolCard as ToolCardModel } from "../lib/chat";
import { cardStat } from "../lib/changes";
import { foldText, unifiedDiff } from "../lib/diff";
import { relativePath } from "../lib/format";
import { readOpen, toggleOpen } from "../lib/viewstate";
import {
  diffBlocks,
  effectiveKind,
  KIND_LABEL,
  metaToolName,
  STATE_TEXT,
  toolState,
  toolText,
  toolTitle,
  type ToolKind,
  type ToolState,
} from "../lib/tools";
import { Icon, type IconName } from "./Icon";
import { DiffCount, Spinner } from "./ui";

const KIND_ICON: Record<ToolKind, IconName> = {
  read: "file-text",
  edit: "pencil-line",
  delete: "trash",
  move: "corner-down-right",
  search: "search",
  execute: "terminal",
  think: "brain",
  fetch: "globe",
  switch_mode: "shuffle",
  other: "wrench",
};

function StateIcon({ state }: { state: ToolState }) {
  switch (state) {
    case "in_progress":
      return <Spinner size={14} className="text-brand" />;
    case "completed":
      return <Icon name="check" size={14} className="text-success" />;
    case "failed":
      return <Icon name="x" size={14} className="text-danger" />;
    case "denied":
      return <Icon name="circle-slash" size={14} className="text-fg-subtle" />;
    case "stopped":
      return <Icon name="square" size={14} className="text-fg-subtle" />;
    default:
      return <Icon name="circle" size={14} className="text-control" />;
  }
}

function DiffView({ oldText, newText }: { oldText: string; newText: string }) {
  const lines = unifiedDiff(oldText, newText);
  if (lines.length === 0) return null;
  return (
    <div className="max-h-(--layout-output-max) overflow-auto font-mono text-caption leading-normal">
      {lines.map((line, i) => {
        const tone =
          line.type === "add"
            ? "--color-diff-add"
            : line.type === "remove"
              ? "--color-diff-remove"
              : null;
        return (
          <div
            key={i}
            className="flex"
            style={
              tone
                ? {
                    backgroundColor: `color-mix(in srgb, var(${tone}) 14%, transparent)`,
                    boxShadow: `inset 3px 0 0 var(${tone})`,
                  }
                : undefined
            }
          >
            <span
              className="tabular w-12 shrink-0 border-r border-border px-2 text-right"
              style={
                tone
                  ? {
                      backgroundColor: `color-mix(in srgb, var(${tone}) 18%, var(--color-canvas))`,
                      color: `var(${tone})`,
                    }
                  : { color: "var(--color-fg-subtle)" }
              }
            >
              {line.type === "add" ? line.newNo : line.oldNo}
            </span>
            {/* `+` / `-` 的字符本身留在行首——颜色之外的第二通道 */}
            <span className="flex-1 px-3 break-all whitespace-pre-wrap">
              {line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}
              {line.text}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function Output({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const folded = expanded ? null : foldText(text);
  return (
    <div className="max-h-(--layout-output-max) overflow-auto rounded-lg bg-surface p-2 font-mono text-caption leading-normal break-words whitespace-pre-wrap text-fg-muted">
      {folded ? (
        <>
          {folded.head.join("\n")}
          {"\n"}
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="my-1 cursor-pointer text-brand underline decoration-1 underline-offset-2"
          >
            展开 {folded.hidden} 行
          </button>
          {"\n"}
          {folded.tail.join("\n")}
        </>
      ) : (
        text
      )}
    </div>
  );
}

export function ToolCard({ card, cwd }: { card: ToolCardModel; cwd?: string | null }) {
  const state = toolState(card);
  const kind = effectiveKind(card);
  const stat = cardStat(card);
  const diffs = diffBlocks(card);
  const text = toolText(card);
  const key = `tool:${card.callId}`;
  // completed 默认收起；failed **默认展开**，错误文本可复制
  const fallbackOpen = state === "failed";
  const [, force] = useState(0);
  const open = readOpen(key, fallbackOpen);
  const hasBody = diffs.length > 0 || text.length > 0;
  const label = kind === "other" ? (metaToolName(card) ?? KIND_LABEL.other) : KIND_LABEL[kind];
  const added = stat?.reduce((n, s) => n + s.added, 0) ?? null;
  const removed = stat?.reduce((n, s) => n + s.removed, 0) ?? null;

  return (
    <article
      data-testid="tool-card"
      data-status={card.status}
      data-state={state}
      className="flex flex-col gap-2 rounded-lg"
    >
      <button
        type="button"
        onClick={() => {
          toggleOpen(key, !open);
          force((n) => n + 1);
        }}
        aria-expanded={open}
        className="group flex cursor-pointer items-center gap-2 self-start rounded-lg px-1 text-ui hover:bg-hover"
      >
        <Icon name={KIND_ICON[kind]} size={16} className="text-fg-subtle" />
        <span
          className={[
            "font-medium",
            state === "in_progress" ? "shimmer" : "text-fg-subtle",
            state === "failed" ? "text-danger" : "",
            state === "denied" ? "text-fg-subtle line-through" : "",
          ].join(" ")}
        >
          {label}
        </span>
        <span className="min-w-0 truncate text-fg-muted" title={toolTitle(card, cwd)}>
          {toolTitle(card, cwd)}
        </span>
        <DiffCount added={added} removed={removed} />
        <StateIcon state={state} />
        <span className="text-caption text-fg-subtle">{STATE_TEXT[state]}</span>
        <Icon
          name="chevron-right"
          size={16}
          className={`text-fg-subtle opacity-0 transition-[transform,opacity] duration-200 group-hover:opacity-100 ${
            open ? "rotate-90 opacity-100" : ""
          }`}
        />
      </button>

      {!card.sawFirstCard ? (
        <p className="px-1 text-caption text-warning">
          没收到这张卡的首帧，内容是从后续 update 拼出来的。
        </p>
      ) : null}

      {open ? (
        <div className="flex flex-col gap-2 pt-2">
          {diffs.map((d, i) => (
            <div key={i} className="overflow-hidden rounded-lg border border-border">
              {d.path ? (
                <div className="border-b border-border px-3 py-1 font-mono text-caption text-fg-muted">
                  {relativePath(d.path, cwd)}
                </div>
              ) : null}
              <DiffView oldText={d.oldText} newText={d.newText} />
            </div>
          ))}
          {text ? <Output text={text} /> : null}
          {/* 输出五态里的空 / 加载两态：不编内容，如实说现在有什么 */}
          {!hasBody ? (
            state === "in_progress" ? (
              <p className="flex items-center gap-2 px-1 text-caption text-fg-subtle">
                <Spinner size={12} /> 同步中
              </p>
            ) : (
              <p className="px-1 text-caption text-fg-subtle">暂无输出</p>
            )
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
