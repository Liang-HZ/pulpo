// agent 正文的排版。
//
// 正文**不加气泡、不加背景**——正文就是页面本身，整屏唯一的焦点给它。
// 标题不靠放大字号：`#` 20 / `##` 16 / `###`–`######` 全部 14，差别靠字重 700 + 留白。
// 行内 code **不缩小字号**（实测 Claude 的行内 code 块高与正文行高同档）。

import { memo, useState } from "react";
import { parseMarkdown, type Inline, type Node } from "../lib/markdown";
import { Icon } from "./Icon";
import { IconButton } from "./ui";

function InlineRun({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((node, i) => {
        switch (node.type) {
          case "code":
            return (
              <code
                key={i}
                className="rounded-sm bg-hover px-1 py-0.5 font-mono text-[1em] break-words"
              >
                {node.text}
              </code>
            );
          case "strong":
            return (
              <strong key={i} className="font-bold">
                {node.text}
              </strong>
            );
          case "em":
            return (
              <em key={i} className="italic">
                {node.text}
              </em>
            );
          case "link":
            return (
              // 链接不能只靠颜色：下划线是第二通道
              <a
                key={i}
                href={node.href}
                target="_blank"
                rel="noreferrer noopener"
                className="text-brand underline decoration-1 underline-offset-2"
              >
                {node.text}
              </a>
            );
          default:
            return <span key={i}>{node.text}</span>;
        }
      })}
    </>
  );
}

function CodeBlock({ lang, text }: { lang: string | null; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex h-8 items-center justify-between gap-2 border-b border-border px-3">
        <span className="text-caption text-fg-subtle">{lang ?? "文本"}</span>
        <IconButton
          icon={copied ? "check" : "copy"}
          label={copied ? "已复制" : "复制代码"}
          size={24}
          onClick={() => {
            void navigator.clipboard?.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        />
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-ui leading-normal text-fg">
        <code>{text}</code>
      </pre>
    </div>
  );
}

function Block({ node }: { node: Node }) {
  switch (node.type) {
    case "heading": {
      // `#` 20 / `##` 16 / 其余 14；层级靠字重与留白，不靠继续放大
      const size =
        node.level === 1 ? "text-h1" : node.level === 2 ? "text-h2" : "text-ui";
      const space = node.level <= 2 ? "pt-6 pb-2" : "pt-4 pb-1";
      return (
        <div className={`${size} ${space} font-bold text-fg`}>
          <InlineRun nodes={node.inline} />
        </div>
      );
    }
    case "code":
      return <CodeBlock lang={node.lang} text={node.text} />;
    case "list":
      return node.ordered ? (
        <ol className="flex list-decimal flex-col gap-1 pl-6 marker:text-fg-subtle">
          {node.items.map((item, i) => (
            <li key={i}>
              <InlineRun nodes={item} />
            </li>
          ))}
        </ol>
      ) : (
        <ul className="flex list-disc flex-col gap-1 pl-4 marker:text-fg-subtle">
          {node.items.map((item, i) => (
            <li key={i}>
              <InlineRun nodes={item} />
            </li>
          ))}
        </ul>
      );
    case "quote":
      return (
        <blockquote className="border-l-2 border-control pl-3 text-fg-muted">
          <InlineRun nodes={node.inline} />
        </blockquote>
      );
    case "hr":
      return <hr className="my-6 border-0 border-t border-border" />;
    case "table":
      return (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-caption">
            <thead>
              <tr className="border-b border-border">
                {node.head.map((cell, i) => (
                  <th key={i} className="h-8 px-2 text-left font-medium text-fg">
                    <InlineRun nodes={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {node.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j} className="h-8 px-2 align-top text-fg-muted">
                      <InlineRun nodes={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    default:
      return (
        <p className="break-words whitespace-pre-wrap">
          <InlineRun nodes={node.inline} />
        </p>
      );
  }
}

/**
 * 已定稿的消息 memo 住，依赖只有文本本身——流式过程中只有最后一条在重解析。
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const nodes = parseMarkdown(text);
  return (
    <div className="flex flex-col gap-4 text-body text-fg">
      {nodes.map((node, i) => (
        <Block key={i} node={node} />
      ))}
    </div>
  );
});

/** 思考正文：同一套排版，颜色降一档 */
export function ThoughtBody({ text }: { text: string }) {
  return (
    <div className="text-body break-words whitespace-pre-wrap text-fg-muted">{text}</div>
  );
}

export function CopyButton({ text, label = "复制" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <IconButton
      icon={copied ? "check" : "copy"}
      label={copied ? "已复制" : label}
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    />
  );
}

export function InlineIcon({ name }: { name: Parameters<typeof Icon>[0]["name"] }) {
  return <Icon name={name} size={14} />;
}
