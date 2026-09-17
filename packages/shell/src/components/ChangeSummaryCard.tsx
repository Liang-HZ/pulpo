// 文件改动汇总卡。
//
// 数字来自 `turn_finished.changes`（摘要：文件数 / 加 / 减）；
// 「审查」调 `session/changes { includeDiff: true }` 拉逐文件明细与 unified diff；
// 「撤销」调 `session/revert`。**文件数按去重路径算**——七次 edit 落在三条路径上，
// 卡上写的是「3 个文件已更改」（去重在 core 侧已经做过一遍，壳不再叠加）。
//
// 五态：没有数字 → **整卡不渲染**（不显示「0 个文件」）；加载 → 明细区一行 spinner；
// 部分 → 已拿到的 + 「显示更多」；错误 → 一行 danger + 重试；理想 → 如设计图。
//
// 注意 `session/changes` 报的是**此刻**的差异（每次现拍一棵工作区的树再比），
// 回合结束后人又手改了也会如实出现——卡上照实写，不说成"本回合改了什么"。

import { useState } from "react";
import type { TurnChanges } from "../lib/protocol";
import { aggregateChanges } from "../lib/changes";
import type { ToolCard } from "../lib/chat";
import { relativePath } from "../lib/format";
import type { AppState } from "../lib/store";
import { AppStore } from "../lib/store";
import { Icon } from "./Icon";
import { Button, DiffCount, Spinner, StateBlock } from "./ui";

const VISIBLE = 5;

const STATUS_LABEL: Record<string, string> = {
  added: "新建",
  modified: "修改",
  deleted: "删除",
};

export function ChangeSummaryCard({
  store,
  state,
  sessionRef,
  turnId,
  changes,
  reverted,
  cwd,
  cards,
  revertable,
}: {
  store: AppStore;
  state: AppState;
  sessionRef: string;
  turnId: string;
  /** `turn_finished.changes`。缺失时退回本地按 agent 入参聚合（同一套行数公式）。 */
  changes: TurnChanges | undefined;
  reverted: boolean;
  cwd?: string | null;
  cards: ToolCard[];
  /** descriptor 说这条会话能不能撤销（cwd 不在 git 仓库里就不能） */
  revertable: boolean;
}) {
  const key = `${sessionRef}::${turnId}`;
  const fetched = state.changes[key];
  const phase = state.changesPhase[key] ?? "idle";
  const error = state.changesError[key];

  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const local = !changes;
  const fallback = local ? aggregateChanges(cards) : null;
  const total = changes ?? {
    files: fallback!.files.length,
    added: fallback!.added,
    removed: fallback!.removed,
  };
  // 没有数字 → 整卡不渲染。规则是：不是显示 0。
  if (total.files <= 0) return null;

  const detail = fetched?.files ?? fallback?.files ?? [];
  const files = showAll ? detail : detail.slice(0, VISIBLE);
  const hidden = detail.length - files.length;
  const canRevert = revertable && changes?.revert !== "unavailable";

  const expand = (): void => {
    const next = !open;
    setOpen(next);
    // 逐文件明细**展开时才拉**，不在流式过程中攒
    if (next && !fetched && phase !== "loading") void store.loadChanges(sessionRef, turnId);
  };

  return (
    <article
      data-testid="change-summary"
      data-files={total.files}
      data-added={total.added}
      data-removed={total.removed}
      data-source={local ? "shell" : "core"}
      className="overflow-hidden rounded-xl border border-border bg-surface"
    >
      <div className="flex h-10 items-center justify-between gap-3 px-2 transition-[background-color] hover:bg-hover">
        <button
          type="button"
          onClick={expand}
          aria-expanded={open}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-ui text-fg"
        >
          <Icon
            name="chevron-right"
            size={16}
            className={`text-fg-subtle transition-transform duration-200 ${open ? "rotate-90" : ""}`}
          />
          <span className="truncate font-medium">{total.files} 个文件已更改</span>
          <DiffCount added={total.added} removed={total.removed} />
          {reverted ? <span className="text-caption text-fg-subtle">已撤销</span> : null}
          {local ? (
            <span
              className="text-caption text-fg-subtle"
              title="core 没给这个回合的改动摘要，这里的数字是壳按 agent 的工具入参算的"
            >
              壳内估算
            </span>
          ) : null}
        </button>
        <div className="flex shrink-0 items-center gap-2">
          {canRevert && !reverted ? (
            <Button
              tone="danger"
              size="md"
              data-testid="changes-undo"
              loading={Boolean(state.busy.revert)}
              onClick={() => setConfirming(true)}
            >
              撤销
            </Button>
          ) : null}
          <Button
            tone="outline"
            size="md"
            data-testid="changes-review"
            onClick={() => {
              setOpen(true);
              setShowAll(true);
              setShowDiff(true);
              void store.loadChanges(sessionRef, turnId, true);
            }}
          >
            审查
          </Button>
        </div>
      </div>

      {!canRevert && changes?.reason ? (
        <p className="border-t border-border px-3 py-1 text-caption text-fg-subtle">
          这条会话不能撤销：{changes.reason}
        </p>
      ) : null}

      {confirming ? (
        <div className="flex flex-col gap-2 border-t border-border p-3">
          <p className="text-ui text-fg">要把这 {total.files} 个文件撤回到本回合之前吗？</p>
          <p className="text-caption leading-relaxed text-fg-muted">
            core 逐个文件比对：内容与本回合结束时不一致（被外部改过、被删过）、
            或本回合根本没碰过的路径一律跳过，不覆盖。跳过的文件与原因会原样列出来。
          </p>
          <div className="flex gap-2">
            <Button
              tone="primary"
              size="lg"
              data-testid="changes-undo-confirm"
              onClick={() => {
                setConfirming(false);
                void store.revertTurn(sessionRef, turnId);
              }}
            >
              撤销
            </Button>
            <Button tone="ghost" size="lg" onClick={() => setConfirming(false)}>
              不撤
            </Button>
          </div>
        </div>
      ) : null}

      {open ? (
        <div className="max-h-(--layout-card-max) overflow-auto border-t border-border">
          {phase === "loading" && detail.length === 0 ? (
            <StateBlock phase="loading" title="正在检查…" compact />
          ) : null}
          {phase === "error" ? (
            <div className="flex items-center gap-2 px-3 py-2">
              <p className="min-w-0 flex-1 text-caption text-danger">{error}</p>
              <Button size="sm" onClick={() => void store.loadChanges(sessionRef, turnId)}>
                重试
              </Button>
            </div>
          ) : null}
          {files.map((file, i) => (
            <div
              key={file.path ?? i}
              className="flex h-row items-center gap-2 px-3 transition-[background-color] hover:bg-hover"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-caption text-fg-muted">
                {relativePath(file.path ?? "（未解析出路径）", cwd)}
              </span>
              {"status" in file && typeof file.status === "string" ? (
                <span className="text-caption text-fg-subtle">
                  {STATUS_LABEL[file.status] ?? file.status}
                </span>
              ) : null}
              <DiffCount added={file.added} removed={file.removed} />
            </div>
          ))}
          {phase === "loading" && detail.length > 0 ? (
            <div className="flex items-center gap-2 px-3 py-1 text-caption text-fg-muted">
              <Spinner size={12} /> 正在检查…
            </div>
          ) : null}
          {hidden > 0 ? (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="h-6 w-full cursor-pointer px-3 text-left text-caption text-brand transition-[background-color] hover:bg-hover"
            >
              显示更多 {hidden} 个
            </button>
          ) : null}
          {showDiff && fetched?.diff ? (
            <pre
              data-testid="changes-diff"
              className="border-t border-border p-3 font-mono text-caption leading-normal break-all whitespace-pre-wrap"
            >
              {fetched.diff.split("\n").map((line, i) => (
                <div
                  key={i}
                  className={
                    line.startsWith("+") && !line.startsWith("+++")
                      ? "text-diff-add"
                      : line.startsWith("-") && !line.startsWith("---")
                        ? "text-diff-remove"
                        : "text-fg-muted"
                  }
                >
                  {line}
                </div>
              ))}
            </pre>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
