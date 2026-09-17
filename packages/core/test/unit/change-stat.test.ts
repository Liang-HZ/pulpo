import { describe, expect, it } from "vitest";
import {
  ChangeStatTracker,
  changeStatFromDiffBlocks,
  changeStatFromInput,
  changeStatOf,
  countLines,
  diffLines,
  MAX_DIFF_FILES,
  normalizeToolName,
  sumChangeStat,
  unifiedDiffCount,
} from "../../src/derive/changeStat.js";

describe("行数与工具名归一", () => {
  it("空串 0 行；末尾换行不多算一行", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("a")).toBe(1);
    expect(countLines("a\nb\nc")).toBe(3);
    expect(countLines("a\nb\nc\n")).toBe(3);
    expect(countLines(undefined)).toBe(0);
  });

  it("工具名去 MCP 前缀与分隔符", () => {
    expect(normalizeToolName("Write")).toBe("write");
    expect(normalizeToolName("mcp__pulpo__MultiEdit")).toBe("multiedit");
    expect(normalizeToolName("notebook-edit")).toBe("notebookedit");
  });
});

describe("① diff 块：合成 unified diff 再数", () => {
  it("只数 +/- 行，不用 newLines - oldLines（净变化不是加减行数）", () => {
    // 旧 3 行 → 新 3 行，中间一行换了：净变化 0，实际是 +1 −1。
    const c = unifiedDiffCount("a\nb\nc\n", "a\nB\nc\n");
    expect(c).toEqual({ added: 1, removed: 1, truncated: false });
  });

  it("纯新增 / 纯删除都数得对", () => {
    expect(unifiedDiffCount("", "x\ny\nz\n")).toMatchObject({ added: 3, removed: 0 });
    expect(unifiedDiffCount("x\ny\nz\n", "")).toMatchObject({ added: 0, removed: 3 });
  });

  it("上下文行不进计数（2 行上下文只影响封顶预算）", () => {
    const oldText = Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n");
    const newText = oldText.replace("l25", "L25");
    expect(unifiedDiffCount(oldText, newText)).toEqual({ added: 1, removed: 1, truncated: false });
  });

  it("超过 1200 行封顶时如实标 truncated", () => {
    const big = Array.from({ length: 2000 }, (_, i) => `x${i}`).join("\n");
    const c = unifiedDiffCount("", big);
    expect(c.truncated).toBe(true);
    expect(c.added).toBeLessThanOrEqual(1200);
  });

  it("diff 块按路径归并，最多 8 个文件", () => {
    const content = Array.from({ length: 12 }, (_, i) => ({
      type: "diff",
      path: `/ws/f${i}.ts`,
      oldText: "a\n",
      newText: "a\nb\n",
    }));
    const stats = changeStatFromDiffBlocks(content);
    expect(stats).toHaveLength(MAX_DIFF_FILES);
    expect(stats[0]).toEqual({ path: "/ws/f0.ts", added: 1, removed: 0 });
  });

  it("diffLines 剥公共前后缀后仍然给出完整操作序列", () => {
    const ops = diffLines(["a", "b", "c"], ["a", "x", "c"]);
    expect(ops.map((o) => o.kind)).toEqual(["same", "del", "add", "same"]);
  });
});

describe("② 入参公式：四条", () => {
  it("Write → added = content 行数，removed = 0", () => {
    expect(changeStatFromInput("Write", { file_path: "/ws/a.txt", content: "1\n2\n3\n" })).toEqual([
      { path: "/ws/a.txt", added: 3, removed: 0 },
    ]);
  });

  it("Edit → added = new_string 行数，removed = old_string 行数", () => {
    expect(
      changeStatFromInput("Edit", { file_path: "/ws/a.ts", old_string: "x\ny", new_string: "X" }),
    ).toEqual([{ path: "/ws/a.ts", added: 1, removed: 2 }]);
  });

  it("MultiEdit → 对 edits[] 累加", () => {
    const stats = changeStatFromInput("MultiEdit", {
      file_path: "/ws/a.ts",
      edits: [
        { old_string: "a", new_string: "A\nA2" },
        { old_string: "b\nb2", new_string: "B" },
      ],
    });
    expect(stats).toEqual([{ path: "/ws/a.ts", added: 3, removed: 3 }]);
  });

  it("NotebookEdit → added = new_source 行数", () => {
    expect(
      changeStatFromInput("NotebookEdit", { notebook_path: "/ws/n.ipynb", new_source: "a\nb" }),
    ).toEqual([{ path: "/ws/n.ipynb", added: 2, removed: 0 }]);
  });

  it("非写入类工具一律不给统计（不是给 0）", () => {
    expect(changeStatFromInput("Read", { file_path: "/ws/a.ts" })).toEqual([]);
    expect(changeStatFromInput("Bash", { command: "ls" })).toEqual([]);
  });

  it("路径去重按工作区相对路径：7 次 edit 落在 3 个路径上就是 3 个文件", () => {
    const stats = changeStatFromInput("MultiEdit", {
      file_path: "/ws/a.ts",
      edits: [
        { file_path: "/ws/a.ts", old_string: "1", new_string: "1x" },
        { file_path: "/ws\\a.ts", old_string: "2", new_string: "2x" },
        { file_path: "/ws/b.ts", old_string: "3", new_string: "3x" },
        { file_path: "/ws/b.ts", old_string: "4", new_string: "4x" },
        { file_path: "/ws/c.ts", old_string: "5", new_string: "5x" },
        { file_path: "/ws/c.ts", old_string: "6", new_string: "6x" },
        { file_path: "/ws/c.ts", old_string: "7", new_string: "7x" },
      ],
    });
    expect(sumChangeStat(stats).files).toBe(3);
    expect(stats.find((s) => s.path.includes("a.ts"))).toMatchObject({ added: 2, removed: 2 });
  });

  it("有 diff 块时优先走 diff 块，不再数入参", () => {
    const stats = changeStatOf({
      sessionUpdate: "tool_call",
      title: "Write a.txt",
      rawInput: { file_path: "/ws/a.txt", content: "1\n2\n3\n" },
      content: [{ type: "diff", path: "/ws/a.txt", oldText: "", newText: "1\n" }],
    });
    expect(stats).toEqual([{ path: "/ws/a.txt", added: 1, removed: 0 }]);
  });

  it("工具名只在 title 里时也能认出来（ZCode adapter 的 tool_call 就是这样）", () => {
    const stats = changeStatOf({
      sessionUpdate: "tool_call",
      title: "Write hello.txt",
      rawInput: { file_path: "/ws/hello.txt", content: "a\nb\nc\n" },
    });
    expect(stats).toEqual([{ path: "/ws/hello.txt", added: 3, removed: 0 }]);
  });
});

describe("暂存 → 提交（失败的编辑一行都不算）", () => {
  const call = (over: Record<string, unknown> = {}) => ({
    sessionUpdate: "tool_call",
    toolCallId: "c1",
    title: "Write a.txt",
    status: "pending",
    rawInput: { file_path: "/ws/a.txt", content: "1\n2\n3\n" },
    ...over,
  });

  it("tool_call 只暂存，不提交", () => {
    const t = new ChangeStatTracker();
    expect(t.onUpdate(call())).toBeUndefined();
    expect(t.pendingCount).toBe(1);
  });

  it("结果回来且非 error 才提交，且只提交一次", () => {
    const t = new ChangeStatTracker();
    t.onUpdate(call());
    expect(t.onUpdate({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" })).toEqual([
      { path: "/ws/a.txt", added: 3, removed: 0 },
    ]);
    expect(
      t.onUpdate({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" }),
    ).toBeUndefined();
  });

  it("status=failed 时丢掉暂存，永不提交", () => {
    const t = new ChangeStatTracker();
    t.onUpdate(call());
    expect(t.onUpdate({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "failed" })).toBeUndefined();
    expect(
      t.onUpdate({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" }),
    ).toBeUndefined();
  });

  it("rawOutput.is_error 也算失败", () => {
    const t = new ChangeStatTracker();
    t.onUpdate(call());
    expect(
      t.onUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "c1",
        status: "completed",
        rawOutput: { is_error: true },
      }),
    ).toBeUndefined();
  });

  it("一条 tool_call 直接带 completed 时当场提交", () => {
    const t = new ChangeStatTracker();
    expect(t.onUpdate(call({ status: "completed" }))).toEqual([
      { path: "/ws/a.txt", added: 3, removed: 0 },
    ]);
  });

  it("算不出统计的工具不产生任何字段（不塞 0）", () => {
    const t = new ChangeStatTracker();
    t.onUpdate({ sessionUpdate: "tool_call", toolCallId: "b1", title: "Bash ls", rawInput: { command: "ls" } });
    expect(
      t.onUpdate({ sessionUpdate: "tool_call_update", toolCallId: "b1", status: "completed" }),
    ).toBeUndefined();
  });

  it("正文 / 思考这类 update 一律不碰", () => {
    const t = new ChangeStatTracker();
    expect(t.onUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "hi" } })).toBeUndefined();
  });
});
