import { describe, expect, it } from "vitest";
import {
  applyCorrection,
  applyStaticCorrections,
  isTightening,
  LooseningRejected,
  riskRank,
  STATIC_CORRECTIONS,
} from "../../src/descriptor/overrides.js";
import {
  descriptorFromInitialize,
  mergeSessionSelfDescription,
  selfReportedRisk,
} from "../../src/descriptor/build.js";
import { BOOTSTRAP } from "../../src/descriptor/registry.js";
import type { CapabilityDescriptor } from "../../src/descriptor/types.js";

/** ZCode adapter 实际发的 modes 自描述（只有 id/name/description，没有等级）。 */
const ZCODE_MODES = {
  currentModeId: "default",
  availableModes: [
    { id: "default", name: "变更前确认", description: "改文件前先问我。" },
    { id: "acceptEdits", name: "自动编辑", description: "自动编辑文件。" },
    { id: "plan", name: "计划模式", description: "编辑前先出计划。" },
    { id: "bypassPermissions", name: "完全访问", description: "减少确认次数。" },
  ],
};

function zcodeDescriptor(modes: unknown = ZCODE_MODES): CapabilityDescriptor {
  return mergeSessionSelfDescription(
    descriptorFromInitialize("zcode", BOOTSTRAP.zcode!, { protocolVersion: 1 }),
    { sessionId: "s1", modes },
  );
}

describe("agent 自报优先", () => {
  it("mode 对象带 risk / _meta.risk / dangerLevel 时直接采信，覆盖表不介入", () => {
    const d = zcodeDescriptor({
      availableModes: [
        { id: "default", name: "确认", risk: "safe" },
        { id: "acceptEdits", name: "自动编辑", _meta: { risk: "elevated" } },
        { id: "bypassPermissions", name: "完全访问", dangerLevel: "high" },
      ],
    });
    expect(d.modes.map((m) => m.risk)).toEqual(["safe", "elevated", "full"]);
    const applied = applyStaticCorrections({ descriptor: d, probes: {} });
    expect(applied.filter((c) => c.path.includes("risk"))).toHaveLength(0);
  });

  it("认不出来的写法一律返回 undefined，留给覆盖表", () => {
    expect(selfReportedRisk({ risk: "橙色" })).toBeUndefined();
    expect(selfReportedRisk({})).toBeUndefined();
    expect(selfReportedRisk(null)).toBeUndefined();
  });
});

describe("覆盖表补 ZCode 四个模式的危险等级", () => {
  it("agent 没自报时按实测证据补，且每条都可审计", () => {
    const d = zcodeDescriptor();
    expect(d.modes.every((m) => m.risk === undefined)).toBe(true);
    applyStaticCorrections({ descriptor: d, probes: {} });
    const byId = Object.fromEntries(d.modes.map((m) => [m.id, m.risk]));
    expect(byId).toEqual({
      default: "safe",
      acceptEdits: "elevated",
      plan: "safe",
      bypassPermissions: "full",
    });
    for (const c of d.corrections.filter((x) => x.path.includes("risk"))) {
      expect(c.from).toBeUndefined();
      expect(c.reason.length).toBeGreaterThan(0);
      // 证据必须是 adapter 源码里的实测，不是推断
      expect(c.evidence).toMatch(/_decide_permission|MODE_TO_ENGINE/);
      expect(c.versionCondition.length).toBeGreaterThan(0);
    }
  });

  it("descriptor 里没有那个模式时不会凭空造一条", () => {
    const d = zcodeDescriptor({ availableModes: [{ id: "default", name: "确认" }] });
    applyStaticCorrections({ descriptor: d, probes: {} });
    expect(d.modes).toHaveLength(1);
    expect(d.corrections.filter((c) => c.path.includes("risk"))).toHaveLength(1);
  });

  it("重复应用不重复记账", () => {
    const d = zcodeDescriptor();
    applyStaticCorrections({ descriptor: d, probes: {} });
    const n = d.corrections.length;
    applyStaticCorrections({ descriptor: d, probes: {} });
    expect(d.corrections).toHaveLength(n);
  });

  it("覆盖表里的 risk 条目都针对 zcode 且路径合法", () => {
    const riskRules = STATIC_CORRECTIONS.filter((r) => r.path.includes("risk"));
    expect(riskRules.length).toBe(4);
    for (const r of riskRules) {
      expect(r.agentId).toBe("zcode");
      expect(r.path).toMatch(/^modes\[.+\]\.risk$/);
    }
  });
});

describe("危险等级只收紧", () => {
  it("等级序：undefined < safe < elevated < full", () => {
    expect(riskRank(undefined)).toBe(0);
    expect(riskRank("safe")).toBe(1);
    expect(riskRank("elevated")).toBe(2);
    expect(riskRank("full")).toBe(3);
  });

  it("往高了改算收紧，往低了改算放宽", () => {
    expect(isTightening("modes[x].risk", undefined, "safe")).toBe(true);
    expect(isTightening("modes[x].risk", "safe", "full")).toBe(true);
    expect(isTightening("modes[x].risk", "full", "safe")).toBe(false);
    expect(isTightening("modes[x].risk", "elevated", "elevated")).toBe(false);
  });

  it("试图把已标的高危降级会被当场拒绝（不是静默通过）", () => {
    const d = zcodeDescriptor();
    applyStaticCorrections({ descriptor: d, probes: {} });
    expect(() =>
      applyCorrection(d, {
        id: "坏条目",
        path: "modes[bypassPermissions].risk",
        to: "safe",
        reason: "想把完全访问说成安全",
        evidence: "无",
        versionCondition: "无",
      }),
    ).toThrow(LooseningRejected);
    expect(d.modes.find((m) => m.id === "bypassPermissions")!.risk).toBe("full");
  });

  it("给不存在的模式标等级会报错，不会悄悄新建一个模式", () => {
    const d = zcodeDescriptor({ availableModes: [{ id: "default" }] });
    expect(() =>
      applyCorrection(d, {
        id: "x",
        path: "modes[不存在].risk",
        to: "full",
        reason: "r",
        evidence: "e",
        versionCondition: "v",
      }),
    ).toThrow(/没有模式/);
  });
});
