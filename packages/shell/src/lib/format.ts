// 文案与数字的格式化。全部是纯函数，界面里不再各写一份。

/** 时长 → `1天2时` / `3分4秒` / `12秒`。单位取 ZCode 的 天/时/分/秒。 */
export function duration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d}天${h}时`;
  if (h > 0) return `${h}时${m}分`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}

/** 相对时间 → `刚刚` / `2分` / `1时` / `3天`。侧栏会话行右侧用。 */
export function relativeTime(at: number | null | undefined, now: number): string {
  if (!at) return "";
  const diff = Math.max(0, now - at);
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}时`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}天`;
  return new Date(at).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

/** 绝对时刻 `12:04`，审批结算记录与消息动作行用 */
export function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

/** token 数 → `12.4k`。没有数就返回 null，调用方按"不渲染该项"处理。 */
export function compactNumber(n: number | undefined | null): string | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** 工作区相对路径。取不到 cwd 就原样返回——不编一个更短的假路径。 */
export function relativePath(path: string, cwd?: string | null): string {
  const normalized = path.replace(/\\/g, "/");
  if (!cwd) return normalized;
  const base = cwd.replace(/\\/g, "/").replace(/\/$/, "");
  return normalized.startsWith(`${base}/`) ? normalized.slice(base.length + 1) : normalized;
}

/** `~/projects/pulpo`：状态条里的 cwd 显示 */
export function tildePath(path: string, home?: string | null): string {
  if (home && path.startsWith(home)) return `~${path.slice(home.length)}`;
  return path;
}

export function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").replace(/\/$/, "").split("/");
  return parts[parts.length - 1] || path;
}
