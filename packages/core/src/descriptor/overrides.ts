import type {
  AppliedCorrection,
  CapabilityDescriptor,
  DeliveryTier,
  ModeRisk,
} from "./types.js";
import { tierRank } from "./types.js";

/**
 * 修正覆盖表（correction overlay）——壳侧唯一允许偏离 agent 自描述的地方。
 *
 * 三条硬约束，`applyCorrection` 会强制执行：
 *
 *  1. **只收紧**：任何修正都只能让能力变弱/变保守，绝不能凭空放宽。
 *     试图放宽会抛错，不会静默通过。
 *  2. **带版本条件**：每条写清适用范围（版本区间，或"运行时探测命中"）。
 *  3. **可审计**：每条必须有 `reason`（为什么）与 `evidence`（实测到了什么），
 *     应用后原样进 `descriptor.corrections`，上层可以逐条展示。
 */

export interface CorrectionSpec {
  id: string;
  path: CorrectablePath | ModeRiskPath;
  to: unknown;
  reason: string;
  evidence: string;
  versionCondition: string;
}

/** 覆盖表能改的字段，以及"什么算收紧"。白名单之外的路径一律拒绝。 */
export type CorrectablePath =
  | "delivery.steering.supported"
  | "delivery.steering.tier"
  | "delivery.steering.boundary"
  | "delivery.steering.idle"
  | "delivery.steering.settlesOwnerTurn"
  | "delivery.queue.supported"
  | "delivery.queue.drainAt"
  | "sessions.list"
  | "sessions.load"
  | "sessions.resume"
  | "sessions.fork"
  | "sessions.close"
  | "sessions.delete"
  | "subagents.spawn"
  | "subagents.modelOverride"
  | "subagents.effortOverride"
  | "subagents.liveMessaging";

/**
 * 模式危险等级的路径：`modes[<modeId>].risk`。
 *
 * 事实源仍是 agent——它在 `session/new` 的 mode 对象里自报 `risk`
 * （或 `_meta.risk`）时直接采信，覆盖表根本不会命中。只有 agent 什么都
 * 没说时，才由这里补一条**带实测证据**的等级。
 */
export type ModeRiskPath = `modes[${string}].risk`;

export function isModeRiskPath(path: string): path is ModeRiskPath {
  return /^modes\[.+\]\.risk$/.test(path);
}

function modeIdOf(path: string): string {
  return path.slice("modes[".length, path.lastIndexOf("].risk"));
}

/**
 * 危险等级只允许**往高了改**：`undefined → safe → elevated → full`。
 * 「没标等级」是最弱的状态（UI 不显示警告），所以补一条等级算收紧；
 * 把 `full` 改成 `safe` 是在替 agent 撤掉警告 = 放宽，一律拒绝。
 */
const RISK_TIGHTNESS: Record<string, number> = { safe: 1, elevated: 2, full: 3 };

export function riskRank(risk: unknown): number {
  return risk === undefined || risk === null ? 0 : (RISK_TIGHTNESS[String(risk)] ?? -1);
}

const BOUNDARY_TIGHTNESS: Record<string, number> = { step: 0, turn: 1, unknown: 2 };
const IDLE_TIGHTNESS: Record<string, number> = { startsNewTurn: 0, unknown: 1, promptRequired: 2 };
const DRAIN_TIGHTNESS: Record<string, number> = { immediate: 0, turnEnd: 1, unknown: 2 };

/**
 * `to` 相对 `from` 是否算"收紧"。
 * 返回 false 表示这是放宽（或无变化），`applyCorrection` 会拒绝。
 */
export function isTightening(
  path: CorrectablePath | ModeRiskPath,
  from: unknown,
  to: unknown,
): boolean {
  if (from === to) return false;
  if (isModeRiskPath(path)) return riskRank(to) > riskRank(from);
  switch (path) {
    case "delivery.steering.tier": {
      // 档位越靠后越弱：extension → concurrent 是收紧，反向是放宽。
      return tierRank(to as DeliveryTier) > tierRank(from as DeliveryTier);
    }
    case "delivery.steering.settlesOwnerTurn":
      // 承认"注入会提前结算宿主回合"这个缺陷 = 收紧。
      return from === false && to === true;
    case "delivery.steering.boundary":
      return (BOUNDARY_TIGHTNESS[String(to)] ?? -1) > (BOUNDARY_TIGHTNESS[String(from)] ?? -1);
    case "delivery.steering.idle":
      return (IDLE_TIGHTNESS[String(to)] ?? -1) > (IDLE_TIGHTNESS[String(from)] ?? -1);
    case "delivery.queue.drainAt":
      return (DRAIN_TIGHTNESS[String(to)] ?? -1) > (DRAIN_TIGHTNESS[String(from)] ?? -1);
    default:
      // 其余全是布尔能力位：只允许 true → false。
      return from === true && to === false;
  }
}

function readPath(d: CapabilityDescriptor, path: string): unknown {
  if (isModeRiskPath(path)) {
    return d.modes.find((m) => m.id === modeIdOf(path))?.risk;
  }
  return path.split(".").reduce<unknown>((acc, k) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[k];
    return undefined;
  }, d as unknown);
}

function writePath(d: CapabilityDescriptor, path: string, value: unknown): void {
  if (isModeRiskPath(path)) {
    const mode = d.modes.find((m) => m.id === modeIdOf(path));
    if (!mode) throw new Error(`descriptor 里没有模式 ${modeIdOf(path)}，无法给它标危险等级`);
    mode.risk = value as ModeRisk;
    return;
  }
  const keys = path.split(".");
  const last = keys.pop()!;
  let cur: Record<string, unknown> = d as unknown as Record<string, unknown>;
  for (const k of keys) cur = cur[k] as Record<string, unknown>;
  cur[last] = value;
}

export class LooseningRejected extends Error {
  constructor(
    readonly correctionId: string,
    readonly path: string,
    readonly from: unknown,
    readonly to: unknown,
  ) {
    super(
      `修正 ${correctionId} 试图放宽能力：${path} ${JSON.stringify(from)} → ${JSON.stringify(to)}。` +
        `覆盖表只收紧——要放宽请让 agent 在自描述里说。`,
    );
    this.name = "LooseningRejected";
  }
}

/**
 * 应用一条修正。成功返回审计记录并就地改 descriptor；
 * 放宽或无变化时抛 `LooseningRejected` / 返回 null。
 */
export function applyCorrection(
  descriptor: CapabilityDescriptor,
  spec: CorrectionSpec,
): AppliedCorrection | null {
  if (!spec.reason.trim() || !spec.evidence.trim() || !spec.versionCondition.trim()) {
    throw new Error(`修正 ${spec.id} 缺 reason / evidence / versionCondition——不可审计的修正不许进表`);
  }
  const from = readPath(descriptor, spec.path);
  if (from === spec.to) return null; // 与自描述一致，不记账。
  if (!isTightening(spec.path, from, spec.to)) {
    throw new LooseningRejected(spec.id, spec.path, from, spec.to);
  }
  // 已经记过同 id 同 path 的修正就不重复记（运行时探测可能命中多次）。
  const dup = descriptor.corrections.find((c) => c.id === spec.id && c.path === spec.path);
  if (dup) return dup;
  writePath(descriptor, spec.path, spec.to);
  const applied: AppliedCorrection = {
    id: spec.id,
    path: spec.path,
    from,
    to: spec.to,
    reason: spec.reason,
    evidence: spec.evidence,
    versionCondition: spec.versionCondition,
  };
  descriptor.corrections.push(applied);
  return applied;
}

/**
 * 静态覆盖表条目：按 agentId + 版本/探测条件匹配。
 * `match` 拿到的是刚聚合完的 descriptor 与运行时探测结果。
 */
export interface CorrectionRule extends CorrectionSpec {
  agentId: string;
  match: (ctx: CorrectionContext) => boolean;
}

export interface CorrectionContext {
  descriptor: CapabilityDescriptor;
  /**
   * 运行时探测结果。目前唯一一项：`steeringMethodNotFound` —— agent 广告了
   * steering 但扩展方法实际回 -32601。由投递阶梯首次尝试时写入。
   */
  probes: { steeringMethodNotFound?: boolean };
}

/**
 * 静态覆盖表。
 *
 * 目前只有一条，且它的触发条件是**运行时实测**而不是版本号猜测——因为
 * ZCode adapter 的 `initialize` 应答里根本没有版本字段（实测：应答只有
 * protocolVersion / agentCapabilities / sessionCapabilities / authMethods /
 * _meta），壳无法凭版本号判断它有没有实现 steering，只能凭它实际怎么答。
 */
export const STATIC_CORRECTIONS: CorrectionRule[] = [
  {
    id: "zcode.steering-advertised-but-absent",
    agentId: "zcode",
    path: "delivery.steering.tier",
    to: "concurrent" as DeliveryTier,
    versionCondition:
      "任意 ZCode adapter 版本，当 `_session/steering` 实际返回 -32601 时命中（adapter 不自报版本，只能凭实答判断）",
    reason:
      "initialize 的 `_meta.steering.supported` 广告了 steering，但扩展方法未实现。" +
      "广告 ≠ 正确，壳按实答收紧到并发档，避免每条补充消息都白跑一次扩展调用。",
    evidence:
      '实测 `_session/steering` 应答：{"code":-32601,"message":"method not found: _session/steering"}，' +
      "而同一次连接的 initialize 应答里 `_meta.steering.supported` 为 true。",
    match: (ctx) => ctx.probes.steeringMethodNotFound === true,
  },
  ...zcodeModeRiskRules(),
];

/**
 * ZCode 四个访问模式的危险等级。
 *
 * 事实源本应是 agent 自报，但实测 ZCode adapter 的 `session/new` 应答里
 * mode 对象只有 `{id, name, description}`，没有任何可推断等级的字段——
 * 所以按覆盖表补，每条都带 adapter 源码里的实测证据。agent 哪天自己报了
 * `risk`，`match` 就不再命中（只在 `risk` 为空时补），自描述自动接管。
 *
 * 证据出自 `packages/adapters/zcode/bin/zcode-acp`：
 *  - `MODE_TO_ENGINE = {"default": "build", "acceptEdits": "edit",
 *    "plan": "plan", "bypassPermissions": "yolo"}`（模式 → 引擎模式）；
 *  - `_decide_permission()` 的分支就是各模式的实际放行范围。
 */
function zcodeModeRiskRules(): CorrectionRule[] {
  const table: { modeId: string; risk: ModeRisk; engine: string; reason: string; evidence: string }[] = [
    {
      modeId: "default",
      risk: "safe",
      engine: "build",
      reason: "变更前确认：任何编辑 / 执行都要人点头，等级 safe。",
      evidence:
        "zcode-acp `_decide_permission()`：mode=default 时不命中任何自动放行分支，" +
        "一律走 `permission_cb` 转给客户端审批；`MODE_TO_ENGINE[\"default\"] = \"build\"`。",
    },
    {
      modeId: "plan",
      risk: "safe",
      engine: "plan",
      reason: "计划模式：只读工具放行，编辑 / 执行类直接拒绝，等级 safe。",
      evidence:
        "zcode-acp `_decide_permission()`：`elif mode == \"plan\" and tname not in READ_TOOLS: decision = \"deny\"`；" +
        "`MODE_TO_ENGINE[\"plan\"] = \"plan\"`。",
    },
    {
      modeId: "acceptEdits",
      risk: "elevated",
      engine: "edit",
      reason: "自动编辑：编辑类工具自动放行、不再问人，等级 elevated。",
      evidence:
        "zcode-acp `_decide_permission()`：`elif mode == \"acceptEdits\" and (tname in EDIT_TOOLS or tname in READ_TOOLS): decision = \"allow\"`，" +
        "`EDIT_TOOLS = {edit, write, multiedit, notebookedit, writestdin}`；`MODE_TO_ENGINE[\"acceptEdits\"] = \"edit\"`。",
    },
    {
      modeId: "bypassPermissions",
      risk: "full",
      engine: "yolo",
      reason: "完全访问：所有工具无条件放行（含 Bash），等级 full。",
      evidence:
        "zcode-acp `_decide_permission()`：`if mode == \"bypassPermissions\": decision = \"allow\"`（不分工具类别）；" +
        "`MODE_TO_ENGINE[\"bypassPermissions\"] = \"yolo\"`。",
    },
  ];
  return table.map((t) => ({
    id: `zcode.mode-risk.${t.modeId}`,
    agentId: "zcode",
    path: `modes[${t.modeId}].risk` as ModeRiskPath,
    to: t.risk,
    reason: t.reason,
    evidence: t.evidence,
    versionCondition:
      `任意 ZCode adapter 版本，当 session/new 自描述里 modes 含 \`${t.modeId}\`（引擎模式 ${t.engine}）` +
      "且该模式没有自报 risk 时命中；agent 一旦自报 risk 就不再命中。",
    match: (ctx: CorrectionContext) => {
      const mode = ctx.descriptor.modes.find((m) => m.id === t.modeId);
      return !!mode && mode.risk === undefined;
    },
  }));
}

/** 把静态覆盖表里命中的条目全部应用到 descriptor 上。 */
export function applyStaticCorrections(ctx: CorrectionContext): AppliedCorrection[] {
  const out: AppliedCorrection[] = [];
  for (const rule of STATIC_CORRECTIONS) {
    if (rule.agentId !== ctx.descriptor.agentId) continue;
    if (!rule.match(ctx)) continue;
    const applied = applyCorrection(ctx.descriptor, rule);
    if (applied) out.push(applied);
  }
  return out;
}
