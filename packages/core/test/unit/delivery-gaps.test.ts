import { describe, expect, it } from "vitest";
import {
  DeliveryLadder,
  INJECTABLE_WAIT_MS,
  mapSteeringOutcome,
  steeringFailureDetail,
} from "../../src/delivery/ladder.js";
import { descriptorFromInitialize } from "../../src/descriptor/build.js";
import { BOOTSTRAP } from "../../src/descriptor/registry.js";
import type { AcpKernel, SessionHandle, TurnInfo } from "../../src/acp/kernel.js";

/** 目标自报失败的实测样本（shell 功能轮抓到的原文）。 */
const FAILED_SAMPLE = {
  outcome: "failed",
  _meta: {
    steering: {
      reason: "fault.command.executionFailed",
      detail: "FOREIGN KEY constraint failed",
    },
  },
};

function harness(opts: { turnActive?: boolean; turn?: TurnInfo | undefined } = {}) {
  const descriptor = descriptorFromInitialize("zcode", BOOTSTRAP.zcode!, {
    protocolVersion: 1,
    sessionCapabilities: { list: {}, resume: {}, fork: {}, close: {} },
    _meta: { steering: { supported: true } },
  });
  const handle = {
    ref: "zcode#s1",
    agentId: "zcode",
    sessionId: "s1",
    cwd: "/tmp/ws",
    descriptor,
    newSessionResponse: {},
    turnActive: opts.turnActive ?? true,
    turns: new Map<string, TurnInfo>(),
    createdAt: Date.now(),
  } as unknown as SessionHandle;

  const state = {
    handle,
    steeringResults: [] as unknown[],
    steeringCalls: 0,
    turn: opts.turn,
    injectableWaits: 0,
    kernel: null as unknown as AcpKernel,
  };

  state.kernel = {
    require: () => handle,
    get: () => handle,
    sessionRequest: async () => {
      const next = state.steeringResults[Math.min(state.steeringCalls, state.steeringResults.length - 1)];
      state.steeringCalls++;
      return next;
    },
    prompt: async () => ({ stopReason: "end_turn" }),
    cancel: async () => undefined,
    currentTurn: () => state.turn,
    awaitInjectable: async () => {
      state.injectableWaits++;
      if (state.turn) state.turn.injectable = true;
      return true;
    },
  } as unknown as AcpKernel;
  return state;
}

const TEXT = [{ type: "text", text: "补一句" }];

describe("目标自报失败 ≠ unsupported", () => {
  it("回执 outcome=failed，attempts 状态同为 failed，reason/detail 原样透出", async () => {
    const h = harness();
    h.steeringResults = [FAILED_SAMPLE];
    const receipt = await new DeliveryLadder(h.kernel).deliver("zcode#s1", TEXT);
    expect(receipt.outcome).toBe("failed");
    expect(receipt.tier).toBe("extension");
    expect(receipt.attempts).toEqual([
      {
        tier: "extension",
        status: "failed",
        detail: "目标自报失败：fault.command.executionFailed：FOREIGN KEY constraint failed",
      },
    ]);
    expect(receipt.raw).toEqual(FAILED_SAMPLE);
  });

  it("failed 不再继续降级——机制在，这次没成，降级只会重复投一遍", async () => {
    const h = harness();
    h.steeringResults = [FAILED_SAMPLE];
    const receipt = await new DeliveryLadder(h.kernel).deliver("zcode#s1", TEXT);
    expect(receipt.attempts.filter((a) => a.tier !== "extension")).toHaveLength(0);
  });

  it("映射与说明文案", () => {
    expect(mapSteeringOutcome(FAILED_SAMPLE)).toBe("failed");
    expect(steeringFailureDetail({ outcome: "failed" })).toContain("未给 reason / detail");
  });
});

describe("回合刚开始的可注入空窗", () => {
  it("目标还没开口就回 promptRequired → 等它开口后重试一次，重试写进 attempts", async () => {
    const turn: TurnInfo = {
      turnId: "t1",
      sessionRef: "zcode#s1",
      startedAt: Date.now(),
      injectable: false,
    };
    const h = harness({ turn });
    h.steeringResults = [
      { outcome: "promptRequired", reason: "noRunningTurn" },
      { outcome: "injected" },
    ];
    const receipt = await new DeliveryLadder(h.kernel).deliver("zcode#s1", TEXT);
    expect(h.steeringCalls).toBe(2);
    expect(h.injectableWaits).toBe(1);
    expect(receipt.outcome).toBe("injected");
    expect(receipt.attempts.map((a) => a.status)).toEqual(["ok", "skipped", "ok"]);
    expect(receipt.attempts[1]!.detail).toContain("重试一次");
  });

  it("目标已经开口过（injectable）就不重试——那是真的没有活动回合", async () => {
    const turn: TurnInfo = {
      turnId: "t1",
      sessionRef: "zcode#s1",
      startedAt: Date.now(),
      injectable: true,
    };
    const h = harness({ turn });
    h.steeringResults = [{ outcome: "promptRequired", reason: "noRunningTurn" }];
    const receipt = await new DeliveryLadder(h.kernel).deliver("zcode#s1", TEXT);
    expect(h.steeringCalls).toBe(1);
    expect(receipt.outcome).toBe("no_active_turn");
  });

  it("回合已经开始超过窗口时间也不重试", async () => {
    const turn: TurnInfo = {
      turnId: "t1",
      sessionRef: "zcode#s1",
      startedAt: Date.now() - INJECTABLE_WAIT_MS - 1,
      injectable: false,
    };
    const h = harness({ turn });
    h.steeringResults = [{ outcome: "promptRequired", reason: "noRunningTurn" }];
    const receipt = await new DeliveryLadder(h.kernel).deliver("zcode#s1", TEXT);
    expect(h.steeringCalls).toBe(1);
    expect(receipt.outcome).toBe("no_active_turn");
  });

  it("重试后目标仍说没有活动回合 → 如实回 no_active_turn，不美化", async () => {
    const turn: TurnInfo = {
      turnId: "t1",
      sessionRef: "zcode#s1",
      startedAt: Date.now(),
      injectable: false,
    };
    const h = harness({ turn });
    h.steeringResults = [{ outcome: "promptRequired" }];
    const receipt = await new DeliveryLadder(h.kernel).deliver("zcode#s1", TEXT);
    expect(h.steeringCalls).toBe(2);
    expect(receipt.outcome).toBe("no_active_turn");
  });
});
