// 投递阶梯的文案映射（PROTOCOL.md §4.6、PLAN §4.4）。
//
// 规矩：**同一位置、同一个按钮**，文案随目标 descriptor 的实际档位如实变化。
// 档位来自 `descriptor.delivery.steering.tier`——那是 core 修正层收紧之后的
// 实际档位，不是 agent 自己广告的那个。壳不许美化：目标只能排队就写"排队"。

import type { DeliveryOutcome, DeliveryReceipt, SteeringTier } from "./protocol";

export interface SteeringLabel {
  /** 按钮上的字 */
  action: string;
  /** 档位徽标，如"档 2 · 扩展" */
  badge: string;
  /** 输入框下方一句解释，说清这一档意味着什么 */
  hint: string;
  /** 档位序号，1 最强 */
  level: 1 | 2 | 3 | 4 | 5;
}

const TIER_LABELS: Record<SteeringTier, SteeringLabel> = {
  native: {
    action: "注入当前回合",
    badge: "档 1 · 原生",
    hint: "目标有原生 steering 原语，这条会并进正在跑的这一步。",
    level: 1,
  },
  extension: {
    action: "注入当前回合",
    badge: "档 2 · 扩展",
    hint: "走 _session/steering 扩展方法，这条会并进正在跑的这一步。",
    level: 2,
  },
  concurrent: {
    action: "回合结束后执行",
    badge: "档 3 · 并发",
    hint: "目标不支持步内注入，这条并发投出后由目标自己裁决——实测是当前回合跑完再执行，不会丢。",
    level: 3,
  },
  "soft-interrupt": {
    action: "打断并重投",
    badge: "档 4 · 软打断",
    hint: "只能先打断当前这一步再重投，已经跑到一半的工作会丢。",
    level: 4,
  },
  queue: {
    action: "排队",
    badge: "档 5 · 排队",
    hint: "目标没有任何注入通道，这条先存在壳里，等目标回合结束时再发。",
    level: 5,
  },
};

/** 回合进行中时，输入框按钮该显示什么。回合空闲时按钮是普通的"发送"。 */
export function steeringLabel(tier: SteeringTier | null | undefined): SteeringLabel {
  if (!tier) {
    return {
      action: "排队",
      badge: "档位未知",
      hint: "还没拿到目标的能力描述符，按最保守的一档处理。",
      level: 5,
    };
  }
  return TIER_LABELS[tier] ?? TIER_LABELS.queue;
}

/**
 * 回执条的文案。`tier` **原样显示** native / extension / concurrent /
 * soft-interrupt / queue——不要翻译成"实时 / 准实时"这种自造词，回执如实是铁律。
 */
const OUTCOME_LABELS: Record<DeliveryOutcome, string> = {
  injected: "已投递",
  queued: "已排队，下一回合发送",
  no_active_turn: "对方当前没有进行中的回合，已转为新一轮",
  completed_race: "回合刚结束，已转为新一轮",
  failed: "目标收下了这次投递，但它自报失败",
  unsupported: "该渠道不支持补充消息，已排队",
};

export type ReceiptTone = "ok" | "muted" | "warn";

export interface ReceiptLabel {
  /** 归一后的枚举；目标回了不认识的字符串时一律是 `unsupported` */
  outcome: DeliveryOutcome;
  /** 目标回执里的原文，跟归一后的值可能不一样——不一样的时候要显示出来 */
  rawOutcome: string;
  text: string;
  detail: string;
  tone: ReceiptTone;
}

const OUTCOME_TONE: Record<DeliveryOutcome, ReceiptTone> = {
  injected: "ok",
  queued: "muted",
  no_active_turn: "muted",
  completed_race: "muted",
  failed: "warn",
  unsupported: "warn",
};

/**
 * 回执照实翻译。注意 `injected` 不等于"已并进当前这一步"——那是档 2 的语义，
 * 档 3 的 injected 意思是目标按它自己的规矩并入。要区分就看 `tier`，
 * 所以这里把实际档位一并写进 detail。
 */
export function receiptLabel(receipt: DeliveryReceipt): ReceiptLabel {
  const known = Boolean(OUTCOME_LABELS[receipt.outcome]);
  const outcome: DeliveryOutcome = known ? receipt.outcome : "unsupported";
  // 档位原文，不翻译
  const tierText = receipt.tier ?? "无可用档位";
  const downgraded =
    receipt.requestedTier && receipt.tier && receipt.requestedTier !== receipt.tier
      ? `（从 ${receipt.requestedTier} 降到 ${tierText}）`
      : "";
  // 不认识的 outcome 归到 unsupported，但原文要带出来——否则看到"没有一档可用"
  // 的人根本查不出目标到底回了什么。
  const unknownNote = known ? "" : `（目标回的是「${String(receipt.outcome)}」）`;
  return {
    outcome,
    rawOutcome: String(receipt.outcome),
    text: known && receipt.outcome === "injected" ? `已投递（${tierText}）` : OUTCOME_LABELS[outcome],
    detail: `${tierText}${downgraded}${unknownNote}`,
    tone: OUTCOME_TONE[outcome],
  };
}

/** descriptor 自述与实测档位不一致时给一句人话——"agent 说支持但实测不可用"。 */
export function steeringDiscrepancy(
  supported: boolean,
  tier: SteeringTier | null | undefined,
): string | null {
  if (!supported) return null;
  if (tier === "native" || tier === "extension") return null;
  return `agent 自报支持步内注入，实测只能走${steeringLabel(tier).badge}`;
}
