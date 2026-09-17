import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DelegationBroker, readUsage } from "../../src/broker/delegate.js";
import { HUMAN_NODE, SessionGraph } from "../../src/graph/sessionGraph.js";
import { descriptorFromInitialize } from "../../src/descriptor/build.js";
import { BOOTSTRAP } from "../../src/descriptor/registry.js";
import type { AcpKernel } from "../../src/acp/kernel.js";
import type { DeliveryLadder } from "../../src/delivery/ladder.js";

const ROOT = fs.mkdtempSync(path.join("/tmp", `pulpo-broker-gaps-${process.pid}-`));

/**
 * 假内核：`prompt` 会把一串 session update 推出来（正文 + 两次工具调用 +
 * 一条 usage_update），broker 就是从这些里聚合用量的。
 */
class FakeKernel extends EventEmitter {
  updates: unknown[] = [];
  closed: string[] = [];

  async newSession(p: { agentId: string; cwd: string }) {
    return {
      ref: `${p.agentId}#s-child`,
      agentId: p.agentId,
      sessionId: "s-child",
      cwd: p.cwd,
      descriptor: descriptorFromInitialize(p.agentId, BOOTSTRAP.zcode!, { protocolVersion: 1 }),
      newSessionResponse: {},
      turnActive: false,
      turns: new Map(),
      createdAt: Date.now(),
    };
  }

  async setConfigOption() {
    return {};
  }

  async closeSession(ref: string) {
    this.closed.push(ref);
  }

  async cancel() {}

  async prompt(ref: string) {
    for (const u of this.updates) {
      this.emit("session_update", { agentId: "zcode", sessionId: "s-child", sessionRef: ref, update: u });
    }
    return { stopReason: "end_turn" };
  }
}

function makeBroker(): { broker: DelegationBroker; kernel: FakeKernel; graph: SessionGraph } {
  const dir = fs.mkdtempSync(path.join(ROOT, "case-"));
  const kernel = new FakeKernel();
  const graph = new SessionGraph({ file: path.join(dir, "graph.json") });
  const ladder = { deliver: async () => ({}), drain: () => [] } as unknown as DeliveryLadder;
  const broker = new DelegationBroker({
    kernel: kernel as unknown as AcpKernel,
    graph,
    ladder,
    stateFile: path.join(dir, "tasks.json"),
  });
  return { broker, kernel, graph };
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 30));
}

let ctx: ReturnType<typeof makeBroker>;

beforeEach(() => {
  ctx = makeBroker();
});

afterEach(() => {
  /* 每个用例一套独立目录，ROOT 最后统一清 */
});

describe("人从壳里派活也要进会话图", () => {
  it("不带 callerRef 时 delegate 边挂在 human 伪节点上，via=human", async () => {
    const res = await ctx.broker.delegate({ agentId: "zcode", task: "干活", cwd: ROOT });
    await settle();
    const edges = ctx.graph.listEdges({ kind: "delegate" });
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ from: HUMAN_NODE, to: res.sessionRef, via: "human" });
    const tree = ctx.graph.tree(HUMAN_NODE)!;
    expect(tree.children.map((c) => c.id)).toEqual([res.sessionRef]);
    expect(tree.children[0]!.kind).toBe("delegation-child");
  });

  it("带 fromSessionRef 时挂在壳当时打开的那条会话下，右栏画得出派活层", async () => {
    ctx.graph.upsertNode({ id: "zcode#open", kind: "root", agentId: "zcode", sessionId: "open" });
    const res = await ctx.broker.delegate({
      agentId: "zcode",
      task: "干活",
      cwd: ROOT,
      fromSessionRef: "zcode#open",
    });
    await settle();
    expect(ctx.graph.tree("zcode#open")!.children.map((c) => c.id)).toEqual([res.sessionRef]);
  });

  it("人派的边不构成熔断关系：目标自己还能再派（一层熔断只管 agent 之间）", async () => {
    const res = await ctx.broker.delegate({ agentId: "zcode", task: "干活", cwd: ROOT });
    await settle();
    expect(ctx.graph.isDelegationChild(res.sessionRef)).toBe(false);
    expect(() => ctx.broker.assertMayDelegate(res.sessionRef)).not.toThrow();
  });

  it("agent 派活仍然构成熔断关系", async () => {
    ctx.graph.upsertNode({ id: "zcode#parent", kind: "root", agentId: "zcode", sessionId: "parent" });
    const res = await ctx.broker.delegate({
      agentId: "zcode",
      task: "干活",
      cwd: ROOT,
      callerRef: "zcode#parent",
    });
    await settle();
    expect(ctx.graph.isDelegationChild(res.sessionRef)).toBe(true);
    expect(() => ctx.broker.assertMayDelegate(res.sessionRef)).toThrow(/recursion blocked/);
  });

  it("回合结束后 result 边也挂到发起节点上（人派活以前根本没有这条边）", async () => {
    const res = await ctx.broker.delegate({ agentId: "zcode", task: "干活", cwd: ROOT });
    await settle();
    const results = ctx.graph.listEdges({ kind: "result" });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ from: res.sessionRef, to: HUMAN_NODE, status: "done" });
  });
});

describe("用量聚合", () => {
  beforeEach(() => {
    ctx.kernel.updates = [
      { sessionUpdate: "agent_message_chunk", content: { text: "好" } },
      { sessionUpdate: "tool_call", toolCallId: "c1", title: "Read a.ts" },
      { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" },
      { sessionUpdate: "tool_call", toolCallId: "c2", title: "Write b.ts" },
      { sessionUpdate: "usage_update", used: 12_400, size: 1_000_000, cost: { amount: 0 } },
    ];
  });

  it("工具调用次数由 core 数（按 toolCallId 去重），上下文用量来自 agent 自报", async () => {
    const res = await ctx.broker.delegate({ agentId: "zcode", task: "干活", cwd: ROOT });
    await settle();
    const t = ctx.broker.getTask(res.taskId);
    expect(t.usage).toEqual({ toolCalls: 2, contextUsed: 12_400, contextTotal: 1_000_000 });
  });

  it("agent 什么都没报、也没工具调用时整个 usage 字段都不给（不是 0）", async () => {
    ctx.kernel.updates = [{ sessionUpdate: "agent_message_chunk", content: { text: "好" } }];
    const res = await ctx.broker.delegate({ agentId: "zcode", task: "干活", cwd: ROOT });
    await settle();
    expect(ctx.broker.getTask(res.taskId).usage).toBeUndefined();
  });

  it("readUsage 只认得出来的字段，认不出的不补 0", () => {
    expect(readUsage({ used: 5, size: 10 })).toEqual({ contextUsed: 5, contextTotal: 10 });
    expect(readUsage({ usage: { inputTokens: 3, outputTokens: 4 } })).toEqual({
      inputTokens: 3,
      outputTokens: 4,
    });
    expect(readUsage({ cost: { amount: 0 } })).toEqual({});
    expect(readUsage({ used: "很多" })).toEqual({});
    // 0 = "没报"，不是"测到 0"：zcode-adapter 在引擎没给数时推字面量 0
    expect(readUsage({ used: 0, size: 1_000_000 })).toEqual({ contextTotal: 1_000_000 });
    expect(readUsage({ used: 0, size: 0 })).toEqual({});
  });

  it("用量落进任务登记并跟着 task/update 推出去", async () => {
    const seen: any[] = [];
    ctx.broker.on("task_update", (t) => seen.push(t));
    const res = await ctx.broker.delegate({ agentId: "zcode", task: "干活", cwd: ROOT });
    await settle();
    const last = seen.at(-1);
    expect(last.taskId).toBe(res.taskId);
    expect(last.status).toBe("done");
    expect(last.usage).toMatchObject({ toolCalls: 2, contextUsed: 12_400 });
  });
});
