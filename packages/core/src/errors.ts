/**
 * pulpo 的 JSON-RPC 错误码。
 *
 * -32700..-32600 与 -32603/-32602/-32601 沿用 JSON-RPC 2.0 标准含义；
 * -32000 段是 pulpo 自有的应用错误。
 */
export const ErrorCode = {
  /** JSON-RPC 2.0 标准码 */
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,

  /** 泛化的 agent 侧失败（把 agent 原始错误放进 data.cause）。 */
  AgentError: -32000,
  /** 引用了不存在的 agent / session / task / node。 */
  NotFound: -32001,
  /** agent 不具备该能力（descriptor 说了不支持，或 agent 回 -32601）。 */
  Unsupported: -32002,
  /**
   * 一层熔断：被派活的会话不得再往外派活。
   * message 为 "recursion blocked (one-level dispatch only)"，
   * error.data.legacyExitCode = 3。
   */
  RecursionBlocked: -32003,
  /** 审批请求超时未应答（按默认拒绝结算）。 */
  ApprovalTimeout: -32004,
  /** daemon 正在关停。 */
  ShuttingDown: -32005,
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }

  toJSON(): { code: number; message: string; data?: unknown } {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data };
  }
}

export function notFound(what: string): RpcError {
  return new RpcError(ErrorCode.NotFound, what);
}

export function invalidParams(message: string): RpcError {
  return new RpcError(ErrorCode.InvalidParams, message);
}

export function unsupported(message: string, data?: unknown): RpcError {
  return new RpcError(ErrorCode.Unsupported, message, data);
}

export function recursionBlocked(sessionRef: string): RpcError {
  return new RpcError(
    ErrorCode.RecursionBlocked,
    "recursion blocked (one-level dispatch only)",
    { legacyExitCode: 3, sessionRef },
  );
}

/** 判断一个 agent 侧错误是不是 "method not found"。 */
export function isMethodNotFound(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === ErrorCode.MethodNotFound) return true;
  const msg = (err as { message?: unknown } | null)?.message;
  return typeof msg === "string" && /method not found/i.test(msg);
}
