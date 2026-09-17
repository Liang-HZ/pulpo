// 零件层。不上组件库：弹层本可以引 Radix primitives，
// 这里**没有引 Radix**——壳只需要"点开一个小面板、点外面关掉、Esc 关掉"这一种弹层，
// 下面 60 行就做完了，为它加一个运行时依赖不划算。代价是没有 Radix 的碰撞检测与
// Portal 分层，所以弹层一律往下/往右开、并且只在标题栏与 composer 这两处用。
//
// 九态（default / hover / active / focus-visible / disabled / loading / selected /
// error / empty）在这里一次做齐，上层只挑变体。
// disabled 用 `text-fg-subtle` + `cursor-not-allowed`，**不降透明度**——
// 降透明度会把对比度打到 4.5 以下。

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { Icon, type IconName } from "./Icon";

export type ButtonTone = "primary" | "outline" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const TONE: Record<ButtonTone, string> = {
  primary: "bg-brand text-brand-fg border border-brand hover:brightness-110 active:brightness-95",
  outline: "bg-transparent text-fg border border-control hover:bg-hover active:bg-selected",
  ghost: "bg-transparent text-fg-muted border border-transparent hover:bg-hover hover:text-fg active:bg-selected",
  danger: "bg-transparent text-danger border border-transparent hover:bg-hover active:bg-selected",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "h-5 px-1 text-caption gap-1 rounded-md",
  md: "h-6 px-2 text-ui gap-1 rounded-md",
  lg: "h-8 px-3 text-ui gap-2 rounded-md",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: ButtonTone;
  size?: ButtonSize;
  loading?: boolean;
  selected?: boolean;
}

export function Button({
  tone = "outline",
  size = "md",
  loading = false,
  selected = false,
  disabled,
  children,
  className = "",
  ...rest
}: ButtonProps) {
  const isDisabled = disabled || loading;
  return (
    <button
      type="button"
      {...rest}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      aria-pressed={selected || undefined}
      className={[
        "inline-flex shrink-0 items-center justify-center font-medium select-none",
        "transition-[background-color,color,border-color,filter]",
        SIZE[size],
        TONE[tone],
        selected ? "bg-selected text-fg" : "",
        isDisabled ? "cursor-not-allowed text-fg-subtle hover:bg-transparent" : "cursor-pointer",
        className,
      ].join(" ")}
    >
      {loading ? <Spinner /> : null}
      {children}
    </button>
  );
}

/** 标题栏 / 动作行的方块图标按钮。默认 24，标题栏那一组是 26。 */
export function IconButton({
  icon,
  label,
  size = 24,
  iconSize = 14,
  tone = "ghost",
  selected = false,
  badge,
  className = "",
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  icon: IconName;
  label: string;
  size?: number;
  iconSize?: number;
  tone?: ButtonTone;
  selected?: boolean;
  badge?: number | null;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={selected || undefined}
      {...rest}
      style={{ width: size, height: size }}
      className={[
        "relative inline-flex shrink-0 cursor-pointer items-center justify-center rounded-md",
        "transition-[background-color,color]",
        TONE[tone],
        selected ? "bg-selected text-fg" : "",
        "disabled:cursor-not-allowed disabled:text-fg-subtle",
        className,
      ].join(" ")}
    >
      <Icon name={icon} size={iconSize} />
      {badge ? (
        <span className="tabular absolute -top-0.5 -right-0.5 min-w-3 rounded-full bg-brand px-0.5 text-center text-caption leading-none text-brand-fg">
          {badge}
        </span>
      ) : null}
    </button>
  );
}

export function Spinner({ size = 14, className = "" }: { size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className={`spin inline-block shrink-0 rounded-full border border-current border-t-transparent ${className}`}
    />
  );
}

export type ChipVariant = "neutral" | "outline" | "warn" | "brand" | "danger";

const CHIP: Record<ChipVariant, string> = {
  neutral: "text-fg-muted",
  outline: "text-fg border border-control",
  warn: "bg-warning-surface text-warning",
  brand: "bg-brand-surface text-brand",
  danger: "text-danger border border-danger",
};

/** 项目 / 分支 / 模型 / 访问模式共用一套。高 20，圆角 4。 */
export function Chip({
  variant = "neutral",
  icon,
  children,
  menu = false,
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ChipVariant;
  icon?: IconName;
  menu?: boolean;
}) {
  const interactive = Boolean(rest.onClick);
  return (
    <button
      type="button"
      disabled={!interactive || rest.disabled}
      {...rest}
      className={[
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-md px-1 text-caption",
        "transition-[background-color,color,border-color]",
        CHIP[variant],
        interactive ? "cursor-pointer hover:bg-hover" : "cursor-default",
        rest.disabled ? "cursor-not-allowed text-fg-subtle" : "",
        className,
      ].join(" ")}
    >
      {icon ? <Icon name={icon} size={12} /> : null}
      <span className="max-w-[180px] truncate">{children}</span>
      {menu ? <Icon name="chevron-down" size={12} /> : null}
    </button>
  );
}

export type DotState = "running" | "awaiting" | "failed" | "idle" | "done" | "queued";

const DOT_LABEL: Record<DotState, string> = {
  running: "运行中",
  awaiting: "等待确认",
  failed: "失败",
  idle: "空闲",
  done: "已完成",
  queued: "排队中",
};

/**
 * 状态点。状态不能只靠颜色：空心 / 实心的**形状差异**
 * 加 aria-label 是第二通道。
 */
export function StatusDot({ state, size = 14 }: { state: DotState; size?: number }) {
  const inner = Math.round(size * 0.57);
  const solid = state === "running" || state === "awaiting" || state === "failed" || state === "done";
  const color =
    state === "running"
      ? "bg-brand"
      : state === "awaiting"
        ? "bg-warning"
        : state === "failed"
          ? "bg-danger"
          : state === "done"
            ? "bg-success"
            : "";
  return (
    <span
      role="img"
      aria-label={DOT_LABEL[state]}
      title={DOT_LABEL[state]}
      style={{ width: size, height: size }}
      className="inline-flex shrink-0 items-center justify-center"
    >
      <span
        style={{ width: inner, height: inner }}
        className={[
          "block rounded-full",
          solid ? color : "border-[1.5px] border-control",
          state === "running" ? "breathe" : "",
        ].join(" ")}
      />
    </span>
  );
}

/** `+N −N`。两个数都是 0 时返回 null——不渲染，而不是显示 `+0 −0`。 */
export function DiffCount({
  added,
  removed,
  className = "",
}: {
  added: number | null | undefined;
  removed: number | null | undefined;
  className?: string;
}) {
  if (typeof added !== "number" || typeof removed !== "number") return null;
  if (added === 0 && removed === 0) return null;
  return (
    <span className={`tabular inline-flex shrink-0 items-center gap-1 text-caption ${className}`}>
      <span className="text-diff-add">+{added}</span>
      <span className="text-diff-remove">−{removed}</span>
    </span>
  );
}

interface FieldProps {
  label: string;
  help?: string;
  error?: string;
  required?: boolean;
  optional?: boolean;
  children: (props: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}

/** 表单字段四段齐全：标签 / 输入 / 帮助文字 / 错误。错误落在自己这个字段下面。 */
export function Field({ label, help, error, required, optional, children }: FieldProps) {
  const id = useId();
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const describedBy = [help ? helpId : null, error ? errorId : null].filter(Boolean).join(" ");
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-caption font-medium text-fg-muted">
        {label}
        {required ? <span className="text-danger"> 必填</span> : null}
        {optional ? <span className="text-fg-subtle"> 可选</span> : null}
      </label>
      {children({ id, describedBy: describedBy || undefined, invalid: Boolean(error) })}
      {help && !error ? (
        <p id={helpId} className="text-caption text-fg-muted">
          {help}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-caption text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export const inputClass = (invalid = false): string =>
  [
    "w-full rounded-md border bg-surface px-2 text-ui text-fg",
    "placeholder:text-fg-subtle transition-[border-color]",
    "disabled:cursor-not-allowed disabled:text-fg-subtle",
    invalid ? "border-danger" : "border-control hover:border-fg-muted focus:border-brand",
  ].join(" ");

/**
 * 数据区五态：空 / 加载 / 部分 / 错误 / 理想。
 * 空态必须有引导文案和一个主行动——`action` 是给这件事留的插槽。
 */
export function StateBlock({
  phase,
  title,
  hint,
  action,
  compact = false,
}: {
  phase: "empty" | "loading" | "error" | "partial";
  title: string;
  hint?: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      data-phase={phase}
      className={`flex flex-col items-start gap-2 ${compact ? "px-2 py-2" : "px-3 py-4"}`}
    >
      <p
        className={`flex items-center gap-2 text-caption font-medium ${
          phase === "error" ? "text-danger" : "text-fg-muted"
        }`}
      >
        {phase === "loading" ? <Spinner size={12} /> : null}
        {title}
      </p>
      {hint ? <p className="text-caption leading-relaxed text-fg-muted">{hint}</p> : null}
      {action}
    </div>
  );
}

/** 加载骨架：侧栏 6 条 26 高的灰条、会话流三条段落 */
export function Skeleton({ rows, height = 26 }: { rows: number; height?: number }) {
  return (
    <div aria-hidden className="flex flex-col gap-0.5 px-2">
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          style={{ height, width: `${92 - (i % 3) * 14}%` }}
          className="rounded-lg bg-hover"
        />
      ))}
    </div>
  );
}

/** 右栏分区头：24 高，可折叠，右侧留一个 badge 插槽 */
export function SectionHeader({
  title,
  open,
  onToggle,
  badge,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  badge?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="flex h-6 w-full cursor-pointer items-center gap-1 rounded-md px-1 text-caption font-medium text-fg-muted transition-[background-color] hover:bg-hover"
    >
      <Icon
        name="chevron-right"
        size={12}
        className={`transition-transform duration-200 ${open ? "rotate-90" : ""}`}
      />
      <span className="flex-1 text-left">{title}</span>
      {badge}
    </button>
  );
}

/**
 * 弹层。点外面关、Esc 关、打开时给触发器挂 `data-popup-open`
 * （消息动作行靠这个属性把自己钉住）。
 */
export function Popover({
  trigger,
  children,
  align = "start",
  side = "bottom",
  label,
}: {
  trigger: (props: { open: boolean; toggle: () => void; "data-popup-open"?: string }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "start" | "end";
  /** composer 贴在窗口底部，那一排 chip 的弹层必须往**上**开，否则会掉到窗口外 */
  side?: "bottom" | "top";
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent): void => {
      if (box.current && !box.current.contains(e.target as globalThis.Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={box} className="relative inline-flex">
      {trigger({
        open,
        toggle: () => setOpen((v) => !v),
        ...(open ? { "data-popup-open": "" } : {}),
      })}
      {open ? (
        <div
          role="dialog"
          aria-label={label}
          className={[
            "fade-in absolute z-50 max-h-[40vh] min-w-[180px] overflow-auto rounded-lg border border-border bg-surface p-1",
            "shadow-popover dark:shadow-none",
            side === "top" ? "bottom-full mb-1" : "top-full mt-1",
            align === "end" ? "right-0" : "left-0",
          ].join(" ")}
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

/** 弹层里的一行选项 */
export function MenuItem({
  children,
  selected = false,
  onClick,
  tone = "default",
}: {
  children: ReactNode;
  selected?: boolean;
  onClick: () => void;
  tone?: "default" | "danger";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={selected ? "true" : undefined}
      className={[
        "flex h-6 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-ui",
        "transition-[background-color] hover:bg-hover",
        tone === "danger" ? "text-danger" : "text-fg",
        selected ? "bg-selected" : "",
      ].join(" ")}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {selected ? <Icon name="check" size={12} /> : null}
    </button>
  );
}

/** 展开/收起。箭头 200ms 转 90°，内容不做高度动画（内容在流式中长，动画只会抖）。 */
export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  count,
}: {
  summary: string;
  children: ReactNode;
  defaultOpen?: boolean;
  count?: number;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex cursor-pointer items-center gap-1 self-start text-caption text-fg-subtle transition-[color] hover:text-fg"
      >
        <Icon
          name="chevron-right"
          size={12}
          className={`transition-transform duration-200 ${open ? "rotate-90" : ""}`}
        />
        {summary}
        {count !== undefined ? <span className="text-fg-subtle"> · {count}</span> : null}
      </button>
      {open ? <div className="pl-3">{children}</div> : null}
    </div>
  );
}

/** 等宽代码块，最大高度 320 内滚 */
export function Code({ children }: { children: ReactNode }) {
  return (
    <pre className="max-h-(--layout-output-max) overflow-auto rounded-lg bg-surface p-2 font-mono text-caption leading-normal break-words whitespace-pre-wrap text-fg">
      {children}
    </pre>
  );
}
