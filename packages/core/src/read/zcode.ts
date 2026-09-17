import { makeSessionRef } from "../acp/kernel.js";
import { changeStatOf } from "../derive/changeStat.js";
import type {
  SessionReader,
  SessionSummary,
  UnifiedMessage,
  UnifiedPart,
  UnifiedTranscript,
} from "./model.js";
import {
  ZcodeEngine,
  buildProviderRegistry,
  type EngineSessionInfo,
  type EngineWorkspace,
} from "./zcodeEngine.js";

interface EnginePart {
  type?: string;
  partId?: string;
  text?: string;
  tool?: string;
  callId?: string;
  state?: {
    status?: string;
    input?: unknown;
    output?: unknown;
    title?: string;
    startedAt?: number;
    completedAt?: number;
  };
  [k: string]: unknown;
}

interface EngineMessageShape {
  info?: {
    messageId?: string;
    role?: string;
    time?: { created?: number };
    model?: { providerId?: string; modelId?: string; variant?: string };
  };
  parts?: EnginePart[];
}

/**
 * ZCode 会话读取器。
 *
 * **只读**：只调 `session/list` / `workspace/updateProviderRegistry` /
 * `session/resume` / `session/read` / `session/close`，不写、不改、不缓存。
 *
 * 一处必须说清的副作用：ZCode 引擎的 `session/read` 只对 active 会话有效
 * （实测：历史会话直接读回 `-32004 Session is not active`），所以读一条历史
 * 会话必须先 `session/resume` 把它激活。读完立刻 `session/close` 还原。
 * 这是引擎的读取方式，不是我们在建第二存储——读到的内容一律不落盘。
 */
export class ZcodeReader implements SessionReader {
  readonly id = "zcode";
  readonly agentId = "zcode";

  private engine: ZcodeEngine | null = null;

  constructor(
    private readonly opts: { cwd: string; env?: NodeJS.ProcessEnv; cjs?: string },
  ) {}

  private ensureEngine(): ZcodeEngine {
    if (this.engine?.alive) return this.engine;
    const engineOpts: { cwd: string; env?: NodeJS.ProcessEnv; cjs?: string } = { cwd: this.opts.cwd };
    if (this.opts.env) engineOpts.env = this.opts.env;
    if (this.opts.cjs) engineOpts.cjs = this.opts.cjs;
    this.engine = new ZcodeEngine(engineOpts);
    this.engine.start();
    return this.engine;
  }

  async list(opts: { cwd?: string; limit?: number } = {}): Promise<SessionSummary[]> {
    const engine = this.ensureEngine();
    const params: Record<string, unknown> = {
      includeArchived: false,
      limit: opts.limit ?? 50,
    };
    if (opts.cwd) {
      params.workspace = { workspacePath: opts.cwd, workspaceKey: opts.cwd };
    }
    const res = await engine.call<{ sessions?: EngineSessionInfo[] }>("session/list", params);
    const all = res?.sessions ?? [];
    // 引擎对 workspace 过滤不是硬约束（实测会回全量），这里按 cwd 自己再筛一次。
    const filtered = opts.cwd
      ? all.filter((s) => s.workspace?.workspacePath === opts.cwd)
      : all;
    return filtered.map((s) => {
      const summary: SessionSummary = {
        sessionRef: makeSessionRef(this.agentId, s.sessionId),
        agentId: this.agentId,
        sessionId: s.sessionId,
      };
      if (s.title) summary.title = s.title;
      if (s.workspace?.workspacePath) summary.cwd = s.workspace.workspacePath;
      if (s.updatedAt !== undefined) summary.updatedAt = s.updatedAt;
      if (s.status) summary.status = s.status;
      return summary;
    });
  }

  async read(sessionId: string, opts: { cwd?: string } = {}): Promise<UnifiedTranscript> {
    const engine = this.ensureEngine();
    const bare = sessionId.startsWith(`${this.agentId}#`)
      ? sessionId.slice(this.agentId.length + 1)
      : sessionId;

    // 1) 会话身份 = 它自己的 workspace 二元组，从 session/list 记录里取；
    //    自己编 workspaceKey 会让引擎判模型不可用。
    const listed = await engine.call<{ sessions?: EngineSessionInfo[] }>("session/list", {
      includeArchived: false,
      limit: 200,
    });
    const info = (listed?.sessions ?? []).find((s) => s.sessionId === bare);
    const workspace: EngineWorkspace =
      info?.workspace ??
      (opts.cwd
        ? { workspacePath: opts.cwd, workspaceKey: opts.cwd }
        : { workspacePath: this.opts.cwd, workspaceKey: this.opts.cwd });

    // 2) 推 provider 注册表（resume 前置）。
    const registry = buildProviderRegistry(this.opts.env ?? process.env);
    if (registry) {
      await engine.call("workspace/updateProviderRegistry", { workspace, registry });
    }

    // 3) 激活 → 读 → 还原。session/read 只对 active 会话有效。
    let messages: EngineMessageShape[] = [];
    let resumed = false;
    try {
      const r = await engine.call<{ messages?: EngineMessageShape[] }>("session/resume", {
        sessionId: bare,
        workspace,
      });
      resumed = true;
      messages = r?.messages ?? [];
      const full = await engine.call<{ messages?: EngineMessageShape[] }>("session/read", {
        sessionId: bare,
      });
      if (Array.isArray(full?.messages)) messages = full.messages;
    } finally {
      if (resumed) {
        await engine.call("session/close", { sessionId: bare }).catch(() => undefined);
      }
    }

    const transcript: UnifiedTranscript = {
      sessionRef: makeSessionRef(this.agentId, bare),
      agentId: this.agentId,
      sessionId: bare,
      messages: messages.map((m) => toUnifiedMessage(m)),
      readBy: this.id,
      readAt: Date.now(),
    };
    if (info?.title) transcript.title = info.title;
    if (workspace.workspacePath) transcript.cwd = workspace.workspacePath;
    return transcript;
  }

  async dispose(): Promise<void> {
    await this.engine?.stop();
    this.engine = null;
  }
}

function toUnifiedMessage(m: EngineMessageShape): UnifiedMessage {
  const role = m.info?.role;
  const out: UnifiedMessage = {
    messageId: String(m.info?.messageId ?? ""),
    role:
      role === "user" || role === "assistant" || role === "system"
        ? role
        : "unknown",
    parts: (m.parts ?? []).map(toUnifiedPart),
    raw: m,
  };
  if (m.info?.time?.created !== undefined) out.createdAt = m.info.time.created;
  if (m.info?.model) out.model = m.info.model;
  return out;
}

/**
 * 引擎片段 → 统一片段。
 * 实测到的 type 全集：`text` / `reasoning` / `tool` / `step-start` /
 * `step-finish` / `timeline`。不认识的一律 `unknown` 并保留 raw。
 */
function toUnifiedPart(p: EnginePart): UnifiedPart {
  const base: UnifiedPart = { kind: "unknown", raw: p };
  if (p.partId) base.partId = p.partId;
  switch (p.type) {
    case "text":
      base.kind = "text";
      base.text = p.text ?? "";
      return base;
    case "reasoning":
      base.kind = "thought";
      base.text = p.text ?? "";
      return base;
    case "tool": {
      base.kind = "tool_call";
      const st = p.state ?? {};
      const tool: NonNullable<UnifiedPart["tool"]> = { name: String(p.tool ?? "") };
      if (p.callId) tool.callId = p.callId;
      tool.status = normalizeToolStatus(st.status);
      if (st.input !== undefined) tool.input = st.input;
      if (st.output !== undefined) tool.output = st.output;
      if (st.title) tool.title = st.title;
      if (st.startedAt !== undefined) tool.startedAt = st.startedAt;
      if (st.completedAt !== undefined) tool.completedAt = st.completedAt;
      // 派生的 +N −N。只给已完成且没报错的工具——失败的编辑一行都不算。
      if (tool.status === "completed") {
        const stats = changeStatOf(
          {
            sessionUpdate: "tool_call",
            ...(Array.isArray(st.output) ? { content: st.output } : {}),
            rawInput: st.input,
            ...(st.title ? { title: st.title } : {}),
          },
          tool.name,
        );
        if (stats.length) tool.changeStat = stats;
      }
      base.tool = tool;
      return base;
    }
    case "step-start":
      base.kind = "step_start";
      return base;
    case "step-finish":
      base.kind = "step_finish";
      return base;
    case "timeline":
      base.kind = "timeline";
      return base;
    default:
      return base;
  }
}

function normalizeToolStatus(s: unknown): "pending" | "running" | "completed" | "failed" {
  switch (String(s ?? "")) {
    case "completed":
      return "completed";
    case "error":
    case "failed":
      return "failed";
    case "running":
    case "started":
      return "running";
    default:
      return "pending";
  }
}
