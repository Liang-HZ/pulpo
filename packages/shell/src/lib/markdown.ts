// 极小的 markdown 解析（正文排版要的那几种块），纯函数、无依赖。
//
// 不引 markdown 库是有意的：我们只需要段落 / 标题 / 列表 / 代码块 / 表格 / 引用 /
// 分隔线 / 行内强调这八样，一个库进来就是几十 KB 加一套它自己的排版默认值，
// 而排版规则在这里已经写死了。流式过程中不高亮代码，
// 所以也不需要 shiki。

export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; text: string }
  | { type: "em"; text: string }
  | { type: "link"; text: string; href: string };

export type Node =
  | { type: "p"; inline: Inline[] }
  | { type: "heading"; level: number; inline: Inline[] }
  | { type: "code"; lang: string | null; text: string }
  | { type: "list"; ordered: boolean; items: Inline[][] }
  | { type: "quote"; inline: Inline[] }
  | { type: "hr" }
  | { type: "table"; head: Inline[][]; rows: Inline[][][] };

const INLINE_RE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\[[^\]]*\]\([^)\s]+\))/;

/** 行内：代码 > 粗 > 斜 > 链接。没匹配到的一律是纯文本，不做任何转义猜测。 */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let rest = src;
  while (rest.length > 0) {
    const match = INLINE_RE.exec(rest);
    if (!match || match.index === undefined) break;
    if (match.index > 0) out.push({ type: "text", text: rest.slice(0, match.index) });
    const token = match[0];
    if (token.startsWith("`")) out.push({ type: "code", text: token.slice(1, -1) });
    else if (token.startsWith("**")) out.push({ type: "strong", text: token.slice(2, -2) });
    else if (token.startsWith("*")) out.push({ type: "em", text: token.slice(1, -1) });
    else {
      const split = token.indexOf("](");
      out.push({
        type: "link",
        text: token.slice(1, split),
        href: token.slice(split + 2, -1),
      });
    }
    rest = rest.slice(match.index + token.length);
  }
  if (rest.length > 0) out.push({ type: "text", text: rest });
  return out;
}

function splitRow(line: string): string[] {
  return line
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

/** 块级。未闭合的代码围栏按"到文末为止"处理——流式过程中这是常态，不是错误。 */
export function parseMarkdown(src: string): Node[] {
  const lines = src.split("\n");
  const nodes: Node[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    const fence = /^```(\w*)\s*$/.exec(line.trim());
    if (fence) {
      const lang = fence[1] ? fence[1] : null;
      const body: string[] = [];
      i += 1;
      while (i < lines.length && lines[i]!.trim() !== "```") {
        body.push(lines[i]!);
        i += 1;
      }
      i += 1;
      nodes.push({ type: "code", lang, text: body.join("\n") });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      nodes.push({
        type: "heading",
        level: heading[1]!.length,
        inline: parseInline(heading[2]!),
      });
      i += 1;
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      nodes.push({ type: "hr" });
      i += 1;
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) {
      const head = splitRow(line).map(parseInline);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) {
        rows.push(splitRow(lines[i]!).map(parseInline));
        i += 1;
      }
      nodes.push({ type: "table", head, rows });
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) {
        body.push(lines[i]!.replace(/^\s*>\s?/, ""));
        i += 1;
      }
      nodes.push({ type: "quote", inline: parseInline(body.join(" ")) });
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      const items: Inline[][] = [];
      while (i < lines.length) {
        const current = lines[i]!;
        const m = ordered ? /^\s*\d+[.)]\s+(.*)$/.exec(current) : /^\s*[-*+]\s+(.*)$/.exec(current);
        if (!m) break;
        items.push(parseInline(m[1]!));
        i += 1;
      }
      nodes.push({ type: "list", ordered, items });
      continue;
    }

    const paragraph: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !/^```/.test(lines[i]!.trim()) &&
      !/^#{1,6}\s/.test(lines[i]!) &&
      !/^\s*[-*+]\s+/.test(lines[i]!) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]!) &&
      !/^\s*>\s?/.test(lines[i]!)
    ) {
      paragraph.push(lines[i]!);
      i += 1;
    }
    if (paragraph.length === 0) {
      paragraph.push(lines[i]!);
      i += 1;
    }
    nodes.push({ type: "p", inline: parseInline(paragraph.join("\n")) });
  }

  return nodes;
}
