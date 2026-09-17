// 三条纯策略：stopReason 白名单、未读判定、risk → chip 颜色。
// 外加工具认读与展开记忆。

import { beforeEach, describe, expect, it } from "vitest";
import type { ToolCard } from "../lib/chat";
import {
  isMemoryPath,
  isUnread,
  riskVariant,
  riskWarns,
  stopNotice,
  usageLevel,
} from "../lib/policy";
import {
  effectiveKind,
  metaToolName,
  sniffKind,
  toolPath,
  toolState,
  toolSubject,
  toolTitle,
} from "../lib/tools";
import { autoOpen, readOpen, resetViewState, toggleOpen, nextScale } from "../lib/viewstate";
import { foldText, unifiedDiff } from "../lib/diff";

let seq = 0;
function card(over: Partial<ToolCard> = {}): ToolCard {
  seq += 1;
  return {
    callId: `c${seq}`,
    title: "",
    toolName: null,
    kind: null,
    status: "completed",
    rawInput: null,
    rawOutput: null,
    content: [],
    locations: [],
    sawFirstCard: true,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  } as ToolCard;
}

describe("stopReason 白名单", () => {
  it("end_turn 静默", () => {
    expect(stopNotice("end_turn")).toEqual({ tone: "silent", text: "", action: null, known: true });
  });

  it("cancelled 一行「已停止」", () => {
    expect(stopNotice("cancelled")?.text).toBe("已停止");
    expect(stopNotice("cancelled")?.tone).toBe("muted");
  });

  it("max_tokens 是 warning 并带「继续」", () => {
    const n = stopNotice("max_tokens");
    expect(n?.tone).toBe("warning");
    expect(n?.action).toBe("continue");
  });

  it("refusal 是 danger", () => {
    expect(stopNotice("refusal")?.tone).toBe("danger");
  });

  it("表外取值一律**原样显示**，绝不 fallback 成「完成」", () => {
    const n = stopNotice("some_new_reason");
    expect(n?.known).toBe(false);
    expect(n?.text).toContain("some_new_reason");
    expect(n?.text).not.toContain("完成");
  });

  it("没有 stopReason 就没有这一行", () => {
    expect(stopNotice(undefined)).toBeNull();
    expect(stopNotice(null)).toBeNull();
    expect(stopNotice("")).toBeNull();
  });
});

describe("未读判定", () => {
  it("更新时间晚于游标就是未读", () => {
    expect(isUnread(200, 100)).toBe(true);
    expect(isUnread(100, 200)).toBe(false);
    expect(isUnread(100, 100)).toBe(false);
  });

  it("没有更新时间或没有游标时不判未读（不猜）", () => {
    expect(isUnread(undefined, 100)).toBe(false);
    expect(isUnread(200, undefined)).toBe(false);
  });
});

describe("risk → chip 变体", () => {
  it("full 才是橙——全屏唯一的橙色", () => {
    expect(riskVariant("full")).toBe("warn");
    expect(riskWarns("full")).toBe(true);
  });

  it("elevated 用描边，safe 用中性", () => {
    expect(riskVariant("elevated")).toBe("outline");
    expect(riskWarns("elevated")).toBe(false);
    expect(riskVariant("safe")).toBe("neutral");
  });

  it("字段缺失 = agent 没说，按中性渲染，不猜", () => {
    expect(riskVariant(undefined)).toBe("neutral");
    expect(riskVariant(null)).toBe("neutral");
    expect(riskWarns(undefined)).toBe(false);
  });
});

describe("上下文用量的三档", () => {
  it(">80% warning，>95% danger", () => {
    expect(usageLevel(10, 100)).toBe("normal");
    expect(usageLevel(81, 100)).toBe("warning");
    expect(usageLevel(96, 100)).toBe("danger");
  });

  it("没有总量时不着色", () => {
    expect(usageLevel(10, 0)).toBe("normal");
  });
});

describe("记忆文件的 UI 侧推断", () => {
  it("命中约定文件名", () => {
    expect(isMemoryPath("/w/CLAUDE.md")).toBe(true);
    expect(isMemoryPath("/w/sub/AGENTS.md")).toBe(true);
    expect(isMemoryPath("C:\\w\\.cursorrules")).toBe(true);
  });

  it("普通文件不命中", () => {
    expect(isMemoryPath("/w/README.md")).toBe(false);
    expect(isMemoryPath(null)).toBe(false);
  });
});

describe("工具认读", () => {
  it("agent 给的 kind 优先", () => {
    expect(effectiveKind(card({ kind: "execute", rawInput: { file_path: "/a" } }))).toBe("execute");
  });

  it("kind 缺失时按 rawInput 的形状嗅", () => {
    expect(sniffKind(card({ rawInput: { command: "ls" } }))).toBe("execute");
    expect(sniffKind(card({ rawInput: { old_string: "a", new_string: "b" } }))).toBe("edit");
    expect(sniffKind(card({ rawInput: { patch: "*** Begin Patch\n…" } }))).toBe("edit");
    expect(sniffKind(card({ rawInput: { url: "https://x.dev/a" } }))).toBe("fetch");
    expect(sniffKind(card({ rawInput: { pattern: "foo" } }))).toBe("search");
    expect(sniffKind(card({ rawInput: { file_path: "/a" } }))).toBe("read");
    expect(sniffKind(card({ rawInput: { nothing: 1 } }))).toBeNull();
  });

  it("表外的 kind 也走嗅形状，不硬认", () => {
    expect(effectiveKind(card({ kind: "weird_kind", rawInput: { command: "ls" } }))).toBe("execute");
    expect(effectiveKind(card({ kind: "weird_kind" }))).toBe("other");
  });

  it("_meta 里的工具名直接用", () => {
    expect(metaToolName(card({ meta: { claudeCode: { toolName: "Bash" } } }))).toBe("Bash");
    expect(metaToolName(card({ meta: { "x.ai/tool": { kind: "grep" } } }))).toBe("grep");
    expect(metaToolName(card())).toBeNull();
  });

  it("路径优先取 locations，其次 rawInput", () => {
    expect(toolPath(card({ locations: [{ path: "/w/a.ts" }] }))).toBe("/w/a.ts");
    expect(toolPath(card({ rawInput: { notebook_path: "/w/b.ipynb" } }))).toBe("/w/b.ipynb");
    expect(toolPath(card())).toBeNull();
  });

  it("终端取命令首行，抓取取域名", () => {
    expect(toolSubject(card({ kind: "execute", rawInput: { command: "ls -al\npwd" } }))).toBe(
      "ls -al",
    );
    expect(toolSubject(card({ kind: "fetch", rawInput: { url: "https://x.dev/a?b=1" } }))).toBe(
      "x.dev",
    );
  });

  it("六态：本地态盖过 ACP 的 status", () => {
    expect(toolState(card({ status: "in_progress" }))).toBe("in_progress");
    expect(toolState(card({ status: "in_progress", local: "stopped" }))).toBe("stopped");
    expect(toolState(card({ status: "pending", local: "denied" }))).toBe("denied");
  });

  it("标题随状态换时态；被拒的写「未执行」", () => {
    const base = { kind: "read", rawInput: { file_path: "/w/a.ts" } } as Partial<ToolCard>;
    expect(toolTitle(card({ ...base, status: "in_progress" }), "/w")).toBe("正在读取 a.ts");
    expect(toolTitle(card({ ...base, status: "completed" }), "/w")).toBe("已读取 a.ts");
    expect(toolTitle(card({ ...base, status: "failed" }), "/w")).toBe("读取 a.ts 失败");
    expect(toolTitle(card({ ...base, local: "denied" }), "/w")).toBe("未执行：a.ts");
    expect(toolTitle(card({ ...base, local: "stopped" }), "/w")).toBe("已停止读取 a.ts");
  });

  it("agent 给的标题原样用，但会补上它还没有的路径", () => {
    expect(toolTitle(card({ title: "Write a.txt", rawInput: { file_path: "/w/a.txt" } }), "/w")).toBe(
      "Write a.txt",
    );
    expect(toolTitle(card({ title: "Write", rawInput: { file_path: "/w/a.txt" } }), "/w")).toBe(
      "Write a.txt",
    );
  });

  it("什么都认不出来时说「使用了工具」，不编一个名字", () => {
    expect(toolTitle(card())).toBe("使用了工具");
  });
});

describe("展开记忆", () => {
  beforeEach(() => resetViewState());

  it("没记过就用调用方给的默认值", () => {
    expect(readOpen("seg-1", true)).toBe(true);
    expect(readOpen("seg-1", false)).toBe(false);
  });

  it("自动规则写得进去", () => {
    autoOpen("seg-1", false);
    expect(readOpen("seg-1", true)).toBe(false);
  });

  it("用户手动碰过之后，自动规则不再覆盖它", () => {
    toggleOpen("seg-1", true);
    autoOpen("seg-1", false);
    expect(readOpen("seg-1", false)).toBe(true);
  });

  it("界面缩放只走四个档位", () => {
    expect(nextScale(1, 1)).toBe(1.1);
    expect(nextScale(1.25, 1)).toBe(1.25);
    expect(nextScale(0.9, -1)).toBe(0.9);
    expect(nextScale(1.1, 0)).toBe(1);
  });
});

describe("diff 与输出折叠", () => {
  it("合成的 diff 带上下文行与行号", () => {
    const lines = unifiedDiff("a\nb\nc\nd\ne", "a\nb\nX\nd\ne");
    expect(lines.filter((l) => l.type === "remove").map((l) => l.text)).toEqual(["c"]);
    expect(lines.filter((l) => l.type === "add").map((l) => l.text)).toEqual(["X"]);
    expect(lines.some((l) => l.type === "context")).toBe(true);
  });

  it("超过 12 行的输出折成前 6 + 后 3", () => {
    const folded = foldText(Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n"));
    expect(folded?.head).toHaveLength(6);
    expect(folded?.tail).toHaveLength(3);
    expect(folded?.hidden).toBe(11);
  });

  it("12 行以内不折", () => {
    expect(foldText("a\nb\nc")).toBeNull();
  });
});
