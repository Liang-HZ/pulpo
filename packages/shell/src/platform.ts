// 能力探测只在这一处。前端其余代码不许出现 `window.__TAURI__`——
// 同一份代码后面要跑 Android，也要能在纯浏览器里被验收。

export type Host = "tauri" | "browser";

interface TauriInternals {
  __TAURI_INTERNALS__?: unknown;
  __TAURI__?: unknown;
}

export function host(): Host {
  const w = globalThis as unknown as TauriInternals;
  return w.__TAURI_INTERNALS__ || w.__TAURI__ ? "tauri" : "browser";
}

export const isTauri = (): boolean => host() === "tauri";

/**
 * 选一个工作目录。桌面端弹原生目录对话框；浏览器端没有这个能力，
 * 返回 null，由调用方退化成手填输入框（不是报错，也不是假装成功）。
 */
export async function pickDirectory(): Promise<string | null> {
  if (!isTauri()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, multiple: false, title: "选择工作目录" });
  return typeof picked === "string" ? picked : null;
}

/** 在系统文件管理器里打开一个目录。浏览器端无声不做（按钮本来就不显示）。 */
export async function revealPath(path: string): Promise<void> {
  if (!isTauri()) return;
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(path);
}

/**
 * core 的 WebSocket 地址。
 * - 桌面端：Rust 侧保证 daemon 起着，端口通过 `VITE_PULPO_WS` 或默认值给出；
 * - 浏览器端：同样直连 127.0.0.1，端口可用 `?ws=` 覆盖，方便 e2e 用临时端口。
 */
export function coreUrl(): string {
  const fromQuery =
    typeof location !== "undefined" ? new URLSearchParams(location.search).get("ws") : null;
  if (fromQuery) return fromQuery.includes("://") ? fromQuery : `ws://127.0.0.1:${fromQuery}`;
  const fromEnv = import.meta.env?.VITE_PULPO_WS as string | undefined;
  if (fromEnv) return fromEnv;
  return "ws://127.0.0.1:27183";
}

export interface CoreBoot {
  url: string;
  /** true = 这个 daemon 是壳刚拉起来的；false = 本来就有一个在跑（或浏览器端由用户自己起） */
  spawnedByShell: boolean;
  error: string | null;
}

/**
 * 连 core 之前的准备。
 * - 桌面端：让 Rust 侧保证本机有个能连的 daemon（连不上才拉，绝不杀用户自己起的那个）；
 * - 浏览器端：没有拉进程的能力，直接用地址；连不上由连接状态条如实显示。
 */
export async function ensureCore(): Promise<CoreBoot> {
  const fallback: CoreBoot = { url: coreUrl(), spawnedByShell: false, error: null };
  if (!isTauri()) return fallback;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const status = await invoke<{
      url: string;
      spawned_by_shell: boolean;
      error: string | null;
    }>("ensure_core");
    return { url: status.url, spawnedByShell: status.spawned_by_shell, error: status.error };
  } catch (err) {
    return { ...fallback, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 壳记住"你打开过哪些工作目录"。这是 UI 偏好，不是会话内容，掉了不影响事实源。 */
const CWD_KEY = "pulpo.cwds";

export function loadRememberedCwds(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(CWD_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function rememberCwd(cwd: string): void {
  try {
    const next = [cwd, ...loadRememberedCwds().filter((c) => c !== cwd)].slice(0, 20);
    globalThis.localStorage?.setItem(CWD_KEY, JSON.stringify(next));
  } catch {
    /* 隐私模式下 localStorage 会抛，记不住就算了，不影响功能 */
  }
}

/** 本机 git 状态（仓库行 / 底部状态条）。浏览器端没有这个能力，返回 null。 */
export interface GitStatus {
  branch: string | null;
  added: number;
  removed: number;
  dirty_files: number;
}

export async function gitStatus(cwd: string): Promise<GitStatus | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<GitStatus | null>("git_status", { cwd });
  } catch {
    // 不是 git 仓库、或本机没装 git。整行不渲染，不显示"无仓库"。
    return null;
  }
}
