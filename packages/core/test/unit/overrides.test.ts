import { describe, expect, it } from "vitest";
import {
  applyCorrection,
  applyStaticCorrections,
  isTightening,
  LooseningRejected,
  STATIC_CORRECTIONS,
} from "../../src/descriptor/overrides.js";
import { descriptorFromInitialize } from "../../src/descriptor/build.js";
import { BOOTSTRAP } from "../../src/descriptor/registry.js";
import type { CapabilityDescriptor } from "../../src/descriptor/types.js";

/** 用实测到的 ZCode shim initialize 应答原文建 descriptor。 */
const REAL_ZCODE_INITIALIZE = {
  protocolVersion: 1,
  agentCapabilities: { loadSession: false, promptCapabilities: { embeddedContext: false } },
  sessionCapabilities: { list: {}, resume: {}, fork: {}, close: {} },
  authMethods: [],
  _meta: {
    steering: { supported: true },
    goal: { version: 1, controlMethod: "_session/goal", actions: ["set", "clear"] },
  },
};

function fresh(): CapabilityDescriptor {
  return descriptorFromInitialize("zcode", BOOTSTRAP.zcode!, REAL_ZCODE_INITIALIZE);
}

describe("descriptor 修正覆盖表：只收紧", () => {
  it("档位只能往弱里改", () => {
    expect(isTightening("delivery.steering.tier", "extension", "concurrent")).toBe(true);
    expect(isTightening("delivery.steering.tier", "extension", "queue")).toBe(true);
    expect(isTightening("delivery.steering.tier", "concurrent", "extension")).toBe(false);
    expect(isTightening("delivery.steering.tier", "queue", "native")).toBe(false);
    expect(isTightening("delivery.steering.tier", "extension", "extension")).toBe(false);
  });

  it("布尔能力位只能 true → false", () => {
    expect(isTightening("subagents.spawn", true, false)).toBe(true);
    expect(isTightening("subagents.spawn", false, true)).toBe(false);
    expect(isTightening("sessions.fork", true, false)).toBe(true);
    expect(isTightening("sessions.fork", false, true)).toBe(false);
  });

  it("settlesOwnerTurn 只能 false → true（承认缺陷才算收紧）", () => {
    expect(isTightening("delivery.steering.settlesOwnerTurn", false, true)).toBe(true);
    expect(isTightening("delivery.steering.settlesOwnerTurn", true, false)).toBe(false);
  });

  it("boundary / idle / drainAt 按保守程度排序", () => {
    expect(isTightening("delivery.steering.boundary", "step", "turn")).toBe(true);
    expect(isTightening("delivery.steering.boundary", "turn", "step")).toBe(false);
    expect(isTightening("delivery.steering.idle", "startsNewTurn", "promptRequired")).toBe(true);
    expect(isTightening("delivery.steering.idle", "promptRequired", "startsNewTurn")).toBe(false);
    expect(isTightening("delivery.queue.drainAt", "immediate", "turnEnd")).toBe(true);
    expect(isTightening("delivery.queue.drainAt", "turnEnd", "immediate")).toBe(false);
  });

  it("试图放宽会被拒绝，descriptor 不受影响", () => {
    const d = fresh();
    d.delivery.steering.tier = "queue";
    expect(() =>
      applyCorrection(d, {
        id: "test.loosen",
        path: "delivery.steering.tier",
        to: "native",
        reason: "测试",
        evidence: "测试",
        versionCondition: "测试",
      }),
    ).toThrow(LooseningRejected);
    expect(d.delivery.steering.tier).toBe("queue");
    expect(d.corrections).toHaveLength(0);
  });

  it("缺 reason / evidence / versionCondition 的修正不许进表", () => {
    const d = fresh();
    expect(() =>
      applyCorrection(d, {
        id: "test.no-evidence",
        path: "delivery.steering.tier",
        to: "queue",
        reason: "有理由",
        evidence: "  ",
        versionCondition: "任意",
      }),
    ).toThrow(/不可审计/);
    expect(d.corrections).toHaveLength(0);
  });

  it("与自描述一致时不记账", () => {
    const d = fresh();
    const applied = applyCorrection(d, {
      id: "test.noop",
      path: "delivery.steering.tier",
      to: "extension",
      reason: "r",
      evidence: "e",
      versionCondition: "v",
    });
    expect(applied).toBeNull();
    expect(d.corrections).toHaveLength(0);
  });

  it("同一条修正重复应用只记一次", () => {
    const d = fresh();
    const spec = {
      id: "test.dup",
      path: "delivery.steering.tier" as const,
      to: "concurrent",
      reason: "r",
      evidence: "e",
      versionCondition: "v",
    };
    applyCorrection(d, spec);
    applyCorrection(d, spec);
    expect(d.corrections).toHaveLength(1);
  });

  it("每条审计记录都带 reason / evidence / versionCondition / from / to", () => {
    const d = fresh();
    const applied = applyCorrection(d, {
      id: "test.audit",
      path: "delivery.steering.tier",
      to: "soft-interrupt",
      reason: "理由",
      evidence: "实测数据",
      versionCondition: "版本条件",
    })!;
    expect(applied).toMatchObject({
      id: "test.audit",
      path: "delivery.steering.tier",
      from: "extension",
      to: "soft-interrupt",
      reason: "理由",
      evidence: "实测数据",
      versionCondition: "版本条件",
    });
  });
});

describe("静态覆盖表", () => {
  it("每条条目都自带 reason / evidence / versionCondition", () => {
    expect(STATIC_CORRECTIONS.length).toBeGreaterThan(0);
    for (const rule of STATIC_CORRECTIONS) {
      expect(rule.reason.trim()).not.toBe("");
      expect(rule.evidence.trim()).not.toBe("");
      expect(rule.versionCondition.trim()).not.toBe("");
    }
  });

  it("探测没命中时不动 descriptor", () => {
    const d = fresh();
    const applied = applyStaticCorrections({ descriptor: d, probes: {} });
    expect(applied).toHaveLength(0);
    expect(d.delivery.steering.tier).toBe("extension");
    expect(d.corrections).toHaveLength(0);
  });

  it("探测到 `_session/steering` 不存在时，把档 2 收紧到档 3", () => {
    const d = fresh();
    expect(d.delivery.steering.tier).toBe("extension");
    const applied = applyStaticCorrections({
      descriptor: d,
      probes: { steeringMethodNotFound: true },
    });
    expect(applied).toHaveLength(1);
    expect(d.delivery.steering.tier).toBe("concurrent");
    // supported 仍然是 agent 自己说的 true —— 我们只改实际档位，不改它的自述。
    expect(d.delivery.steering.supported).toBe(true);
    expect(d.corrections[0]!.evidence).toContain("-32601");
  });

  it("只对自己 agentId 的条目生效", () => {
    const d = fresh();
    d.agentId = "someone-else";
    const applied = applyStaticCorrections({
      descriptor: d,
      probes: { steeringMethodNotFound: true },
    });
    expect(applied).toHaveLength(0);
  });
});
