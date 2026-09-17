import { beforeEach, describe, expect, it, vi } from "vitest";
import { RpcClient, RpcError, splitRef, type ConnectionState } from "../lib/rpc";
import { FakeClock, FakeWebSocket } from "./fake-websocket";

function makeClient(clock = new FakeClock()) {
  const client = new RpcClient({
    url: "ws://127.0.0.1:27183",
    WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
    backoffBaseMs: 500,
    backoffMaxMs: 4000,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
    now: clock.now,
  });
  return { client, clock };
}

beforeEach(() => {
  FakeWebSocket.reset();
});

describe("请求与应答的配对", () => {
  it("按 id 把应答交回给对应的调用方，先发的后回也不串", async () => {
    const { client } = makeClient();
    client.connect();
    FakeWebSocket.last().open();

    const first = client.call<{ v: string }>("core/info");
    const second = client.call<{ v: string }>("agent/list");
    expect(client.pendingCount).toBe(2);

    const ws = FakeWebSocket.last();
    expect(ws.request(0).method).toBe("core/info");
    expect(ws.request(1).method).toBe("agent/list");

    // 故意乱序回
    ws.deliver({ jsonrpc: "2.0", id: ws.request(1).id, result: { v: "second" } });
    ws.deliver({ jsonrpc: "2.0", id: ws.request(0).id, result: { v: "first" } });

    await expect(first).resolves.toEqual({ v: "first" });
    await expect(second).resolves.toEqual({ v: "second" });
    expect(client.pendingCount).toBe(0);
  });

  it("错误应答变成带 code 的 RpcError", async () => {
    const { client } = makeClient();
    client.connect();
    const ws = FakeWebSocket.last();
    ws.open();

    const call = client.call("task/delegate");
    ws.deliver({
      jsonrpc: "2.0",
      id: ws.request(0).id,
      error: { code: -32003, message: "recursion blocked", data: { legacyExitCode: 3 } },
    });

    await expect(call).rejects.toBeInstanceOf(RpcError);
    await call.catch((err: RpcError) => {
      expect(err.code).toBe(-32003);
      expect(err.data).toEqual({ legacyExitCode: 3 });
    });
  });

  it("没连上时调用直接失败，不静默挂起", async () => {
    const { client } = makeClient();
    client.connect(); // 还没 open
    await expect(client.call("core/info")).rejects.toThrow(/未连接/);
    expect(client.pendingCount).toBe(0);
  });

  it("参数缺省时补成空对象，符合 JSON-RPC 的形状", async () => {
    const { client } = makeClient();
    client.connect();
    const ws = FakeWebSocket.last();
    ws.open();
    void client.call("session/open");
    expect(ws.request(0)).toMatchObject({ method: "session/open", params: {} });
  });

  it("批量应答（一个数组）里的每一条都能配对", async () => {
    const { client } = makeClient();
    client.connect();
    const ws = FakeWebSocket.last();
    ws.open();
    const a = client.call("core/info");
    const b = client.call("agent/list");
    ws.deliver([
      { jsonrpc: "2.0", id: ws.request(0).id, result: 1 },
      { jsonrpc: "2.0", id: ws.request(1).id, result: 2 },
    ]);
    await expect(Promise.all([a, b])).resolves.toEqual([1, 2]);
  });
});

describe("通知分发", () => {
  it("把无 id 的通知按 method 派给订阅者", () => {
    const { client } = makeClient();
    const updates: unknown[] = [];
    const tasks: unknown[] = [];
    client.on("session/update", (p) => updates.push(p));
    client.on("task/update", (p) => tasks.push(p));
    client.connect();
    const ws = FakeWebSocket.last();
    ws.open();

    ws.deliver({ jsonrpc: "2.0", method: "session/update", params: { sessionRef: "zcode#a" } });
    ws.deliver({ jsonrpc: "2.0", method: "task/update", params: { taskId: "t1" } });
    ws.deliver({ jsonrpc: "2.0", method: "agent/exit", params: { agentId: "zcode" } });

    expect(updates).toEqual([{ sessionRef: "zcode#a" }]);
    expect(tasks).toEqual([{ taskId: "t1" }]);
  });

  it("同一个 method 的多个订阅者都收到，退订之后不再收", () => {
    const { client } = makeClient();
    const a: unknown[] = [];
    const b: unknown[] = [];
    const offA = client.on("session/update", (p) => a.push(p));
    client.on("session/update", (p) => b.push(p));
    client.connect();
    const ws = FakeWebSocket.last();
    ws.open();

    ws.deliver({ jsonrpc: "2.0", method: "session/update", params: 1 });
    offA();
    ws.deliver({ jsonrpc: "2.0", method: "session/update", params: 2 });

    expect(a).toEqual([1]);
    expect(b).toEqual([1, 2]);
  });

  it("带 id 的消息不会被当成通知（应答不触发通知处理器）", () => {
    const { client } = makeClient();
    const seen: unknown[] = [];
    client.on("session/update", (p) => seen.push(p));
    client.connect();
    const ws = FakeWebSocket.last();
    ws.open();
    ws.deliver({ jsonrpc: "2.0", id: 99, method: "session/update", params: { x: 1 } });
    expect(seen).toEqual([]);
  });

  it("非法帧被丢掉，不把连接拖垮", () => {
    const { client } = makeClient();
    const seen: unknown[] = [];
    client.on("session/update", (p) => seen.push(p));
    client.connect();
    const ws = FakeWebSocket.last();
    ws.open();
    ws.deliverRaw("{ 这不是 JSON");
    ws.deliver({ jsonrpc: "2.0", method: "session/update", params: { ok: true } });
    expect(seen).toEqual([{ ok: true }]);
  });
});

describe("断线与重连", () => {
  it("断开时挂起的请求全部当场失败，不无限等", async () => {
    const { client } = makeClient();
    client.connect();
    const ws = FakeWebSocket.last();
    ws.open();
    const prompt = client.call("session/prompt");
    expect(client.pendingCount).toBe(1);

    ws.drop();

    await expect(prompt).rejects.toThrow(/session\/prompt 未完成/);
    expect(client.pendingCount).toBe(0);
  });

  it("连着连不上时退避指数增长并封顶，每次都真的重开一条连接", () => {
    const { client, clock } = makeClient();
    const states: ConnectionState[] = [];
    client.onStateChange((s) => states.push({ ...s }));
    client.connect();
    expect(FakeWebSocket.instances).toHaveLength(1);

    const delays: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const before = clock.now();
      FakeWebSocket.last().drop(); // 一次都没 open 成功
      const retryAt = client.getState().retryAt!;
      delays.push(retryAt - before);
      clock.advance(retryAt - before);
    }

    expect(delays).toEqual([500, 1000, 2000, 4000, 4000]); // backoffMax = 4000
    expect(FakeWebSocket.instances).toHaveLength(6);
    expect(states.some((s) => s.phase === "reconnecting")).toBe(true);
    client.close();
  });

  it("每次成功连上都把退避重新从最短开始，不带着上一次的账", () => {
    const { client, clock } = makeClient();
    client.connect();
    const delays: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      FakeWebSocket.last().open();
      const before = clock.now();
      FakeWebSocket.last().drop();
      const retryAt = client.getState().retryAt!;
      delays.push(retryAt - before);
      clock.advance(retryAt - before);
    }
    expect(delays).toEqual([500, 500, 500]);
    client.close();
  });

  it("连上之后 attempt 归零、错误清掉", () => {
    const { client, clock } = makeClient();
    client.connect();
    FakeWebSocket.last().open();
    FakeWebSocket.last().drop(1006, "boom");

    expect(client.getState().phase).toBe("reconnecting");
    expect(client.getState().attempt).toBe(1);
    expect(client.getState().lastError).toMatch(/1006/);

    clock.advance(500);
    FakeWebSocket.last().open();

    expect(client.getState()).toMatchObject({ phase: "open", attempt: 0, lastError: null });
  });

  it("主动 close 之后不再重连", () => {
    const { client, clock } = makeClient();
    client.connect();
    FakeWebSocket.last().open();
    client.close();

    expect(client.getState().phase).toBe("closed");
    const count = FakeWebSocket.instances.length;
    clock.advance(60_000);
    expect(FakeWebSocket.instances).toHaveLength(count);
  });

  it("旧连接掉线后发来的帧不会污染新连接", async () => {
    const { client, clock } = makeClient();
    client.connect();
    const first = FakeWebSocket.last();
    first.open();
    const seen: unknown[] = [];
    client.on("session/update", (p) => seen.push(p));

    first.drop();
    clock.advance(500);
    const second = FakeWebSocket.last();
    second.open();
    expect(second).not.toBe(first);

    first.deliver({ jsonrpc: "2.0", method: "session/update", params: "来自已死的连接" });
    second.deliver({ jsonrpc: "2.0", method: "session/update", params: "来自新连接" });

    expect(seen).toEqual(["来自新连接"]);
  });

  it("构造 WebSocket 就抛（比如地址非法）也走重连路径，不炸掉调用方", () => {
    const clock = new FakeClock();
    const Broken = vi.fn(() => {
      throw new Error("拨号失败");
    });
    const client = new RpcClient({
      url: "ws://127.0.0.1:1",
      WebSocketCtor: Broken as unknown as typeof WebSocket,
      backoffBaseMs: 100,
      setTimeoutFn: clock.setTimeout,
      clearTimeoutFn: clock.clearTimeout,
      now: clock.now,
    });
    expect(() => client.connect()).not.toThrow();
    expect(client.getState().phase).toBe("reconnecting");
    expect(client.getState().lastError).toBe("拨号失败");
    clock.advance(100);
    expect(Broken).toHaveBeenCalledTimes(2);
    client.close();
  });
});

describe("sessionRef 拆分", () => {
  it("`#` 之后原样是 agent 自己的 id，含连字符也不动", () => {
    expect(splitRef("zcode#zc-sess_47f2f33a-dc34")).toEqual({
      agentId: "zcode",
      sessionId: "zc-sess_47f2f33a-dc34",
    });
  });

  it("没有 `#` 时不瞎拆", () => {
    expect(splitRef("zcode")).toEqual({ agentId: "zcode", sessionId: "" });
  });
});

describe("close 之后还能再连", () => {
  it("StrictMode 的 mount→cleanup→mount 不会把客户端永久停在 closed", () => {
    const { client } = makeClient();
    client.connect();
    FakeWebSocket.last().open();
    client.close();
    expect(client.getState().phase).toBe("closed");

    client.connect();
    FakeWebSocket.last().open();
    expect(client.getState().phase).toBe("open");
    client.close();
  });
});
