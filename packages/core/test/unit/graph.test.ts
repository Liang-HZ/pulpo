import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionGraph } from "../../src/graph/sessionGraph.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join("/tmp", `pulpo-graph-${process.pid}-`));
  file = path.join(dir, "session-graph.json");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function g(): SessionGraph {
  return new SessionGraph({ file });
}

describe("会话图", () => {
  it("节点只记位置，不存消息副本", () => {
    const graph = g();
    const n = graph.upsertNode({
      id: "zcode#s1",
      kind: "root",
      agentId: "zcode",
      sessionId: "s1",
      cwd: "/tmp/ws",
    });
    expect(Object.keys(n).sort()).toEqual(
      ["agentId", "createdAt", "cwd", "id", "kind", "sessionId", "updatedAt"].sort(),
    );
    expect(JSON.stringify(graph.listNodes())).not.toMatch(/messages|parts|content/);
  });

  it("upsert 保留 createdAt、刷新 updatedAt", async () => {
    const graph = g();
    const a = graph.upsertNode({ id: "zcode#s1", kind: "root", agentId: "zcode", sessionId: "s1" });
    await new Promise((r) => setTimeout(r, 5));
    const b = graph.upsertNode({ id: "zcode#s1", kind: "root", agentId: "zcode", sessionId: "s1", title: "标题" });
    expect(b.createdAt).toBe(a.createdAt);
    expect(b.updatedAt).toBeGreaterThanOrEqual(a.updatedAt);
    expect(b.title).toBe("标题");
  });

  it("三种边各自可查", () => {
    const graph = g();
    graph.addDelegate({ from: "zcode#p", to: "zcode#c", taskId: "t1", task: "干活", modelId: "m", effort: "high" });
    graph.addSupplement({ from: "zcode#p", to: "zcode#c", tier: "concurrent", outcome: "injected" });
    graph.addResult({ from: "zcode#c", to: "zcode#p", taskId: "t1", status: "done", nativeSessionRef: "zcode#c" });
    expect(graph.listEdges({ kind: "delegate" })).toHaveLength(1);
    expect(graph.listEdges({ kind: "supplement" })).toHaveLength(1);
    expect(graph.listEdges({ kind: "result" })).toHaveLength(1);
    expect(graph.listEdges({ taskId: "t1" })).toHaveLength(2);
    expect(graph.listEdges({ from: "zcode#c" })).toHaveLength(1);
  });

  it("薄状态落盘后可原样重建", () => {
    const a = g();
    a.upsertNode({ id: "zcode#p", kind: "root", agentId: "zcode", sessionId: "p" });
    a.upsertNode({ id: "zcode#c", kind: "delegation-child", agentId: "zcode", sessionId: "c" });
    a.addDelegate({ from: "zcode#p", to: "zcode#c", taskId: "t1", task: "干活" });
    a.registerNativeSubagent("zcode#p", "zcode#zcsub-1", { agentId: "zcode", sessionId: "zcsub-1", title: "子代理" });
    a.save();
    expect(fs.existsSync(file)).toBe(true);

    const b = g();
    expect(b.listNodes()).toHaveLength(3);
    expect(b.isDelegationChild("zcode#c")).toBe(true);
    expect(b.parentOfSubagent("zcode#zcsub-1")).toBe("zcode#p");
  });

  it("文件损坏时当空图起，不挂掉", () => {
    fs.writeFileSync(file, "{ 这不是 JSON");
    const graph = g();
    expect(graph.listNodes()).toEqual([]);
    expect(graph.listEdges()).toEqual([]);
  });

  it("轨迹树把派活子会话与原生 subagent 一起展开", () => {
    const graph = g();
    graph.upsertNode({ id: "zcode#p", kind: "root", agentId: "zcode", sessionId: "p" });
    graph.upsertNode({ id: "zcode#c", kind: "delegation-child", agentId: "zcode", sessionId: "c" });
    graph.addDelegate({ from: "zcode#p", to: "zcode#c", taskId: "t1", task: "干活", modelId: "m1", effort: "high" });
    graph.registerNativeSubagent("zcode#c", "zcode#zcsub-9", { agentId: "zcode", sessionId: "zcsub-9" });

    const tree = graph.tree("zcode#p")!;
    expect(tree.id).toBe("zcode#p");
    expect(tree.children).toHaveLength(1);
    const child = tree.children[0]!;
    expect(child.id).toBe("zcode#c");
    expect(child.viaTaskId).toBe("t1");
    expect(child.modelId).toBe("m1");
    expect(child.effort).toBe("high");
    expect(child.children.map((n) => n.id)).toEqual(["zcode#zcsub-9"]);
  });

  it("成环也不会无限递归", () => {
    const graph = g();
    graph.upsertNode({ id: "a", kind: "root", agentId: "x", sessionId: "a" });
    graph.upsertNode({ id: "b", kind: "delegation-child", agentId: "x", sessionId: "b" });
    graph.addDelegate({ from: "a", to: "b", taskId: "t", task: "x" });
    graph.addDelegate({ from: "b", to: "a", taskId: "t2", task: "x" });
    const tree = graph.tree("a")!;
    expect(tree.children[0]!.id).toBe("b");
    expect(tree.children[0]!.children).toHaveLength(0);
  });

  it("一层熔断判据：只有 delegate 边的 child 才算被派活会话", () => {
    const graph = g();
    graph.addDelegate({ from: "zcode#p", to: "zcode#c", taskId: "t1", task: "干活" });
    expect(graph.isDelegationChild("zcode#c")).toBe(true);
    expect(graph.isDelegationChild("zcode#p")).toBe(false);
    expect(graph.isDelegationChild("zcode#unknown")).toBe(false);
    // supplement 边不构成派活关系
    graph.addSupplement({ from: null, to: "zcode#p", tier: "queue", outcome: "queued" });
    expect(graph.isDelegationChild("zcode#p")).toBe(false);
  });

  it("childrenOf 只回 delegate 边", () => {
    const graph = g();
    graph.addDelegate({ from: "a", to: "b", taskId: "t", task: "x" });
    graph.addSupplement({ from: "a", to: "z", tier: "queue", outcome: "queued" });
    expect(graph.childrenOf("a").map((e) => e.to)).toEqual(["b"]);
  });
});
