import { describe, expect, it } from "vitest";
import type { DeliveryReceipt, SteeringTier } from "../lib/protocol";
import { receiptLabel, steeringDiscrepancy, steeringLabel } from "../lib/steering";

describe("档位 → 按钮文案", () => {
  it.each<[SteeringTier, string, number]>([
    ["native", "注入当前回合", 1],
    ["extension", "注入当前回合", 2],
    ["concurrent", "回合结束后执行", 3],
    ["soft-interrupt", "打断并重投", 4],
    ["queue", "排队", 5],
  ])("%s 档显示「%s」（第 %d 档）", (tier, action, level) => {
    const label = steeringLabel(tier);
    expect(label.action).toBe(action);
    expect(label.level).toBe(level);
    expect(label.badge).toContain(`档 ${level}`);
    expect(label.hint.length).toBeGreaterThan(0);
  });

  it("拿不到档位时按最保守的一档处理，不假装能注入", () => {
    for (const value of [null, undefined]) {
      const label = steeringLabel(value);
      expect(label.action).toBe("排队");
      expect(label.level).toBe(5);
    }
  });

  it("目标只能排队时不许说成注入", () => {
    expect(steeringLabel("queue").action).not.toContain("注入");
  });

  it("步内注入（档 1/2）与边界注入（档 3）的文案必须不同", () => {
    expect(steeringLabel("extension").action).not.toBe(steeringLabel("concurrent").action);
  });
});

describe("回执翻译", () => {
  const base = { sessionRef: "zcode#a", deliveredAt: 1 };

  it("injected 是好结果，并把实际档位写出来——档 3 的 injected 不等于并进了这一步", () => {
    const label = receiptLabel({
      ...base,
      outcome: "injected",
      tier: "concurrent",
      requestedTier: "concurrent",
    } as DeliveryReceipt);
    // 档位**原样显示** native / extension / concurrent / …，
    // 不要翻译成"实时 / 准实时"这种自造词。
    expect(label.tone).toBe("ok");
    expect(label.text).toBe("已投递（concurrent）");
    expect(label.detail).toContain("concurrent");
  });

  it("降级过就把降级路径写在回执里", () => {
    const label = receiptLabel({
      ...base,
      outcome: "injected",
      tier: "concurrent",
      requestedTier: "extension",
    } as DeliveryReceipt);
    expect(label.detail).toContain("从 extension");
    expect(label.detail).toContain("降到 concurrent");
  });

  it("queued 说清只进了壳的队列、还没到 agent", () => {
    const label = receiptLabel({ ...base, outcome: "queued", tier: "queue" } as DeliveryReceipt);
    expect(label.text).toBe("已排队，下一回合发送");
    expect(label.tone).toBe("muted");
  });

  it("no_active_turn / completed_race 是「已转为新一轮」，不是失败", () => {
    for (const outcome of ["no_active_turn", "completed_race"] as const) {
      const label = receiptLabel({ ...base, outcome, tier: "concurrent" } as DeliveryReceipt);
      expect(label.tone).toBe("muted");
      expect(label.text).toContain("已转为新一轮");
    }
  });

  it("unsupported 是失败，tier 为 null 时说明没有可用档位", () => {
    const label = receiptLabel({ ...base, outcome: "unsupported", tier: null } as DeliveryReceipt);
    expect(label.tone).toBe("warn");
    expect(label.text).toBe("该渠道不支持补充消息，已排队");
    expect(label.detail).toBe("无可用档位");
  });

  it("failed 是「目标收下了但自报失败」，不许说成不支持、也不许说成已投递", () => {
    const label = receiptLabel({ ...base, outcome: "failed", tier: "extension" } as DeliveryReceipt);
    expect(label.outcome).toBe("failed");
    expect(label.tone).toBe("warn");
    expect(label.text).toBe("目标收下了这次投递，但它自报失败");
    expect(label.detail).toBe("extension");
    expect(label.text).not.toContain("已投递");
  });

  it("目标给了不认识的 outcome 一律记成 unsupported，绝不当成 injected，但原文要带出来", () => {
    const label = receiptLabel({
      ...base,
      outcome: "某种新说法" as never,
      tier: "concurrent",
    } as DeliveryReceipt);
    expect(label.outcome).toBe("unsupported");
    expect(label.tone).toBe("warn");
    expect(label.rawOutcome).toBe("某种新说法");
    expect(label.detail).toContain("某种新说法");
  });

  it("认识的 outcome 不会平白多出一句「目标回的是」", () => {
    const label = receiptLabel({ ...base, outcome: "injected", tier: "extension" } as DeliveryReceipt);
    expect(label.detail).not.toContain("目标回的是");
    expect(label.rawOutcome).toBe("injected");
  });
});

describe("自述与实测不一致的提示", () => {
  it("agent 说支持但实际只到并发档时明说", () => {
    expect(steeringDiscrepancy(true, "concurrent")).toContain("实测只能走档 3");
  });

  it("agent 说支持且实际就是步内注入时不啰嗦", () => {
    expect(steeringDiscrepancy(true, "extension")).toBeNull();
    expect(steeringDiscrepancy(true, "native")).toBeNull();
  });

  it("agent 自己就说不支持时不提示（没有不一致）", () => {
    expect(steeringDiscrepancy(false, "queue")).toBeNull();
  });
});
