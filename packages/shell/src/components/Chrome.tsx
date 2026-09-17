// 窗口框架：标题栏、仓库行、提醒条、底部状态条。

import { useEffect, useState } from "react";
import type { ConnectionState } from "../lib/rpc";
import type { Usage } from "../lib/chat";
import { basename, tildePath } from "../lib/format";
import { usageLevel } from "../lib/policy";
import type { AppState } from "../lib/store";
import { AppStore } from "../lib/store";
import { gitStatus, isTauri, revealPath, type GitStatus } from "../platform";
import { Icon } from "./Icon";
import { Button, Chip, DiffCount, IconButton, MenuItem, Popover, StatusDot } from "./ui";

/** 本机 git 状态。没有仓库、或在浏览器里跑，就一直是 null → 仓库行整行不渲染。 */
export function useGit(cwd: string | null): GitStatus | null {
  const [git, setGit] = useState<GitStatus | null>(null);
  useEffect(() => {
    if (!cwd) {
      setGit(null);
      return undefined;
    }
    let alive = true;
    const poll = (): void => {
      void gitStatus(cwd).then((g) => {
        if (alive) setGit(g);
      });
    };
    poll();
    const timer = setInterval(poll, 15_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [cwd]);
  return git;
}

export function TitleBar({
  store,
  state,
  sessionRef,
  git,
  sidebarOpen,
  inspectorOpen,
  runningAgents,
  onToggleSidebar,
  onToggleInspector,
}: {
  store: AppStore;
  state: AppState;
  sessionRef: string | null;
  git: GitStatus | null;
  sidebarOpen: boolean;
  inspectorOpen: boolean;
  runningAgents: number;
  onToggleSidebar: () => void;
  onToggleInspector: () => void;
}) {
  const session = state.openSessions.find((s) => s.sessionRef === sessionRef);
  const chat = sessionRef ? state.chats[sessionRef] : undefined;
  const row = state.cwds
    .flatMap((cwd) => state.agents.map((a) => state.directories[`${a.agentId}::${cwd}`] ?? []))
    .flat()
    .find((r) => r.acpSessionId && `${r.agentId}#${r.acpSessionId}` === sessionRef);
  // 标题优先级：agent 自己给的会话标题 > 对话的第一句（还没定名的会话，ZCode 就是这样）
  // > agent 的原生 session id。**不编标题**，拿不到就老实显示 id。
  const firstUser = chat?.items.find((i) => i.kind === "user");
  const title =
    (row?.title && row.title !== row.acpSessionId ? row.title : null) ??
    (firstUser?.kind === "user" && firstUser.text.trim() ? firstUser.text.trim().slice(0, 80) : null) ??
    (sessionRef ? (sessionRef.split("#")[1] ?? sessionRef) : "pulpo");

  const connected = state.connection.phase === "open";

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-chrome px-3">
      {!sidebarOpen ? (
        <IconButton icon="panel-left" label="展开左栏（⌘B）" onClick={onToggleSidebar} />
      ) : null}
      <span
        title={connected ? `已连上 core：${state.coreVersion ?? ""}` : "没连上 core"}
        data-testid="connection"
        data-phase={state.connection.phase}
        className="inline-flex size-6 items-center justify-center"
      >
        <StatusDot state={connected ? "done" : "failed"} />
      </span>
      <span className="min-w-0 truncate text-ui font-medium text-fg" title={title}>
        {title}
      </span>
      {session ? (
        <Chip icon="folder" onClick={() => void revealPath(session.cwd)}>
          {basename(session.cwd)}
        </Chip>
      ) : null}
      {git?.branch ? <Chip icon="branch">{git.branch}</Chip> : null}

      <span className="flex-1" />

      <div className="flex items-center gap-1">
        <IconButton
          icon="refresh"
          label="刷新"
          size={26}
          onClick={() => {
            void store.refreshOpen();
            void store.refreshTasks();
            if (sessionRef) void store.refreshTree(sessionRef);
          }}
        />
        <IconButton
          icon="panel-left"
          label="折叠 / 展开左栏（⌘B）"
          size={26}
          selected={sidebarOpen}
          onClick={onToggleSidebar}
        />
        <IconButton
          icon="panel-right"
          label="折叠 / 展开右栏（⌘E）"
          size={26}
          selected={inspectorOpen}
          badge={inspectorOpen ? null : runningAgents || null}
          onClick={onToggleInspector}
        />
        <Popover
          label="更多"
          align="end"
          trigger={({ toggle, ...rest }) => (
            <IconButton icon="settings" label="更多" size={26} onClick={toggle} {...rest} />
          )}
        >
          {(close) => (
            <>
              {sessionRef ? (
                <MenuItem
                  onClick={() => {
                    void store.forkSession(sessionRef);
                    close();
                  }}
                >
                  分叉这条会话
                </MenuItem>
              ) : null}
              {sessionRef ? (
                <MenuItem
                  tone="danger"
                  onClick={() => {
                    void store.closeSession(sessionRef);
                    close();
                  }}
                >
                  关闭会话
                </MenuItem>
              ) : null}
            </>
          )}
        </Popover>
      </div>
    </header>
  );
}

/** 仓库行。无 git 仓库时**整行不渲染**，不显示"无仓库"。 */
export function RepoRow({ cwd, git }: { cwd: string | null; git: GitStatus | null }) {
  if (!cwd || !git) return null;
  return (
    <div
      data-testid="repo-row"
      className="flex h-8 shrink-0 items-center gap-2 border-t border-border px-4"
    >
      <Chip icon="folder">{basename(cwd)}</Chip>
      {git.branch ? <Chip icon="branch">{git.branch}</Chip> : null}
      <DiffCount added={git.added} removed={git.removed} />
      <span className="flex-1" />
      {git.dirty_files > 0 ? (
        <span className="text-caption text-fg-muted">{git.dirty_files} 个文件未提交</span>
      ) : (
        <span className="text-caption text-success">干净</span>
      )}
    </div>
  );
}

/**
 * 提醒条。连接断开是 danger，其余是 warning。
 * 可 Dismiss——但连接断开这一条不给关，关掉它等于骗人。
 */
export function NoticeBar({
  connection,
  banner,
  onDismiss,
  onReconnect,
}: {
  connection: ConnectionState;
  banner: { text: string; tone: "warn" | "bad" } | null;
  onDismiss: () => void;
  onReconnect: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (connection.phase !== "reconnecting") return undefined;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [connection.phase]);

  const disconnected = connection.phase === "reconnecting" || connection.phase === "closed";
  if (!disconnected && !banner) return null;

  if (disconnected) {
    const left = connection.retryAt ? Math.max(0, Math.ceil((connection.retryAt - now) / 1000)) : 0;
    return (
      <div
        role="status"
        className="mx-4 mb-2 flex h-8 shrink-0 items-center gap-2 rounded-lg bg-warning-surface px-3 text-caption text-danger"
      >
        <Icon name="alert-triangle" size={14} />
        <span className="min-w-0 flex-1 truncate">
          与 core 的连接已断开
          {connection.phase === "reconnecting"
            ? ` · 重新连接中… 第 ${connection.attempt} 次${left ? `，${left} 秒后再试` : ""}`
            : ""}
          {connection.lastError ? ` · ${connection.lastError}` : ""}
        </span>
        <span data-testid="connection-reason" className="sr-only">
          {connection.lastError ?? "连接已断开"}
        </span>
        <Button size="sm" onClick={onReconnect}>
          重连
        </Button>
      </div>
    );
  }

  return (
    <div
      role="status"
      className={`mx-4 mb-2 flex min-h-8 shrink-0 items-center gap-2 rounded-lg px-3 text-caption ${
        banner!.tone === "bad" ? "bg-warning-surface text-danger" : "bg-warning-surface text-warning"
      }`}
    >
      <Icon name="alert-triangle" size={14} />
      <p className="min-w-0 flex-1 break-words">{banner!.text}</p>
      <IconButton icon="x" label="知道了" onClick={onDismiss} />
    </div>
  );
}

/** 底部状态条。高 28，元素间距 12，全部可点。 */
export function StatusBar({
  cwd,
  git,
  usage,
  url,
}: {
  cwd: string | null;
  git: GitStatus | null;
  usage: Usage | null;
  url: string;
}) {
  const level = usage?.size ? usageLevel(usage.used, usage.size) : "normal";
  const percent = usage?.size ? Math.round((usage.used / usage.size) * 100) : null;
  return (
    <footer className="flex h-7 shrink-0 items-center gap-3 border-t border-border bg-chrome px-3 text-caption text-fg-subtle">
      {cwd ? (
        <button
          type="button"
          onClick={() => void revealPath(cwd)}
          title={isTauri() ? "在访达中打开" : cwd}
          className="cursor-pointer truncate transition-[color] hover:text-fg"
        >
          {tildePath(cwd)}
        </button>
      ) : null}
      <span>·</span>
      <span title={url}>Local</span>
      {git?.branch ? (
        <>
          <span>·</span>
          <span>{git.branch}</span>
        </>
      ) : null}
      {percent !== null ? (
        <>
          <span>·</span>
          <span
            className={`tabular ${
              level === "danger" ? "text-danger" : level === "warning" ? "text-warning" : ""
            }`}
          >
            {level !== "normal" ? "⚠ " : ""}上下文 {percent}%
          </span>
        </>
      ) : null}
      <span className="flex-1" />
    </footer>
  );
}
