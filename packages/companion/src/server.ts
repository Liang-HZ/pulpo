import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CoreRpcError, type CoreClient } from "./coreClient.js";
import { CallerIdentity, attributionFor } from "./identity.js";
import {
  TOOL_DESCRIPTIONS,
  callerLabel,
  capabilityRef,
  errorPayload,
  resolveSummary,
  toCoreDelivery,
  toolSchemas,
  type DeliveryInput,
} from "./tools.js";

export const COMPANION_NAME = "pulpo";
export const COMPANION_VERSION = "0.1.1";

export interface CompanionOptions {
  client: CoreClient;
  env?: NodeJS.ProcessEnv;
  identity?: CallerIdentity;
}

type ToolPayload = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(payload: unknown): ToolPayload {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function fail(payload: unknown): ToolPayload {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError: true };
}

async function guarded(fn: () => Promise<ToolPayload>): Promise<ToolPayload> {
  try {
    return await fn();
  } catch (err) {
    return fail(errorPayload(err));
  }
}

/**
 * companion MCP 服务器。
 *
 * 它自己**不持任何状态、不起 agent 子进程**：四件套全部落到 core 的
 * `task/*` 与 `delivery/*`（PROTOCOL.md §4.6 / §4.9）。一层熔断也在 core——
 * companion 只负责把"我是谁"（callerRef）如实报上去。
 */
export function createCompanionServer(opts: CompanionOptions): McpServer {
  const env = opts.env ?? process.env;
  const client = opts.client;
  const identity = opts.identity ?? new CallerIdentity({ env, client });

  const server = new McpServer(
    { name: COMPANION_NAME, version: COMPANION_VERSION },
    {
      instructions:
        "pulpo companion：把子任务派给别的渠道（agent）去做。先 list_agents 看有哪些渠道与它们的模型/思考强度，" +
        "再 delegate_to_agent 派活，用 get_task 取结论、send_input 补充、cancel_task 撤销。派活只允许一层。",
    },
  );

  server.registerTool(
    "list_agents",
    { title: "列出可派活的渠道与其模型目录", description: TOOL_DESCRIPTIONS.list_agents, inputSchema: toolSchemas.list_agents },
    async () =>
      guarded(async () => {
        const caller = await identity.resolve();
        const agents = await client.call<any[]>("agent/list", {});
        const out = [];
        for (const a of agents) {
          try {
            const d = await client.call<any>("agent/descriptor", { agentId: a.agentId });
            out.push({
              agent_type: a.agentId,
              label: a.label,
              storage: a.storage,
              current_model_id: d.currentModelId ?? null,
              current_thinking_effort: d.currentEffort ?? null,
              available_models: (d.models ?? []).map((m: any) => ({
                model_id: m.id,
                label: m.label,
                efforts: m.efforts ?? [],
                default_effort: m.defaultEffort ?? null,
                total_context_tokens: m.totalContextTokens ?? null,
              })),
              available_efforts: d.efforts ?? [],
              delivery: capabilityRef(d, "").delivery,
              descriptor_available: true,
            });
          } catch (err) {
            out.push({
              agent_type: a.agentId,
              label: a.label,
              storage: a.storage,
              descriptor_available: false,
              reason:
                err instanceof CoreRpcError
                  ? err.message
                  : `拿不到能力描述符：${(err as Error).message}`,
              note:
                "能力事实源是 agent 自己的会话自描述；这个渠道当前没有活动会话，模型目录读不到。" +
                "仍然可以派活（不指定 model_id / thinking_effort 就用它的默认）。",
            });
          }
        }
        return ok({ caller: callerLabel(caller), agents: out });
      }),
  );

  server.registerTool(
    "delegate_to_agent",
    { title: "跨渠道派活", description: TOOL_DESCRIPTIONS.delegate_to_agent, inputSchema: toolSchemas.delegate_to_agent },
    async (args) =>
      guarded(async () => {
        const caller = await identity.resolve();
        const cwd =
          args.working_dir ??
          (caller.kind === "agent" ? caller.cwd : undefined) ??
          env.PULPO_DEFAULT_CWD ??
          process.cwd();
        if (!path.isAbsolute(cwd)) {
          return fail({
            error: `working_dir 必须是绝对路径，收到：${cwd}`,
            code: -32602,
          });
        }
        const params: Record<string, unknown> = {
          agentId: args.agent_type,
          task: args.task,
          cwd,
          delivery: toCoreDelivery(args.delivery as DeliveryInput | undefined),
        };
        if (args.model_id) params.modelId = args.model_id;
        if (args.thinking_effort) params.effort = args.thinking_effort;
        if (caller.kind === "agent") params.callerRef = caller.sessionRef;
        const res = await client.call<any>("task/delegate", params);
        return ok({
          task_id: res.taskId,
          session_ref: res.sessionRef,
          capability_ref: capabilityRef(res.capabilityRef, res.sessionRef),
          caller: callerLabel(caller),
          working_dir: cwd,
          next: "用 get_task 轮询结论；需要补充信息用 send_input。",
        });
      }),
  );

  server.registerTool(
    "send_input",
    { title: "给派出去的任务补一句", description: TOOL_DESCRIPTIONS.send_input, inputSchema: toolSchemas.send_input },
    async (args) =>
      guarded(async () => {
        if (!args.task_id && !args.session_ref) {
          return fail({ error: "要给 task_id 或 session_ref 其中之一", code: -32602 });
        }
        const caller = await identity.resolve();
        const attribution = attributionFor(caller);
        const params: Record<string, unknown> = {
          message: args.message,
          attribution,
          delivery: toCoreDelivery(args.delivery as DeliveryInput | undefined),
        };
        if (args.task_id) params.taskId = args.task_id;
        if (args.session_ref) params.sessionRef = args.session_ref;
        const receipt = await client.call<any>("task/send_input", params);
        return ok({
          outcome: receipt.outcome,
          tier: receipt.tier,
          requested_tier: receipt.requestedTier,
          attempts: receipt.attempts,
          turn_active: receipt.turnActive,
          session_ref: receipt.sessionRef,
          attribution,
          caller: callerLabel(caller),
        });
      }),
  );

  server.registerTool(
    "get_task",
    { title: "查派活任务的状态与结论", description: TOOL_DESCRIPTIONS.get_task, inputSchema: toolSchemas.get_task },
    async (args) =>
      guarded(async () => {
        const caller = await identity.resolve();
        const t = await client.call<any>("task/get", { taskId: args.task_id });
        const { summary, summarySource, note } = await resolveSummary(client, t);
        return ok({
          task_id: t.taskId,
          status: t.status,
          summary,
          summary_source: summarySource,
          ...(note ? { note } : {}),
          session_ref: t.sessionRef,
          agent_type: t.agentId,
          model_id: t.modelId ?? null,
          thinking_effort: t.effort ?? null,
          stop_reason: t.stopReason ?? null,
          ...(t.error ? { failure: t.error } : {}),
          working_dir: t.cwd,
          caller: callerLabel(caller),
        });
      }),
  );

  server.registerTool(
    "cancel_task",
    { title: "撤销派活任务", description: TOOL_DESCRIPTIONS.cancel_task, inputSchema: toolSchemas.cancel_task },
    async (args) =>
      guarded(async () => {
        const res = await client.call<{ ok: boolean }>("task/cancel", { taskId: args.task_id });
        return ok({
          ok: res.ok,
          ...(res.ok ? {} : { reason: "任务已经结束（done / failed / cancelled），没有可撤销的回合" }),
        });
      }),
  );

  return server;
}
