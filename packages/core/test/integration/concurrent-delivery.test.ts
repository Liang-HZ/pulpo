import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PulpoDaemon } from "../../src/server/daemon.js";
import { RpcClient, haveZcode, makeTestEnv, startDaemon, waitFor, type TestEnv } from "../helpers.js";

/**
 * 回合进行中投递（档 3，真实 ZCode 引擎）。
 *
 * adapter 0.7.0 的 descriptor 起点是档 2（`_session/steering` 真实现），
 * 所以这条用例**显式把档位往保守方向压**到并发档——per-request 的压档是
 * 协议允许的方向（只能更弱，不能更强）。它回答的是"并发 prompt 在真目标上
 * 到底发生了什么"：回执不能靠壳猜，得跟实际行为对得上。
 */
describe.runIf(haveZcode())("回合进行中投递（真实 ZCode 引擎）", () => {
  let t: TestEnv;
  let daemon: PulpoDaemon;
  let c: RpcClient;
  let sessionRef: string;
  const updates: any[] = [];

  beforeAll(async () => {
    t = makeTestEnv("concurrent");
    daemon = await startDaemon(t);
    c = await RpcClient.unix(daemon.socketPath!);
    await c.call("subscribe", { topics: ["session/update"] });
    c.onNotification((m) => {
      if (m.method === "session/update") updates.push(m.params);
    });
    const res = await c.call("session/new", { agentId: "zcode", cwd: t.ws });
    sessionRef = res.sessionRef;
  });

  afterAll(async () => {
    c?.close();
    await daemon?.stop();
    t?.cleanup();
  });

  it("回合进行中时 turnActive 为真，投递据此裁决", async () => {
    const turn = c.call("session/prompt", {
      sessionRef,
      // 够长，让我们有时间在回合中途投递；又不至于烧太多额度。
      text: "从 1 数到 60，每个数字单独一行，不要调用任何工具，不要解释。",
    });

    // 等到真的开始流了再投——这样 turnActive 一定是真的
    await waitFor(
      () => updates.some((u) => u.sessionRef === sessionRef && u.update?.sessionUpdate === "agent_message_chunk"),
      { what: "回合开始流式输出", timeoutMs: 180_000 },
    );
    const open = await c.call("session/open");
    const me = open.find((s: any) => s.sessionRef === sessionRef);
    expect(me.turnActive).toBe(true);

    const receipt = await c.call("delivery/send", {
      sessionRef,
      text: "补充：数完之后回一句 补充已收到。",
      delivery: { tier: "concurrent" },
    });

    // 请求方把档位压到了并发档；回合确实在跑，所以是 injected 而不是 no_active_turn。
    expect(receipt.requestedTier).toBe("concurrent");
    expect(receipt.tier).toBe("concurrent");
    expect(receipt.turnActive).toBe(true);
    expect(receipt.outcome).toBe("injected");
    expect(receipt.attempts.at(-1)).toMatchObject({ tier: "concurrent", status: "ok" });

    const res = await turn;
    expect(res.stopReason).toBe("end_turn");
  });

  it("档 3 的 injected = 已投给目标，由目标按自己的规矩并入（实测：ZCode 顺序执行）", async () => {
    // ZCode 引擎原生拒绝并发 send，adapter 因此把并发 prompt 串行化——
    // 补充消息不会丢，但它是在**当前回合结束后**才被执行的。
    // 这就是档 3 的真实语义："并发投出 / 下一个安全边界注入"，
    // 而不是"已经并进了当前这一步"。档 2（真 steering）才是步内注入。
    await waitFor(
      () => {
        const text = updates
          .filter((u) => u.sessionRef === sessionRef && u.update?.sessionUpdate === "agent_message_chunk")
          .map((u) => u.update.content?.text ?? "")
          .join("");
        return text.includes("补充已收到");
      },
      { what: "补充消息被目标执行", timeoutMs: 240_000 },
    );

    // 会话图上如实记着这条补充边
    const { edges } = await c.call("graph/edges", { kind: "supplement", to: sessionRef });
    expect(edges.at(-1)).toMatchObject({ tier: "concurrent", outcome: "injected" });
  });
});
