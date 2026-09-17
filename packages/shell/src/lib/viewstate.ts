// 视图状态：展开态、栏宽、未读游标、界面缩放。
//
// 折叠展开态是**模块级 Map**，不进 React state、不落盘、不进 URL：
// 它是视图状态，会话关掉就该没了；但切走再切回来要保持原样，所以也不能放进
// 会随重渲染重建的地方。

const openState = new Map<string, boolean>();
/** 用户亲手点过的段。自动规则只在状态跃迁那一刻写，之后用户的手动操作优先。 */
const touched = new Set<string>();

export function readOpen(key: string, fallback: boolean): boolean {
  const value = openState.get(key);
  return value === undefined ? fallback : value;
}

/** 用户点的。写进 Map 并钉住，以后自动规则不再覆盖它。 */
export function toggleOpen(key: string, value: boolean): void {
  openState.set(key, value);
  touched.add(key);
}

/** 自动规则（跑完自动收起）。用户碰过的段一律不动。 */
export function autoOpen(key: string, value: boolean): void {
  if (touched.has(key)) return;
  openState.set(key, value);
}

export function wasTouched(key: string): boolean {
  return touched.has(key);
}

/** 只给测试用：清掉模块级记忆 */
export function resetViewState(): void {
  openState.clear();
  touched.clear();
}

// ── 栏宽 ──────────────────────
export const LAYOUT_KEYS = {
  sidebar: "pulpo:layout:sidebar",
  inspector: "pulpo:layout:inspector",
  sidebarOpen: "pulpo:layout:sidebarOpen",
  inspectorOpen: "pulpo:layout:inspectorOpen",
  uiScale: "pulpo:layout:uiScale",
  theme: "pulpo:layout:theme",
} as const;

export function clampWidth(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function loadNumber(key: string, fallback: number): number {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    const value = raw === null || raw === undefined ? NaN : Number(raw);
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

export function saveNumber(key: string, value: number): void {
  try {
    globalThis.localStorage?.setItem(key, String(value));
  } catch {
    /* 隐私模式下会抛；记不住不影响功能 */
  }
}

export function loadFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (raw === "1") return true;
    if (raw === "0") return false;
    return fallback;
  } catch {
    return fallback;
  }
}

export function saveFlag(key: string, value: boolean): void {
  saveNumber(key, value ? 1 : 0);
}

/** 界面缩放档位：只有这四档，不会冒出 13px 这种值 */
export const UI_SCALES = [0.9, 1, 1.1, 1.25] as const;

export function nextScale(current: number, direction: 1 | -1 | 0): number {
  if (direction === 0) return 1;
  const index = UI_SCALES.indexOf(current as (typeof UI_SCALES)[number]);
  const base = index < 0 ? 1 : index;
  const next = Math.min(UI_SCALES.length - 1, Math.max(0, base + direction));
  return UI_SCALES[next]!;
}

// ── 未读游标 ────────────────────────────────────────────────────────────────
const SEEN_KEY = "pulpo:seen";

export function loadSeen(): Record<string, number> {
  try {
    const raw = globalThis.localStorage?.getItem(SEEN_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

export function markSeen(ref: string, at: number): Record<string, number> {
  const next = { ...loadSeen(), [ref]: at };
  try {
    globalThis.localStorage?.setItem(SEEN_KEY, JSON.stringify(next));
  } catch {
    /* 同上 */
  }
  return next;
}
