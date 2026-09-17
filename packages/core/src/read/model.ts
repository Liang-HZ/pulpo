/**
 * 统一消息模型。
 *
 * 各渠道的原生转录形态差得很远（JSONL / SQLite / 引擎协议），但**内容是
 * 它们的，不是我们的**——读取器只做形状归一，不重写语义、不补内容、不缓存。
 * 遇到不认识的片段一律进 `unknown` 并原样保留 `raw`，绝不丢弃。
 */

import type { ChangeStat } from "../derive/changeStat.js";

export type PartKind =
  | "text"
  | "thought"
  | "tool_call"
  | "step_start"
  | "step_finish"
  | "timeline"
  | "unknown";

export interface UnifiedPart {
  kind: PartKind;
  /** 原生片段 id（去重用）。 */
  partId?: string;
  text?: string;
  tool?: {
    name: string;
    callId?: string;
    status?: "pending" | "running" | "completed" | "failed";
    input?: unknown;
    output?: unknown;
    title?: string;
    startedAt?: number;
    completedAt?: number;
    /**
     * **派生字段**：这次工具调用改了哪些文件、各自几加几减。
     * 由 core 现算（有 diff 块就数 diff，没有就按入参公式数行），
     * **算不出就没有这个字段**——不会出现 `added: 0` 这种假数据。
     * 只在工具已完成且没报错时给。不落盘。
     */
    changeStat?: ChangeStat[];
  };
  /** 原生片段原文。上层要展示原生细节时读这里。 */
  raw: unknown;
}

export interface UnifiedMessage {
  messageId: string;
  role: "user" | "assistant" | "system" | "unknown";
  createdAt?: number;
  model?: { providerId?: string; modelId?: string; variant?: string };
  parts: UnifiedPart[];
  raw: unknown;
}

export interface UnifiedTranscript {
  sessionRef: string;
  agentId: string;
  sessionId: string;
  title?: string;
  cwd?: string;
  messages: UnifiedMessage[];
  /** 读取器 id 与读取时刻——这是读穿的快照，不是副本，不落盘。 */
  readBy: string;
  readAt: number;
}

export interface SessionSummary {
  sessionRef: string;
  agentId: string;
  sessionId: string;
  title?: string;
  cwd?: string;
  updatedAt?: number;
  status?: string;
}

/**
 * 渠道读取器接口。**只读**：没有任何写方法。
 * 每个渠道一个实现；本期只有 zcode。
 */
export interface SessionReader {
  readonly id: string;
  readonly agentId: string;
  /** 列会话（可按 cwd 过滤）。 */
  list(opts?: { cwd?: string; limit?: number }): Promise<SessionSummary[]>;
  /** 读一条会话的全文。 */
  read(sessionId: string, opts?: { cwd?: string }): Promise<UnifiedTranscript>;
  /** 释放读取器持有的资源（子进程等）。 */
  dispose(): Promise<void>;
}
