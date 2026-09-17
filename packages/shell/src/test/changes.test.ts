// changeStat 聚合与去重。
// 核心是三句话：**文件数按去重路径算**、**失败的编辑一行都不算**、**算不出来不补 0**。

import { describe, expect, it } from "vitest";
import type { ToolCard } from "../lib/chat";
import {
  aggregateChanges,
  cardStat,
  cardsByTurn,
  countsTowardChanges,
  hasChanges,
  lineCount,
  normalizePath,
  statFromDiff,
  statFromInput,
  summarizeStats,
} from "../lib/changes";

let seq = 0;
function card(over: Partial<ToolCard> = {}): ToolCard {
  seq += 1;
  return {
    callId: `c${seq}`,
    title: `t${seq}`,
    toolName: null,
    kind: "edit",
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

describe("行数", () => {
  it("空串是 0 行，末尾换行不额外算一行", () => {
    expect(lineCount("")).toBe(0);
    expect(lineCount("a")).toBe(1);
    expect(lineCount("a\n")).toBe(1);
    expect(lineCount("a\nb\n")).toBe(2);
    expect(lineCount(undefined)).toBe(0);
    expect(lineCount(123)).toBe(0);
  });
});

describe("按入参数行（第二条兜底，不需要 agent 配合）", () => {
  it("Write：added = 行数(content)，removed = 0", () => {
    expect(statFromInput({ file_path: "/a", content: "x\ny\nz" })).toEqual({
      added: 3,
      removed: 0,
    });
  });

  it("Edit：new_string / old_string 各数各的", () => {
    expect(statFromInput({ old_string: "a\nb", new_string: "a\nb\nc" })).toEqual({
      added: 3,
      removed: 2,
    });
  });

  it("MultiEdit：对 edits[] 累加", () => {
    expect(
      statFromInput({
        edits: [
          { old_string: "a", new_string: "a\nb" },
          { old_string: "c\nd", new_string: "c" },
        ],
      }),
    ).toEqual({ added: 3, removed: 3 });
  });

  it("NotebookEdit：new_source", () => {
    expect(statFromInput({ new_source: "a\nb" })).toEqual({ added: 2, removed: 0 });
  });

  it("认不出的形状返回 null，不是 0", () => {
    expect(statFromInput({ command: "ls" })).toBeNull();
    expect(statFromInput(null)).toBeNull();
    expect(statFromInput([])).toBeNull();
    expect(statFromInput({ edits: [{ foo: 1 }] })).toBeNull();
  });
});

describe("从 diff 数加减行——不是 newLines - oldLines", () => {
  it("掐掉公共前后缀后剩下的才是动过的行", () => {
    expect(statFromDiff("a\nb\nc", "a\nB\nc")).toEqual({ added: 1, removed: 1 });
  });

  it("纯新增", () => {
    expect(statFromDiff("", "x\ny\nz")).toEqual({ added: 3, removed: 0 });
  });

  it("纯删除", () => {
    expect(statFromDiff("x\ny\nz", "")).toEqual({ added: 0, removed: 3 });
  });

  it("净变化为 0 但确实改了两行时，加减都要如实算出来", () => {
    const stat = statFromDiff("a\nb\nc\nd", "a\nB\nC\nd");
    expect(stat).toEqual({ added: 2, removed: 2 });
    // 走 `newLines - oldLines` 的话这里会是 0，那是错的
    expect(stat.added - stat.removed).toBe(0);
  });
});

describe("单张卡的统计", () => {
  it("core 派生的 changeStat 优先", () => {
    expect(
      cardStat(card({ changeStat: [{ path: "/a", added: 9, removed: 1 }], rawInput: { content: "x" } })),
    ).toEqual([{ path: "/a", added: 9, removed: 1 }]);
  });

  it("其次是 diff 块", () => {
    expect(
      cardStat(
        card({ content: [{ type: "diff", path: "/a.ts", oldText: "a", newText: "a\nb" }] }),
      ),
    ).toEqual([{ path: "/a.ts", added: 1, removed: 0 }]);
  });

  it("最后才按入参；路径取 rawInput 的四个字段之一", () => {
    expect(cardStat(card({ rawInput: { file_path: "/w/a.ts", content: "x\ny" } }))).toEqual([
      { path: "/w/a.ts", added: 2, removed: 0 },
    ]);
  });

  it("三条都算不出来返回 null", () => {
    expect(cardStat(card({ rawInput: { command: "ls" } }))).toBeNull();
  });

  it("反斜杠路径归一成正斜杠——这是去重的唯一依据", () => {
    expect(normalizePath("C:\\ws\\a.ts")).toBe("C:/ws/a.ts");
  });
});

describe("哪些卡算进改动", () => {
  it("只算已结算的写入类", () => {
    expect(countsTowardChanges(card({ kind: "edit", status: "completed" }))).toBe(true);
    expect(countsTowardChanges(card({ kind: "delete", status: "completed" }))).toBe(true);
    expect(countsTowardChanges(card({ kind: "move", status: "completed" }))).toBe(true);
    expect(countsTowardChanges(card({ kind: "read", status: "completed" }))).toBe(false);
    expect(countsTowardChanges(card({ kind: "execute", status: "completed" }))).toBe(false);
  });

  it("失败 / 被拒 / 被停的编辑一行都不算", () => {
    expect(countsTowardChanges(card({ status: "failed" }))).toBe(false);
    expect(countsTowardChanges(card({ status: "in_progress" }))).toBe(false);
    expect(countsTowardChanges(card({ status: "completed", local: "denied" }))).toBe(false);
    expect(countsTowardChanges(card({ status: "completed", local: "stopped" }))).toBe(false);
  });
});

describe("聚合", () => {
  it("七次 edit 落在三条路径上就是 3 个文件", () => {
    const cards = [
      card({ changeStat: [{ path: "/w/a", added: 1, removed: 0 }] }),
      card({ changeStat: [{ path: "/w/a", added: 2, removed: 1 }] }),
      card({ changeStat: [{ path: "/w/a", added: 1, removed: 0 }] }),
      card({ changeStat: [{ path: "/w/b", added: 5, removed: 0 }] }),
      card({ changeStat: [{ path: "/w/b", added: 1, removed: 2 }] }),
      card({ changeStat: [{ path: "/w/c", added: 3, removed: 0 }] }),
      card({ changeStat: [{ path: "/w/c", added: 0, removed: 4 }] }),
    ];
    const s = aggregateChanges(cards);
    expect(s.files).toHaveLength(3);
    expect(s.added).toBe(13);
    expect(s.removed).toBe(7);
  });

  it("失败的那一次不进总数", () => {
    const s = aggregateChanges([
      card({ changeStat: [{ path: "/w/a", added: 3, removed: 0 }] }),
      card({ status: "failed", changeStat: [{ path: "/w/b", added: 99, removed: 99 }] }),
    ]);
    expect(s.files).toHaveLength(1);
    expect(s.added).toBe(3);
  });

  it("解析不出路径的单独计 pathless，不并进某个文件", () => {
    const s = aggregateChanges([card({ rawInput: { content: "x\ny" } })]);
    expect(s.files).toHaveLength(0);
    expect(s.pathless).toBe(1);
    expect(s.added).toBe(2);
  });

  it("windows 路径与 posix 路径指同一个文件时要合并", () => {
    const s = aggregateChanges([
      card({ changeStat: [{ path: "C:\\ws\\a.ts", added: 1, removed: 0 }] }),
      card({ changeStat: [{ path: "C:/ws/a.ts", added: 2, removed: 0 }] }),
    ]);
    expect(s.files).toHaveLength(1);
    expect(s.added).toBe(3);
  });

  it("core 直接给的明细走同一条去重", () => {
    const s = summarizeStats([
      { path: "/w/a", added: 1, removed: 0 },
      { path: "/w/a", added: 2, removed: 3 },
      { path: "/w/b", added: 1, removed: 0 },
    ]);
    expect(s.files).toHaveLength(2);
    expect(s.added).toBe(4);
    expect(s.removed).toBe(3);
  });

  it("没有文件也没有 pathless 时整卡不渲染", () => {
    expect(hasChanges(aggregateChanges([]))).toBe(false);
    expect(hasChanges(summarizeStats([]))).toBe(false);
    expect(hasChanges(null)).toBe(false);
    expect(hasChanges(summarizeStats([{ path: "/a", added: 0, removed: 0 }]))).toBe(true);
  });
});

describe("按回合切工具卡", () => {
  it("turn-end 标记切段，标记之后的卡归下一个回合", () => {
    const a = card();
    const b = card();
    const c = card();
    const items = [
      { kind: "tool" as const, id: "1", card: a },
      { kind: "tool" as const, id: "2", card: b },
      { kind: "turn-end" as const, id: "e1", turnId: "T1", at: 1 },
      { kind: "tool" as const, id: "3", card: c },
      { kind: "turn-end" as const, id: "e2", turnId: "T2", at: 2 },
    ];
    expect(cardsByTurn(items)).toEqual({ T1: [a, b], T2: [c] });
  });
});
