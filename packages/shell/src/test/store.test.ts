import { beforeEach, describe, expect, it } from "vitest";
import type { AgentSessionInfo, OpenSession, ReadSessionSummary } from "../lib/protocol";
import { AppStore, dedupe, mergeDirectory, sameSession } from "../lib/store";
import { FakeWebSocket } from "./fake-websocket";

describe("两套 id 的对齐", () => {
  it("ACP 面带 adapter 前缀，读取层是原生 id，按后缀对上", () => {
    expect(sameSession("zc-sess_abc", "sess_abc")).toBe(true);
    expect(sameSession("sess_abc", "sess_abc")).toBe(true);
    expect(sameSession("zc-sess_abc", "sess_xyz")).toBe(false);
  });
});

describe("会话列表的并集", () => {
  const acp: AgentSessionInfo[] = [
    { sessionId: "zc-sess_1", cwd: "/w", title: "新的", updatedAt: "2026-09-16T08:31:40Z" },
  ];
  const native: ReadSessionSummary[] = [
    {
      sessionRef: "zcode#sess_1",
      agentId: "zcode",
      sessionId: "sess_1",
      title: "新的",
      cwd: "/w",
      updatedAt: 1_789_547_500_972,
    },
    {
      sessionRef: "zcode#sess_old",
      agentId: "zcode",
      sessionId: "sess_old",
      title: "只在读取层有",
      cwd: "/w",
      updatedAt: 1_000,
    },
  ];
  const open: OpenSession[] = [
    {
      sessionRef: "zcode#zc-sess_1",
      agentId: "zcode",
      sessionId: "zc-sess_1",
      cwd: "/w",
      turnActive: false,
      createdAt: 1,
    },
  ];

  it("同一条会话只出现一次，两边的 id 都带着", () => {
    const rows = mergeDirectory("zcode", "/w", acp, native, open);
    expect(rows).toHaveLength(2);
    const merged = rows.find((r) => r.acpSessionId === "zc-sess_1")!;
    expect(merged.nativeSessionId).toBe("sess_1");
    expect(merged.live).toBe(true);
  });

  it("只在读取层有的历史会话也列出来，但标成没有可 resume 的 ACP id", () => {
    const rows = mergeDirectory("zcode", "/w", acp, native, open);
    const readOnly = rows.find((r) => r.nativeSessionId === "sess_old")!;
    expect(readOnly.acpSessionId).toBeNull();
    expect(readOnly.live).toBe(false);
  });

  it("按更新时间倒序，最近的在最上面", () => {
    const rows = mergeDirectory("zcode", "/w", acp, native, open);
    expect(rows.map((r) => r.title)).toEqual(["新的", "只在读取层有"]);
  });

  it("读取层没给时间时退回 session/list 的 ISO 串", () => {
    const rows = mergeDirectory("zcode", "/w", acp, [], []);
    expect(rows[0]?.updatedAt).toBe(Date.parse("2026-09-16T08:31:40Z"));
  });

  it("两边都空时是空列表，不是报错", () => {
    expect(mergeDirectory("zcode", "/w", [], [], [])).toEqual([]);
  });

  it("在册但两个列表都还没收录的会话照样列出来（刚建的会话不会从侧栏消失）", () => {
    const open: OpenSession[] = [
      {
        sessionRef: "zcode#zc-sess_new",
        agentId: "zcode",
        sessionId: "zc-sess_new",
        cwd: "/w",
        turnActive: true,
        createdAt: 1_789_600_000_000,
      },
      // 别的目录 / 别的渠道的在册会话不许串进来
      { sessionRef: "zcode#zc-sess_other", agentId: "zcode", sessionId: "zc-sess_other", cwd: "/other", turnActive: false, createdAt: 1 },
      { sessionRef: "claude#x", agentId: "claude", sessionId: "x", cwd: "/w", turnActive: false, createdAt: 1 },
    ];
    const rows = mergeDirectory("zcode", "/w", [], [], open);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      acpSessionId: "zc-sess_new",
      nativeSessionId: null,
      live: true,
    });
  });

  it("同一条会话不会因为同时在册又被读取层列出来而出现两次", () => {
    const open: OpenSession[] = [
      {
        sessionRef: "zcode#zc-sess_1",
        agentId: "zcode",
        sessionId: "zc-sess_1",
        cwd: "/w",
        turnActive: false,
        createdAt: 2,
      },
    ];
    const native: ReadSessionSummary[] = [
      { sessionRef: "zcode#sess_1", agentId: "zcode", sessionId: "sess_1", title: "已定名", cwd: "/w" },
    ];
    const rows = mergeDirectory("zcode", "/w", [], native, open);
    expect(rows).toHaveLength(1);
  });
});

describe("dedupe", () => {
  it("保序去重并滤掉空串", () => {
    expect(dedupe(["/a", "", "/b", "/a"])).toEqual(["/a", "/b"]);
  });
});

describe("store 与 core 的往来", () => {
  beforeEach(() => {
    FakeWebSocket.reset();
    globalThis.localStorage = {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
      clear: () => undefined,
      key: () => null,
      length: 0,
    } as unknown as Storage;
  });

  function boot() {
    const store = new AppStore(
      "ws://127.0.0.1:0",
      FakeWebSocket as unknown as typeof WebSocket,
    );
    store.start();
    const ws = FakeWebSocket.last();
    ws.open();
    return { store, ws };
  }

  it("一连上就订阅——订阅是每连接独立的，重连后必须重来一遍", async () => {
    const { store, ws } = boot();
    await Promise.resolve();
    expect(ws.request(0).method).toBe("subscribe");

    ws.drop();
    await Promise.resolve();
    // 重连由退避定时器驱动，这里直接再 start 一次模拟重连成功
    store.start();
    const next = FakeWebSocket.last();
    next.open();
    await Promise.resolve();
    expect(next.request(0).method).toBe("subscribe");
    store.stop();
  });

  it("session/update 可以先于 session/new 的应答到达，照样建槽收流（flush 之后）", () => {
    const { store, ws } = boot();
    ws.deliver({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionRef: "zcode#zc-sess_未登记",
        agentId: "zcode",
        sessionId: "zc-sess_未登记",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "先到了" } },
      },
    });
    // chunk 走 16ms 的节流队列，所以还没进 state
    expect(store.getSnapshot().chats["zcode#zc-sess_未登记"]).toBeUndefined();
    store.flushUpdates();
    const chat = store.getSnapshot().chats["zcode#zc-sess_未登记"];
    expect(chat?.items[0]).toMatchObject({ kind: "assistant", text: "先到了" });
    store.stop();
  });

  it("task/update 按 taskId 就地更新，不堆重复条目", () => {
    const { store, ws } = boot();
    const record = {
      taskId: "t1",
      agentId: "zcode",
      sessionRef: "zcode#c",
      parentRef: null,
      task: "干活",
      cwd: "/w",
      createdAt: 1,
      updatedAt: 1,
    };
    ws.deliver({ jsonrpc: "2.0", method: "task/update", params: { ...record, status: "running" } });
    ws.deliver({
      jsonrpc: "2.0",
      method: "task/update",
      params: { ...record, status: "done", summary: "完事", updatedAt: 2 },
    });
    const tasks = store.getSnapshot().tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ status: "done", summary: "完事" });
    store.stop();
  });

  it("permission/requested 变成一张待审批卡片，带上选项与超时时刻", () => {
    const { store, ws } = boot();
    ws.deliver({
      jsonrpc: "2.0",
      method: "permission/requested",
      params: {
        requestId: "r1",
        sessionRef: "zcode#a",
        agentId: "zcode",
        request: { toolCall: { title: "Write: note.txt", rawInput: { path: "note.txt" } } },
        options: [
          { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject_once", name: "Reject", kind: "reject_once" },
        ],
        createdAt: 10,
        expiresAt: 310,
      },
    });
    const approval = store.getSnapshot().approvals[0]!;
    expect(approval).toMatchObject({
      type: "permission",
      requestId: "r1",
      title: "Write: note.txt",
      expiresAt: 310,
    });
    expect(approval.options).toHaveLength(2);
    store.stop();
  });

  it("permission/pending 里的追问条目渲染成追问卡，不是一张没有按钮的审批卡", async () => {
    const { store, ws } = boot();
    const tick = () => new Promise((r) => setTimeout(r, 0));
    // 走完 boot 握手：subscribe → core/info → agent/list，之后才是 permission/pending
    for (const [method, result] of [
      ["subscribe", { subscribed: [] }],
      ["core/info", { name: "@liangai/pulpo-core", version: "0.1.0" }],
      ["agent/list", []],
    ] as const) {
      await tick();
      const call = ws.requests().find((r) => r.method === method);
      expect(call?.id, `${method} 没发出来`).toBeDefined();
      ws.deliver({ jsonrpc: "2.0", id: call!.id, result });
    }
    await tick();
    const pendingCall = ws.requests().find((r) => r.method === "permission/pending");
    expect(pendingCall?.id).toBeDefined();
    ws.deliver({
      jsonrpc: "2.0",
      id: pendingCall!.id,
      result: {
        pending: [
          {
            requestId: "r1",
            sessionRef: "zcode#a",
            agentId: "zcode",
            options: [{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
            request: { toolCall: { title: "Write: a.txt" } },
          },
          {
            requestId: "q1",
            sessionRef: "zcode#a",
            agentId: "zcode",
            kind: "elicitation",
            params: {
              message: "选个颜色",
              requestedSchema: {
                properties: { color: { type: "string", title: "颜色" } },
                required: ["color"],
              },
            },
          },
        ],
      },
    });
    await tick();
    const approvals = store.getSnapshot().approvals;
    expect(approvals.find((a) => a.type === "permission")?.requestId).toBe("r1");
    const elicitation = approvals.find((a) => a.type === "elicitation");
    expect(elicitation).toMatchObject({ requestId: "q1", message: "选个颜色" });
    expect(elicitation?.fields).toEqual([{ name: "color", title: "颜色", required: true }]);
    store.stop();
  });

  it("agent/exit 挂出横幅，不静默", () => {
    const { store, ws } = boot();
    ws.deliver({
      jsonrpc: "2.0",
      method: "agent/exit",
      params: { agentId: "zcode", code: 1, signal: null },
    });
    expect(store.getSnapshot().banner?.text).toContain("zcode 进程已退出");
    store.stop();
  });

  it("连接断开时横幅如实写出原因", () => {
    const { store, ws } = boot();
    ws.drop(1006, "boom");
    const state = store.getSnapshot();
    expect(state.connection.phase).toBe("reconnecting");
    expect(state.banner?.tone).toBe("bad");
    expect(state.banner?.text).toContain("1006");
    store.stop();
  });

  it("回合进行中发消息走 delivery/send，空闲时走 session/prompt", async () => {
    const { store, ws } = boot();
    const ref = "zcode#a";
    ws.sent.length = 0;

    void store.send(ref, "空闲时这一句");
    await Promise.resolve();
    expect(ws.request(0).method).toBe("session/prompt");

    // session/prompt 的应答回来之前 turnActive 是 true，这时再发就是补充消息
    void store.send(ref, "回合里这一句");
    await Promise.resolve();
    expect(ws.request(1).method).toBe("delivery/send");
    store.stop();
  });

  it("分页读穿：先拉最后 50 条，第二页把上一页的 cursor 当 before 发出去", async () => {
    const { store, ws } = boot();
    const tick = () => new Promise((r) => setTimeout(r, 0));
    ws.sent.length = 0;
    // 先把两边的列表对上：nativeIds 有了之后，读穿才有可能直接打 read/transcript
    const dir = store.refreshDirectory("zcode", "/w");
    await tick();
    ws.deliver({
      jsonrpc: "2.0",
      id: ws.request(0).id,
      result: { sessions: [{ sessionId: "zc-sess_a", cwd: "/w" }] },
    });
    ws.deliver({
      jsonrpc: "2.0",
      id: ws.request(1).id,
      result: {
        sessions: [{ sessionRef: "zcode#sess_a", agentId: "zcode", sessionId: "sess_a", cwd: "/w" }],
      },
    });
    await dir;
    ws.sent.length = 0;

    void store.loadTranscript("zcode#zc-sess_a", "/w");
    await tick();
    const first = ws.request(0);
    expect(first.method).toBe("read/transcript");
    expect(first.params).toMatchObject({ agentId: "zcode", sessionId: "sess_a", limit: 50 });
    expect(first.params).not.toHaveProperty("before");

    ws.deliver({
      jsonrpc: "2.0",
      id: first.id,
      result: { messages: [], hasMore: true, cursor: "msg_17" },
    });
    await tick();

    void store.loadTranscript("zcode#zc-sess_a", "/w", "msg_17");
    await tick();
    expect(ws.request(1).params).toMatchObject({ before: "msg_17", limit: 50 });
    store.stop();
  });

  it("原生 id 还不知道时先拉列表对出来，不把 ACP id 直接喂给读取层", async () => {
    const { store, ws } = boot();
    const tick = () => new Promise((r) => setTimeout(r, 0));
    ws.sent.length = 0;
    const done = store.loadTranscript("zcode#zc-sess_a", "/w");
    await tick();
    // 先补列表（session/list + read/list），再读穿
    expect(ws.requests().map((r) => r.method)).toEqual(["session/list", "read/list"]);
    ws.deliver({
      jsonrpc: "2.0",
      id: ws.request(0).id,
      result: { sessions: [{ sessionId: "zc-sess_a", cwd: "/w", title: "会话" }] },
    });
    ws.deliver({
      jsonrpc: "2.0",
      id: ws.request(1).id,
      result: {
        sessions: [
          { sessionRef: "zcode#sess_a", agentId: "zcode", sessionId: "sess_a", cwd: "/w" },
        ],
      },
    });
    await tick();
    const read = ws.requests().find((r) => r.method === "read/transcript");
    expect(read?.params).toMatchObject({ sessionId: "sess_a" });
    ws.deliver({ jsonrpc: "2.0", id: read!.id, result: { messages: [] } });
    await done;
    store.stop();
  });

  it("审查调 session/changes 时带 turnId 与 includeDiff（PROTOCOL §4.12）", async () => {
    const { store, ws } = boot();
    ws.sent.length = 0;
    void store.loadChanges("zcode#a", "turn-1", true);
    await Promise.resolve();
    expect(ws.request(0).method).toBe("session/changes");
    expect(ws.request(0).params).toEqual({
      sessionRef: "zcode#a",
      turnId: "turn-1",
      includeDiff: true,
    });
    store.stop();
  });
});
