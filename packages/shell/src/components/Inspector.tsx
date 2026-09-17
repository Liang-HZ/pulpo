// 右栏 Inspector与任务 / 子代理条目。
//
// 两类子节点的规矩不同（PROTOCOL §4.7，UI 必须体现）：
//   · `delegation-child`（我们派出去的）→ 条目底部有「补充消息」入口；
//   · `native-subagent`（agent 自己的）→ **没有**这个入口，第二行末尾挂「只观测」标签。
//     不给它做一个禁用的输入框——那是在暗示以后会开，而这是设计。
//
// **分区为空时整个分区不渲染**，不要留一排"暂无"。

import { useEffect, useState } from "react";
import type { GraphTreeNode, TaskRecord, TaskStatus } from "../lib/protocol";
import type { PlanEntry } from "../lib/chat";
import { compactNumber, duration, relativePath } from "../lib/format";
import { isMemoryPath } from "../lib/policy";
import { toolPath, toolUrl } from "../lib/tools";
import type { AppState } from "../lib/store";
import { AppStore } from "../lib/store";
import { revealPath } from "../platform";
import { ElicitationCard, PermissionCard } from "./ApprovalCard";
import { Icon } from "./Icon";
import { Receipt } from "./Receipt";
import {
  Button,
  Chip,
  DiffCount,
  Disclosure,
  inputClass,
  SectionHeader,
  Spinner,
  StatusDot,
  type DotState,
} from "./ui";
import { useGit } from "./Chrome";

const TASK_TEXT: Record<TaskStatus, string> = {
  queued: "排队中",
  running: "运行中",
  awaiting_approval: "等待确认",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const TASK_DOT: Record<TaskStatus, DotState> = {
  queued: "queued",
  running: "running",
  awaiting_approval: "awaiting",
  done: "done",
  failed: "failed",
  cancelled: "idle",
};

function Section({
  title,
  badge,
  children,
}: {
  title: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section className="flex flex-col gap-2">
      <SectionHeader title={title} open={open} onToggle={() => setOpen((v) => !v)} badge={badge} />
      {open ? children : null}
    </section>
  );
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** 任务 / 子代理条目。整行的明暗才是主要信号：running 亮，其余暗；状态词只在 failed 时变红。 */
function TaskEntry({
  store,
  state,
  task,
}: {
  store: AppStore;
  state: AppState;
  task: TaskRecord;
}) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const receipt = state.taskReceipts[task.taskId] ?? null;
  const running = task.status === "running";
  const now = useNow(running);
  const finished = task.status === "done" || task.status === "failed" || task.status === "cancelled";
  const usage = task.usage;
  const tok = compactNumber((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0));
  const meta = [
    task.modelId,
    // 字段缺失时"不渲染该项"——不显示 0 tok
    usage && tok && tok !== "0" ? `${tok} tok` : null,
    usage?.toolCalls ? `${usage.toolCalls} 次工具调用` : null,
  ].filter(Boolean);

  const send = async (): Promise<void> => {
    if (!message.trim()) return;
    setSending(true);
    const res = await store.sendTaskInput(task.taskId, message.trim());
    setSending(false);
    if (res) setMessage("");
  };

  return (
    <li
      data-testid="task-node"
      data-status={task.status}
      className={[
        "group/task flex flex-col gap-1 rounded-lg p-2 transition-[background-color] hover:bg-hover",
        running ? "text-fg" : "text-fg-muted",
      ].join(" ")}
    >
      <div className="flex h-6 items-center gap-2">
        <StatusDot state={TASK_DOT[task.status]} />
        <span className="min-w-0 flex-1 truncate text-ui" title={task.task}>
          {task.task}
        </span>
        <Chip variant="outline">{task.agentId}</Chip>
        {task.effort ? <Chip variant="outline">{task.effort}</Chip> : null}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label="展开任务详情"
          className="cursor-pointer opacity-0 transition-opacity group-hover/task:opacity-100 group-focus-within/task:opacity-100"
        >
          <Icon
            name="chevron-right"
            size={12}
            className={`transition-transform duration-200 ${open ? "rotate-90" : ""}`}
          />
        </button>
      </div>

      <p className="flex h-[18px] items-center gap-1 text-caption text-fg-subtle">
        {/* 运行中不显示"运行中"——亮度与动效已经说了；改显示实时时长 */}
        {running ? (
          <span className="tabular">{duration(now - task.createdAt)}</span>
        ) : (
          <span className={task.status === "failed" ? "text-danger" : ""}>
            {TASK_TEXT[task.status]}
          </span>
        )}
        {meta.map((m) => (
          <span key={m as string}>· {m}</span>
        ))}
      </p>

      <div className="flex h-6 items-center gap-2 opacity-0 transition-opacity group-hover/task:opacity-100 group-focus-within/task:opacity-100">
        <button
          type="button"
          onClick={() => store.selectSession(task.sessionRef)}
          className="cursor-pointer text-caption text-brand underline decoration-1 underline-offset-2"
        >
          查看轨迹
        </button>
        {!finished ? (
          <button
            type="button"
            onClick={() => void store.cancelTask(task.taskId)}
            className="cursor-pointer text-caption text-danger"
          >
            取消
          </button>
        ) : null}
      </div>

      {open ? (
        <div className="flex flex-col gap-2">
          {task.summary ? (
            <p className="max-h-(--layout-taskout-max) overflow-auto text-caption leading-relaxed break-all whitespace-pre-wrap text-fg-muted">
              {task.summary}
            </p>
          ) : (
            <p className="text-caption text-fg-subtle">暂无输出</p>
          )}
          {task.error ? <p className="text-caption text-danger">{task.error}</p> : null}
          {state.trees[task.sessionRef]?.children?.length ? (
            <ul className="flex flex-col gap-1">
              {state.trees[task.sessionRef]!.children.map((child) => (
                <NativeNode key={child.id} node={child} />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* 派活子会话才有这个入口。原生 subagent 没有，并且不给禁用输入框。 */}
      {!finished ? (
        <div className="flex gap-2">
          <input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter") {
                e.preventDefault();
                void send();
              }
            }}
            aria-label={`给任务「${task.task.slice(0, 20)}」补充一句`}
            placeholder="补充一句…"
            className={`${inputClass()} h-5 text-caption`}
          />
          <Button size="sm" loading={sending} disabled={!message.trim()} onClick={() => void send()}>
            投递
          </Button>
        </div>
      ) : null}
      {receipt ? <Receipt receipt={receipt} /> : null}
    </li>
  );
}

function NativeNode({ node }: { node: GraphTreeNode }) {
  return (
    <li className="flex flex-col gap-1">
      <div className="flex h-6 items-center gap-2 text-fg-muted">
        <StatusDot state="idle" />
        <span className="min-w-0 flex-1 truncate text-ui" title={node.id}>
          {node.title ?? node.sessionId}
        </span>
      </div>
      <p className="text-caption text-fg-subtle">
        {node.agentId} · <span className="text-fg-subtle">只观测</span>
      </p>
      {node.children?.length ? (
        <ul className="border-l border-border pl-3">
          {node.children.map((child) => (
            <NativeNode key={child.id} node={child} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

const PLAN_ICON = {
  completed: "check-circle",
  in_progress: "circle-dot",
} as const;

function PlanSection({ entries }: { entries: PlanEntry[] }) {
  const done = entries.filter((e) => e.status === "completed").length;
  return (
    <Section
      title="计划"
      badge={
        <span className="tabular text-caption text-fg-subtle">
          {done}/{entries.length}
        </span>
      }
    >
      <ul className="flex max-h-(--layout-plan-max) flex-col gap-1 overflow-auto">
        {entries.map((entry, i) => {
          const priority = (entry.priority ?? "").toLowerCase();
          return (
            <li key={i} className="flex items-start gap-2 py-1 text-ui">
              <Icon
                name={PLAN_ICON[entry.status as keyof typeof PLAN_ICON] ?? "circle-dashed"}
                size={14}
                className={
                  entry.status === "completed"
                    ? "mt-0.5 text-success"
                    : entry.status === "in_progress"
                      ? "mt-0.5 text-brand"
                      : "mt-0.5 text-fg-subtle"
                }
              />
              <span
                className={`min-w-0 flex-1 leading-normal ${
                  entry.status === "completed" ? "text-fg-muted line-through" : "text-fg"
                }`}
              >
                {entry.content}
              </span>
              {priority ? (
                <Chip
                  variant={
                    priority === "high" ? "danger" : priority === "medium" ? "warn" : "outline"
                  }
                >
                  {priority === "medium" ? "MED" : priority.toUpperCase()}
                </Chip>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

export function Inspector({
  store,
  state,
  sessionRef,
  onDelegate,
}: {
  store: AppStore;
  state: AppState;
  sessionRef: string | null;
  onDelegate: () => void;
}) {
  const session = state.openSessions.find((s) => s.sessionRef === sessionRef);
  const cwd = session?.cwd ?? null;
  const git = useGit(cwd);
  const chat = sessionRef ? state.chats[sessionRef] : undefined;
  const tree = sessionRef ? state.trees[sessionRef] : undefined;
  const descriptor = sessionRef ? state.descriptors[sessionRef] : undefined;

  const tasks = [...state.tasks].sort((a, b) => b.createdAt - a.createdAt);
  const running = tasks.filter((t) => t.status !== "done" && t.status !== "failed" && t.status !== "cancelled");
  const ended = tasks.filter((t) => t.status === "done" || t.status === "failed" || t.status === "cancelled");
  // 轨迹树里只有 `native-subagent` 走「只观测」那一套；`delegation-child` 由
  // task/list 管（它有状态、用量、补充消息入口），不在树里重复渲染一遍。
  const natives = (tree?.children ?? []).filter((node) => node.kind === "native-subagent");
  // 别的会话挂着的审批也在这里出现——派活子会话卡在审批上时，用户得有个地方能应答它，
  // 否则那条会话会一直挂到 core 的 5 分钟超时（右栏含审批卡片）。
  const otherApprovals = state.approvals.filter((a) => a.sessionRef !== sessionRef);

  const plan = chat?.items.findLast((i) => i.kind === "plan");
  const planEntries = plan && plan.kind === "plan" ? plan.entries : [];
  const treeError = sessionRef ? state.treeErrors[sessionRef] : undefined;

  // 来源：本轮引用到的文件与 URL，来自工具卡（locations / fetch 的入参），去重
  const sources = [
    ...new Set(
      (chat?.items ?? [])
        .filter((i): i is Extract<typeof i, { kind: "tool" }> => i.kind === "tool")
        .flatMap((i) => {
          const path = toolPath(i.card);
          const url = toolUrl(i.card);
          return [path, url];
        })
        .filter((p): p is string => Boolean(p)),
    ),
  ];
  const memory = sources.filter((p) => isMemoryPath(p));

  return (
    <aside
      aria-label="轨迹树"
      className="flex h-full min-h-0 flex-col gap-6 overflow-y-auto bg-chrome p-2"
    >
      {cwd || git ? (
        <Section title="环境">
          <dl className="flex flex-col gap-1 px-1 text-caption">
            {session ? (
              <div className="flex gap-2">
                <dt className="text-fg-subtle">渠道</dt>
                <dd className="text-fg">{session.agentId}</dd>
              </div>
            ) : null}
            {cwd ? (
              <div className="flex min-w-0 gap-2">
                <dt className="shrink-0 text-fg-subtle">目录</dt>
                <dd className="min-w-0 break-all text-fg">
                  <button
                    type="button"
                    onClick={() => void revealPath(cwd)}
                    className="cursor-pointer text-left hover:text-brand"
                  >
                    {cwd}
                  </button>
                </dd>
              </div>
            ) : null}
            {git?.branch ? (
              <div className="flex gap-2">
                <dt className="text-fg-subtle">分支</dt>
                <dd className="text-fg">{git.branch}</dd>
              </div>
            ) : null}
            {git ? (
              <div className="flex gap-2">
                <dt className="text-fg-subtle">更改</dt>
                <dd>
                  {git.dirty_files === 0 ? (
                    <span className="text-success">干净</span>
                  ) : (
                    <DiffCount added={git.added} removed={git.removed} />
                  )}
                </dd>
              </div>
            ) : null}
            {descriptor ? (
              <div className="flex gap-2">
                <dt className="text-fg-subtle">补充消息</dt>
                <dd className="text-fg">{descriptor.delivery.steering.tier}</dd>
              </div>
            ) : null}
          </dl>
          {descriptor?.corrections?.length ? (
            <Disclosure summary="能力被壳收紧过" count={descriptor.corrections.length}>
              <div className="flex flex-col gap-2">
                {descriptor.corrections.map((c) => (
                  <div key={c.id} className="flex flex-col gap-1">
                    <p className="text-caption font-medium text-fg">
                      {c.path}：{c.from} → {c.to}
                    </p>
                    <p className="text-caption leading-relaxed text-fg-muted">{c.reason}</p>
                  </div>
                ))}
              </div>
            </Disclosure>
          ) : null}
        </Section>
      ) : null}

      {running.length || ended.length || natives.length ? (
        <Section
          title="子代理与任务"
          badge={
            running.length ? (
              <span className="tabular text-caption text-fg-subtle">{running.length} 运行</span>
            ) : null
          }
        >
          {treeError ? (
            <div className="flex items-center gap-2 px-1">
              <p className="min-w-0 flex-1 text-caption text-danger">读轨迹树失败：{treeError}</p>
              <Button
                size="sm"
                onClick={() => (sessionRef ? void store.refreshTree(sessionRef) : undefined)}
              >
                重试
              </Button>
            </div>
          ) : null}
          {running.length ? (
            <>
              <p className="px-1 text-caption text-fg-subtle">进行中</p>
              <ul className="flex flex-col gap-2">
                {running.map((task) => (
                  <TaskEntry key={task.taskId} store={store} state={state} task={task} />
                ))}
              </ul>
            </>
          ) : null}
          {natives.length ? (
            <ul className="flex flex-col gap-2 pt-6">
              {natives.map((node) => (
                <NativeNode key={node.id} node={node} />
              ))}
            </ul>
          ) : null}
          {ended.length ? (
            <div className="flex flex-col gap-2 pt-6">
              <p className="px-1 text-caption text-fg-subtle">已结束</p>
              <ul className="flex flex-col gap-2">
                {ended.map((task) => (
                  <TaskEntry key={task.taskId} store={store} state={state} task={task} />
                ))}
              </ul>
            </div>
          ) : null}
        </Section>
      ) : (
        <Section title="子代理与任务">
          <div className="flex flex-col items-start gap-2 px-1">
            <p className="text-caption leading-relaxed text-fg-muted">
              还没有派过活。把一件事交给某个渠道，带上模型 ID 与思考强度，这里会实时显示它的状态与结论。
            </p>
            <Button tone="primary" size="md" onClick={onDelegate}>
              派一件事
            </Button>
          </div>
        </Section>
      )}

      {planEntries.length ? <PlanSection entries={planEntries} /> : null}

      {otherApprovals.length ? (
        <Section
          title="待审批"
          badge={
            <span className="tabular text-caption text-warning">{otherApprovals.length}</span>
          }
        >
          <div className="flex flex-col gap-2">
            {otherApprovals.map((approval) =>
              approval.type === "permission" ? (
                <PermissionCard key={approval.key} approval={approval} store={store} cwd={cwd} />
              ) : (
                <ElicitationCard key={approval.key} approval={approval} store={store} />
              ),
            )}
          </div>
        </Section>
      ) : null}

      {sources.length ? (
        <Section title="来源">
          <div className="flex flex-wrap gap-1 px-1">
            {sources.slice(0, 24).map((path) => (
              <Chip key={path} variant="outline" title={path}>
                {relativePath(path, cwd)}
              </Chip>
            ))}
          </div>
        </Section>
      ) : null}

      {memory.length ? (
        <Section title="记忆已更新">
          <p className="px-1 text-caption leading-relaxed text-fg-muted">
            这一轮动过约定的规则文件：{memory.map((p) => relativePath(p, cwd)).join("、")}。
            （这是壳按文件名推断的，core 还没有 `memory_updated` 通知。）
          </p>
        </Section>
      ) : null}

      {state.busy.delegate ? (
        <p className="flex items-center gap-2 px-1 text-caption text-fg-muted">
          <Spinner size={12} /> 正在派活…
        </p>
      ) : null}
    </aside>
  );
}
