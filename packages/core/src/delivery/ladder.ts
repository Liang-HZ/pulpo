import type { AcpKernel, SessionHandle, SessionRef } from "../acp/kernel.js";
import { STEERING_METHOD } from "../descriptor/build.js";
import {
  applyStaticCorrections,
  type CorrectionContext,
} from "../descriptor/overrides.js";
import type {
  CapabilityDescriptor,
  DeliveryOutcome,
  DeliveryTier,
} from "../descriptor/types.js";
import { tierRank } from "../descriptor/types.js";
import { isMethodNotFound, RpcError } from "../errors.js";

/** 请求侧的投递偏好（per-request 决策）。 */
export interface DeliveryPref {
  /** 想要的档位。达不到就按阶梯往下降，不会往上升。 */
  tier?: DeliveryTier;
  /** 允许降到的最弱档位。默认 "queue"。 */
  maxTier?: DeliveryTier;
  /** 允许打断当前步（档 4）。默认 false——打断是有代价的，必须显式要。 */
  allowInterrupt?: boolean;
  /** 空闲（无活动回合）时是否直接开新回合。默认 false → 回 no_active_turn。 */
  startTurnIfIdle?: boolean;
}

export interface DeliveryReceipt {
  outcome: DeliveryOutcome;
  /** 实际走的档位。unsupported 时为 null。 */
  tier: DeliveryTier | null;
  /** 请求时算出来的目标档位（降级前）。 */
  requestedTier: DeliveryTier;
  /** 这次投递依次尝试过哪些档位、各自结果——回执可追溯。 */
  attempts: DeliveryAttempt[];
  /** 目标 agent 的原始应答。回执如实来自目标，不是壳侧猜的。 */
  raw?: unknown;
  /** 投递时目标会话是否有进行中的回合（决策依据）。 */
  turnActive: boolean;
  sessionRef: SessionRef;
  deliveredAt: number;
}

export interface DeliveryAttempt {
  tier: DeliveryTier;
  /**
   * `ok` = 目标收下了；`failed` = 目标收下但它自己报了失败（回执 outcome 同为
   * `failed`，两者必须一致）；`unsupported` = 这一档目标不认；`error` = 调用本身
   * 出错；`skipped` = 条件不满足，没试。
   */
  status: "ok" | "failed" | "unsupported" | "error" | "skipped";
  detail?: string;
}

/** 回合刚开始时的"可注入空窗"重试上限（D）。 */
export const INJECTABLE_WAIT_MS = 2000;

/** 壳侧排队：档 5 的落点。会话结束一回合后 drain。 */
export interface QueuedMessage {
  sessionRef: SessionRef;
  content: unknown[];
  queuedAt: number;
}

function candidateTiers(
  descriptor: CapabilityDescriptor,
  pref: DeliveryPref,
): DeliveryTier[] {
  const ladder: DeliveryTier[] = [
    "native",
    "extension",
    "concurrent",
    "soft-interrupt",
    "queue",
  ];
  // 起点：descriptor 说这个 agent 的 steering 落在哪一档。请求方可以要求
  // **更弱**的档位（保守），不能要求更强——能力是 agent 说了算。
  const capTier = descriptor.delivery.steering.tier;
  let start = tierRank(capTier);
  if (pref.tier) start = Math.max(start, tierRank(pref.tier));
  let end = tierRank(pref.maxTier ?? "queue");
  if (end < start) end = start;
  const out = ladder.slice(start, end + 1);
  return out.filter((t) => {
    if (t === "soft-interrupt" && !pref.allowInterrupt) return false;
    if (t === "queue" && !descriptor.delivery.queue.supported) return false;
    return true;
  });
}

/** 把 ContentBlock[] 拼成纯文本（并发档 / 打断档要重投 prompt 时用）。 */
function blocksToText(blocks: unknown[]): string {
  return blocks
    .map((b) => {
      const o = b as { type?: string; text?: string };
      return o?.type === "text" ? (o.text ?? "") : "";
    })
    .join("");
}

/**
 * 投递阶梯。
 *
 * 规则：
 *  - 档位由 descriptor 决定，请求方只能往保守方向压，不能往上抬；
 *  - 每一档都**问目标**，回执如实来自目标的应答，壳不代答；
 *  - 某一档被目标否掉（-32601 等）→ 记进修正覆盖层（只收紧、带实测证据），
 *    之后同一会话不再白跑这一档；
 *  - 所有档都不可用 → `unsupported`，不假装成功。
 */
export class DeliveryLadder {
  private readonly queues = new Map<SessionRef, QueuedMessage[]>();

  constructor(private readonly kernel: AcpKernel) {}

  queueFor(ref: SessionRef): QueuedMessage[] {
    return this.queues.get(ref) ?? [];
  }

  /** 取出并清空某会话的排队消息（回合结束时 drain）。 */
  drain(ref: SessionRef): QueuedMessage[] {
    const q = this.queues.get(ref) ?? [];
    this.queues.delete(ref);
    return q;
  }

  async deliver(
    sessionRef: SessionRef,
    content: unknown[],
    pref: DeliveryPref = {},
  ): Promise<DeliveryReceipt> {
    const handle = this.kernel.require(sessionRef);
    const turnActiveAtDecision = handle.turnActive;
    const tiers = candidateTiers(handle.descriptor, pref);
    const attempts: DeliveryAttempt[] = [];
    const requestedTier = tiers[0] ?? "queue";

    for (const tier of tiers) {
      let r = await this.tryTier(handle, tier, content, pref, attempts);
      // 注入空窗：`session/prompt` 刚发出去的一两秒里，core 已经把 turnActive 置真，
      // 目标却还没真正开跑，steering 会回 promptRequired——这是空窗，不是事实。
      // 判据是"目标开没开口"（本回合有没有来过 session/update），等到它开口再
      // 重试一次，重试如实写进 attempts。
      if (r?.outcome === "no_active_turn" && this.inStartupWindow(handle)) {
        const ready = await this.kernel.awaitInjectable(handle.ref, INJECTABLE_WAIT_MS);
        attempts.push({
          tier,
          status: "skipped",
          detail: ready
            ? "回合刚开始、目标尚未开口 → 等到目标开口后重试一次"
            : `回合刚开始，等了 ${INJECTABLE_WAIT_MS}ms 目标仍未开口 → 重试一次`,
        });
        const retry = await this.tryTier(handle, tier, content, pref, attempts);
        if (retry) r = retry;
      }
      if (r) {
        return {
          ...r,
          requestedTier,
          attempts,
          turnActive: turnActiveAtDecision,
          sessionRef,
          deliveredAt: Date.now(),
        };
      }
    }

    return {
      outcome: "unsupported",
      tier: null,
      requestedTier,
      attempts,
      turnActive: turnActiveAtDecision,
      sessionRef,
      deliveredAt: Date.now(),
    };
  }

  /** 目标回合是否处在"已开跑但还没开口"的空窗里。 */
  private inStartupWindow(handle: SessionHandle): boolean {
    const turn = this.kernel.currentTurn(handle.ref);
    if (!turn) return false;
    if (turn.injectable) return false;
    return Date.now() - turn.startedAt < INJECTABLE_WAIT_MS;
  }

  private async tryTier(
    handle: SessionHandle,
    tier: DeliveryTier,
    content: unknown[],
    pref: DeliveryPref,
    attempts: DeliveryAttempt[],
  ): Promise<Omit<DeliveryReceipt, "requestedTier" | "attempts" | "turnActive" | "sessionRef" | "deliveredAt"> | null> {
    switch (tier) {
      case "native":
        // 档 1 由具体 agent 的原生原语实现（如 Codex `turn/steer`）。
        // ZCode 没有原生原语，descriptor 也不会把起点定在这里。
        attempts.push({ tier, status: "unsupported", detail: "本 agent 无原生 steering 原语" });
        return null;

      case "extension":
        return this.tryExtension(handle, content, attempts);

      case "concurrent":
        return this.tryConcurrent(handle, tier, content, pref, attempts);

      case "soft-interrupt":
        return this.trySoftInterrupt(handle, content, attempts);

      case "queue": {
        const q = this.queues.get(handle.ref) ?? [];
        q.push({ sessionRef: handle.ref, content, queuedAt: Date.now() });
        this.queues.set(handle.ref, q);
        attempts.push({ tier, status: "ok", detail: `壳内排队，队列深度 ${q.length}` });
        // 回执如实：这条消息确实只是进了壳的队列，还没到 agent。
        return { outcome: "queued", tier, raw: { queueDepth: q.length } };
      }
    }
  }

  private async tryExtension(
    handle: SessionHandle,
    content: unknown[],
    attempts: DeliveryAttempt[],
  ): Promise<Omit<DeliveryReceipt, "requestedTier" | "attempts" | "turnActive" | "sessionRef" | "deliveredAt"> | null> {
    const method = handle.descriptor.delivery.steering.method ?? STEERING_METHOD;
    try {
      const raw = await this.kernel.sessionRequest<Record<string, unknown>>(handle.ref, method, {
        prompt: content,
        _meta: { steering: { idleBehavior: "promptRequired" } },
      });
      const outcome = mapSteeringOutcome(raw);
      // attempts 的状态必须和 outcome 一致。目标自报 failed 时，
      // 这一档并不是"ok"，也不是"unsupported"——原样记 failed 并带上它给的原因。
      if (outcome === "failed") {
        attempts.push({
          tier: "extension",
          status: "failed",
          detail: steeringFailureDetail(raw),
        });
      } else {
        attempts.push({ tier: "extension", status: "ok" });
      }
      return { outcome, tier: "extension", raw };
    } catch (err) {
      if (isMethodNotFound(err)) {
        // 广告了但没实现 —— 实测证据到手，收紧 descriptor，之后不再白跑这一档。
        const ctx: CorrectionContext = {
          descriptor: handle.descriptor,
          probes: { steeringMethodNotFound: true },
        };
        applyStaticCorrections(ctx);
        attempts.push({
          tier: "extension",
          status: "unsupported",
          detail: `目标回 method not found：${(err as RpcError).message}`,
        });
        return null;
      }
      attempts.push({
        tier: "extension",
        status: "error",
        detail: (err as Error).message,
      });
      throw err;
    }
  }

  private async tryConcurrent(
    handle: SessionHandle,
    tier: DeliveryTier,
    content: unknown[],
    pref: DeliveryPref,
    attempts: DeliveryAttempt[],
  ): Promise<Omit<DeliveryReceipt, "requestedTier" | "attempts" | "turnActive" | "sessionRef" | "deliveredAt"> | null> {
    if (!handle.turnActive) {
      if (!pref.startTurnIfIdle) {
        // 空闲：并发注入无从谈起。如实回 no_active_turn，不偷偷开新回合。
        attempts.push({ tier, status: "skipped", detail: "无进行中回合" });
        return { outcome: "no_active_turn", tier, raw: { reason: "noRunningTurn" } };
      }
      // 请求方明说了空闲就开新回合。
      void this.kernel.prompt(handle.ref, content).catch(() => undefined);
      attempts.push({ tier, status: "ok", detail: "空闲 → 按请求开新回合" });
      return { outcome: "injected", tier, raw: { startedNewTurn: true } };
    }
    // 回合进行中：并发投一条 prompt，由目标自己裁决怎么并入。
    const before = handle.turnActive;
    const p = this.kernel.prompt(handle.ref, content);
    p.catch(() => undefined);
    if (!before) {
      attempts.push({ tier, status: "skipped", detail: "投递前回合已结束" });
      return { outcome: "completed_race", tier };
    }
    attempts.push({ tier, status: "ok", detail: "并发 prompt 已投出" });
    return { outcome: "injected", tier, raw: { concurrentPrompt: true } };
  }

  private async trySoftInterrupt(
    handle: SessionHandle,
    content: unknown[],
    attempts: DeliveryAttempt[],
  ): Promise<Omit<DeliveryReceipt, "requestedTier" | "attempts" | "turnActive" | "sessionRef" | "deliveredAt"> | null> {
    if (!handle.turnActive) {
      attempts.push({ tier: "soft-interrupt", status: "skipped", detail: "无进行中回合，无需打断" });
      return { outcome: "no_active_turn", tier: "soft-interrupt" };
    }
    await this.kernel.cancel(handle.ref);
    void this.kernel.prompt(handle.ref, content).catch(() => undefined);
    attempts.push({
      tier: "soft-interrupt",
      status: "ok",
      detail: `已打断当前步并重投（原文 ${blocksToText(content).length} 字）`,
    });
    return { outcome: "injected", tier: "soft-interrupt", raw: { interrupted: true } };
  }
}

/**
 * 目标对 `_session/steering` 的应答 → pulpo 回执枚举。
 *
 * 认的是两份官方参考实现的并集：
 *  - claude-agent-acp：`injected` / `{outcome:"promptRequired", reason:"noRunningTurn"}`
 *  - codex-acp：`injected` / `startedNewTurn`
 * 没给 outcome 字段的（应答为空对象）按 `injected` 记——目标没报错就是收下了。
 */
export function mapSteeringOutcome(raw: unknown): DeliveryOutcome {
  const o = (raw ?? {}) as { outcome?: unknown };
  const outcome = typeof o.outcome === "string" ? o.outcome : undefined;
  switch (outcome) {
    case undefined:
    case "injected":
    case "startedNewTurn":
      return "injected";
    case "promptRequired":
    case "noRunningTurn":
      return "no_active_turn";
    case "queued":
      return "queued";
    case "completedRace":
    case "completed_race":
      return "completed_race";
    case "failed":
      // 目标收下了、它自己报失败。不是 unsupported——机制在，这次没成。
      return "failed";
    case "unsupported":
      return "unsupported";
    default:
      // 目标说了个我们不认的词——按"没投进去"处理，绝不美化成 injected。
      return "unsupported";
  }
}

/**
 * 目标自报失败时的原因说明。实测样本（ZCode adapter）：
 * `{"outcome":"failed","_meta":{"steering":{"reason":"fault.command.executionFailed",
 * "detail":"FOREIGN KEY constraint failed"}}}` —— 原样透出，不改写、不归类。
 */
export function steeringFailureDetail(raw: unknown): string {
  const meta = (raw as { _meta?: { steering?: { reason?: unknown; detail?: unknown } } } | null)?._meta
    ?.steering;
  const reason = typeof meta?.reason === "string" ? meta.reason : "";
  const detail = typeof meta?.detail === "string" ? meta.detail : "";
  const both = [reason, detail].filter(Boolean).join("：");
  return both ? `目标自报失败：${both}` : "目标自报失败（未给 reason / detail）";
}
