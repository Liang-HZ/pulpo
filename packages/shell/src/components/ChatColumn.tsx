// 中栏会话流。
//
// 列宽 768 居中，左右内边距 16 → 正文行宽 736（14px 下约 66ch，已经落在 65ch 附近，
// 所以**不额外设 65ch**）。消息之间 32，同一条内多段 16。
// 新消息**不做进场动画**：流式内容自己在长，再加动画只会抖。

import { useEffect, useRef, useState } from "react";
import type { ChatItem, ChatState, ToolCard as ToolCardModel } from "../lib/chat";
import { splitBlocks } from "../lib/segments";
import { cardsByTurn } from "../lib/changes";
import { stopNotice } from "../lib/policy";
import { clockTime } from "../lib/format";
import type { AppState, Approval } from "../lib/store";
import { AppStore } from "../lib/store";
import { ApprovalRecord, ElicitationCard, PermissionCard } from "./ApprovalCard";
import { ChangeSummaryCard } from "./ChangeSummaryCard";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";
import { Receipt } from "./Receipt";
import { ToolCard } from "./ToolCard";
import { WorkSegment } from "./WorkSegment";
import { Button, Chip, Code, Disclosure, IconButton, Skeleton, StateBlock } from "./ui";

/** 距底 <48px 就算"跟着走" */
const FOLLOW_THRESHOLD = 48;

function MessageActions({
  text,
  align,
  at,
  onFork,
}: {
  text: string;
  align: "start" | "end";
  at: number;
  onFork?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    // 出现/隐藏纯用 CSS（index.css 的 [data-reveal] 规则），不进 React state
    <div
      data-reveal=""
      className={`flex items-center ${align === "end" ? "justify-end" : "justify-start"}`}
    >
      <IconButton
        icon={copied ? "check" : "copy"}
        label={copied ? "已复制" : "复制"}
        onClick={() => {
          void navigator.clipboard?.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      />
      {onFork ? <IconButton icon="fork" label="分叉" onClick={onFork} /> : null}
      <span className="tabular pl-6 text-caption text-fg-subtle">{clockTime(at)}</span>
    </div>
  );
}

function StopRow({ item, store, ref_ }: { item: Extract<ChatItem, { kind: "turn-end" }>; store: AppStore; ref_: string }) {
  const notice = stopNotice(item.stopReason);
  if (!notice || notice.tone === "silent") return null;
  const tone =
    notice.tone === "danger"
      ? "text-danger"
      : notice.tone === "warning"
        ? "text-warning"
        : "text-fg-muted";
  return (
    <div data-testid="stop-reason" data-reason={item.stopReason} className="flex items-center gap-2">
      <span className={`text-caption ${tone}`}>{notice.text}</span>
      {notice.action === "continue" ? (
        <Button size="sm" onClick={() => void store.send(ref_, "继续")}>
          继续
        </Button>
      ) : null}
    </div>
  );
}

function Row({
  item,
  store,
  state,
  sessionRef,
  cwd,
  turnCards,
  revertable,
}: {
  item: ChatItem;
  store: AppStore;
  state: AppState;
  sessionRef: string;
  cwd: string | null;
  turnCards: Record<string, ToolCardModel[]>;
  revertable: boolean;
}) {
  switch (item.kind) {
    case "user":
      return (
        <div className="group/message flex flex-col items-end gap-1">
          <div className="max-w-[85%] rounded-lg bg-bubble px-4 py-3 text-body break-words whitespace-pre-wrap text-bubble-fg">
            {item.text}
          </div>
          {item.receipt ? <Receipt receipt={item.receipt} align="end" /> : null}
          <MessageActions text={item.text} align="end" at={item.at} />
        </div>
      );
    case "assistant":
      return (
        <div className="group/message flex flex-col gap-2">
          <Markdown text={item.text} />
          <MessageActions
            text={item.text}
            align="start"
            at={item.at}
            onFork={() => void store.forkSession(sessionRef)}
          />
        </div>
      );
    case "tool":
      return <ToolCard card={item.card} cwd={cwd} />;
    case "turn-end":
      return (
        <div className="flex flex-col gap-4">
          <StopRow item={item} store={store} ref_={sessionRef} />
          <ChangeSummaryCard
            store={store}
            state={state}
            sessionRef={sessionRef}
            turnId={item.turnId}
            changes={item.changes}
            reverted={Boolean(item.reverted)}
            cwd={cwd}
            cards={turnCards[item.turnId] ?? []}
            revertable={revertable}
          />
        </div>
      );
    case "plan":
      // 计划在右栏有专门的分区，流里不重复渲染一份
      return null;
    case "notice":
      return (
        <p
          className={`text-caption ${
            item.tone === "bad" ? "text-danger" : item.tone === "warn" ? "text-warning" : "text-fg-muted"
          }`}
        >
          {item.text}
        </p>
      );
    case "thought":
      return <div className="text-body whitespace-pre-wrap text-fg-muted">{item.text}</div>;
    default:
      return (
        <Disclosure summary={`未识别的片段：${item.sessionUpdate}`}>
          <Code>{JSON.stringify(item.raw, null, 2)}</Code>
        </Disclosure>
      );
  }
}

export function ChatColumn({
  store,
  state,
  sessionRef,
  onPickAgent,
}: {
  store: AppStore;
  state: AppState;
  sessionRef: string | null;
  /** 空态里的渠道选择器：点一个渠道 → 左栏的新建表单带着它打开 */
  onPickAgent: (agentId: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [hasNew, setHasNew] = useState(false);

  const chat: ChatState | undefined = sessionRef ? state.chats[sessionRef] : undefined;
  const phase = sessionRef ? (state.transcriptPhase[sessionRef] ?? "idle") : "idle";
  const cwd = sessionRef
    ? (state.openSessions.find((s) => s.sessionRef === sessionRef)?.cwd ?? null)
    : null;
  const approvals: Approval[] = state.approvals.filter((a) => a.sessionRef === sessionRef);
  const records = state.approvalLog.filter((a) => a.sessionRef === sessionRef);
  const blocks = chat ? splitBlocks(chat.items) : [];
  const turnCards: Record<string, ToolCardModel[]> = chat ? cardsByTurn(chat.items) : {};
  // cwd 不在 git 仓库里时 core 如实标 unavailable，两个按钮就不该出现
  const revertable =
    (sessionRef ? state.descriptors[sessionRef]?.revert?.supported : undefined) !== "unavailable";
  // 分页游标：core 说还有更早的、并且给了游标才谈得上"加载更早消息"。
  // hasMore 但没有游标 = core 没给分页依据，这时**不去重复拉同一页**，如实说明。
  const cursor = sessionRef ? state.transcriptCursor[sessionRef] : undefined;

  // 切会话时 follow 重置为 true，且**第一帧直接跳到底，不做平滑动画**
  useEffect(() => {
    follow.current = true;
    setShowJump(false);
    setHasNew(false);
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [sessionRef]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (follow.current) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    // 用户往上翻了：新内容不进视口，只在「回到底部」按钮上挂一个 brand 小点
    setHasNew(true);
  }, [chat?.items, approvals.length]);

  const onScroll = (): void => {
    const el = scroller.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    follow.current = distance < FOLLOW_THRESHOLD;
    setShowJump(!follow.current);
    if (follow.current) setHasNew(false);
  };

  const jump = (): void => {
    const el = scroller.current;
    if (!el) return;
    follow.current = true;
    setShowJump(false);
    setHasNew(false);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  if (!sessionRef) {
    // 空态也住在**同一个 768 的会话列**里。
    // 五态里的空态：图标 + 引导文案 + 渠道选择器。
    return (
      <div className="relative flex min-h-0 flex-1 flex-col bg-canvas">
        <div data-testid="chat-scroll" className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-(--layout-column) flex-col gap-8 px-4 py-12">
            <div className="flex flex-col items-center gap-4 pt-24 text-center">
              <Icon name="folder" size={32} className="text-fg-subtle" />
              <p className="text-display font-bold text-fg">选个渠道开始</p>
              <p className="text-body text-fg-muted">
                左栏里点开一条已有会话，或者新建一条。会话内容一律读穿各渠道的原生存储，
                关掉 pulpo 也不会丢。
              </p>
              {state.agents.length ? (
                <div className="flex flex-wrap justify-center gap-2 pt-2">
                  {state.agents.map((agent) => (
                    <Chip
                      key={agent.agentId}
                      variant="outline"
                      icon="plus"
                      onClick={() => onPickAgent(agent.agentId)}
                    >
                      {agent.label}
                    </Chip>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-canvas">
      <div
        ref={scroller}
        onScroll={onScroll}
        onKeyDown={(e) => {
          if (e.key === "End") jump();
        }}
        tabIndex={-1}
        data-testid="chat-scroll"
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex w-full max-w-(--layout-column) flex-col gap-8 px-4 py-12">
          {typeof cursor === "string" ? (
            <Button
              size="lg"
              onClick={() =>
                cwd ? void store.loadTranscript(sessionRef, cwd, cursor) : undefined
              }
            >
              加载更早消息
            </Button>
          ) : cursor === null ? (
            <p className="text-caption text-fg-subtle">
              core 说这条会话还有更早的消息，但没给分页游标，这次读不到更早的了。
            </p>
          ) : null}

          {phase === "loading" && blocks.length === 0 ? (
            <div className="flex flex-col gap-4">
              <StateBlock
                phase="loading"
                title="正在读穿这条会话的全文…"
                hint="引擎的读取只对活动会话有效，core 会先把它激活再读、读完还原，所以要几秒。"
              />
              <Skeleton rows={3} height={23} />
            </div>
          ) : null}

          {phase === "error" ? (
            <StateBlock
              phase="error"
              title="读取转录失败"
              hint="下面仍然是这条会话的实时流。"
              action={
                cwd ? (
                  <Button size="md" onClick={() => void store.loadTranscript(sessionRef, cwd)}>
                    重试
                  </Button>
                ) : null
              }
            />
          ) : null}

          {blocks.length === 0 && phase !== "loading" ? (
            <StateBlock
              phase="empty"
              title="这条会话还没有内容"
              hint="在下面的输入框里说第一句话。"
            />
          ) : null}

          {blocks.map((block) =>
            block.kind === "segment" ? (
              <WorkSegment
                key={block.id}
                id={block.id}
                items={block.items}
                groups={block.groups}
                cwd={cwd}
              />
            ) : (
              <Row
                key={block.id}
                item={block.item}
                store={store}
                state={state}
                sessionRef={sessionRef}
                cwd={cwd}
                turnCards={turnCards}
                revertable={revertable}
              />
            ),
          )}

          {records.map((r) => (
            <ApprovalRecord key={r.key} decision={r.decision} title={r.title} at={r.at} />
          ))}

          {approvals.map((approval) =>
            approval.type === "permission" ? (
              <PermissionCard key={approval.key} approval={approval} store={store} cwd={cwd} />
            ) : (
              <ElicitationCard key={approval.key} approval={approval} store={store} />
            ),
          )}
        </div>
      </div>

      {showJump ? (
        <button
          type="button"
          onClick={jump}
          data-testid="jump-to-bottom"
          aria-label="滚动到底部"
          title="滚动到底部"
          style={{ width: 36, height: 36 }}
          className="absolute right-4 bottom-24 inline-flex cursor-pointer items-center justify-center rounded-full border border-border bg-surface text-fg-muted shadow-popover transition-[background-color] hover:bg-hover dark:shadow-none"
        >
          <Icon name="arrow-down" size={16} />
          {hasNew ? (
            <span
              aria-hidden
              className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-brand"
            />
          ) : null}
        </button>
      ) : null}
    </div>
  );
}
