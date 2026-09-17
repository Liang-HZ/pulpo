import type { AgentBootstrap } from "./registry.js";
import type {
  CapabilityDescriptor,
  DeliveryTier,
  ModeCapability,
  ModeRisk,
  ModelCapability,
} from "./types.js";

/** `initialize` 应答里我们会读的字段（宽松结构——agent 想多说什么都留在 raw 里）。 */
interface InitializeShape {
  protocolVersion?: number;
  agentCapabilities?: {
    loadSession?: boolean;
    promptCapabilities?: Record<string, unknown>;
  };
  sessionCapabilities?: Record<string, unknown>;
  agentInfo?: { name?: string; version?: string };
  _meta?: {
    steering?: {
      supported?: boolean;
      method?: string;
      boundary?: string;
      idle?: string;
      settlesOwnerTurn?: boolean;
      tier?: string;
    };
    [k: string]: unknown;
  };
}

/**
 * agent 自报的 mode 对象。ACP 只规定了 `id` / `name`，但**任何能推断危险等级的
 * 字段都算自报**（事实源是 agent）：`risk` / `_meta.risk` / `dangerLevel` /
 * `permissionLevel` 都认，认不出来才轮到修正覆盖表。
 */
interface ModeSelfDescription {
  id?: string;
  name?: string;
  description?: string;
  risk?: string;
  dangerLevel?: string;
  permissionLevel?: string;
  _meta?: { risk?: string; [k: string]: unknown };
}

interface ConfigOption {
  id?: string;
  name?: string;
  category?: string;
  type?: string;
  currentValue?: unknown;
  options?: { value?: unknown; name?: string; description?: string }[];
}

interface NewSessionShape {
  sessionId?: string;
  models?: {
    availableModels?: {
      modelId?: string;
      label?: string;
      totalContextTokens?: number;
      supportsReasoningEffort?: boolean;
    }[];
    currentModelId?: string;
  };
  configOptions?: ConfigOption[];
  modes?: {
    currentModeId?: string;
    availableModes?: ModeSelfDescription[];
  };
}

/** `_session/steering` — ACP 生态约定的 steering 扩展方法名。 */
export const STEERING_METHOD = "_session/steering";

/**
 * 从 `initialize` 应答建一份 descriptor 骨架。
 *
 * 这一步完全采信 agent 自描述：它说支持什么就是什么。收紧发生在
 * `overrides.ts`，且必须带实测证据。
 */
export function descriptorFromInitialize(
  agentId: string,
  boot: AgentBootstrap,
  init: unknown,
): CapabilityDescriptor {
  const i = (init ?? {}) as InitializeShape;
  const sc = i.sessionCapabilities ?? {};
  const steering = i._meta?.steering;
  const steeringSupported = steering?.supported === true;

  // 广告了 steering 扩展 → 档 2（extension）；没广告 → 先落在并发档，
  // 由投递阶梯按实答再收紧。壳不替 agent 声称它有更强的能力。
  const tier: DeliveryTier = steeringSupported ? "extension" : "concurrent";

  return {
    agentId,
    agentName: i.agentInfo?.name,
    version: i.agentInfo?.version,
    protocolVersion: typeof i.protocolVersion === "number" ? i.protocolVersion : 0,
    delivery: {
      steering: {
        supported: steeringSupported,
        tier: (steering?.tier as DeliveryTier | undefined) ?? tier,
        boundary: (steering?.boundary as "step" | "turn" | undefined) ?? "unknown",
        idle:
          (steering?.idle as "promptRequired" | "startsNewTurn" | undefined) ?? "unknown",
        settlesOwnerTurn: steering?.settlesOwnerTurn === true,
        method: steering?.method ?? STEERING_METHOD,
      },
      // 排队是壳自己的兜底能力，永远可用；drainAt 是"下一回合发送"。
      queue: { supported: true, drainAt: "turnEnd" },
    },
    sessions: {
      list: "list" in sc,
      load: i.agentCapabilities?.loadSession === true,
      resume: "resume" in sc,
      fork: "fork" in sc,
      close: "close" in sc,
      delete: "delete" in sc,
    },
    models: [],
    efforts: [],
    modes: [],
    subagents: {
      // 原生 subagent 的存在与否要从会话流/读取层观测，initialize 不载明；
      // 壳不猜——留 false，由读取层看到 subagent 节点后再置真（见 graph）。
      spawn: false,
      modelOverride: false,
      effortOverride: false,
      liveMessaging: false,
    },
    transports: { acp: true, mcp: [] },
    storage: { ...boot.storage, reader: boot.reader },
    raw: { initialize: init },
    corrections: [],
    aggregatedAt: Date.now(),
  };
}

/**
 * 用 `session/new`（或 `session/resume`）应答把 models / efforts / modes 聚合进
 * descriptor。**模型与思考强度的事实源就是这里**——configOptions 与 models
 * 两处都读，取并集，原样保留 agent 给的 id，不重命名、不映射。
 */
export function mergeSessionSelfDescription(
  descriptor: CapabilityDescriptor,
  newSession: unknown,
): CapabilityDescriptor {
  const s = (newSession ?? {}) as NewSessionShape;
  const opts = Array.isArray(s.configOptions) ? s.configOptions : [];

  // effort 维度：configOptions 里 id 含 effort / reasoning 的那一项。
  const effortOpt = opts.find(
    (o) => typeof o.id === "string" && /effort|reasoning|thinking/i.test(o.id),
  );
  const efforts = (effortOpt?.options ?? [])
    .map((o) => String(o.value ?? ""))
    .filter(Boolean);
  const currentEffort =
    effortOpt?.currentValue === undefined ? undefined : String(effortOpt.currentValue);

  // model 维度：configOptions(category=model, id=model) 与 models.availableModels 取并集。
  const modelOpt = opts.find((o) => o.id === "model");
  const byId = new Map<string, ModelCapability>();
  for (const o of modelOpt?.options ?? []) {
    const id = String(o.value ?? "");
    if (!id) continue;
    byId.set(id, { id, label: o.name, efforts: [...efforts], defaultEffort: currentEffort });
  }
  for (const m of s.models?.availableModels ?? []) {
    const id = String(m.modelId ?? "");
    if (!id) continue;
    const prev = byId.get(id);
    // supportsReasoningEffort=false 的模型不给它安 effort 档位。
    const modelEfforts = m.supportsReasoningEffort === false ? [] : [...efforts];
    byId.set(id, {
      id,
      label: m.label ?? prev?.label,
      efforts: modelEfforts,
      defaultEffort: modelEfforts.length ? currentEffort : undefined,
      totalContextTokens: m.totalContextTokens,
    });
  }

  const modeOpt = opts.find((o) => o.id === "mode" || o.category === "mode");
  const modes: ModeCapability[] = (s.modes?.availableModes ?? []).map((m) => {
    const mode: ModeCapability = { id: String(m.id ?? "") };
    if (m.name !== undefined) mode.name = m.name;
    if (m.description !== undefined) mode.description = m.description;
    const risk = selfReportedRisk(m);
    if (risk) mode.risk = risk;
    return mode;
  });
  if (!modes.length && modeOpt) {
    for (const o of modeOpt.options ?? []) {
      const id = String(o.value ?? "");
      if (!id) continue;
      const mode: ModeCapability = { id };
      if (o.name !== undefined) mode.name = o.name;
      if (o.description !== undefined) mode.description = o.description;
      const risk = selfReportedRisk(o as ModeSelfDescription);
      if (risk) mode.risk = risk;
      modes.push(mode);
    }
  }

  descriptor.models = [...byId.values()];
  descriptor.currentModelId =
    s.models?.currentModelId ??
    (modelOpt?.currentValue === undefined ? undefined : String(modelOpt.currentValue));
  descriptor.efforts = efforts;
  descriptor.currentEffort = currentEffort;
  descriptor.modes = modes.filter((m) => m.id);
  descriptor.currentModeId =
    s.modes?.currentModeId ??
    (modeOpt?.currentValue === undefined ? undefined : String(modeOpt.currentValue));
  descriptor.raw.newSession = newSession;
  descriptor.aggregatedAt = Date.now();
  return descriptor;
}

/** configOptions 里承载 effort 的那一项的 id（set_config_option 要用）。 */
export function effortConfigId(newSession: unknown): string | undefined {
  const s = (newSession ?? {}) as NewSessionShape;
  const opt = (s.configOptions ?? []).find(
    (o) => typeof o.id === "string" && /effort|reasoning|thinking/i.test(o.id),
  );
  return opt?.id;
}

/**
 * agent 自报的危险等级。认 `risk` / `_meta.risk` / `dangerLevel` /
 * `permissionLevel` 四个写法，值归一到 `safe|elevated|full`。
 * 认不出来返回 undefined —— 留给修正覆盖表补（只收紧、带证据）。
 */
export function selfReportedRisk(mode: unknown): ModeRisk | undefined {
  if (!mode || typeof mode !== "object") return undefined;
  const m = mode as {
    risk?: unknown;
    dangerLevel?: unknown;
    permissionLevel?: unknown;
    _meta?: { risk?: unknown };
  };
  const raw = m.risk ?? m._meta?.risk ?? m.dangerLevel ?? m.permissionLevel;
  if (typeof raw !== "string") return undefined;
  switch (raw.trim().toLowerCase()) {
    case "safe":
    case "low":
    case "readonly":
    case "read-only":
      return "safe";
    case "elevated":
    case "medium":
    case "moderate":
      return "elevated";
    case "full":
    case "high":
    case "danger":
    case "dangerous":
    case "bypass":
      return "full";
    default:
      return undefined;
  }
}
