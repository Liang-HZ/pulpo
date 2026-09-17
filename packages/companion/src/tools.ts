import { z } from "zod";
import { CoreRpcError, type CoreClient } from "./coreClient.js";
import { CallerIdentity, type Caller } from "./identity.js";

/** 投递档位（PROTOCOL.md §4.6 的五档阶梯）。 */
export const DELIVERY_TIERS = [
  "native",
  "extension",
  "concurrent",
  "soft-interrupt",
  "queue",
] as const;

export const deliverySchema = z
  .object({
    tier: z
      .enum(DELIVERY_TIERS)
      .optional()
      .describe(
        "想要的起始档位。只能比目标 descriptor 自报的档位更保守（往弱压），抬不上去——能力由目标 agent 说了算。",
      ),
    max_tier: z
      .enum(DELIVERY_TIERS)
      .optional()
      .describe("允许降到的最弱档，默认 queue（排队等目标回合结束）。"),
    allow_interrupt: z
      .boolean()
      .optional()
      .describe("允许档 4（soft-interrupt）打断目标当前这一步再重投。默认 false，代价大，慎用。"),
    start_turn_if_idle: z
      .boolean()
      .optional()
      .describe("目标空闲（没有进行中的回合）时是否直接开一个新回合把消息发出去。默认 false。"),
  })
  .describe("投递偏好，逐次请求生效。省略即按目标能力自动选档。");

export type DeliveryInput = z.infer<typeof deliverySchema>;

export function toCoreDelivery(d: DeliveryInput | undefined): Record<string, unknown> {
  if (!d) return {};
  return {
    ...(d.tier ? { tier: d.tier } : {}),
    ...(d.max_tier ? { maxTier: d.max_tier } : {}),
    ...(d.allow_interrupt === undefined ? {} : { allowInterrupt: d.allow_interrupt }),
    ...(d.start_turn_if_idle === undefined ? {} : { startTurnIfIdle: d.start_turn_if_idle }),
  };
}

export interface ToolContext {
  client: CoreClient;
  identity: CallerIdentity;
  env: NodeJS.ProcessEnv;
}

export function callerLabel(caller: Caller): string {
  return caller.kind === "human" ? "human" : `${caller.agentId}:${caller.sessionRef}`;
}

/** 目标会话的能力摘要——派活回执带着它，调用方据此决定后面怎么投递。 */
export function capabilityRef(descriptor: any, sessionRef: string): Record<string, unknown> {
  const steering = descriptor?.delivery?.steering ?? {};
  return {
    session_ref: sessionRef,
    agent_type: descriptor?.agentId,
    model_id: descriptor?.currentModelId,
    thinking_effort: descriptor?.currentEffort,
    available_models: Array.isArray(descriptor?.models)
      ? descriptor.models.map((m: any) => m.id)
      : [],
    available_efforts: descriptor?.efforts ?? [],
    delivery: {
      steering_supported: steering.supported ?? false,
      steering_tier: steering.tier ?? null,
      steering_idle: steering.idle ?? null,
      queue_supported: descriptor?.delivery?.queue?.supported ?? false,
    },
    storage: descriptor?.storage ?? null,
  };
}

/** ZCode adapter 的 ACP 会话 id 比引擎原生 id 多一个 `zc-` 前缀（PROTOCOL.md §4.8）。 */
export function nativeSessionId(agentId: string, sessionId: string): string {
  return agentId === "zcode" && sessionId.startsWith("zc-") ? sessionId.slice(3) : sessionId;
}

export function splitRef(sessionRef: string): { agentId: string; sessionId: string } {
  const i = sessionRef.indexOf("#");
  if (i <= 0) throw new Error(`sessionRef 格式错误：${sessionRef}`);
  return { agentId: sessionRef.slice(0, i), sessionId: sessionRef.slice(i + 1) };
}

/**
 * `get_task` 的 summary：优先用 core 任务登记里的结论（它是目标会话这一轮的
 * agent 正文）。结论为空（例如这一轮只有工具调用）时读穿目标会话的转录，
 * 取最近一条 assistant 文本——**不返回占位符**。
 */
export async function resolveSummary(
  client: CoreClient,
  task: { summary?: string; sessionRef: string; agentId: string; cwd: string; status: string },
): Promise<{ summary: string; summarySource: "task" | "transcript" | "none"; note?: string }> {
  const direct = (task.summary ?? "").trim();
  if (direct) return { summary: direct, summarySource: "task" };
  if (task.status === "queued" || task.status === "running" || task.status === "awaiting_approval") {
    return { summary: "", summarySource: "none", note: "回合还没结束，目标尚未给出结论" };
  }
  try {
    const { agentId, sessionId } = splitRef(task.sessionRef);
    const transcript = await client.call<{ messages?: any[] }>("read/transcript", {
      agentId,
      sessionId: nativeSessionId(agentId, sessionId),
      cwd: task.cwd,
    });
    const texts: string[] = [];
    for (const m of transcript.messages ?? []) {
      if (m?.role !== "assistant") continue;
      const t = (m.parts ?? [])
        .filter((p: any) => p?.kind === "text" && typeof p.text === "string")
        .map((p: any) => p.text)
        .join("");
      if (t.trim()) texts.push(t);
    }
    const last = texts.at(-1)?.trim() ?? "";
    if (last) return { summary: last, summarySource: "transcript" };
    return { summary: "", summarySource: "none", note: "目标会话里没有任何 agent 正文" };
  } catch (err) {
    return {
      summary: "",
      summarySource: "none",
      note: `读穿目标会话失败：${(err as Error).message}`,
    };
  }
}

export function errorPayload(err: unknown): Record<string, unknown> {
  if (err instanceof CoreRpcError) {
    const data = (err.data ?? null) as { legacyExitCode?: number } | null;
    const payload: Record<string, unknown> = {
      error: err.message,
      code: err.code,
      data,
    };
    if (err.code === -32003) {
      payload.legacyExitCode = data?.legacyExitCode ?? 3;
      payload.hint =
        "一层熔断：你自己就是被派活出来的会话，不能再往外派活。把需要的工作自己做完，或把结论回给派你活的那一方。";
    }
    return payload;
  }
  return { error: (err as Error)?.message ?? String(err) };
}

export const TOOL_DESCRIPTIONS = {
  list_agents:
    "列出 pulpo 能派活的渠道（agent），以及每个渠道自报的模型目录、思考强度档位、当前模型 / 当前强度、" +
    "投递（steering）能力。**派活前先调一次**：`delegate_to_agent` 的 `agent_type` / `model_id` / " +
    "`thinking_effort` 取值全部来自这里，不要凭印象猜——模型 id 是各渠道自己的写法（可能含中文），必须原样回传。" +
    "某个渠道当前没有活动会话时，它的模型目录读不到（能力事实源是 agent 的会话自描述），返回里会写明原因。",
  delegate_to_agent:
    "把一件独立的子任务派给另一个渠道的 agent 去做（跨渠道派活）。适用于：这件事更适合另一个渠道的模型 / 额度 / 工具，" +
    "或者你想并行推进一条互不依赖的支线。派出去之后立刻返回 task_id，不阻塞你自己这一轮——用 `get_task` 查进度和结论，" +
    "用 `send_input` 中途补充信息，用 `cancel_task` 撤销。\n" +
    "`agent_type` 取 `list_agents` 里的 agent_type；`model_id` / `thinking_effort` 取该渠道 descriptor 里的 " +
    "available_models / available_efforts（不给就用它的默认）；填了目标不认识的值会当场报错，不会静默回落。\n" +
    "**一层限制**：派活只允许一层。如果你自己就是被别人派活出来的会话，调这个工具会被拒（错误里带 legacyExitCode 3）——" +
    "那时请自己完成工作，不要再往下派。",
  send_input:
    "给一个已经派出去的任务补充信息 / 修正要求。目标是任务所在的**主会话**，消息前会自动标注来源（原生端可见）。\n" +
    "回执 `outcome` 如实反映目标收没收到：injected = 目标收下了；queued = 只进了 pulpo 的队列，还没到 agent；" +
    "no_active_turn = 目标当时没有进行中的回合（消息没被投出去，可用 delivery.start_turn_if_idle 让它开新回合）；" +
    "completed_race = 决策到投递之间目标那一轮结束了；unsupported = 阶梯上没有一档可用。回执里的 `tier` 是实际走的档位。",
  get_task:
    "查一个派出去的任务：status（queued / running / awaiting_approval / done / failed / cancelled）、" +
    "summary（目标给出的结论正文，来自目标会话最近的 agent 文本）、session_ref（目标的原生会话位置，可在壳里看全轨迹）。" +
    "任务在后台跑，需要结论时轮询这个工具；awaiting_approval 表示目标卡在一条需要人批准的操作上。",
  cancel_task: "撤销一个还在跑的派活任务。已经结束的任务如实回 ok=false，不假装成功。",
} as const;

export const toolSchemas = {
  list_agents: {},
  delegate_to_agent: {
    agent_type: z
      .string()
      .describe("目标渠道 id，取自 list_agents 的 agent_type（如 zcode）。"),
    task: z
      .string()
      .describe("给目标 agent 的任务描述。它看不到你的上下文，要自带背景、验收标准与边界。"),
    working_dir: z
      .string()
      .optional()
      .describe("目标会话的工作目录，必须是绝对路径。不填则沿用你自己会话的工作目录。"),
    model_id: z
      .string()
      .optional()
      .describe(
        "目标渠道的模型 id，取自 list_agents 里该渠道的 available_models，原样回传（可能含中文）。不填用它的当前模型。",
      ),
    thinking_effort: z
      .string()
      .optional()
      .describe("思考强度，取自 list_agents 里该渠道的 available_efforts（如 low / medium / high / max）。"),
    delivery: deliverySchema.optional(),
  },
  send_input: {
    task_id: z.string().optional().describe("delegate_to_agent 返回的 task_id。与 session_ref 二选一。"),
    session_ref: z
      .string()
      .optional()
      .describe("目标会话 ref（<agent_type>#<session_id>）。与 task_id 二选一。"),
    message: z.string().describe("要补充给目标的内容。"),
    delivery: deliverySchema.optional(),
  },
  get_task: {
    task_id: z.string().describe("delegate_to_agent 返回的 task_id。"),
  },
  cancel_task: {
    task_id: z.string().describe("delegate_to_agent 返回的 task_id。"),
  },
} as const;

export const TOOL_NAMES = [
  "list_agents",
  "delegate_to_agent",
  "send_input",
  "get_task",
  "cancel_task",
] as const;
