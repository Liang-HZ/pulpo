import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PulpoDaemon } from "@pulpo/core";
import {
  RpcClient,
  connectCompanion,
  haveZcode,
  makeTestEnv,
  startDaemon,
  toolJson,
  waitFor,
  type TestEnv,
} from "../helpers.js";

/**
 * companion 全链路（真实 core daemon + 真实 ZCode 引擎，不 mock）：
 *
 *   list_agents → delegate_to_agent（带 model_id + thinking_effort）
 *     → get_task 轮询到 done → send_input（带归属标注）→ cancel_task
 *     → 以被派活会话的身份再派活 → 一层熔断
 *
 * 渠道额度（如 Coding Plan）按滚动窗口计量，所以 prompt 只有一句、要求只回两个字。
 */
describe.runIf(haveZcode())("companion 四件套（真实 core + ZCode 引擎）", () => {
  let t: TestEnv;
  let daemon: PulpoDaemon;
  let rpc: RpcClient;
  let parentRef: string;
  let modelId: string;
  let effort: string;
  let mcp: Awaited<ReturnType<typeof connectCompanion>>;
  let taskId: string;
  let childRef: string;

  beforeAll(async () => {
    t = makeTestEnv("flow");
    daemon = await startDaemon(t);
    rpc = await RpcClient.unix(daemon.socketPath!);
    // 派活方会话：companion 就"挂"在它上面（真实注入见 injection.test.ts）。
    const parent = await rpc.call("session/new", { agentId: "zcode", cwd: t.ws });
    parentRef = parent.sessionRef;
    modelId = parent.descriptor.currentModelId;
    effort = parent.descriptor.currentEffort;
    mcp = await connectCompanion({ socketPath: daemon.socketPath!, sessionRef: parentRef });
  });

  afterAll(async () => {
    await mcp?.close();
    rpc?.close();
    await daemon?.stop();
    t?.cleanup();
  });

  it("list_agents：模型目录与思考强度来自 core 的 descriptor，不是猜的", async () => {
    const out = toolJson(await mcp.client.callTool({ name: "list_agents", arguments: {} }));
    expect(out.caller).toBe(`zcode:${parentRef}`);
    const zcode = out.agents.find((a: any) => a.agent_type === "zcode");
    expect(zcode.descriptor_available).toBe(true);
    expect(zcode.current_model_id).toBe(modelId);
    expect(zcode.current_thinking_effort).toBe(effort);
    expect(zcode.available_models.map((m: any) => m.model_id)).toContain(modelId);
    expect(zcode.available_efforts).toContain(effort);
    // adapter 0.7.0 真实现了 `_session/steering`
    expect(zcode.delivery).toMatchObject({ steering_supported: true, steering_tier: "extension" });
  });

  it("delegate_to_agent：用 descriptor 给的 model_id / thinking_effort 派活", async () => {
    const res = await mcp.client.callTool(
      {
        name: "delegate_to_agent",
        arguments: {
          agent_type: "zcode",
          task: "只回复两个字：完成。不要调用任何工具。",
          working_dir: t.ws,
          model_id: modelId,
          thinking_effort: effort,
        },
      },
      undefined,
      { timeout: 300_000 },
    );
    expect(res.isError).toBeFalsy();
    const out = toolJson(res);
    taskId = out.task_id;
    childRef = out.session_ref;
    expect(taskId).toBeTruthy();
    expect(childRef).toMatch(/^zcode#/);
    expect(out.caller).toBe(`zcode:${parentRef}`);
    expect(out.working_dir).toBe(t.ws);
    expect(out.capability_ref).toMatchObject({
      session_ref: childRef,
      agent_type: "zcode",
      model_id: modelId,
      thinking_effort: effort,
    });

    // core 侧如实记了派活边（含 model/effort）
    const { edges } = await rpc.call("graph/edges", { kind: "delegate", taskId });
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ from: parentRef, to: childRef, modelId, effort });
  });

  it("get_task：轮询到 done，summary 是目标真实给出的结论", async () => {
    await waitFor(
      async () => {
        const out = toolJson(
          await mcp.client.callTool({ name: "get_task", arguments: { task_id: taskId } }),
        );
        return out.status === "done" || out.status === "failed";
      },
      { what: "派活任务跑完", timeoutMs: 280_000, intervalMs: 1000 },
    );
    const out = toolJson(
      await mcp.client.callTool({ name: "get_task", arguments: { task_id: taskId } }),
    );
    expect(out.status).toBe("done");
    expect(out.stop_reason).toBe("end_turn");
    expect(out.summary).toContain("完成");
    expect(out.summary_source).toBe("task");
    expect(out.session_ref).toBe(childRef);
    expect(out.model_id).toBe(modelId);
    expect(out.thinking_effort).toBe(effort);
  });

  it("send_input：回执如实，消息带归属标注写进目标会话", async () => {
    const out = toolJson(
      await mcp.client.callTool(
        { name: "send_input", arguments: { task_id: taskId, message: "补充：记一下这句。" } },
        undefined,
        { timeout: 300_000 },
      ),
    );
    expect(out.attribution).toBe(`来自派活方 zcode:${parentRef}`);
    // 任务已跑完 → 目标没有进行中的回合。adapter 的 `_session/steering` 空闲时
    // 回 promptRequired，壳如实映射成 no_active_turn，不假装投进去了。
    expect(out.outcome).toBe("no_active_turn");
    expect(out.tier).toBe("extension");
    expect(out.session_ref).toBe(childRef);

    const { edges } = await rpc.call("graph/edges", { kind: "supplement", to: childRef });
    expect(edges.at(-1)).toMatchObject({
      from: parentRef,
      outcome: "no_active_turn",
      attribution: `来自派活方 zcode:${parentRef}`,
    });
  });

  it("cancel_task：已经结束的任务如实回 ok=false", async () => {
    const out = toolJson(
      await mcp.client.callTool({ name: "cancel_task", arguments: { task_id: taskId } }),
    );
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("已经结束");
  });

  it("一层熔断：以被派活会话的身份再派活，被拒并带 legacyExitCode 3", async () => {
    const child = await connectCompanion({
      socketPath: daemon.socketPath!,
      sessionRef: childRef,
    });
    try {
      const res = await child.client.callTool({
        name: "delegate_to_agent",
        arguments: { agent_type: "zcode", task: "再派一层", working_dir: t.ws },
      });
      expect(res.isError).toBe(true);
      const out = toolJson(res);
      expect(out.code).toBe(-32003);
      expect(out.legacyExitCode).toBe(3);
      expect(out.error).toBe("recursion blocked (one-level dispatch only)");
      expect(out.data).toMatchObject({ legacyExitCode: 3, sessionRef: childRef });
      // 真的没建出第二层会话
      const { tasks } = await rpc.call("task/list", { parentRef: childRef });
      expect(tasks).toEqual([]);
    } finally {
      await child.close();
    }
  });

  it("没有会话身份时视为人直接调用：允许派活，回执标 caller: human", async () => {
    const human = await connectCompanion({ socketPath: daemon.socketPath! });
    try {
      const agents = toolJson(await human.client.callTool({ name: "list_agents", arguments: {} }));
      expect(agents.caller).toBe("human");

      const res = await human.client.callTool(
        {
          name: "delegate_to_agent",
          arguments: {
            agent_type: "zcode",
            task: "只回复一个字：好。不要调用任何工具。",
            working_dir: t.ws,
          },
        },
        undefined,
        { timeout: 300_000 },
      );
      expect(res.isError).toBeFalsy();
      const out = toolJson(res);
      expect(out.caller).toBe("human");
      // 人派出来的是 root 会话，不受一层限制（core 侧不建 delegate 边）
      const { edges } = await rpc.call("graph/edges", { kind: "delegate", taskId: out.task_id });
      expect(edges).toEqual([]);
      const cancel = toolJson(
        await human.client.callTool({ name: "cancel_task", arguments: { task_id: out.task_id } }),
      );
      expect(typeof cancel.ok).toBe("boolean");
      await rpc.call("session/close", { sessionRef: out.session_ref });
    } finally {
      await human.close();
    }
  });
});
