import { describe, expect, it, vi } from "vitest";
import { DeliveryLadder, mapSteeringOutcome } from "../../src/delivery/ladder.js";
import { descriptorFromInitialize } from "../../src/descriptor/build.js";
import { BOOTSTRAP } from "../../src/descriptor/registry.js";
import type { AcpKernel, SessionHandle } from "../../src/acp/kernel.js";
import type { CapabilityDescriptor } from "../../src/descriptor/types.js";
import { RpcError, ErrorCode } from "../../src/errors.js";

function descriptor(meta: Record<string, unknown> = { steering: { supported: true } }): CapabilityDescriptor {
  return descriptorFromInitialize("zcode", BOOTSTRAP.zcode!, {
    protocolVersion: 1,
    sessionCapabilities: { list: {}, resume: {}, fork: {}, close: {} },
    _meta: meta,
  });
}

interface FakeKernel {
  kernel: AcpKernel;
  handle: SessionHandle;
  calls: { method: string; params: unknown }[];
  prompts: unknown[][];
  cancels: number;
  steeringResult: unknown;
  steeringError: unknown;
}

function fakeKernel(opts: { turnActive?: boolean; descriptor?: CapabilityDescriptor } = {}): FakeKernel {
  const handle = {
    ref: "zcode#s1",
    agentId: "zcode",
    sessionId: "s1",
    cwd: "/tmp/ws",
    descriptor: opts.descriptor ?? descriptor(),
    newSessionResponse: {},
    turnActive: opts.turnActive ?? false,
    createdAt: Date.now(),
  } as unknown as SessionHandle;

  const state: FakeKernel = {
    handle,
    calls: [],
    prompts: [],
    cancels: 0,
    steeringResult: { outcome: "injected" },
    steeringError: null,
    kernel: null as unknown as AcpKernel,
  };

  state.kernel = {
    require: () => handle,
    get: () => handle,
    sessionRequest: async (_ref: string, method: string, params: unknown) => {
      state.calls.push({ method, params });
      if (state.steeringError) throw state.steeringError;
      return state.steeringResult;
    },
    prompt: async (_ref: string, prompt: unknown[]) => {
      state.prompts.push(prompt);
      return { stopReason: "end_turn" };
    },
    cancel: async () => {
      state.cancels++;
    },
    // D 的空窗重试用这两个：默认"没有进行中的回合"，行为与改动前一致。
    currentTurn: () => undefined,
    awaitInjectable: async () => false,
  } as unknown as AcpKernel;

  return state;
}

const TEXT = [{ type: "text", text: "补充一句" }];

describe("投递档位选择", () => {
  it("descriptor 落档 2 时先走扩展方法，回执来自目标", async () => {
    const f = fakeKernel({ turnActive: true });
    f.steeringResult = { outcome: "injected" };
    const receipt = await new DeliveryLadder(f.kernel).deliver("zcode#s1", TEXT);
    expect(receipt.tier).toBe("extension");
    expect(receipt.outcome).toBe("injected");
    expect(receipt.raw).toEqual({ outcome: "injected" });
    expect(f.calls[0]!.method).toBe("_session/steering");
    expect(f.calls[0]!.params).toMatchObject({
      prompt: TEXT,
      _meta: { steering: { idleBehavior: "promptRequired" } },
    });
  });

  it("目标回 promptRequired → no_active_turn，不美化成成功", async () => {
    const f = fakeKernel({ turnActive: false });
    f.steeringResult = { outcome: "promptRequired", reason: "noRunningTurn" };
    const receipt = await new DeliveryLadder(f.kernel).deliver("zcode#s1", TEXT);
    expect(receipt.outcome).toBe("no_active_turn");
    expect(receipt.tier).toBe("extension");
  });

  it("目标回 -32601 → 收紧 descriptor 并降到下一档", async () => {
    const f = fakeKernel({ turnActive: true });
    f.steeringError = new RpcError(ErrorCode.MethodNotFound, "method not found: _session/steering");
    const receipt = await new DeliveryLadder(f.kernel).deliver("zcode#s1", TEXT);
    expect(receipt.requestedTier).toBe("extension");
    expect(receipt.tier).toBe("concurrent");
    expect(receipt.outcome).toBe("injected");
    expect(receipt.attempts[0]).toMatchObject({ tier: "extension", status: "unsupported" });
    // 收紧记账
    expect(f.handle.descriptor.delivery.steering.tier).toBe("concurrent");
    expect(f.handle.descriptor.corrections).toHaveLength(1);
    expect(f.handle.descriptor.corrections[0]!.id).toBe("zcode.steering-advertised-but-absent");
  });

  it("扩展档报非 -32601 的错，如实抛出，不悄悄降级", async () => {
    const f = fakeKernel({ turnActive: true });
    f.steeringError = new RpcError(ErrorCode.AgentError, "引擎炸了");
    await expect(new DeliveryLadder(f.kernel).deliver("zcode#s1", TEXT)).rejects.toThrow("引擎炸了");
  });

  it("没广告 steering 的 agent 直接落并发档", async () => {
    const f = fakeKernel({ turnActive: true, descriptor: descriptor({}) });
    const receipt = await new DeliveryLadder(f.kernel).deliver("zcode#s1", TEXT);
    expect(receipt.requestedTier).toBe("concurrent");
    expect(receipt.tier).toBe("concurrent");
    expect(f.calls).toHaveLength(0);
    expect(f.prompts).toHaveLength(1);
  });

  it("并发档在空闲时如实回 no_active_turn，不偷偷开新回合", async () => {
    const f = fakeKernel({ turnActive: false, descriptor: descriptor({}) });
    const receipt = await new DeliveryLadder(f.kernel).deliver("zcode#s1", TEXT);
    expect(receipt.outcome).toBe("no_active_turn");
    expect(f.prompts).toHaveLength(0);
  });

  it("请求方明说 startTurnIfIdle 才会开新回合", async () => {
    const f = fakeKernel({ turnActive: false, descriptor: descriptor({}) });
    const receipt = await new DeliveryLadder(f.kernel).deliver("zcode#s1", TEXT, {
      startTurnIfIdle: true,
    });
    expect(receipt.outcome).toBe("injected");
    expect(f.prompts).toHaveLength(1);
  });

  it("请求方只能往弱里压档位，不能往上抬", async () => {
    // descriptor 说档 3；请求方要档 1 —— 不给，仍然从档 3 起。
    const f = fakeKernel({ turnActive: true, descriptor: descriptor({}) });
    const receipt = await new DeliveryLadder(f.kernel).deliver("zcode#s1", TEXT, { tier: "native" });
    expect(receipt.requestedTier).toBe("concurrent");
    expect(receipt.tier).toBe("concurrent");
  });

  it("请求方要求 queue 时直接排队", async () => {
    const f = fakeKernel({ turnActive: true });
    const ladder = new DeliveryLadder(f.kernel);
    const receipt = await ladder.deliver("zcode#s1", TEXT, { tier: "queue" });
    expect(receipt.tier).toBe("queue");
    expect(receipt.outcome).toBe("queued");
    expect(f.calls).toHaveLength(0);
    expect(ladder.queueFor("zcode#s1")).toHaveLength(1);
    expect(ladder.drain("zcode#s1")).toHaveLength(1);
    expect(ladder.queueFor("zcode#s1")).toHaveLength(0);
  });

  it("maxTier 限死降级底线，够不到就 unsupported", async () => {
    const f = fakeKernel({ turnActive: true });
    f.steeringError = new RpcError(ErrorCode.MethodNotFound, "method not found");
    const receipt = await new DeliveryLadder(f.kernel).deliver("zcode#s1", TEXT, {
      maxTier: "extension",
    });
    expect(receipt.outcome).toBe("unsupported");
    expect(receipt.tier).toBeNull();
  });

  it("打断档要显式 allowInterrupt 才会进候选", async () => {
    const d = descriptor({});
    d.delivery.steering.tier = "soft-interrupt";
    const f = fakeKernel({ turnActive: true, descriptor: d });
    const noInterrupt = await new DeliveryLadder(f.kernel).deliver("zcode#s1", TEXT, {
      maxTier: "soft-interrupt",
    });
    expect(noInterrupt.outcome).toBe("unsupported");
    expect(f.cancels).toBe(0);

    const withInterrupt = await new DeliveryLadder(f.kernel).deliver("zcode#s1", TEXT, {
      allowInterrupt: true,
    });
    expect(withInterrupt.tier).toBe("soft-interrupt");
    expect(withInterrupt.outcome).toBe("injected");
    expect(f.cancels).toBe(1);
  });

  it("每次投递都记下尝试过的档位，回执可追溯", async () => {
    const f = fakeKernel({ turnActive: true });
    f.steeringError = new RpcError(ErrorCode.MethodNotFound, "method not found");
    const receipt = await new DeliveryLadder(f.kernel).deliver("zcode#s1", TEXT);
    expect(receipt.attempts.map((a) => a.tier)).toEqual(["extension", "concurrent"]);
    expect(receipt.turnActive).toBe(true);
    expect(receipt.sessionRef).toBe("zcode#s1");
  });
});

describe("steering 回执映射（两份官方实现的并集）", () => {
  it.each([
    [{ outcome: "injected" }, "injected"],
    [{ outcome: "startedNewTurn" }, "injected"],
    [{}, "injected"],
    [{ outcome: "promptRequired", reason: "noRunningTurn" }, "no_active_turn"],
    [{ outcome: "noRunningTurn" }, "no_active_turn"],
    [{ outcome: "queued" }, "queued"],
    [{ outcome: "completedRace" }, "completed_race"],
    [{ outcome: "unsupported" }, "unsupported"],
  ])("%j → %s", (raw, expected) => {
    expect(mapSteeringOutcome(raw)).toBe(expected);
  });

  it("目标说了不认识的词 → unsupported，绝不当成 injected", () => {
    expect(mapSteeringOutcome({ outcome: "谁知道这是什么" })).toBe("unsupported");
  });
});
