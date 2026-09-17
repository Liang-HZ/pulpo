// 命令面板（⌘K）。只做"会话"这一段：
// 文件与命令两段需要 core 侧的检索能力（`read/search` 之类），PROTOCOL 里没有这个方法，
// 做成一个搜不出东西的空段比不做更糟。见 README 的"与主流桌面端的取舍"。
//
// 排序：未读的排前面（未读游标），其次按更新时间倒序。

import { useEffect, useMemo, useRef, useState } from "react";
import { basename, relativeTime } from "../lib/format";
import { isUnread } from "../lib/policy";
import type { AppState, DirectoryRow } from "../lib/store";
import { AppStore, dirKey } from "../lib/store";
import { Icon } from "./Icon";
import { StatusDot } from "./ui";

interface Entry extends DirectoryRow {
  ref: string | null;
  unread: boolean;
}

export function CommandPalette({
  store,
  state,
  onClose,
}: {
  store: AppStore;
  state: AppState;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const now = Date.now();

  useEffect(() => {
    input.current?.focus();
  }, []);

  const entries = useMemo<Entry[]>(() => {
    const rows: Entry[] = [];
    for (const cwd of state.cwds) {
      for (const agent of state.agents) {
        for (const row of state.directories[dirKey(agent.agentId, cwd)] ?? []) {
          const ref = row.acpSessionId
            ? `${row.agentId}#${row.acpSessionId}`
            : row.nativeSessionId
              ? `${row.agentId}#${row.nativeSessionId}`
              : null;
          rows.push({ ...row, ref, unread: ref ? isUnread(row.updatedAt, state.seen[ref]) : false });
        }
      }
    }
    const q = query.trim().toLowerCase();
    return rows
      .filter((r) => !q || r.title.toLowerCase().includes(q) || r.cwd.toLowerCase().includes(q))
      .sort(
        (a, b) =>
          Number(b.unread) - Number(a.unread) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
      )
      .slice(0, 30);
  }, [state.cwds, state.agents, state.directories, state.seen, query]);

  const open = (entry: Entry): void => {
    void store.openSession(entry);
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="搜索会话"
      className="fixed inset-0 z-50 flex items-start justify-center bg-[rgb(0_0_0/0.3)] pt-12"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[60vh] w-[560px] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-dialog">
        <div className="flex h-12 items-center gap-2 border-b border-border px-3">
          <Icon name="search" size={16} className="text-fg-subtle" />
          <input
            ref={input}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Escape") onClose();
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setCursor((c) => Math.min(entries.length - 1, c + 1));
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setCursor((c) => Math.max(0, c - 1));
              }
              if (e.key === "Enter") {
                e.preventDefault();
                const entry = entries[cursor];
                if (entry) open(entry);
              }
            }}
            placeholder="搜索会话…"
            aria-label="搜索会话"
            className="h-6 flex-1 bg-transparent text-ui text-fg placeholder:text-fg-subtle focus:outline-none"
          />
          <span className="text-caption text-fg-subtle">Esc 关闭</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {entries.length === 0 ? (
            <p className="px-2 py-4 text-caption text-fg-muted">没有匹配的会话。</p>
          ) : (
            entries.map((entry, i) => (
              <button
                key={`${entry.agentId}:${entry.acpSessionId ?? entry.nativeSessionId}`}
                type="button"
                onMouseEnter={() => setCursor(i)}
                onClick={() => open(entry)}
                className={`flex h-6 w-full cursor-pointer items-center gap-2 rounded-lg px-2 text-left ${
                  i === cursor ? "bg-selected" : ""
                }`}
              >
                <StatusDot state={entry.unread ? "awaiting" : "idle"} />
                <span className="min-w-0 flex-1 truncate text-ui text-fg">{entry.title}</span>
                <span className="shrink-0 text-caption text-fg-subtle">{basename(entry.cwd)}</span>
                <span className="tabular shrink-0 text-caption text-fg-subtle">
                  {relativeTime(entry.updatedAt, now)}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
