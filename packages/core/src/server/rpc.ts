import { ErrorCode, RpcError } from "../errors.js";

/**
 * JSON-RPC 2.0 的编解码与分发，**与传输无关**。
 * unix socket（换行分隔）与 WebSocket（一帧一消息）共用这一套，
 * 两种传输上的方法表、参数、返回、通知完全一致。
 */

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcSuccess
  | JsonRpcFailure
  | JsonRpcNotification;

/** 一条客户端连接（socket 或 ws）在方法层看到的样子。 */
export interface ClientSession {
  readonly id: string;
  /** 主动推一条通知给这个客户端。 */
  notify(method: string, params?: unknown): void;
  /** 该客户端订阅了哪些主题。 */
  readonly subscriptions: Set<string>;
  readonly closed: boolean;
}

export type MethodHandler = (params: unknown, client: ClientSession) => Promise<unknown> | unknown;

export class MethodRouter {
  private readonly methods = new Map<string, MethodHandler>();

  register(name: string, handler: MethodHandler): this {
    if (this.methods.has(name)) throw new Error(`方法重复注册：${name}`);
    this.methods.set(name, handler);
    return this;
  }

  has(name: string): boolean {
    return this.methods.has(name);
  }

  list(): string[] {
    return [...this.methods.keys()].sort();
  }

  /**
   * 处理一条已经解析好的入站消息。
   * 返回要回给客户端的响应；通知（无 id）返回 null。
   */
  async handle(
    msg: unknown,
    client: ClientSession,
  ): Promise<JsonRpcSuccess | JsonRpcFailure | null> {
    const parsed = parseRequest(msg);
    if ("error" in parsed) {
      return { jsonrpc: "2.0", id: parsed.id, error: parsed.error };
    }
    const { id, method, params } = parsed.request;
    const isNotification = id === undefined;
    const handler = this.methods.get(method);
    if (!handler) {
      if (isNotification) return null;
      return {
        jsonrpc: "2.0",
        id: id ?? null,
        error: { code: ErrorCode.MethodNotFound, message: `未知方法：${method}` },
      };
    }
    try {
      const result = await handler(params, client);
      if (isNotification) return null;
      return { jsonrpc: "2.0", id: id ?? null, result: result ?? null };
    } catch (err) {
      if (isNotification) return null;
      return { jsonrpc: "2.0", id: id ?? null, error: toErrorObject(err) };
    }
  }
}

export function toErrorObject(err: unknown): { code: number; message: string; data?: unknown } {
  if (err instanceof RpcError) return err.toJSON();
  const e = err as { code?: unknown; message?: unknown; data?: unknown } | null;
  const code = typeof e?.code === "number" ? e.code : ErrorCode.InternalError;
  const message = typeof e?.message === "string" ? e.message : String(err);
  return e?.data === undefined ? { code, message } : { code, message, data: e.data };
}

type ParseResult =
  | { request: { id?: JsonRpcId; method: string; params?: unknown } }
  | { id: JsonRpcId; error: { code: number; message: string } };

export function parseRequest(msg: unknown): ParseResult {
  if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
    return { id: null, error: { code: ErrorCode.InvalidRequest, message: "请求必须是 JSON 对象" } };
  }
  const m = msg as Record<string, unknown>;
  const id = (m.id ?? undefined) as JsonRpcId | undefined;
  if (m.jsonrpc !== "2.0") {
    return {
      id: id ?? null,
      error: { code: ErrorCode.InvalidRequest, message: 'jsonrpc 字段必须是 "2.0"' },
    };
  }
  if (typeof m.method !== "string" || !m.method) {
    return {
      id: id ?? null,
      error: { code: ErrorCode.InvalidRequest, message: "method 必须是非空字符串" },
    };
  }
  if (id !== undefined && id !== null && typeof id !== "string" && typeof id !== "number") {
    return {
      id: null,
      error: { code: ErrorCode.InvalidRequest, message: "id 只能是 string / number / null" },
    };
  }
  const out: { id?: JsonRpcId; method: string; params?: unknown } = { method: m.method };
  if ("id" in m) out.id = id ?? null;
  if ("params" in m) out.params = m.params;
  return { request: out };
}

/** 解析一行/一帧文本。解析失败时给出标准的 -32700。 */
export function decodeFrame(text: string): { msg: unknown } | { error: JsonRpcFailure } {
  try {
    return { msg: JSON.parse(text) };
  } catch (err) {
    return {
      error: {
        jsonrpc: "2.0",
        id: null,
        error: { code: ErrorCode.ParseError, message: `JSON 解析失败：${(err as Error).message}` },
      },
    };
  }
}

export function encodeFrame(msg: JsonRpcMessage): string {
  return JSON.stringify(msg);
}

export function notification(method: string, params?: unknown): JsonRpcNotification {
  return params === undefined
    ? { jsonrpc: "2.0", method }
    : { jsonrpc: "2.0", method, params };
}
