import { describe, expect, it } from "vitest";
import {
  descriptorFromInitialize,
  effortConfigId,
  mergeSessionSelfDescription,
} from "../../src/descriptor/build.js";
import { BOOTSTRAP, resolveCommand, defaultZcodeAdapterPath } from "../../src/descriptor/registry.js";

const INIT = {
  protocolVersion: 1,
  agentCapabilities: { loadSession: false },
  sessionCapabilities: { list: {}, resume: {}, fork: {}, close: {} },
  _meta: { steering: { supported: true } },
};

/** 实测的 session/new 应答结构（截取）。 */
const NEW_SESSION = {
  sessionId: "zc-sess_x",
  models: {
    availableModels: [
      { modelId: "Demo Plan/glm-5.3-flash", label: "glm-5.3-flash", totalContextTokens: 1_000_000, supportsReasoningEffort: true },
      { modelId: "Demo Relay/gpt-5.5", label: "gpt-5.5", totalContextTokens: 200_000, supportsReasoningEffort: true },
      { modelId: "无思考/plain", label: "plain", supportsReasoningEffort: false },
    ],
    currentModelId: "Demo Plan/glm-5.3-flash",
  },
  configOptions: [
    {
      id: "mode",
      name: "安全模式",
      category: "mode",
      type: "select",
      currentValue: "default",
      options: [
        { value: "default", name: "变更前确认" },
        { value: "plan", name: "计划模式" },
      ],
    },
    {
      id: "model",
      category: "model",
      type: "select",
      currentValue: "Demo Plan/glm-5.3-flash",
      options: [
        { value: "Demo Plan/glm-5.3-flash", name: "glm-5.3-flash" },
        { value: "只在 configOptions 里/extra", name: "extra" },
      ],
    },
    {
      id: "reasoning_effort",
      name: "推理强度",
      category: "model",
      type: "select",
      currentValue: "medium",
      options: [
        { value: "low", name: "低" },
        { value: "high", name: "高" },
        { value: "max", name: "最高" },
        { value: "medium", name: "中" },
      ],
    },
  ],
  modes: {
    currentModeId: "default",
    availableModes: [
      { id: "default", name: "变更前确认" },
      { id: "plan", name: "计划模式" },
    ],
  },
};

describe("descriptor 聚合：事实源是 agent 自描述", () => {
  it("initialize 的 sessionCapabilities 逐项落到 sessions", () => {
    const d = descriptorFromInitialize("zcode", BOOTSTRAP.zcode!, INIT);
    expect(d.sessions).toEqual({
      list: true,
      load: false,
      resume: true,
      fork: true,
      close: true,
      delete: false,
    });
    expect(d.protocolVersion).toBe(1);
  });

  it("广告了 steering 就落档 2，没广告落档 3（壳不替 agent 拔高）", () => {
    const withSteering = descriptorFromInitialize("zcode", BOOTSTRAP.zcode!, INIT);
    expect(withSteering.delivery.steering.tier).toBe("extension");
    const without = descriptorFromInitialize("zcode", BOOTSTRAP.zcode!, {
      ...INIT,
      _meta: {},
    });
    expect(without.delivery.steering.supported).toBe(false);
    expect(without.delivery.steering.tier).toBe("concurrent");
  });

  it("initialize 原文原样留在 raw 里", () => {
    const d = descriptorFromInitialize("zcode", BOOTSTRAP.zcode!, INIT);
    expect(d.raw.initialize).toEqual(INIT);
  });

  it("models 取 configOptions 与 availableModels 的并集，id 原样不重命名", () => {
    const d = mergeSessionSelfDescription(
      descriptorFromInitialize("zcode", BOOTSTRAP.zcode!, INIT),
      NEW_SESSION,
    );
    const ids = d.models.map((m) => m.id);
    expect(ids).toContain("Demo Plan/glm-5.3-flash");
    expect(ids).toContain("Demo Relay/gpt-5.5");
    expect(ids).toContain("只在 configOptions 里/extra");
    expect(d.currentModelId).toBe("Demo Plan/glm-5.3-flash");
  });

  it("efforts 来自 configOptions，currentValue 就是当前档", () => {
    const d = mergeSessionSelfDescription(
      descriptorFromInitialize("zcode", BOOTSTRAP.zcode!, INIT),
      NEW_SESSION,
    );
    expect(d.efforts).toEqual(["low", "high", "max", "medium"]);
    expect(d.currentEffort).toBe("medium");
  });

  it("supportsReasoningEffort=false 的模型不安 effort 档位", () => {
    const d = mergeSessionSelfDescription(
      descriptorFromInitialize("zcode", BOOTSTRAP.zcode!, INIT),
      NEW_SESSION,
    );
    expect(d.models.find((m) => m.id === "无思考/plain")!.efforts).toEqual([]);
    expect(d.models.find((m) => m.id === "Demo Relay/gpt-5.5")!.efforts).toEqual([
      "low",
      "high",
      "max",
      "medium",
    ]);
  });

  it("modes 与 currentModeId 也来自自描述", () => {
    const d = mergeSessionSelfDescription(
      descriptorFromInitialize("zcode", BOOTSTRAP.zcode!, INIT),
      NEW_SESSION,
    );
    expect(d.modes.map((m) => m.id)).toEqual(["default", "plan"]);
    expect(d.currentModeId).toBe("default");
  });

  it("effortConfigId 认出承载思考强度的配置项", () => {
    expect(effortConfigId(NEW_SESSION)).toBe("reasoning_effort");
    expect(effortConfigId({ configOptions: [] })).toBeUndefined();
  });

  it("agent 没给 configOptions 时聚合出空表，不编默认值", () => {
    const d = mergeSessionSelfDescription(
      descriptorFromInitialize("zcode", BOOTSTRAP.zcode!, INIT),
      { sessionId: "x" },
    );
    expect(d.models).toEqual([]);
    expect(d.efforts).toEqual([]);
    expect(d.currentModelId).toBeUndefined();
  });
});

describe("引导表", () => {
  it("默认指向仓内 adapter，环境变量可覆盖", () => {
    const boot = BOOTSTRAP.zcode!;
    expect(boot.command).toBe(defaultZcodeAdapterPath());
    expect(boot.command).toMatch(/packages\/adapters\/zcode\/bin\/zcode-acp$/);
    expect(resolveCommand(boot, { env: {} })).toBe(boot.command);
    expect(resolveCommand(boot, { env: { PULPO_ZCODE_ACP: "/tmp/other" } })).toBe("/tmp/other");
    expect(
      resolveCommand(boot, { override: "/tmp/win", env: { PULPO_ZCODE_ACP: "/tmp/other" } }),
    ).toBe("/tmp/win");
  });

  it("引导表不含任何能力断言（能力只能由 agent 自报）", () => {
    for (const boot of Object.values(BOOTSTRAP)) {
      expect(boot).not.toHaveProperty("delivery");
      expect(boot).not.toHaveProperty("models");
      expect(boot).not.toHaveProperty("steering");
    }
  });
});
