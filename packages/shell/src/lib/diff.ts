// 从 `oldText` / `newText` 合成 unified diff 的行（工具卡的 diff 块）。
//
// 只做"掐掉公共前后缀"这一种对齐：块内的增删原样并排列出，**不做 LCS**。
// 对 agent 实际给的 diff 块（一次编辑一处）够用，而且不会在长文件上把 CPU 吃掉。
// 上下文行数与封顶：2 行上下文、封顶 1200 行。

export interface DiffLine {
  type: "context" | "add" | "remove";
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

const CONTEXT = 2;
const MAX_LINES = 1200;

export function unifiedDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.length ? oldText.replace(/\n$/, "").split("\n") : [];
  const b = newText.length ? newText.replace(/\n$/, "").split("\n") : [];

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }

  const lines: DiffLine[] = [];
  const preStart = Math.max(0, head - CONTEXT);
  for (let i = preStart; i < head; i += 1) {
    lines.push({ type: "context", oldNo: i + 1, newNo: i + 1, text: a[i]! });
  }
  for (let i = head; i < a.length - tail; i += 1) {
    lines.push({ type: "remove", oldNo: i + 1, newNo: null, text: a[i]! });
  }
  for (let i = head; i < b.length - tail; i += 1) {
    lines.push({ type: "add", oldNo: null, newNo: i + 1, text: b[i]! });
  }
  const postEnd = Math.min(a.length, a.length - tail + CONTEXT);
  for (let i = a.length - tail; i < postEnd; i += 1) {
    lines.push({
      type: "context",
      oldNo: i + 1,
      newNo: i - (a.length - b.length) + 1,
      text: a[i]!,
    });
  }
  return lines.slice(0, MAX_LINES);
}

/**
 * 长文本输出的折叠：超过 12 行只显示前 6 + 后 3，中间一行「展开 {n} 行」。
 * 返回 null 表示不需要折叠。
 */
export function foldText(
  text: string,
): { head: string[]; tail: string[]; hidden: number } | null {
  const lines = text.split("\n");
  if (lines.length <= 12) return null;
  return {
    head: lines.slice(0, 6),
    tail: lines.slice(-3),
    hidden: lines.length - 9,
  };
}
