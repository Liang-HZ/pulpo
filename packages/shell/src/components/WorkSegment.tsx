// 工作段折叠——整个界面最关键的一个组件：把中间几十个工具调用收成一行。
//
// 触发行**只占内容宽度**（self-start），不是全宽条：全宽会让它看起来像分隔符。
// 展开记忆放模块级 Map，不进 React state、不落盘：切走再切回来保持原样，
// 但会话关掉就该没了。

import { useEffect, useRef, useState } from "react";
import type { ChatItem } from "../lib/chat";
import { duration } from "../lib/format";
import {
  segmentHasFailure,
  segmentLabel,
  segmentRunning,
  segmentSpan,
  type Group,
} from "../lib/segments";
import { autoOpen, readOpen, toggleOpen } from "../lib/viewstate";
import { Icon } from "./Icon";
import { ThoughtBody } from "./Markdown";
import { ToolCard } from "./ToolCard";
import { DiffCount } from "./ui";

/** 收起后内容延迟 300ms 卸载，让退场动画跑完（与 ZCode 同款） */
const UNMOUNT_DELAY = 300;
/** 思考段流完 1 秒后才自动收起——留一眼让人看见最后几行（Codeg 的做法） */
const THINK_DELAY = 1000;

function useTick(active: boolean): number {
  const [, force] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return 0;
}

export function WorkSegment({
  id,
  items,
  groups,
  cwd,
}: {
  id: string;
  items: ChatItem[];
  groups: Group[];
  cwd?: string | null;
}) {
  const running = segmentRunning(items);
  const failed = segmentHasFailure(items);
  const thinkOnly = groups.length === 1 && groups[0]!.bucket === "think";
  useTick(running);

  const [, force] = useState(0);
  const wasRunning = useRef(running);
  const [mounted, setMounted] = useState(() => readOpen(id, true));

  const span = segmentSpan(items);
  const endedAt = running ? Date.now() : span.endedAt;
  const label = segmentLabel(groups, {
    running,
    startedAt: span.startedAt,
    endedAt,
  });

  // 段在跑的时候默认展开；跑完的瞬间自动收起——但**有 failed 子项时不自动收起**，
  // 失败被自动藏起来是 bug，不是特性。用户手动碰过的段自动规则一律不动。
  useEffect(() => {
    if (wasRunning.current && !running) {
      wasRunning.current = false;
      if (!failed) {
        const delay = thinkOnly ? THINK_DELAY : 0;
        const timer = setTimeout(() => {
          autoOpen(id, false);
          force((n) => n + 1);
        }, delay);
        return () => clearTimeout(timer);
      }
    }
    if (running) wasRunning.current = true;
    return undefined;
  }, [running, failed, thinkOnly, id]);

  const open = readOpen(id, running || failed);

  useEffect(() => {
    if (open) {
      setMounted(true);
      return undefined;
    }
    const timer = setTimeout(() => setMounted(false), UNMOUNT_DELAY);
    return () => clearTimeout(timer);
  }, [open]);

  const thinkSpan = Math.max(0, span.endedAt - span.startedAt);
  const kindLabel = thinkOnly
    ? running
      ? "思考中…"
      : thinkSpan >= 1000
        ? `已思考 ${duration(thinkSpan)}`
        : null
    : label.kindLabel;

  return (
    <section data-testid="work-segment" data-open={open} data-running={running}>
      <button
        type="button"
        onClick={() => {
          toggleOpen(id, !open);
          force((n) => n + 1);
        }}
        aria-expanded={open}
        data-testid="segment-toggle"
        className="group inline-flex max-w-full cursor-pointer items-center gap-2 self-start rounded-lg px-1 text-ui transition-[background-color] hover:bg-hover"
      >
        {kindLabel ? (
          <span className={`font-medium ${running ? "shimmer" : "text-fg-subtle"}`}>
            {kindLabel}
          </span>
        ) : null}
        {label.parts.map((part, i) => (
          <span key={part} className="flex items-center gap-2 text-fg-muted">
            {kindLabel || i > 0 ? <span className="text-fg-subtle">·</span> : null}
            <span
              className={`truncate ${!kindLabel && i === 0 ? "font-medium text-fg-subtle" : ""}`}
            >
              {part}
            </span>
          </span>
        ))}
        {label.rest ? (
          <span className="flex items-center gap-2 text-fg-subtle">
            <span>·</span>
            <span className="truncate">{label.rest}</span>
          </span>
        ) : null}
        {/* 展开后隐藏统计（hideDiffCountWhenOpen） */}
        {open ? null : <DiffCount added={label.added} removed={label.removed} />}
        {label.failed > 0 ? (
          <span className="text-caption text-danger">失败 {label.failed}</span>
        ) : null}
        <Icon
          name="chevron-right"
          size={16}
          className={`text-fg-subtle opacity-0 transition-[transform,opacity] duration-200 group-hover:opacity-100 ${
            open ? "rotate-90 opacity-100" : ""
          }`}
        />
      </button>

      {mounted && open ? (
        <div className="mt-2 flex flex-col gap-2 border-l border-border pt-2 pl-3 ml-2">
          {items.map((item) =>
            item.kind === "tool" ? (
              <ToolCard key={item.id} card={item.card} cwd={cwd} />
            ) : item.kind === "thought" ? (
              <ThoughtBody key={item.id} text={item.text} />
            ) : null,
          )}
        </div>
      ) : null}
    </section>
  );
}
