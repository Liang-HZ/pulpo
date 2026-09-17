import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PulpoDaemon } from "../../src/server/daemon.js";
import { RpcClient, haveZcode, makeTestEnv, startDaemon, waitFor, type TestEnv } from "../helpers.js";

/**
 * 派活 broker（真实 ZCode 引擎）：
 * delegate（带 model + effort）→ 订阅任务状态 → getTask 到 done →
 * 会话图上有 delegate / result 边 → 被派活会话再派活被熔断。
 */
describe.runIf(haveZcode())("派活 broker（真实 ZCode 引擎）", () => {
  let t: TestEnv;
  let daemon: PulpoDaemon;
  let c: RpcClient;
  let taskId: string;
  let childRef: string;
  let modelId: string;
  const parentRef = "zcode#pretend-parent-session";
  const taskEvents: any[] = [];

  beforeAll(async () => {
    t = makeTestEnv("delegate");
    daemon = await startDaemon(t);
    c = await RpcClient.unix(daemon.socketPath!);
    await c.call("subscribe", { topics: ["task/update"] });
    c.onNotification((m) => {
      if (m.method === "task/update") taskEvents.push(m.params);
    });
    // 派活方节点：让它成为一条真实存在的根会话节点。
    daemon.graph.upsertNode({
      id: parentRef,
      kind: "root",
      agentId: "zcode",
      sessionId: "pretend-parent-session",
      cwd: t.ws,
    });
    daemon.graph.save();
    // 拿到 agent 自报的模型与 effort 档位（不写死通道）。
    const probe = await c.call("session/new", { agentId: "zcode", cwd: t.ws });
    modelId = probe.descriptor.currentModelId;
    expect(probe.descriptor.efforts).toContain("low");
    await c.call("session/close", { sessionRef: probe.sessionRef });
  });

  afterAll(async () => {
    c?.close();
    await daemon?.stop();
    t?.cleanup();
  });

  it("派活时带模型 ID 与思考强度，回执带目标的能力契约", async () => {
    const res = await c.call("task/delegate", {
      agentId: "zcode",
      task: "只回复两个字：完成。不要调用任何工具。",
      cwd: t.ws,
      modelId,
      effort: "low",
      callerRef: parentRef,
    });
    taskId = res.taskId;
    childRef = res.sessionRef;
    expect(taskId).toBeTruthy();
    expect(childRef).toMatch(/^zcode#/);
    // capabilityRef = 目标会话的 descriptor
    expect(res.capabilityRef.agentId).toBe("zcode");
    expect(res.capabilityRef.currentModelId).toBe(modelId);
    expect(res.capabilityRef.currentEffort).toBe("low");
  });

  it("agent 不认识的模型 / effort 当场拒绝，不静默回落默认值", async () => {
    const badModel = await c.raw("task/delegate", {
      agentId: "zcode",
      task: "x",
      cwd: t.ws,
      modelId: "根本不存在/瞎编的模型",
      callerRef: parentRef,
    });
    expect(badModel.error.code).toBe(-32602);
    expect(badModel.error.message).toMatch(/不认识模型/);

    const badEffort = await c.raw("task/delegate", {
      agentId: "zcode",
      task: "x",
      cwd: t.ws,
      effort: "宇宙级",
      callerRef: parentRef,
    });
    expect(badEffort.error.code).toBe(-32602);
    expect(badEffort.error.message).toMatch(/不认识思考强度/);
  });

  it("任务状态推到订阅方，最终 getTask 到 done 并带结论", async () => {
    await waitFor(
      async () => (await c.call("task/get", { taskId })).status === "done",
      { what: "任务跑完", timeoutMs: 240_000 },
    );
    const task = await c.call("task/get", { taskId });
    expect(task.status).toBe("done");
    expect(task.stopReason).toBe("end_turn");
    expect(task.summary).toContain("完成");
    expect(task.modelId).toBe(modelId);
    expect(task.effort).toBe("low");
    expect(task.parentRef).toBe(parentRef);
    expect(task.sessionRef).toBe(childRef);

    // 订阅通道也收到了同一串状态
    const mine = taskEvents.filter((e) => e.taskId === taskId);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.at(-1).status).toBe("done");
  });

  it("任务登记只存结论与 native session 位置，不存转录", async () => {
    const task = await c.call("task/get", { taskId });
    expect(task).not.toHaveProperty("messages");
    expect(task).not.toHaveProperty("transcript");
    const required = [
      "agentId", "caller", "createdAt", "cwd", "effort", "modelId", "originRef",
      "parentRef", "sessionRef", "status", "stopReason", "summary", "task", "taskId",
      "updatedAt",
    ];
    const keys = Object.keys(task).sort();
    // 必有的都在；多出来的只可能是 usage（agent 没报用量时整块省略）
    for (const k of required) expect(keys).toContain(k);
    expect(keys.filter((k) => !required.includes(k))).toEqual(
      task.usage === undefined ? [] : ["usage"],
    );
    // usage 里只有真拿到的数字，没有 0 占位
    for (const v of Object.values(task.usage ?? {})) expect(v).toBeGreaterThan(0);
    expect(task.caller).toBe("agent");
    expect(task.originRef).toBe(parentRef);
  });

  it("会话图上留下 delegate 边（含 model/effort）与 result 边（只报位置）", async () => {
    const del = await c.call("graph/edges", { kind: "delegate", taskId });
    expect(del.edges).toHaveLength(1);
    expect(del.edges[0]).toMatchObject({
      from: parentRef,
      to: childRef,
      taskId,
      modelId,
      effort: "low",
    });
    const result = await c.call("graph/edges", { kind: "result", taskId });
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toMatchObject({
      from: childRef,
      to: parentRef,
      status: "done",
      nativeSessionRef: childRef,
    });
  });

  it("轨迹树从派活方展开能看到子会话", async () => {
    const tree = await c.call("graph/tree", { sessionRef: parentRef });
    expect(tree.children.map((n: any) => n.id)).toContain(childRef);
    const child = tree.children.find((n: any) => n.id === childRef);
    expect(child.kind).toBe("delegation-child");
    expect(child.viaTaskId).toBe(taskId);
  });

  it("一层熔断：被派活的会话再往外派，拒绝并给出 exit-3 语义", async () => {
    const res = await c.raw("task/delegate", {
      agentId: "zcode",
      task: "再派一层",
      cwd: t.ws,
      callerRef: childRef,
    });
    expect(res.error.code).toBe(-32003);
    expect(res.error.message).toBe("recursion blocked (one-level dispatch only)");
    expect(res.error.data).toMatchObject({ legacyExitCode: 3, sessionRef: childRef });
  });

  it("人从壳里直接派活（不带 callerRef）不受熔断限制", async () => {
    const res = await c.call("task/delegate", {
      agentId: "zcode",
      task: "只回复一个字：好。不要调用任何工具。",
      cwd: t.ws,
    });
    expect(res.taskId).toBeTruthy();
    // 人派的会话是 root，它自己还能再派——一层熔断只管 agent 之间
    expect(daemon.graph.isDelegationChild(res.sessionRef)).toBe(false);
    await c.call("task/cancel", { taskId: res.taskId });
  });

  it("send_input 走投递阶梯，回执如实，并在图上记一条 supplement 边", async () => {
    const receipt = await c.call("task/send_input", {
      taskId,
      message: "补充：注意这一点",
      attribution: "来自派活方 agent zcode",
    });
    // 任务已跑完 → 目标没有进行中的回合，如实回 no_active_turn
    expect(receipt.outcome).toBe("no_active_turn");
    expect(receipt.sessionRef).toBe(childRef);
    const sup = await c.call("graph/edges", { kind: "supplement", to: childRef });
    expect(sup.edges.at(-1)).toMatchObject({
      from: parentRef,
      outcome: "no_active_turn",
      attribution: "来自派活方 agent zcode",
    });
  });

  it("task/cancel 对已结束的任务如实回 ok:false", async () => {
    expect(await c.call("task/cancel", { taskId })).toEqual({ ok: false });
  });

  it("未知 taskId 一律 NotFound", async () => {
    expect((await c.raw("task/get", { taskId: "没这个" })).error.code).toBe(-32001);
    expect((await c.raw("task/cancel", { taskId: "没这个" })).error.code).toBe(-32001);
  });

  it("薄状态落盘：任务与会话图都在 PULPO_HOME 下，可重建", async () => {
    const fs = await import("node:fs");
    expect(fs.existsSync(daemon.graph.filePath)).toBe(true);
    expect(daemon.graph.filePath.startsWith(t.home)).toBe(true);
    const tasks = JSON.parse(fs.readFileSync(daemon.broker.filePath, "utf8"));
    expect(tasks.tasks.map((x: any) => x.taskId)).toContain(taskId);
    // 落盘的任务里没有任何会话正文副本
    const raw = fs.readFileSync(daemon.graph.filePath, "utf8");
    expect(raw).not.toContain("agent_message_chunk");
  });
});
