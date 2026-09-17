// 图标。不引图标包：整个壳用到的只有下面这二十几个，每个就是一条 path，
// 加一个运行时依赖换二十几条 path 不划算。
// 形状按 lucide 的同名图标画（24 网格、stroke 2、round cap），默认渲染成 16px。
// **不用 emoji 当图标**。

export type IconName =
  | "file-text"
  | "pencil-line"
  | "trash"
  | "corner-down-right"
  | "search"
  | "terminal"
  | "brain"
  | "globe"
  | "shuffle"
  | "wrench"
  | "chevron-right"
  | "chevron-down"
  | "chevron-up"
  | "check"
  | "check-circle"
  | "circle"
  | "circle-dot"
  | "circle-dashed"
  | "circle-slash"
  | "square"
  | "x"
  | "alert-triangle"
  | "arrow-up"
  | "arrow-down"
  | "plus"
  | "mic"
  | "panel-left"
  | "panel-right"
  | "copy"
  | "fork"
  | "thumbs-up"
  | "thumbs-down"
  | "volume"
  | "settings"
  | "undo"
  | "eye"
  | "branch"
  | "folder"
  | "loader"
  | "refresh"
  | "list-todo"
  | "send";

const PATHS: Record<IconName, string> = {
  "file-text": "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Zm0 0v5h5M8 13h8M8 17h5",
  "pencil-line": "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z",
  trash: "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6",
  "corner-down-right": "M15 10l5 5-5 5M4 4v7a4 4 0 0 0 4 4h12",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.3-4.3",
  terminal: "M4 17l6-6-6-6M12 19h8",
  brain: "M12 5a3 3 0 1 0-5.9.8A3 3 0 0 0 4 9a3 3 0 0 0 2 2.8A3 3 0 0 0 7 18a3 3 0 0 0 5 1.2ZM12 5a3 3 0 1 1 5.9.8A3 3 0 0 1 20 9a3 3 0 0 1-2 2.8A3 3 0 0 1 17 18a3 3 0 0 1-5 1.2ZM12 5v14.2",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18Z",
  shuffle: "M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5",
  wrench: "M14.7 6.3a4 4 0 1 0 5 5L18 13l-7 7-4-4 7-7Z",
  "chevron-right": "M9 18l6-6-6-6",
  "chevron-down": "M6 9l6 6 6-6",
  "chevron-up": "M18 15l-6-6-6 6",
  check: "M20 6 9 17l-5-5",
  "check-circle": "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM8.5 12.5l2.5 2.5 4.5-5",
  circle: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z",
  "circle-dot": "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  "circle-dashed":
    "M10.1 3.2a9 9 0 0 0-3.5 1.5M4.7 6.6a9 9 0 0 0-1.5 3.5M3.2 13.9a9 9 0 0 0 1.5 3.5M6.6 19.3a9 9 0 0 0 3.5 1.5M13.9 20.8a9 9 0 0 0 3.5-1.5M19.3 17.4a9 9 0 0 0 1.5-3.5M20.8 10.1a9 9 0 0 0-1.5-3.5M17.4 4.7a9 9 0 0 0-3.5-1.5",
  "circle-slash": "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM8 16 16 8",
  square: "M6 6h12v12H6z",
  x: "M18 6 6 18M6 6l12 12",
  "alert-triangle": "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0ZM12 9v4M12 17h.01",
  "arrow-up": "M12 19V5M5 12l7-7 7 7",
  "arrow-down": "M12 5v14M19 12l-7 7-7-7",
  plus: "M12 5v14M5 12h14",
  mic: "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3ZM19 10v2a7 7 0 0 1-14 0v-2M12 19v3",
  "panel-left": "M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2ZM9 3v18",
  "panel-right": "M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2ZM15 3v18",
  copy: "M9 9a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2ZM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1",
  fork: "M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM18 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM12 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM6 9v3a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V9M12 15v-3",
  "thumbs-up": "M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1ZM7 10l4-8a3 3 0 0 1 3 3v3h5a2 2 0 0 1 2 2.4l-1.4 7A2 2 0 0 1 17.6 21H7",
  "thumbs-down": "M17 14V3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1ZM17 14l-4 8a3 3 0 0 1-3-3v-3H5a2 2 0 0 1-2-2.4l1.4-7A2 2 0 0 1 6.4 3H17",
  volume: "M11 5 6 9H2v6h4l5 4ZM16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.6 15H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 9 4.6V4a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z",
  undo: "M3 7v6h6M3.5 13a9 9 0 1 0 2.1-5.9L3 10",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  branch: "M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 9a9 9 0 0 1-9 9",
  folder: "M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2Z",
  loader: "M12 3v4M12 17v4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M3 12h4M17 12h4M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8",
  refresh: "M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6",
  "list-todo": "M3 5h2l1 1 2-2M3 12h2l1 1 2-2M3 19h2l1 1 2-2M13 6h8M13 13h8M13 20h8",
  send: "M22 2 11 13M22 2l-7 20-4-9-9-4Z",
};

export function Icon({
  name,
  size = 16,
  className = "",
  title,
}: {
  name: IconName;
  size?: number;
  className?: string;
  title?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      className={`shrink-0 ${className}`}
    >
      {title ? <title>{title}</title> : null}
      <path d={PATHS[name]} />
    </svg>
  );
}
