import { describe, expect, it } from "vitest";
import {
  decodeFrame,
  encodeFrame,
  MethodRouter,
  notification,
  parseRequest,
  toErrorObject,
  type ClientSession,
} from "../../src/server/rpc.js";
import { ErrorCode, RpcError } from "../../src/errors.js";

function client(): ClientSession & { sent: { method: string; params: unknown }[] } {
  const sent: { method: string; params: unknown }[] = [];
  return {
    id: "c1",
    subscriptions: new Set<string>(),
    closed: false,
    notify: (method, params) => sent.push({ method, params }),
    sent,
  };
}

describe("JSON-RPC 编解码", () => {
  it("合法请求解析出 id / method / params", () => {
    const r = parseRequest({ jsonrpc: "2.0", id: 7, method: "core/info", params: { a: 1 } });
    expect(r).toEqual({ request: { id: 7, method: "core/info", params: { a: 1 } } });
  });

  it("通知没有 id", () => {
    const r = parseRequest({ jsonrpc: "2.0", method: "ping" });
    expect("request" in r && r.request.id).toBeUndefined();
  });

  it("jsonrpc 字段不是 2.0 → InvalidRequest", () => {
    const r = parseRequest({ jsonrpc: "1.0", id: 1, method: "x" });
    expect("error" in r && r.error.code).toBe(ErrorCode.InvalidRequest);
  });

  it("method 缺失或非字符串 → InvalidRequest", () => {
    expect(("error" in parseRequest({ jsonrpc: "2.0", id: 1 }) ? 1 : 0)).toBe(1);
    const r = parseRequest({ jsonrpc: "2.0", id: 1, method: 123 });
    expect("error" in r && r.error.code).toBe(ErrorCode.InvalidRequest);
  });

  it("id 类型非法 → InvalidRequest 且 id 回 null", () => {
    const r = parseRequest({ jsonrpc: "2.0", id: { bad: true }, method: "x" });
    expect("error" in r && r.id).toBeNull();
  });

  it("数组 / 非对象 → InvalidRequest", () => {
    expect("error" in parseRequest([1, 2])).toBe(true);
    expect("error" in parseRequest("字符串")).toBe(true);
    expect("error" in parseRequest(null)).toBe(true);
  });

  it("坏 JSON → ParseError(-32700)", () => {
    const d = decodeFrame("{ 不是 JSON");
    expect("error" in d && d.error.error.code).toBe(ErrorCode.ParseError);
    expect("error" in d && d.error.id).toBeNull();
  });

  it("编码出来的帧里没有换行，socket 分帧才安全", () => {
    const text = encodeFrame(notification("session/update", { a: "含\n换行的内容" }));
    expect(text.includes("\n")).toBe(false);
    expect(JSON.parse(text).params.a).toBe("含\n换行的内容");
  });

  it("RpcError 的 code / message / data 原样进错误对象", () => {
    const e = toErrorObject(new RpcError(-32003, "recursion blocked", { legacyExitCode: 3 }));
    expect(e).toEqual({ code: -32003, message: "recursion blocked", data: { legacyExitCode: 3 } });
  });

  it("普通 Error → InternalError", () => {
    expect(toErrorObject(new Error("炸了"))).toEqual({
      code: ErrorCode.InternalError,
      message: "炸了",
    });
  });
});

describe("方法分发", () => {
  it("正常调用回 result", async () => {
    const r = new MethodRouter().register("echo", (p) => p);
    const res = await r.handle({ jsonrpc: "2.0", id: 1, method: "echo", params: { x: 1 } }, client());
    expect(res).toEqual({ jsonrpc: "2.0", id: 1, result: { x: 1 } });
  });

  it("handler 返回 undefined 时 result 为 null（JSON-RPC 不允许缺 result）", async () => {
    const r = new MethodRouter().register("void", () => undefined);
    const res = await r.handle({ jsonrpc: "2.0", id: 1, method: "void" }, client());
    expect(res).toEqual({ jsonrpc: "2.0", id: 1, result: null });
  });

  it("未知方法 → -32601", async () => {
    const res = await new MethodRouter().handle(
      { jsonrpc: "2.0", id: 1, method: "不存在" },
      client(),
    );
    expect(res).toMatchObject({ error: { code: ErrorCode.MethodNotFound } });
  });

  it("通知不产生响应，连未知方法也不产生", async () => {
    const r = new MethodRouter().register("n", () => 1);
    expect(await r.handle({ jsonrpc: "2.0", method: "n" }, client())).toBeNull();
    expect(await r.handle({ jsonrpc: "2.0", method: "不存在" }, client())).toBeNull();
  });

  it("handler 抛 RpcError 时错误码原样透出", async () => {
    const r = new MethodRouter().register("boom", () => {
      throw new RpcError(-32003, "recursion blocked", { legacyExitCode: 3 });
    });
    const res = await r.handle({ jsonrpc: "2.0", id: 9, method: "boom" }, client());
    expect(res).toEqual({
      jsonrpc: "2.0",
      id: 9,
      error: { code: -32003, message: "recursion blocked", data: { legacyExitCode: 3 } },
    });
  });

  it("重复注册同名方法直接报错", () => {
    const r = new MethodRouter().register("a", () => 1);
    expect(() => r.register("a", () => 2)).toThrow(/重复注册/);
  });

  it("handler 能拿到发起方连接（订阅集就在上面）", async () => {
    const c = client();
    const r = new MethodRouter().register("sub", (_p, cl) => {
      cl.subscriptions.add("task/update");
      return [...cl.subscriptions];
    });
    const res = await r.handle({ jsonrpc: "2.0", id: 1, method: "sub" }, c);
    expect((res as { result: string[] }).result).toEqual(["task/update"]);
    expect(c.subscriptions.has("task/update")).toBe(true);
  });
});
