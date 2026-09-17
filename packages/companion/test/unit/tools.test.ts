import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CoreRpcError, type CoreClient } from "../../src/coreClient.js";
import { CallerIdentity } from "../../src/identity.js";
import { createCompanionServer } from "../../src/server.js";

/** 记账用的假 core：只记调用、按脚本回值。集成测试才连真 core。 */
class FakeCore {
  readonly calls: { method: string; params: any }[] = [];
  constructor(private readonly handlers: Record<string, (params: any) => any>) {}
  async call<T = any>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    const h = this.handlers[method];
    if (!h) throw new Error(`假 core 没有这个方法：${method}`);
    const out = h(params);
    if (out instanceof Error) throw out;
    return out as T;
  }
  close(): void {}
  get describeAddress(): string {
    return "fake";
  }
  lastOf(method: string): any {
    return [...this.calls].reverse().find((c) => c.method === method)?.params;
  }
}

const DESCRIPTOR = {
  agentId: "zcode",
  models: [
    { id: "Demo Plan/glm-5.3-flash", label: "glm-5.3-flash", efforts: ["low", "high"], defaultEffort: "high" },
  ],
  efforts: ["low", "high"],
  currentModelId: "Demo Plan/glm-5.3-flash",
  currentEffort: "high",
  delivery: {
    steering: { supported: true, tier: "extension", idle: "promptRequired", method: "_session/steering" },
    queue: { supported: true, drainAt: "turnEnd" },
  },
  storage: { kind: "engine-store" },
};

function defaultHandlers(): Record<string, (p: any) => any> {
  return {
    "agent/list": () => [{ agentId: "zcode", label: "ZCode", storage: { kind: "engine-store" } }],
    "agent/descriptor": () => DESCRIPTOR,
    "task/delegate": () => ({ taskId: "t-1", sessionRef: "zcode#zc-child", capabilityRef: DESCRIPTOR }),
    "task/get": () => ({
      taskId: "t-1",
      agentId: "zcode",
      sessionRef: "zcode#zc-child",
      cwd: "/tmp/x",
      status: "done",
      summary: "干完了",
      stopReason: "end_turn",
      modelId: DESCRIPTOR.currentModelId,
      effort: "low",
    }),
    "task/send_input": () => ({
      outcome: "injected",
      tier: "extension",
      requestedTier: "extension",
      attempts: [{ tier: "extension", status: "ok" }],
      turnActive: true,
      sessionRef: "zcode#zc-child",
    }),
    "task/cancel": () => ({ ok: true }),
  };
}

async function harness(
  env: NodeJS.ProcessEnv,
  handlers: Record<string, (p: any) => any> = defaultHandlers(),
): Promise<{ client: Client; core: FakeCore; close: () => Promise<void> }> {
  const core = new FakeCore(handlers);
  const server = createCompanionServer({
    client: core as unknown as CoreClient,
    env,
    identity: new CallerIdentity({ env, client: core as unknown as CoreClient }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "unit", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    client,
    core,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function json(res: any): any {
  return JSON.parse(res.content.map((c: any) => c.text).join(""));
}

describe("工具清单与 schema", () => {
  it("暴露四件套 + list_agents，描述里写清取值来源与一层限制", async () => {
    const h = await harness({});
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["cancel_task", "delegate_to_agent", "get_task", "list_agents", "send_input"].sort(),
    );

    const delegate = tools.find((t) => t.name === "delegate_to_agent")!;
    expect(delegate.description).toContain("list_agents");
    expect(delegate.description).toContain("legacyExitCode 3");
    expect(delegate.inputSchema.required).toEqual(expect.arrayContaining(["agent_type", "task"]));
    const props = delegate.inputSchema.properties as Record<string, any>;
    expect(Object.keys(props).sort()).toEqual(
      ["agent_type", "delivery", "model_id", "task", "thinking_effort", "working_dir"].sort(),
    );
    expect(props.model_id.description).toContain("available_models");
    expect(props.thinking_effort.description).toContain("available_efforts");
    expect(props.delivery.properties.tier.enum).toEqual([
      "native",
      "extension",
      "concurrent",
      "soft-interrupt",
      "queue",
    ]);

    const send = tools.find((t) => t.name === "send_input")!;
    for (const outcome of ["injected", "queued", "no_active_turn", "completed_race", "unsupported"]) {
      expect(send.description).toContain(outcome);
    }
    expect((send.inputSchema.required ?? []) as string[]).toEqual(["message"]);

    const list = tools.find((t) => t.name === "list_agents")!;
    expect(list.description).toContain("agent_type");
    expect(list.description).toContain("model_id");
    await h.close();
  });

  it("参数校验：类型不对 / 缺必填由 schema 当场拒绝", async () => {
    const h = await harness({});
    const missing = await h.client.callTool({ name: "get_task", arguments: {} });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.content)).toMatch(/task_id/);

    const wrongType = await h.client.callTool({
      name: "delegate_to_agent",
      arguments: { agent_type: "zcode", task: 42 },
    });
    expect(wrongType.isError).toBe(true);

    const badTier = await h.client.callTool({
      name: "send_input",
      arguments: { task_id: "t-1", message: "x", delivery: { tier: "瞎编的档" } },
    });
    expect(badTier.isError).toBe(true);
    // 校验没过就不该打到 core
    expect(h.core.calls.filter((c) => c.method === "task/send_input")).toHaveLength(0);
    await h.close();
  });

  it("send_input 要 task_id 或 session_ref 其中之一，两个都不给时明确报错", async () => {
    const h = await harness({});
    const res = await h.client.callTool({ name: "send_input", arguments: { message: "x" } });
    expect(res.isError).toBe(true);
    expect(json(res).error).toContain("task_id");
    await h.close();
  });
});

describe("调用方身份", () => {
  it("没有 PULPO_SESSION_REF = 人直接调用：允许派活，回执标 caller: human，不带 callerRef", async () => {
    const h = await harness({ PULPO_DEFAULT_CWD: "/tmp/x" });
    const res = await h.client.callTool({
      name: "delegate_to_agent",
      arguments: { agent_type: "zcode", task: "做点事" },
    });
    expect(res.isError).toBeFalsy();
    const out = json(res);
    expect(out.caller).toBe("human");
    expect(out.task_id).toBe("t-1");
    expect(out.session_ref).toBe("zcode#zc-child");
    // 人不受一层限制 → core 那边不带 callerRef
    expect(h.core.lastOf("task/delegate")).not.toHaveProperty("callerRef");
    expect(h.core.lastOf("task/delegate").cwd).toBe("/tmp/x");

    const agents = await h.client.callTool({ name: "list_agents", arguments: {} });
    expect(json(agents).caller).toBe("human");
    await h.close();
  });

  it("有 PULPO_SESSION_REF：如实作为 callerRef 报给 core（一层熔断的判据）", async () => {
    const h = await harness({ PULPO_SESSION_REF: "zcode#zc-parent", PULPO_DEFAULT_CWD: "/tmp/x" });
    const res = await h.client.callTool({
      name: "delegate_to_agent",
      arguments: { agent_type: "zcode", task: "做点事", working_dir: "/tmp/ws" },
    });
    const out = json(res);
    expect(out.caller).toBe("zcode:zcode#zc-parent");
    expect(out.working_dir).toBe("/tmp/ws");
    expect(h.core.lastOf("task/delegate")).toMatchObject({
      agentId: "zcode",
      task: "做点事",
      cwd: "/tmp/ws",
      callerRef: "zcode#zc-parent",
    });
    await h.close();
  });

  it("PULPO_SESSION_REF 格式不对时明确报错，不退化成 human", async () => {
    const h = await harness({ PULPO_SESSION_REF: "没有井号" });
    const res = await h.client.callTool({
      name: "delegate_to_agent",
      arguments: { agent_type: "zcode", task: "x", working_dir: "/tmp/ws" },
    });
    expect(res.isError).toBe(true);
    expect(json(res).error).toContain("PULPO_SESSION_REF 格式错误");
    await h.close();
  });

  it("没有 SESSION_REF 但有 SESSION_TOKEN：用 companion/identify 换身份", async () => {
    const handlers = defaultHandlers();
    handlers["companion/identify"] = (p: any) => {
      expect(p.token).toBe("tok-9");
      return { sessionRef: "zcode#zc-parent", agentId: "zcode", cwd: "/tmp/from-core" };
    };
    const h = await harness({ PULPO_SESSION_TOKEN: "tok-9" }, handlers);
    const res = await h.client.callTool({
      name: "delegate_to_agent",
      arguments: { agent_type: "zcode", task: "x" },
    });
    const out = json(res);
    expect(out.caller).toBe("zcode:zcode#zc-parent");
    // working_dir 没给 → 沿用派活方会话的工作目录
    expect(out.working_dir).toBe("/tmp/from-core");
    expect(h.core.lastOf("task/delegate").callerRef).toBe("zcode#zc-parent");
    await h.close();
  });
});

describe("派活与回执", () => {
  it("model_id / thinking_effort 原样回传给 core，不翻译、不兜底", async () => {
    const h = await harness({ PULPO_SESSION_REF: "zcode#zc-parent" });
    await h.client.callTool({
      name: "delegate_to_agent",
      arguments: {
        agent_type: "zcode",
        task: "x",
        working_dir: "/tmp/ws",
        model_id: "Demo Plan/glm-5.3-flash",
        thinking_effort: "low",
        delivery: { tier: "concurrent", max_tier: "queue", allow_interrupt: true, start_turn_if_idle: true },
      },
    });
    expect(h.core.lastOf("task/delegate")).toMatchObject({
      modelId: "Demo Plan/glm-5.3-flash",
      effort: "low",
      delivery: { tier: "concurrent", maxTier: "queue", allowInterrupt: true, startTurnIfIdle: true },
    });
    await h.close();
  });

  it("capability_ref 带目标的模型目录与投递能力", async () => {
    const h = await harness({ PULPO_SESSION_REF: "zcode#zc-parent" });
    const out = json(
      await h.client.callTool({
        name: "delegate_to_agent",
        arguments: { agent_type: "zcode", task: "x", working_dir: "/tmp/ws" },
      }),
    );
    expect(out.capability_ref).toMatchObject({
      session_ref: "zcode#zc-child",
      agent_type: "zcode",
      model_id: "Demo Plan/glm-5.3-flash",
      available_efforts: ["low", "high"],
      delivery: { steering_supported: true, steering_tier: "extension", queue_supported: true },
    });
    await h.close();
  });

  it("working_dir 必须是绝对路径", async () => {
    const h = await harness({ PULPO_SESSION_REF: "zcode#zc-parent" });
    const res = await h.client.callTool({
      name: "delegate_to_agent",
      arguments: { agent_type: "zcode", task: "x", working_dir: "relative/dir" },
    });
    expect(res.isError).toBe(true);
    expect(json(res).error).toContain("绝对路径");
    await h.close();
  });

  it("一层熔断：core 的 -32003 原样透出，带 legacyExitCode 3 与自助提示", async () => {
    const handlers = defaultHandlers();
    handlers["task/delegate"] = () =>
      new CoreRpcError(-32003, "recursion blocked (one-level dispatch only)", {
        legacyExitCode: 3,
        sessionRef: "zcode#zc-child",
      });
    const h = await harness({ PULPO_SESSION_REF: "zcode#zc-child" }, handlers);
    const res = await h.client.callTool({
      name: "delegate_to_agent",
      arguments: { agent_type: "zcode", task: "再派一层", working_dir: "/tmp/ws" },
    });
    expect(res.isError).toBe(true);
    const out = json(res);
    expect(out.code).toBe(-32003);
    expect(out.legacyExitCode).toBe(3);
    expect(out.data).toMatchObject({ legacyExitCode: 3, sessionRef: "zcode#zc-child" });
    expect(out.hint).toContain("一层熔断");
    await h.close();
  });
});

describe("send_input / get_task / cancel_task", () => {
  it("归属标注按 [来自派活方 <agent_type>:<session_ref>] 写给 core", async () => {
    const h = await harness({ PULPO_SESSION_REF: "zcode#zc-parent" });
    const out = json(
      await h.client.callTool({
        name: "send_input",
        arguments: { task_id: "t-1", message: "补充一句" },
      }),
    );
    expect(out.attribution).toBe("来自派活方 zcode:zcode#zc-parent");
    expect(out.outcome).toBe("injected");
    expect(out.tier).toBe("extension");
    expect(h.core.lastOf("task/send_input")).toMatchObject({
      taskId: "t-1",
      message: "补充一句",
      attribution: "来自派活方 zcode:zcode#zc-parent",
    });
    await h.close();
  });

  it("人直接调用时归属标注也写明来源，不留空", async () => {
    const h = await harness({});
    const out = json(
      await h.client.callTool({
        name: "send_input",
        arguments: { session_ref: "zcode#zc-child", message: "x" },
      }),
    );
    expect(out.attribution).toBe("来自派活方 human:直接调用 companion");
    expect(h.core.lastOf("task/send_input").sessionRef).toBe("zcode#zc-child");
    await h.close();
  });

  it("get_task 的 summary 来自任务登记的结论", async () => {
    const h = await harness({});
    const out = json(await h.client.callTool({ name: "get_task", arguments: { task_id: "t-1" } }));
    expect(out).toMatchObject({
      task_id: "t-1",
      status: "done",
      summary: "干完了",
      summary_source: "task",
      session_ref: "zcode#zc-child",
      stop_reason: "end_turn",
    });
    await h.close();
  });

  it("结论为空且回合已结束时读穿转录取最近一条 agent 正文（去掉 zc- 前缀）", async () => {
    const handlers = defaultHandlers();
    handlers["task/get"] = () => ({
      taskId: "t-1",
      agentId: "zcode",
      sessionRef: "zcode#zc-sess_abc",
      cwd: "/tmp/ws",
      status: "done",
      summary: "",
    });
    handlers["read/transcript"] = (p: any) => {
      expect(p).toMatchObject({ agentId: "zcode", sessionId: "sess_abc", cwd: "/tmp/ws" });
      return {
        messages: [
          { role: "assistant", parts: [{ kind: "text", text: "早一点的回答" }] },
          { role: "user", parts: [{ kind: "text", text: "再说一遍" }] },
          { role: "assistant", parts: [{ kind: "text", text: "最近这条才是结论" }] },
        ],
      };
    };
    const h = await harness({}, handlers);
    const out = json(await h.client.callTool({ name: "get_task", arguments: { task_id: "t-1" } }));
    expect(out.summary).toBe("最近这条才是结论");
    expect(out.summary_source).toBe("transcript");
    await h.close();
  });

  it("回合还在跑时不编结论，如实留空并说明", async () => {
    const handlers = defaultHandlers();
    handlers["task/get"] = () => ({
      taskId: "t-1",
      agentId: "zcode",
      sessionRef: "zcode#zc-child",
      cwd: "/tmp/ws",
      status: "running",
      summary: "",
    });
    const h = await harness({}, handlers);
    const out = json(await h.client.callTool({ name: "get_task", arguments: { task_id: "t-1" } }));
    expect(out.status).toBe("running");
    expect(out.summary).toBe("");
    expect(out.summary_source).toBe("none");
    expect(out.note).toContain("还没结束");
    expect(h.core.calls.some((c) => c.method === "read/transcript")).toBe(false);
    await h.close();
  });

  it("cancel_task 如实回 ok，false 时说明原因", async () => {
    const handlers = defaultHandlers();
    handlers["task/cancel"] = () => ({ ok: false });
    const h = await harness({}, handlers);
    const out = json(await h.client.callTool({ name: "cancel_task", arguments: { task_id: "t-1" } }));
    expect(out).toMatchObject({ ok: false });
    expect(out.reason).toContain("已经结束");
    await h.close();
  });

  it("core 侧的 NotFound 原样透出错误码", async () => {
    const handlers = defaultHandlers();
    handlers["task/get"] = () => new CoreRpcError(-32001, "没有这个任务：x");
    const h = await harness({}, handlers);
    const res = await h.client.callTool({ name: "get_task", arguments: { task_id: "x" } });
    expect(res.isError).toBe(true);
    expect(json(res).code).toBe(-32001);
    await h.close();
  });
});

describe("list_agents", () => {
  it("聚合 agent/list + agent/descriptor，模型 id 原样保留", async () => {
    const h = await harness({});
    const out = json(await h.client.callTool({ name: "list_agents", arguments: {} }));
    expect(out.agents).toHaveLength(1);
    expect(out.agents[0]).toMatchObject({
      agent_type: "zcode",
      label: "ZCode",
      current_model_id: "Demo Plan/glm-5.3-flash",
      current_thinking_effort: "high",
      available_efforts: ["low", "high"],
      descriptor_available: true,
    });
    expect(out.agents[0].available_models[0]).toMatchObject({
      model_id: "Demo Plan/glm-5.3-flash",
      efforts: ["low", "high"],
      default_effort: "high",
    });
    await h.close();
  });

  it("某渠道没有活动会话时如实说明拿不到能力，不编一份出来", async () => {
    const handlers = defaultHandlers();
    handlers["agent/descriptor"] = () => new CoreRpcError(-32001, "zcode 还没有活动会话——请先 session/new");
    const h = await harness({}, handlers);
    const out = json(await h.client.callTool({ name: "list_agents", arguments: {} }));
    expect(out.agents[0].descriptor_available).toBe(false);
    expect(out.agents[0].reason).toContain("没有活动会话");
    expect(out.agents[0]).not.toHaveProperty("available_models");
    await h.close();
  });
});
