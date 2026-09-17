// core 的旁路字段 `derived`（PROTOCOL §5）在壳里的落点：
// 回合边界事件、逐工具的 changeStat、流式合并，以及撤销回执里 skipped 的如实转达。

import { describe, expect, it } from "vitest";
import { AppStore, coalesceUpdates, toApproval } from "../lib/store";
import type { PermissionRequested, SessionUpdateNotification } from "../lib/protocol";
import { FakeWebSocket } from "./fake-websocket";

const REF = "zcode#zc-sess_1";

function boot() {
  const store = new AppStore("ws://127.0.0.1:0", FakeWebSocket as unknown as typeof WebSocket);
  store.start();
  const ws = FakeWebSocket.last();
  ws.open();
  return { store, ws };
}

function notify(ws: ReturnType<typeof boot>["ws"], params: unknown): void {
  ws.deliver({ jsonrpc: "2.0", method: "session/update", params });
}

describe("回合边界走同一条通道，但不冒充 agent 的 update", () => {
  it("有 derived.event 就是壳内合成事件，会立刻结算（不进节流队列）", () => {
    const { store, ws } = boot();
    notify(ws, {
      sessionRef: REF,
      agentId: "zcode",
      sessionId: "zc-sess_1",
      derived: { event: "turn_started", turnId: "T1", startedAt: 1000 },
    });
    expect(store.getSnapshot().turnActive[REF]).toBe(true);
    expect(store.getSnapshot().chats[REF]?.turns).toEqual([
      { turnId: "T1", startedAt: 1000, endedAt: null },
    ]);
    store.stop();
  });

  it("turn_finished 落一条 turn-end 项，带上改动摘要与 stopReason", () => {
    const { store, ws } = boot();
    notify(ws, {
      sessionRef: REF,
      agentId: "zcode",
      sessionId: "zc-sess_1",
      derived: { event: "turn_started", turnId: "T1", startedAt: 1000 },
    });
    notify(ws, {
      sessionRef: REF,
      agentId: "zcode",
      sessionId: "zc-sess_1",
      derived: {
        event: "turn_finished",
        turnId: "T1",
        startedAt: 1000,
        endedAt: 5000,
        stopReason: "end_turn",
        changes: { files: 2, added: 4, removed: 1, revert: "available" },
      },
    });
    const state = store.getSnapshot();
    expect(state.turnActive[REF]).toBe(false);
    const end = state.chats[REF]!.items.at(-1);
    expect(end).toMatchObject({
      kind: "turn-end",
      turnId: "T1",
      stopReason: "end_turn",
      startedAt: 1000,
      changes: { files: 2, added: 4, removed: 1 },
    });
    store.stop();
  });

  it("没有 changes 的回合不带这个字段——UI 据此整卡不渲染，不显示 0 个文件", () => {
    const { store, ws } = boot();
    notify(ws, {
      sessionRef: REF,
      agentId: "zcode",
      sessionId: "zc-sess_1",
      derived: { event: "turn_finished", turnId: "T9", endedAt: 2 },
    });
    const end = store.getSnapshot().chats[REF]!.items.at(-1);
    expect(end && "changes" in end ? end.changes : undefined).toBeUndefined();
    store.stop();
  });

  it("derived.changeStat 挂到对应的工具卡上", () => {
    const { store, ws } = boot();
    notify(ws, {
      sessionRef: REF,
      agentId: "zcode",
      sessionId: "zc-sess_1",
      update: { sessionUpdate: "tool_call", toolCallId: "c1", title: "Write", kind: "edit" },
    });
    notify(ws, {
      sessionRef: REF,
      agentId: "zcode",
      sessionId: "zc-sess_1",
      update: { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" },
      derived: { changeStat: [{ path: "/w/three.txt", added: 3, removed: 0 }] },
    });
    store.flushUpdates();
    const item = store.getSnapshot().chats[REF]!.items.find((i) => i.kind === "tool");
    expect(item?.kind === "tool" && item.card.changeStat).toEqual([
      { path: "/w/three.txt", added: 3, removed: 0 },
    ]);
    store.stop();
  });

  it("没有 update 也没有 derived.event 的通知直接丢掉，不建空卡", () => {
    const { store, ws } = boot();
    notify(ws, { sessionRef: REF, agentId: "zcode", sessionId: "zc-sess_1" });
    store.flushUpdates();
    expect(store.getSnapshot().chats[REF]).toBeUndefined();
    store.stop();
  });
});

describe("流式合并", () => {
  const chunk = (text: string, ref = REF): SessionUpdateNotification =>
    ({
      sessionRef: ref,
      agentId: "zcode",
      sessionId: "s",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    }) as SessionUpdateNotification;

  it("连续的同类文本 chunk 先拼成一条", () => {
    const out = coalesceUpdates([chunk("你"), chunk("好"), chunk("世界")]);
    expect(out).toHaveLength(1);
    const content = out[0]!.update!.content;
    expect(!Array.isArray(content) && content?.text).toBe("你好世界");
  });

  it("不同 sessionRef 不合并", () => {
    expect(coalesceUpdates([chunk("a"), chunk("b", "zcode#other")])).toHaveLength(2);
  });

  it("思考与正文不混着合并", () => {
    const thought = {
      ...chunk("嗯"),
      update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "嗯" } },
    } as SessionUpdateNotification;
    expect(coalesceUpdates([chunk("a"), thought, chunk("b")])).toHaveLength(3);
  });

  it("工具卡原样保留顺序，一条都不吞", () => {
    const tool = {
      sessionRef: REF,
      agentId: "zcode",
      sessionId: "s",
      update: { sessionUpdate: "tool_call", toolCallId: "c1" },
    } as SessionUpdateNotification;
    const out = coalesceUpdates([chunk("a"), tool, chunk("b"), chunk("c")]);
    expect(out).toHaveLength(3);
    expect(out[1]!.update!.sessionUpdate).toBe("tool_call");
  });
});

describe("审批请求 → 卡片模型", () => {
  const base: PermissionRequested = {
    requestId: "r1",
    sessionRef: REF,
    agentId: "zcode",
    options: [
      { optionId: "a", name: "Allow once", kind: "allow_once" },
      { optionId: "r", name: "Reject", kind: "reject_once" },
    ],
    createdAt: 1,
  };

  it("文件清单来自 toolCall.locations", () => {
    const approval = toApproval({
      ...base,
      request: { toolCall: { toolCallId: "c1", kind: "edit", locations: [{ path: "/w/a.ts" }] } },
    });
    expect(approval.files).toEqual(["/w/a.ts"]);
    expect(approval.toolCallId).toBe("c1");
    expect(approval.toolKind).toBe("edit");
  });

  it("`_meta.permission` 缺失时卡片照样能渲染（它是可选的）", () => {
    const approval = toApproval(base);
    expect(approval.meta).toBeNull();
    expect(approval.queueDepth).toBeNull();
    expect(approval.files).toEqual([]);
    expect(approval.options).toHaveLength(2);
  });

  it("带 `_meta.permission` 时原样带进来", () => {
    const approval = toApproval({
      ...base,
      queueDepth: 3,
      request: {
        _meta: { permission: { defaultToNo: true, changes: [{ description: "写入项目设置" }] } },
      },
    });
    expect(approval.meta?.defaultToNo).toBe(true);
    expect(approval.queueDepth).toBe(3);
  });
});

describe("撤销：skipped 必须如实转达", () => {
  it("有跳过的文件就把路径与原因原样写进横幅", async () => {
    const { store, ws } = boot();
    const promise = store.revertTurn(REF, "T1");
    await Promise.resolve();
    const req = ws.requests().find((r) => r.method === "session/revert")!;
    ws.deliver({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        turnId: "T1",
        reverted: ["a.txt"],
        skipped: [{ path: "b.txt", reason: "当前文件已被外部修改（内容与本回合结束时不一致），不覆盖" }],
      },
    });
    await promise;
    const banner = store.getSnapshot().banner;
    expect(banner?.text).toContain("b.txt");
    expect(banner?.text).toContain("当前文件已被外部修改");
    expect(banner?.tone).toBe("warn");
    store.stop();
  });

  it("一个文件都没撤成时是 danger", async () => {
    const { store, ws } = boot();
    const promise = store.revertTurn(REF, "T1");
    await Promise.resolve();
    const req = ws.requests().find((r) => r.method === "session/revert")!;
    ws.deliver({
      jsonrpc: "2.0",
      id: req.id,
      result: { turnId: "T1", reverted: [], skipped: [{ path: "b.txt", reason: "缺少 checkpoint" }] },
    });
    await promise;
    expect(store.getSnapshot().banner?.tone).toBe("bad");
    store.stop();
  });
});
