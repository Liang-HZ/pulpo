// 三栏骨架 + composer、快捷键、左右栏折叠与拖拽。
//
// 骨架用 flex + 显式像素宽（栏宽是用户拖出来的，不能交给 grid 的比例算）；
// 组件内部一律 flex/grid + gap，**子元素不写 margin**。

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ChatColumn } from "./components/ChatColumn";
import { Composer, ComposerPlaceholder } from "./components/Composer";
import { NoticeBar, RepoRow, StatusBar, TitleBar, useGit } from "./components/Chrome";
import { CommandPalette } from "./components/CommandPalette";
import { DelegateForm } from "./components/DelegateForm";
import { Inspector } from "./components/Inspector";
import { ReceiptBar } from "./components/Receipt";
import { Sidebar } from "./components/Sidebar";
import { StateBlock } from "./components/ui";
import { AppStore } from "./lib/store";
import {
  clampWidth,
  LAYOUT_KEYS,
  loadFlag,
  loadNumber,
  nextScale,
  saveFlag,
  saveNumber,
} from "./lib/viewstate";
import { ensureCore, type CoreBoot } from "./platform";

const SIDEBAR = { def: 288, min: 200, max: 420 };
const INSPECTOR = { def: 320, min: 240, max: 560 };
/** 窗口窄于这个宽度就自动折叠左右栏，且**不写回 localStorage**（临时态） */
const NARROW = 900;
/** 中栏可用区的下限。低于它就先挤左右两栏。 */
const COLUMN_MIN = 420;

/**
 * 启动闸门：先把 core 准备好（桌面端可能要拉一个 daemon），再建 store。
 * 这一步失败也照样进主界面——提醒条会如实说连不上，不是白屏。
 */
export function App() {
  const [boot, setBoot] = useState<CoreBoot | null>(null);
  useEffect(() => {
    void ensureCore().then(setBoot);
  }, []);

  if (!boot) {
    return (
      <div className="flex h-full items-center justify-center">
        <StateBlock phase="loading" title="正在准备本机 core…" />
      </div>
    );
  }
  return <Workspace boot={boot} />;
}

/**
 * 拖拽把手。命中区 12px、视觉上只有 1px 的 border；
 * **clamp 只在 commit 时做，拖的过程中不 clamp**——拖过头的手感是"推不动"而不是"跳回"。
 */
function Resizer({
  label,
  width,
  bounds,
  onChange,
  side,
}: {
  label: string;
  width: number;
  bounds: { def: number; min: number; max: number };
  onChange: (next: number) => void;
  side: "left" | "right";
}) {
  const dragging = useRef<{ startX: number; startW: number } | null>(null);

  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      const d = dragging.current;
      if (!d) return;
      const delta = side === "left" ? e.clientX - d.startX : d.startX - e.clientX;
      onChange(d.startW + delta);
    };
    const onUp = (): void => {
      if (!dragging.current) return;
      dragging.current = null;
      onChange(clampWidth(width, bounds.min, bounds.max));
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && dragging.current) {
        onChange(dragging.current.startW);
        dragging.current = null;
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("keydown", onKey);
    };
  }, [onChange, width, bounds, side]);

  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      tabIndex={0}
      onMouseDown={(e) => {
        dragging.current = { startX: e.clientX, startW: width };
      }}
      onDoubleClick={() => onChange(bounds.def)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 64 : 16;
        if (e.key === "ArrowLeft") onChange(clampWidth(width - step, bounds.min, bounds.max));
        if (e.key === "ArrowRight") onChange(clampWidth(width + step, bounds.min, bounds.max));
      }}
      className={[
        "group relative w-3 shrink-0 cursor-col-resize select-none",
        side === "left" ? "-ml-1.5" : "-mr-1.5",
      ].join(" ")}
      style={{ marginLeft: side === "left" ? -6 : 0, marginRight: side === "right" ? -6 : 0 }}
    >
      <span className="absolute inset-y-0 left-1.5 w-px bg-border transition-[background-color] group-hover:bg-control group-focus-visible:w-0.5 group-focus-visible:bg-brand" />
    </div>
  );
}

function Workspace({ boot }: { boot: CoreBoot }) {
  const store = useMemo(() => new AppStore(boot.url), [boot.url]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);

  const [sidebar, setSidebar] = useState(() =>
    clampWidth(loadNumber(LAYOUT_KEYS.sidebar, SIDEBAR.def), SIDEBAR.min, SIDEBAR.max),
  );
  const [inspector, setInspector] = useState(() =>
    clampWidth(loadNumber(LAYOUT_KEYS.inspector, INSPECTOR.def), INSPECTOR.min, INSPECTOR.max),
  );
  const [sidebarOpen, setSidebarOpen] = useState(() => loadFlag(LAYOUT_KEYS.sidebarOpen, true));
  const [inspectorOpen, setInspectorOpen] = useState(() =>
    loadFlag(LAYOUT_KEYS.inspectorOpen, true),
  );
  const [winWidth, setWinWidth] = useState(() =>
    typeof window === "undefined" ? 1280 : window.innerWidth,
  );
  const [delegating, setDelegating] = useState(false);
  const [palette, setPalette] = useState(false);
  const [scale, setScale] = useState(() => loadNumber(LAYOUT_KEYS.uiScale, 1));
  /** 左栏的「在此目录新建会话」表单；空态里的渠道选择器也往这里塞预选渠道 */
  const [creating, setCreating] = useState<{ cwd: string; agentId?: string } | null>(null);

  useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);

  useEffect(() => {
    document.documentElement.style.setProperty("--ui-scale", String(scale));
    saveNumber(LAYOUT_KEYS.uiScale, scale);
  }, [scale]);

  useEffect(() => {
    const onResize = (): void => setWinWidth(window.innerWidth);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((v) => {
      saveFlag(LAYOUT_KEYS.sidebarOpen, !v);
      return !v;
    });
  }, []);
  const toggleInspector = useCallback(() => {
    setInspectorOpen((v) => {
      saveFlag(LAYOUT_KEYS.inspectorOpen, !v);
      return !v;
    });
  }, []);

  const activeRef = state.activeRef;
  const session = state.openSessions.find((s) => s.sessionRef === activeRef);
  const cwd = session?.cwd ?? null;
  const git = useGit(cwd);
  const chat = activeRef ? state.chats[activeRef] : undefined;
  const descriptor = activeRef ? state.descriptors[activeRef] : undefined;
  const turnActive = activeRef ? Boolean(state.turnActive[activeRef]) : false;
  const lastReceipt = chat?.items.findLast((i) => i.kind === "user" && i.receipt);
  const runningAgents = state.tasks.filter((t) => t.status === "running").length;

  // 会话顺序（⌘⌥↑ / ⌘⌥↓ 用）
  const refs = state.openSessions.map((s) => s.sessionRef);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === "b") {
        e.preventDefault();
        toggleSidebar();
      } else if (e.key === "e") {
        e.preventDefault();
        toggleInspector();
      } else if (e.key === "k") {
        e.preventDefault();
        setPalette(true);
      } else if (e.key === "n") {
        e.preventDefault();
        setPalette(false);
        setDelegating(false);
        setCreating({ cwd: state.cwds[0] ?? "" });
      } else if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        setScale((s) => nextScale(s, 1));
      } else if (e.key === "-") {
        e.preventDefault();
        setScale((s) => nextScale(s, -1));
      } else if (e.key === "0") {
        e.preventDefault();
        setScale(1);
      } else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        const index = activeRef ? refs.indexOf(activeRef) : -1;
        const next = e.key === "ArrowUp" ? index - 1 : index + 1;
        const target = refs[(next + refs.length) % Math.max(1, refs.length)];
        if (target) store.selectSession(target);
      } else if (/^[1-9]$/.test(e.key)) {
        // 切换渠道：按 agent/list 的顺序，在当前目录下用第 N 个渠道新建一条会话
        const agent = state.agents[Number(e.key) - 1];
        if (agent && cwd) {
          e.preventDefault();
          void store.newSession(agent.agentId, cwd);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleSidebar, toggleInspector, activeRef, refs, state.agents, state.cwds, cwd, store]);

  // 中栏可用区不得小于 420：不够就**先挤左右两栏**，挤到各自最小值还不够才折叠。
  // 窄于 900 直接折叠，且不写回 localStorage（临时态）。
  const narrow = winWidth < NARROW;
  const squeeze = Math.max(0, sidebar + inspector + COLUMN_MIN - winWidth);
  const inspectorShrink = Math.min(squeeze, inspector - INSPECTOR.min);
  const sidebarShrink = Math.min(squeeze - inspectorShrink, sidebar - SIDEBAR.min);
  const sidebarWidth = sidebar - Math.max(0, sidebarShrink);
  const inspectorWidth = inspector - Math.max(0, inspectorShrink);
  const showSidebar = sidebarOpen && !narrow;
  const showInspector = inspectorOpen && !narrow;

  return (
    <div className="flex h-full min-h-0">
      {showSidebar ? (
        <>
          <div style={{ width: sidebarWidth }} className="min-w-0 shrink-0">
            <Sidebar
              store={store}
              state={state}
              creating={creating}
              onCreating={setCreating}
              onSearch={() => setPalette(true)}
              onDelegate={() => setDelegating(true)}
            />
          </div>
          <Resizer
            label="调整左栏宽度"
            width={sidebar}
            bounds={SIDEBAR}
            side="left"
            onChange={(next) => {
              setSidebar(next);
              saveNumber(LAYOUT_KEYS.sidebar, clampWidth(next, SIDEBAR.min, SIDEBAR.max));
            }}
          />
        </>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col border-x border-border">
        <TitleBar
          store={store}
          state={state}
          sessionRef={activeRef}
          git={git}
          sidebarOpen={showSidebar}
          inspectorOpen={showInspector}
          runningAgents={runningAgents}
          onToggleSidebar={toggleSidebar}
          onToggleInspector={toggleInspector}
        />

        <ChatColumn
          store={store}
          state={state}
          sessionRef={activeRef}
          onPickAgent={(agentId) =>
            setCreating({ cwd: state.cwds[0] ?? "", agentId })
          }
        />

        <NoticeBar
          connection={state.connection}
          banner={state.banner ?? (boot.error ? { text: boot.error, tone: "bad" as const } : null)}
          onDismiss={store.dismissBanner}
          onReconnect={() => store.start()}
        />

        <RepoRow cwd={cwd} git={git} />

        {activeRef ? (
          <Composer
            store={store}
            sessionRef={activeRef}
            turnActive={turnActive}
            descriptor={descriptor}
            configOptions={state.configOptions[activeRef] ?? []}
            usage={chat?.usage ?? null}
            queued={state.queued[activeRef] ?? []}
            isNew={!chat || chat.items.length === 0}
            receipt={
              lastReceipt && lastReceipt.kind === "user" && lastReceipt.receipt ? (
                <ReceiptBar receipt={lastReceipt.receipt} />
              ) : null
            }
          />
        ) : (
          <ComposerPlaceholder onNew={() => setCreating({ cwd: state.cwds[0] ?? "" })} />
        )}

        {delegating ? (
          <DelegateForm store={store} state={state} onClose={() => setDelegating(false)} />
        ) : null}

        <StatusBar cwd={cwd} git={git} usage={chat?.usage ?? null} url={boot.url} />
      </div>

      {showInspector ? (
        <>
          <Resizer
            label="调整右栏宽度"
            width={inspector}
            bounds={INSPECTOR}
            side="right"
            onChange={(next) => {
              setInspector(next);
              saveNumber(LAYOUT_KEYS.inspector, clampWidth(next, INSPECTOR.min, INSPECTOR.max));
            }}
          />
          <div style={{ width: inspectorWidth }} className="min-w-0 shrink-0">
            <Inspector
              store={store}
              state={state}
              sessionRef={activeRef}
              onDelegate={() => setDelegating(true)}
            />
          </div>
        </>
      ) : null}

      {palette ? (
        <CommandPalette store={store} state={state} onClose={() => setPalette(false)} />
      ) : null}
    </div>
  );
}
