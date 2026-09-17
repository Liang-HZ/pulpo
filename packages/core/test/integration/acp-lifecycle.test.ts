import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PulpoDaemon } from "../../src/server/daemon.js";
import { RpcClient, haveZcode, makeTestEnv, startDaemon, waitFor, type TestEnv } from "../helpers.js";

/**
 * 真实 ZCode 引擎全链路（不 mock）：
 * spawn → initialize → session/new → 一轮短 prompt 流式收齐 → list → close。
 *
 * 模型用 `~/.zcode/cli/config.json` 的默认值（不写死通道）；渠道额度
 * （如 Coding Plan）按滚动窗口计量，所以 prompt 只有一句、要求只回两个字。
 */
describe.runIf(haveZcode())("ACP 全链路（真实 ZCode 引擎）", () => {
  let t: TestEnv;
  let daemon: PulpoDaemon;
  let c: RpcClient;
  let sessionRef: string;
  let descriptor: any;
  const updates: any[] = [];

  beforeAll(async () => {
    t = makeTestEnv("lifecycle");
    daemon = await startDaemon(t);
    c = await RpcClient.unix(daemon.socketPath!);
    await c.call("subscribe", { topics: ["session/update"] });
    c.onNotification((m) => {
      if (m.method === "session/update") updates.push(m.params);
    });
  });

  afterAll(async () => {
    c?.close();
    await daemon?.stop();
    t?.cleanup();
  });

  it("session/new：握手 + 自描述聚合成 descriptor", async () => {
    const res = await c.call("session/new", { agentId: "zcode", cwd: t.ws });
    sessionRef = res.sessionRef;
    descriptor = res.descriptor;
    expect(sessionRef).toMatch(/^zcode#/);
    expect(res.cwd).toBe(t.ws);

    // 协议自描述
    expect(descriptor.protocolVersion).toBe(1);
    expect(descriptor.sessions).toMatchObject({
      list: true,
      resume: true,
      fork: true,
      close: true,
    });
    // 模型与思考强度来自 agent 自己的 configOptions，不是壳硬编码
    expect(descriptor.models.length).toBeGreaterThan(0);
    expect(descriptor.currentModelId).toBeTruthy();
    expect(descriptor.efforts.length).toBeGreaterThan(0);
    expect(descriptor.currentEffort).toBeTruthy();
    // 当前模型必须在自报的可选项里
    expect(descriptor.models.map((m: any) => m.id)).toContain(descriptor.currentModelId);
    // initialize 原文留底
    expect(descriptor.raw.initialize).toBeTruthy();
    // 除了"补模式危险等级"（agent 没自报，覆盖表按实测证据补）之外，
    // 没有任何实测收紧——steering 完全采信 agent 自述。
    const nonRisk = descriptor.corrections.filter((c: any) => !c.path.includes("].risk"));
    expect(nonRisk).toEqual([]);
    expect(descriptor.modes.map((m: any) => m.risk)).not.toContain(undefined);
  });

  it("descriptor 里的模型 id 原样保留 agent 的写法（不重命名、不映射）", () => {
    // 实测 ZCode 的 modelId 形如 `<渠道名>/<模型名>`，含中文渠道名。
    for (const m of descriptor.models) {
      expect(m.id).toContain("/");
      expect(typeof m.label).toBe("string");
    }
  });

  it("agent/descriptor 回的是同一份聚合结果", async () => {
    const d = await c.call("agent/descriptor", { agentId: "zcode", sessionRef });
    expect(d.agentId).toBe("zcode");
    expect(d.currentModelId).toBe(descriptor.currentModelId);
  });

  it("一轮短 prompt：流式 chunk 收齐，回合以 end_turn 收尾", async () => {
    const before = updates.length;
    const res = await c.call("session/prompt", {
      sessionRef,
      text: "只回复两个字：收到。不要调用任何工具。",
    });
    expect(res.stopReason).toBe("end_turn");

    const mine = updates.slice(before).filter((u) => u.sessionRef === sessionRef);
    expect(mine.length).toBeGreaterThan(0);
    const text = mine
      .filter((u) => u.update?.sessionUpdate === "agent_message_chunk")
      .map((u) => u.update.content?.text ?? "")
      .join("");
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("收到");
  });

  it("投递阶梯对上真实目标：档 2 扩展可用，空闲时如实回 no_active_turn", async () => {
    const receipt = await c.call("delivery/send", { sessionRef, text: "补充一句" });
    // adapter 0.7.0 真实现了 `_session/steering`，所以起点档就是它，且不降级。
    expect(receipt.requestedTier).toBe("extension");
    expect(receipt.tier).toBe("extension");
    expect(receipt.attempts).toEqual([{ tier: "extension", status: "ok" }]);
    // 回合已结束 → 目标自己回 promptRequired/noRunningTurn，壳如实映射
    expect(receipt.outcome).toBe("no_active_turn");
    expect(receipt.raw).toMatchObject({ outcome: "promptRequired", reason: "noRunningTurn" });

    // 目标的自述经得起实测 → 修正层没有任何收紧
    const d = await c.call("agent/descriptor", { agentId: "zcode", sessionRef });
    expect(d.delivery.steering.tier).toBe("extension");
    expect(d.delivery.steering.supported).toBe(true);
    expect(d.delivery.steering.method).toBe("_session/steering");
    expect(d.delivery.steering.boundary).toBe("step");
    expect(d.delivery.steering.idle).toBe("promptRequired");
    // steering 这一族一条收紧都没有（模式危险等级那几条与投递无关）
    expect(d.corrections.filter((c: any) => c.path.startsWith("delivery."))).toEqual([]);
  });

  it("回合进行中投递：档 2 步内注入，回执 injected", async () => {
    const before = updates.length;
    const turn = c.call("session/prompt", {
      sessionRef,
      text: "从 1 数到 40，每个数字单独一行，不要调用任何工具，不要解释。",
    });
    await waitFor(
      () =>
        updates
          .slice(before)
          .some(
            (u) =>
              u.sessionRef === sessionRef && u.update?.sessionUpdate === "agent_message_chunk",
          ),
      { what: "回合开始流式输出", timeoutMs: 180_000 },
    );

    const receipt = await c.call("delivery/send", {
      sessionRef,
      text: "补充：数完之后回一句 补充已收到。",
    });
    expect(receipt.turnActive).toBe(true);
    expect(receipt.tier).toBe("extension");
    expect(receipt.outcome).toBe("injected");
    expect(receipt.attempts).toEqual([{ tier: "extension", status: "ok" }]);

    const res = await turn;
    expect(res.stopReason).toBe("end_turn");
    // 步内注入的证据：补充内容在**同一个回合**里被执行
    const text = updates
      .slice(before)
      .filter(
        (u) => u.sessionRef === sessionRef && u.update?.sessionUpdate === "agent_message_chunk",
      )
      .map((u) => u.update.content?.text ?? "")
      .join("");
    expect(text).toContain("补充已收到");
  });

  it("补充消息在会话图上留下一条 supplement 边，回执原样记账", async () => {
    const { edges } = await c.call("graph/edges", { kind: "supplement", to: sessionRef });
    expect(edges.length).toBe(2);
    expect(edges[0]).toMatchObject({ outcome: "no_active_turn", tier: "extension" });
    expect(edges[1]).toMatchObject({ outcome: "injected", tier: "extension" });
  });

  it("session/list：刚跑过的会话在 agent 原生列表里能看到", async () => {
    const { sessions } = await c.call("session/list", { agentId: "zcode", cwd: t.ws });
    expect(Array.isArray(sessions)).toBe(true);
    const ids = sessions.map((s: any) => s.sessionId);
    expect(ids).toContain(sessionRef.slice("zcode#".length));
  });

  it("读取层读穿：会话与刚才那轮内容都能从原生存储读回来", async () => {
    const list = await c.call("read/list", { agentId: "zcode", cwd: t.ws });
    const bare = sessionRef.slice("zcode#".length).replace(/^zc-/, "");
    expect(list.sessions.map((s: any) => s.sessionId)).toContain(bare);

    const tr = await c.call("read/transcript", { agentId: "zcode", sessionId: bare, cwd: t.ws });
    expect(tr.readBy).toBe("zcode");
    expect(tr.messages.length).toBeGreaterThan(0);
    const roles = tr.messages.map((m: any) => m.role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
    // 统一消息模型：每个片段都有 kind，且原生片段原文留在 raw 里
    for (const m of tr.messages) {
      for (const p of m.parts) {
        expect(typeof p.kind).toBe("string");
        expect(p.raw).toBeTruthy();
      }
    }
    const answer = tr.messages
      .filter((m: any) => m.role === "assistant")
      .flatMap((m: any) => m.parts)
      .filter((p: any) => p.kind === "text")
      .map((p: any) => p.text)
      .join("");
    expect(answer).toContain("收到");
  });

  it("读取层是只读的：接口上没有任何写方法", async () => {
    const { ZcodeReader } = await import("../../src/read/zcode.js");
    const reader = new ZcodeReader({ cwd: t.ws, env: t.env });
    const names = [
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(reader)),
      ...Object.keys(reader),
    ];
    expect(names).toEqual(
      expect.arrayContaining(["list", "read", "dispose"]),
    );
    expect(names.filter((n) => /write|save|delete|update|create/i.test(n))).toEqual([]);
    await reader.dispose();
  });

  it("session/fork：目标拒绝时如实透出它的原话，不伪造成功", async () => {
    // ZCode 的 session/fork 是**工作区检查点分叉**（引擎里的
    // `forkWorkspaceFromCheckpoint`）。检查点只在会话里真的发生过文件编辑
    // （Edit/Write 这类带 structuredPatch 的工具结果）之后才有。本条会话只
    // 跑了一句不调工具的 prompt，所以没有检查点 —— 实测引擎回
    // `-32603 No workspace checkpoint is available yet.`（code
    // INVALID_STATE_TRANSITION）。
    //
    // 我们要的就是这个：壳把目标的拒绝原样透出来，不吞、不改写、不假装成功。
    // 有检查点时 fork 确实能成，见 permission.test.ts 里写过文件之后的那条。
    const res = await c.raw("session/fork", { sessionRef });
    expect(res.error).toBeTruthy();
    expect(res.result).toBeUndefined();
    expect(res.error.message).toMatch(/fork/i);
  });

  it("session/close：关掉后 agent 子进程收掉，会话不再在册", async () => {
    const openBefore = await c.call("session/open");
    expect(openBefore.map((s: any) => s.sessionRef)).toContain(sessionRef);
    await c.call("session/close", { sessionRef });
    const openAfter = await c.call("session/open");
    expect(openAfter.map((s: any) => s.sessionRef)).not.toContain(sessionRef);
    // 关掉之后再操作它，明确报 NotFound，不是静默成功
    const res = await c.raw("session/prompt", { sessionRef, text: "x" });
    expect(res.error.code).toBe(-32001);
  });
});
