/**
 * capability descriptor
 *
 * 事实源是 **agent 自描述**：`initialize` 应答 + `session/new` 应答里的
 * `configOptions` / `models`。壳侧不维护权威表——只有两样东西：
 *
 *  1. 引导表（`registry.ts`）：agent id → 怎么启动、去哪拉自描述。**不含能力断言**；
 *  2. 修正覆盖表（`overrides.ts`）：已知缺陷的**只收紧**覆盖，每条带版本条件、
 *     reason 与 evidence，应用后写进 `corrections` 供审计。
 */

/** 投递阶梯档位。数字越小越接近原生。 */
export type DeliveryTier =
  | "native"
  | "extension"
  | "concurrent"
  | "soft-interrupt"
  | "queue";

/** 档位强弱序：native 最强，queue 最弱。用于"只收紧"校验。 */
export const DELIVERY_TIER_ORDER: readonly DeliveryTier[] = [
  "native",
  "extension",
  "concurrent",
  "soft-interrupt",
  "queue",
];

export function tierRank(tier: DeliveryTier): number {
  const i = DELIVERY_TIER_ORDER.indexOf(tier);
  if (i < 0) throw new Error(`未知投递档位：${tier}`);
  return i;
}

/** 投递回执枚举（AionUi 的并集）。 */
export type DeliveryOutcome =
  | "injected"
  | "queued"
  | "no_active_turn"
  | "completed_race"
  /**
   * 目标收下了这一档的调用，但**它自己报了失败**（实测样本：ZCode adapter 回
   * `{"outcome":"failed","_meta":{"steering":{"reason":"fault.command.executionFailed",
   * "detail":"FOREIGN KEY constraint failed"}}}`）。
   * 这**不是** `unsupported`——机制在、这次没成。reason/detail 原样进 `raw`。
   */
  | "failed"
  | "unsupported";

export interface SteeringCapability {
  /** agent 是否广告了 steering 能力。 */
  supported: boolean;
  /** 实际走哪一档。 */
  tier: DeliveryTier;
  /** 注入边界：步内 / 回合边界。 */
  boundary: "step" | "turn" | "unknown";
  /** 空闲（无进行中回合）时的行为。 */
  idle: "promptRequired" | "startsNewTurn" | "unknown";
  /** 注入是否会把宿主回合提前结算（Claude 0.64 的 #934 缺陷）。 */
  settlesOwnerTurn: boolean;
  /** 扩展方法名（档 2 用）。 */
  method?: string;
}

export interface QueueCapability {
  supported: boolean;
  drainAt: "turnEnd" | "immediate" | "unknown";
}

export interface DeliveryCapability {
  steering: SteeringCapability;
  queue: QueueCapability;
}

export interface ModelCapability {
  /** agent 自报的模型 id，原样透传，不重命名。 */
  id: string;
  label?: string;
  /** 该 agent 暴露的思考强度档位（来自 configOptions）。 */
  efforts: string[];
  /** 会话当前 effort（configOptions.currentValue）。 */
  defaultEffort?: string;
  totalContextTokens?: number;
}

/**
 * 访问模式的危险等级。
 *
 * UI 靠它决定模式 chip 要不要变橙，**禁止在 UI 里做字符串匹配**
 * （`if (modeId.includes("yolo"))` 是明令禁止的）。
 *
 *  - `safe`：改文件前要人确认，或干脆只读；
 *  - `elevated`：某一类动作（通常是编辑）自动放行；
 *  - `full`：基本不再确认。
 */
export type ModeRisk = "safe" | "elevated" | "full";

export interface ModeCapability {
  id: string;
  name?: string;
  description?: string;
  /** 危险等级。agent 自报优先；没自报的由修正覆盖表补（只收紧、带证据）。 */
  risk?: ModeRisk;
}

/** 回合级撤销能力。壳内 git 快照能不能用。 */
export interface RevertCapability {
  /** `available` = cwd 在 git 仓库里，回合快照可拍可回滚。 */
  supported: RevertAvailabilityLite;
  /** `unavailable` 时的原因（`notGitRepo` / `gitFailed:<原文>`）。 */
  reason?: string;
  /** 实现方式。壳内 git 快照 = `shell-git-snapshot`。 */
  kind: "shell-git-snapshot" | "agent-native" | "none";
}

export type RevertAvailabilityLite = "available" | "unavailable";

export interface SubagentCapability {
  spawn: boolean;
  modelOverride: boolean;
  effortOverride: boolean;
  /** 能否对运行中的原生 subagent 直接投递消息。全生态目前都是 false。 */
  liveMessaging: boolean;
}

export interface SessionLifecycleCapability {
  list: boolean;
  load: boolean;
  resume: boolean;
  fork: boolean;
  close: boolean;
  delete: boolean;
}

export interface StorageCapability {
  kind: "engine-store" | "jsonl" | "sqlite" | "unknown";
  location?: string;
  /** 读取器 id（`read/registry.ts` 查表用）。没有读取器就是 null。 */
  reader: string | null;
}

/** 一条已应用的修正记录——审计用，必须能回答"为什么壳跟 agent 说的不一样"。 */
export interface AppliedCorrection {
  /** 覆盖表条目 id。 */
  id: string;
  /** 被改的 descriptor 路径，如 `delivery.steering.tier`。 */
  path: string;
  /** agent 自描述的原值。 */
  from: unknown;
  /** 收紧后的值。 */
  to: unknown;
  /** 为什么要收紧。 */
  reason: string;
  /** 实测证据——不是推断，是测出来的。 */
  evidence: string;
  /** 条目适用的版本条件（人类可读）。 */
  versionCondition: string;
}

export interface CapabilityDescriptor {
  agentId: string;
  /** agent 自报的实现名与版本（initialize 应答 / `_meta`）。 */
  agentName?: string;
  version?: string;
  /** 协议版本（initialize 协商结果）。 */
  protocolVersion: number;
  delivery: DeliveryCapability;
  sessions: SessionLifecycleCapability;
  /** 从 session/new 的 configOptions + models 聚合。会话建立前为空数组。 */
  models: ModelCapability[];
  currentModelId?: string;
  /** configOptions 里的 effort 维度（id 与全量档位）。 */
  efforts: string[];
  currentEffort?: string;
  /** 模式（安全模式等）。`risk` 见 `ModeCapability`。 */
  modes: ModeCapability[];
  currentModeId?: string;
  subagents: SubagentCapability;
  /** 回合级撤销。与会话的 cwd 绑定，`session/new` 时填。 */
  revert?: RevertCapability;
  transports: { acp: boolean; mcp: string[] };
  storage: StorageCapability;
  /** initialize 应答原文（`_meta` 等）——审计与调试的原始证据。 */
  raw: {
    initialize?: unknown;
    newSession?: unknown;
  };
  /** 已应用的修正，按覆盖表顺序。空数组 = 壳完全采信 agent 自描述。 */
  corrections: AppliedCorrection[];
  /** 聚合时间（epoch ms）。 */
  aggregatedAt: number;
  /**
   * 这份 descriptor 是怎么来的（只有 `agent/descriptor` 的返回里有）：
   *  - `live`：来自一条**活动会话**的自描述；
   *  - `cached`：来自上一次自描述的缓存（`cachedAt` 是它的时间戳）；
   *  - `probed`：刚刚现开一条会话探到的（探完就关）。
   */
  source?: "live" | "cached" | "probed";
  /** `source: "cached"` 时这份自描述是什么时候拿到的。 */
  cachedAt?: number;
}
