import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestEnv, startDaemon, RpcClient, waitFor, type TestEnv } from "../helpers.js";
import { toElicitationResponse } from "../../src/server/daemon.js";
import type { PulpoDaemon } from "../../src/server/daemon.js";

/**
 * 壳内合成事件的形状与时序（回合边界）。这里不需要真 agent——直接把内核事件打出来，
 * 看订阅端收到什么。真引擎上的端到端时序在 integration/gaps.test.ts 里。
 */
let t: TestEnv;
let daemon: PulpoDaemon;
let c: RpcClient;

beforeAll(async () => {
  t = makeTestEnv("turn-events");
  daemon = await startDaemon(t);
  c = await RpcClient.websocket(daemon.wsPort!);
  await c.call("subscribe", { topics: ["session/update"] });
});

afterAll(async () => {
  c?.close();
  await daemon?.stop();
  t?.cleanup();
});

function fire(event: string, params: Record<string, unknown>): void {
  daemon.kernel.emit(event, params);
}

describe("turn_started / turn_finished 走 session/update 通道，但不冒充 agent 的 update", () => {
  it("合成事件没有 update 字段，只有 derived.event", async () => {
    fire("turn_started", {
      sessionRef: "zcode#s1",
      agentId: "zcode",
      sessionId: "s1",
      turnId: "turn-1",
      startedAt: 111,
    });
    await waitFor(() => c.notifications.some((n) => n.params?.derived?.event === "turn_started"), {
      timeoutMs: 3000,
      what: "turn_started",
    });
    const n = c.notifications.find((x) => x.params?.derived?.event === "turn_started")!;
    expect(n.method).toBe("session/update");
    expect(n.params.update).toBeUndefined();
    expect(n.params).toMatchObject({ sessionRef: "zcode#s1", agentId: "zcode", sessionId: "s1" });
    expect(n.params.derived).toEqual({ event: "turn_started", turnId: "turn-1", startedAt: 111 });
  });

  it("turn_finished 带 stopReason 与回合 id", async () => {
    fire("turn_finished", {
      sessionRef: "zcode#s1",
      agentId: "zcode",
      sessionId: "s1",
      turnId: "turn-1",
      startedAt: 111,
      endedAt: 222,
      stopReason: "end_turn",
    });
    await waitFor(() => c.notifications.some((n) => n.params?.derived?.event === "turn_finished"), {
      timeoutMs: 5000,
      what: "turn_finished",
    });
    const n = c.notifications.find((x) => x.params?.derived?.event === "turn_finished")!;
    expect(n.params.derived).toMatchObject({
      event: "turn_finished",
      turnId: "turn-1",
      stopReason: "end_turn",
      endedAt: 222,
    });
    expect(n.params.update).toBeUndefined();
  });

  it("两条事件的先后就是 core 代理请求的先后", () => {
    const events = c.notifications
      .filter((n) => n.params?.derived?.event)
      .map((n) => n.params.derived.event);
    expect(events).toEqual(["turn_started", "turn_finished"]);
  });
});

describe("session/update 透传时带上派生的 changeStat", () => {
  it("tool_call 只暂存不带字段；结算那条才带，且 agent 原文一字不改", async () => {
    const before = c.notifications.length;
    const call = {
      sessionUpdate: "tool_call",
      toolCallId: "zc-1",
      title: "Write hello.txt",
      status: "pending",
      rawInput: { file_path: "/tmp/ws/hello.txt", content: "1\n2\n3\n" },
    };
    fire("session_update", { agentId: "zcode", sessionId: "s2", update: call });
    fire("session_update", {
      agentId: "zcode",
      sessionId: "s2",
      update: { sessionUpdate: "tool_call_update", toolCallId: "zc-1", status: "completed" },
    });
    await waitFor(() => c.notifications.length >= before + 2, { timeoutMs: 3000, what: "两条 update" });
    const [first, second] = c.notifications.slice(before);
    expect(first!.params.derived).toBeUndefined();
    expect(first!.params.update).toEqual(call); // 原文原样
    expect(second!.params.derived).toEqual({
      changeStat: [{ path: "/tmp/ws/hello.txt", added: 3, removed: 0 }],
    });
    expect(second!.params.update.sessionUpdate).toBe("tool_call_update");
  });

  it("失败的工具结果不带统计", async () => {
    const before = c.notifications.length;
    fire("session_update", {
      agentId: "zcode",
      sessionId: "s3",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "zc-2",
        title: "Write bad.txt",
        rawInput: { file_path: "/tmp/ws/bad.txt", content: "1\n" },
      },
    });
    fire("session_update", {
      agentId: "zcode",
      sessionId: "s3",
      update: { sessionUpdate: "tool_call_update", toolCallId: "zc-2", status: "failed" },
    });
    await waitFor(() => c.notifications.length >= before + 2, { timeoutMs: 3000, what: "两条 update" });
    for (const n of c.notifications.slice(before)) expect(n.params.derived).toBeUndefined();
  });
});

describe("elicitation 应答形状", () => {
  it("accept 带 content 原样回给 agent；decline / cancel 不编内容", () => {
    expect(toElicitationResponse({ outcome: "elicit", action: "accept", content: { a: 1 } })).toEqual({
      action: "accept",
      content: { a: 1 },
    });
    expect(toElicitationResponse({ outcome: "elicit", action: "decline" })).toEqual({ action: "decline" });
    expect(toElicitationResponse({ outcome: "elicit", action: "cancel" })).toEqual({ action: "cancel" });
  });

  it("老路径（permission/respond 答 elicitation）仍然有效", () => {
    expect(toElicitationResponse({ outcome: "selected", optionId: "o1" })).toEqual({
      action: "accept",
      content: { optionId: "o1" },
    });
    expect(toElicitationResponse({ outcome: "cancelled" })).toEqual({ action: "decline" });
  });

  it("未知 requestId 一律 -32004，不静默吞", async () => {
    const res = await c.raw("elicitation/respond", { requestId: "没这条", action: "accept" }, 5000);
    expect(res.error.code).toBe(-32004);
    const bad = await c.raw("elicitation/respond", { requestId: "x", action: "乱填" }, 5000);
    expect(bad.error.code).toBe(-32602);
  });
});
