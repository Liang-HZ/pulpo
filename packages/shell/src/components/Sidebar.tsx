// 左栏。
//
// **分组键 = cwd**（项目目录），组名取 basename；取不到 cwd 的进「未归属」组，排在最后。
// 组内会话行间距 2、组之间 24——组间是组内的十几倍，分组关系一眼看得出来。
//
// 没有做「已置顶」组：置顶是会话的属性，core 的 `read/list` 里没有这个字段，
// 壳自己记一份就等于建了第二份会话状态。见 README 的"与主流桌面端的取舍"。

import { useMemo, useState } from "react";
import { basename, relativeTime } from "../lib/format";
import { isUnread } from "../lib/policy";
import type { AppState, DirectoryRow } from "../lib/store";
import { AppStore, dirKey } from "../lib/store";
import { isTauri, pickDirectory } from "../platform";
import { Icon } from "./Icon";
import {
  Button,
  Field,
  IconButton,
  inputClass,
  MenuItem,
  Popover,
  Skeleton,
  StateBlock,
  StatusDot,
  type DotState,
} from "./ui";

/** 一个组超过 20 条时只渲染前 20，末尾一行「显示更多 / 收起」 */
const GROUP_LIMIT = 20;

interface Row extends DirectoryRow {
  ref: string | null;
}

function rowsOf(state: AppState, cwd: string): Row[] {
  const out: Row[] = [];
  for (const agent of state.agents) {
    for (const row of state.directories[dirKey(agent.agentId, cwd)] ?? []) {
      out.push({
        ...row,
        ref: row.acpSessionId
          ? `${row.agentId}#${row.acpSessionId}`
          : row.nativeSessionId
            ? `${row.agentId}#${row.nativeSessionId}`
            : null,
      });
    }
  }
  return out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

function dotState(state: AppState, row: Row): DotState {
  if (!row.ref) return "idle";
  if (state.turnActive[row.ref]) return "running";
  if (state.approvals.some((a) => a.sessionRef === row.ref)) return "awaiting";
  const task = state.tasks.find((t) => t.sessionRef === row.ref);
  if (task?.status === "failed") return "failed";
  return "idle";
}

function SessionRow({
  store,
  state,
  row,
  now,
}: {
  store: AppStore;
  state: AppState;
  row: Row;
  now: number;
}) {
  const active = row.ref !== null && state.activeRef === row.ref;
  const dot = dotState(state, row);
  const unread = row.ref ? isUnread(row.updatedAt, state.seen[row.ref]) : false;

  return (
    <li className="group/row relative">
      <button
        type="button"
        data-testid="session-row"
        data-active={active}
        onClick={() => void store.openSession(row)}
        aria-current={active ? "true" : undefined}
        title={row.title}
        className={[
          "flex h-row w-full cursor-pointer items-center gap-2 rounded-lg pr-2 pl-[7px] text-left",
          "transition-[background-color] hover:bg-hover",
          active ? "bg-selected" : "",
        ].join(" ")}
      >
        <StatusDot state={dot} />
        <span className="min-w-0 flex-1 truncate text-ui text-fg">{row.title}</span>
        {unread || dot === "awaiting" ? (
          <span
            role="img"
            aria-label={dot === "awaiting" ? "等待确认" : "有未读更新"}
            title={dot === "awaiting" ? "等待确认" : "有未读更新"}
            className="size-1 shrink-0 rounded-full bg-warning"
          />
        ) : null}
        <span className="tabular shrink-0 text-caption text-fg-subtle">
          {relativeTime(row.updatedAt, now)}
        </span>
      </button>
      <span className="absolute top-0.5 right-0.5 opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100">
        <Popover
          label="会话操作"
          align="end"
          trigger={({ toggle, ...rest }) => (
            <IconButton icon="settings" label="更多" size={20} iconSize={12} onClick={toggle} {...rest} />
          )}
        >
          {(close) => (
            <>
              {row.ref && state.openSessions.some((s) => s.sessionRef === row.ref) ? (
                <MenuItem
                  onClick={() => {
                    void store.closeSession(row.ref!);
                    close();
                  }}
                >
                  关闭会话
                </MenuItem>
              ) : null}
              <MenuItem
                onClick={() => {
                  void store.refreshDirectory(row.agentId, row.cwd);
                  close();
                }}
              >
                刷新这个目录
              </MenuItem>
            </>
          )}
        </Popover>
      </span>
    </li>
  );
}

function Group({
  store,
  state,
  cwd,
  now,
  onNew,
}: {
  store: AppStore;
  state: AppState;
  cwd: string;
  now: number;
  onNew: (cwd: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const rows = rowsOf(state, cwd);
  const loading = state.agents.some(
    (a) => (state.directoryPhase[dirKey(a.agentId, cwd)] ?? "idle") === "loading",
  );
  const errored = state.agents
    .map((a) => state.directoryError[dirKey(a.agentId, cwd)])
    .filter((e): e is string => Boolean(e));
  const shown = expanded ? rows : rows.slice(0, GROUP_LIMIT);

  return (
    <section className="flex flex-col gap-0.5">
      <div className="group/head flex h-6 items-center gap-1 pr-1 pl-2">
        <h3 className="min-w-0 flex-1 truncate text-ui text-fg-muted" title={cwd}>
          {basename(cwd)}
        </h3>
        <span className="opacity-0 transition-opacity group-hover/head:opacity-100 group-focus-within/head:opacity-100">
          <IconButton
            icon="plus"
            label={`在 ${basename(cwd)} 下新建会话`}
            size={24}
            onClick={() => onNew(cwd)}
          />
        </span>
      </div>

      {loading && rows.length === 0 ? <Skeleton rows={6} /> : null}
      {errored.length > 0 && rows.length === 0 ? (
        <StateBlock
          phase="error"
          title="读取会话失败"
          hint={errored[0]}
          compact
          action={
            <Button
              size="sm"
              onClick={() => {
                for (const a of state.agents) void store.refreshDirectory(a.agentId, cwd);
              }}
            >
              重试
            </Button>
          }
        />
      ) : null}
      {!loading && rows.length === 0 && errored.length === 0 ? (
        <StateBlock
          phase="empty"
          title="这个目录下还没有会话"
          compact
          action={
            <Button size="sm" tone="primary" onClick={() => onNew(cwd)}>
              新建任务
            </Button>
          }
        />
      ) : null}

      <ul className="flex flex-col gap-0.5">
        {shown.map((row) => (
          <SessionRow
            key={`${row.agentId}:${row.acpSessionId ?? row.nativeSessionId}`}
            store={store}
            state={state}
            row={row}
            now={now}
          />
        ))}
      </ul>
      {rows.length > GROUP_LIMIT ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="h-6 cursor-pointer rounded-lg pl-2 text-left text-caption text-brand transition-[background-color] hover:bg-hover"
        >
          {expanded ? "收起" : `显示更多 ${rows.length - GROUP_LIMIT} 个`}
        </button>
      ) : null}
    </section>
  );
}

function NewSession({
  store,
  state,
  cwd,
  initialAgentId,
  onDone,
}: {
  store: AppStore;
  state: AppState;
  cwd: string;
  initialAgentId?: string;
  onDone: () => void;
}) {
  const [agentId, setAgentId] = useState(initialAgentId ?? state.agents[0]?.agentId ?? "");
  const [dir, setDir] = useState(cwd);
  const [error, setError] = useState<string | null>(null);
  const desktop = isTauri();

  const submit = async (): Promise<void> => {
    if (!agentId) {
      setError("先选一个渠道");
      return;
    }
    if (!dir.trim().startsWith("/")) {
      setError("工作目录要填绝对路径");
      return;
    }
    store.addCwd(dir.trim());
    const ref = await store.newSession(agentId, dir.trim());
    if (ref) onDone();
  };

  return (
    <div className="flex flex-col gap-3 border-b border-border px-2 py-3">
      <Field label="渠道">
        {({ id }) => (
          <select
            id={id}
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            className={`${inputClass()} h-6`}
          >
            {state.agents.map((a) => (
              <option key={a.agentId} value={a.agentId}>
                {a.label}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field
        label="工作目录"
        required
        {...(error ? { error } : {})}
        help={desktop ? "点右边的按钮弹系统目录对话框。" : "浏览器里没有目录对话框，直接填绝对路径。"}
      >
        {({ id, describedBy, invalid }) => (
          <div className="flex gap-2">
            <input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              aria-required="true"
              value={dir}
              onChange={(e) => {
                setDir(e.target.value);
                setError(null);
              }}
              placeholder="/绝对/路径"
              className={`${inputClass(invalid)} h-6 font-mono`}
            />
            {desktop ? (
              <Button
                size="md"
                onClick={() => {
                  void pickDirectory().then((p) => {
                    if (p) setDir(p);
                  });
                }}
              >
                选择
              </Button>
            ) : null}
          </div>
        )}
      </Field>
      <div className="flex gap-2">
        <Button
          tone="primary"
          size="lg"
          loading={Boolean(state.busy.newSession)}
          onClick={() => void submit()}
        >
          新建会话
        </Button>
        <Button tone="ghost" size="lg" onClick={onDone}>
          取消
        </Button>
      </div>
    </div>
  );
}

export function Sidebar({
  store,
  state,
  creating,
  onCreating,
  onSearch,
  onDelegate,
}: {
  store: AppStore;
  state: AppState;
  /** 正在"在此目录新建会话"的表单状态；由 App 持有，好让空态里的渠道选择器也能预选渠道 */
  creating: { cwd: string; agentId?: string } | null;
  onCreating: (next: { cwd: string; agentId?: string } | null) => void;
  onSearch: () => void;
  onDelegate: () => void;
}) {
  const now = useMemo(() => Date.now(), [state.openSessions, state.tasks]);

  return (
    <aside
      aria-label="会话列表"
      className="flex h-full min-h-0 flex-col bg-chrome"
    >
      <nav className="flex flex-col gap-0.5 p-2">
        <button
          type="button"
          data-new-task=""
          onClick={() => onCreating({ cwd: state.cwds[0] ?? "" })}
          className="flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 text-ui text-fg transition-[background-color] hover:bg-hover"
        >
          <Icon name="plus" size={16} className="text-fg-subtle" />
          <span className="flex-1 text-left">新建任务</span>
          <span className="text-caption text-fg-subtle">⌘N</span>
        </button>
        <button
          type="button"
          onClick={onSearch}
          className="flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 text-ui text-fg transition-[background-color] hover:bg-hover"
        >
          <Icon name="search" size={16} className="text-fg-subtle" />
          <span className="flex-1 text-left">搜索</span>
          <span className="text-caption text-fg-subtle">⌘K</span>
        </button>
        <button
          type="button"
          onClick={onDelegate}
          data-testid="toggle-delegate"
          className="flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 text-ui text-fg transition-[background-color] hover:bg-hover"
        >
          <Icon name="fork" size={16} className="text-fg-subtle" />
          <span className="flex-1 text-left">派活</span>
        </button>
      </nav>

      {creating !== null ? (
        <NewSession
          store={store}
          state={state}
          cwd={creating.cwd}
          {...(creating.agentId ? { initialAgentId: creating.agentId } : {})}
          onDone={() => onCreating(null)}
        />
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-2 pb-6">
        {state.cwds.length === 0 ? (
          <StateBlock
            phase="empty"
            title="还没有会话"
            hint="pulpo 不存会话，只读穿各渠道的原生存储。先指一个工作目录，它下面所有渠道的历史会话就会列出来。"
            action={
              <Button tone="primary" size="lg" onClick={() => onCreating({ cwd: "" })}>
                新建任务
              </Button>
            }
          />
        ) : (
          state.cwds.map((cwd) => (
            <Group
              key={cwd}
              store={store}
              state={state}
              cwd={cwd}
              now={now}
              onNew={(dir) => onCreating({ cwd: dir })}
            />
          ))
        )}
      </div>

      <footer className="flex h-11 shrink-0 items-center gap-2 border-t border-border px-2">
        <span className="min-w-0 flex-1 truncate text-caption text-fg-muted">
          {state.coreVersion ? `本机 core ${state.coreVersion}` : "core 未连上"}
        </span>
        <Popover
          label="设置"
          align="end"
          trigger={({ toggle, ...rest }) => (
            <IconButton icon="settings" label="设置" onClick={toggle} {...rest} />
          )}
        >
          {() => (
            <>
              <MenuItem onClick={() => void store.refreshOpen()}>刷新在册会话</MenuItem>
              <MenuItem onClick={() => void store.refreshTasks()}>刷新任务</MenuItem>
            </>
          )}
        </Popover>
      </footer>
    </aside>
  );
}
