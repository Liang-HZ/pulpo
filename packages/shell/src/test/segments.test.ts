// 工作段分段与分桶。两层判定各测一遍，外加"标签不闪"那几条。

import { describe, expect, it } from "vitest";
import type { ChatItem, ToolCard } from "../lib/chat";
import {
  bucketOf,
  bucketize,
  groupSummary,
  labelCards,
  segmentHasFailure,
  segmentLabel,
  segmentRunning,
  segmentSpan,
  splitBlocks,
} from "../lib/segments";

let seq = 0;

function tool(
  over: Partial<ToolCard> & { kind?: string | null } = {},
): Extract<ChatItem, { kind: "tool" }> {
  seq += 1;
  const card: ToolCard = {
    callId: `c${seq}`,
    title: `t${seq}`,
    toolName: null,
    kind: over.kind ?? "read",
    status: "completed",
    rawInput: null,
    rawOutput: null,
    content: [],
    locations: [],
    sawFirstCard: true,
    createdAt: 1000,
    updatedAt: 2000,
    ...over,
  } as ToolCard;
  return { kind: "tool", id: `i${seq}`, card };
}

function text(t: string): ChatItem {
  seq += 1;
  return { kind: "assistant", id: `a${seq}`, text: t, at: 1000 };
}

function thought(t = "想"): ChatItem {
  seq += 1;
  return { kind: "thought", id: `th${seq}`, text: t, at: 1000 };
}

describe("第一层：段的边界——遇到非空正文就断", () => {
  it("两段正文之间那一整串工具是一段", () => {
    const blocks = splitBlocks([
      text("开头"),
      tool(),
      tool(),
      tool(),
      text("结尾"),
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(["content", "segment", "content"]);
    const segment = blocks[1];
    expect(segment?.kind === "segment" && segment.items.length).toBe(3);
  });

  it("空的正文块不断段（流式刚开头还没有字）", () => {
    const blocks = splitBlocks([tool(), text("   "), tool()]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe("segment");
  });

  it("段的身份锚在首个子工具的 toolCallId 上——展开记忆跨重渲染不丢", () => {
    const first = tool({ callId: "call_abc" });
    const blocks = splitBlocks([first, tool()]);
    const segment = blocks[0];
    expect(segment?.kind === "segment" && segment.id).toBe("seg-call_abc");
    // item 的本地 id 变了（历史重排/序号重算），段的 key 不变
    const again = splitBlocks([{ ...first, id: "i-换了" }, tool()]);
    const againSegment = again[0];
    expect(againSegment?.kind === "segment" && againSegment.id).toBe("seg-call_abc");
  });

  it("单条工具不成段，直接渲染成普通工具卡", () => {
    const blocks = splitBlocks([text("a"), tool(), text("b")]);
    expect(blocks.map((b) => b.kind)).toEqual(["content", "content", "content"]);
  });

  it("单条思考照样成段——思考段是单独一类，不能散在正文里", () => {
    const blocks = splitBlocks([text("a"), thought(), text("b")]);
    expect(blocks.map((b) => b.kind)).toEqual(["content", "segment", "content"]);
  });

  it("回合结束标记是内联卡片，会把段冲刷掉", () => {
    const end: ChatItem = { kind: "turn-end", id: "e1", turnId: "t1", at: 3000 };
    const blocks = splitBlocks([tool(), tool(), end, tool(), tool()]);
    expect(blocks.map((b) => b.kind)).toEqual(["segment", "content", "segment"]);
  });

  it("没有正文时整串工具就是一段", () => {
    const blocks = splitBlocks([tool(), tool()]);
    expect(blocks).toHaveLength(1);
  });

  it("空输入不产生任何块", () => {
    expect(splitBlocks([])).toEqual([]);
  });
});

describe("第二层：段内按连续同类分桶", () => {
  it("写入类进 changes，shell 进 terminal，读取搜索抓取进 explore", () => {
    expect(bucketOf(tool({ kind: "edit" }))).toBe("changes");
    expect(bucketOf(tool({ kind: "delete" }))).toBe("changes");
    expect(bucketOf(tool({ kind: "move" }))).toBe("changes");
    expect(bucketOf(tool({ kind: "execute" }))).toBe("terminal");
    expect(bucketOf(tool({ kind: "read" }))).toBe("explore");
    expect(bucketOf(tool({ kind: "search" }))).toBe("explore");
    expect(bucketOf(tool({ kind: "fetch" }))).toBe("explore");
    expect(bucketOf(tool({ kind: "switch_mode" }))).toBe("other");
    expect(bucketOf(thought())).toBe("think");
  });

  it("只有连续的才合并——中间插一条别类工具，桶就断开", () => {
    const groups = bucketize([
      tool({ kind: "edit" }),
      tool({ kind: "edit" }),
      tool({ kind: "execute" }),
      tool({ kind: "edit" }),
    ]);
    expect(groups.map((g) => g.bucket)).toEqual(["changes", "terminal", "changes"]);
    expect(groups[0]?.items).toHaveLength(2);
    expect(groups[2]?.items).toHaveLength(1);
  });

  it("文件数按去重路径算，不是调用次数", () => {
    const a = tool({ kind: "edit", locations: [{ path: "/ws/a.ts" }] });
    const b = tool({ kind: "edit", locations: [{ path: "/ws/a.ts" }] });
    const c = tool({ kind: "edit", locations: [{ path: "/ws/b.ts" }] });
    const [group] = bucketize([a, b, c]);
    expect(groupSummary(group!).text).toBe("更改 2 个文件");
  });

  it("一个路径都解析不出来时退回「{n} 个工具」，不编一个文件数", () => {
    const [group] = bucketize([tool({ kind: "edit" }), tool({ kind: "edit" })]);
    expect(groupSummary(group!).text).toBe("更改 2 个工具");
  });

  it("终端摘要带失败与已停止的计数", () => {
    const [group] = bucketize([
      tool({ kind: "execute" }),
      tool({ kind: "execute", status: "failed" }),
      tool({ kind: "execute", local: "stopped" }),
    ]);
    expect(groupSummary(group!).text).toBe("终端 3 个命令, 失败 1, 已停止 1");
  });

  it("探索与思考各有自己的量词", () => {
    expect(groupSummary(bucketize([tool(), tool()])[0]!).text).toBe("探索 2 个工具");
    expect(groupSummary(bucketize([thought(), thought()])[0]!).text).toBe("思考 2 段");
  });
});

describe("折叠行的标签", () => {
  it("耗时够一秒才写「已工作 …」，否则让桶摘要顶上", () => {
    const groups = bucketize([tool(), tool()]);
    expect(
      segmentLabel(groups, { running: false, startedAt: 0, endedAt: 12_000 }).kindLabel,
    ).toBe("已工作 12秒");
    expect(
      segmentLabel(groups, { running: false, startedAt: 0, endedAt: 0 }).kindLabel,
    ).toBeNull();
    expect(
      segmentLabel(groups, { running: true, startedAt: 0, endedAt: 3000 }).kindLabel,
    ).toBe("工作中 3秒");
  });

  it("桶按条数降序取前 2，剩下的收成一句", () => {
    const groups = bucketize([
      tool({ kind: "read" }),
      tool({ kind: "execute" }),
      tool({ kind: "execute" }),
      tool({ kind: "execute" }),
      tool({ kind: "edit" }),
      tool({ kind: "edit" }),
      thought(),
    ]);
    const label = segmentLabel(groups, { running: false, startedAt: 0, endedAt: 12_000 });
    expect(label.parts).toEqual(["终端 3 个命令", "更改 2 个工具"]);
    expect(label.rest).toBe("以及另外 2 个工具");
  });

  it("算不出加减行数时 added / removed 是 null，不是 0", () => {
    const groups = bucketize([tool({ kind: "read" })]);
    const label = segmentLabel(groups, { running: false, startedAt: 0, endedAt: 2000 });
    expect(label.added).toBeNull();
    expect(label.removed).toBeNull();
  });

  it("有写入时给出 +N −N", () => {
    const groups = bucketize([
      tool({
        kind: "edit",
        locations: [{ path: "/ws/a.ts" }],
        changeStat: [{ path: "/ws/a.ts", added: 42, removed: 7 }],
      }),
    ]);
    const label = segmentLabel(groups, { running: false, startedAt: 0, endedAt: 2000 });
    expect(label.added).toBe(42);
    expect(label.removed).toBe(7);
  });

  it("失败数出现在标签里", () => {
    const groups = bucketize([tool({ kind: "execute", status: "failed" })]);
    expect(segmentLabel(groups, { running: false, startedAt: 0, endedAt: 2000 }).failed).toBe(1);
  });
});

describe("标签不闪：只用已结算的工具算标签", () => {
  it("有已结算的就只用已结算的", () => {
    const done = tool({ status: "completed" });
    const running = tool({ status: "in_progress" });
    expect(labelCards([done, running])).toEqual([done.card]);
  });

  it("一个都没结算就保留最后一个", () => {
    const a = tool({ status: "pending" });
    const b = tool({ status: "in_progress" });
    expect(labelCards([a, b])).toEqual([b.card]);
  });

  it("没有工具时返回空", () => {
    expect(labelCards([thought()])).toEqual([]);
  });
});

describe("段的运行态与失败态", () => {
  it("有 pending / in_progress 子项就算在跑", () => {
    expect(segmentRunning([tool({ status: "completed" })])).toBe(false);
    expect(segmentRunning([tool({ status: "pending" })])).toBe(true);
    expect(segmentRunning([tool({ status: "in_progress" })])).toBe(true);
  });

  it("被拒 / 被停的不算在跑（它们已经结算了）", () => {
    expect(segmentRunning([tool({ status: "pending", local: "denied" })])).toBe(false);
    expect(segmentRunning([tool({ status: "in_progress", local: "stopped" })])).toBe(false);
  });

  it("有失败子项时要能查出来——失败的段不自动收起", () => {
    expect(segmentHasFailure([tool({ status: "failed" })])).toBe(true);
    expect(segmentHasFailure([tool({ status: "completed" })])).toBe(false);
  });

  it("段的时间跨度取子项的最早开始与最晚结束", () => {
    const span = segmentSpan([
      tool({ createdAt: 500, updatedAt: 800 }),
      tool({ createdAt: 700, updatedAt: 9000 }),
    ]);
    expect(span).toEqual({ startedAt: 500, endedAt: 9000 });
  });
});
