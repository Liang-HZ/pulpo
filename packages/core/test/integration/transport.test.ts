import { afterAll, beforeAll, describe, expect, it } from "vitest";
import net from "node:net";
import os from "node:os";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { PulpoDaemon } from "../../src/server/daemon.js";
import { RpcClient, makeTestEnv, startDaemon, type TestEnv } from "../helpers.js";

/**
 * 两条传输的等价性。
 * 不碰模型——这些用例只验协议壳本身，跑得快、不烧额度。
 */
let t: TestEnv;
let daemon: PulpoDaemon;
let unix: RpcClient;
let ws: RpcClient;

beforeAll(async () => {
  t = makeTestEnv("transport");
  daemon = await startDaemon(t);
  unix = await RpcClient.unix(daemon.socketPath!);
  ws = await RpcClient.websocket(daemon.wsPort!);
});

afterAll(async () => {
  unix?.close();
  ws?.close();
  await daemon?.stop();
  t?.cleanup();
});

describe("传输层", () => {
  it("unix socket 与 WebSocket 同时可用，端口是动态分配的", () => {
    expect(daemon.socketPath).toContain(t.home);
    expect(fs.existsSync(daemon.socketPath!)).toBe(true);
    expect(daemon.wsPort).toBeGreaterThan(0);
  });

  it("WebSocket 只绑 127.0.0.1（以内核的 LISTEN 表为准）", async () => {
    // 判据是内核里真实的监听地址，不是"连得上/连不上"——本机装了 TUN 模式
    // 代理时，198.18.0.0/16 这类 fake-ip 地址对**任意端口**都会握手成功
    // （实测：无人监听的 59999 / 60001 / 12345 全部 CONNECTED，而
    // 127.0.0.1 上同样的端口一律 ECONNREFUSED），"连得上"根本不证明
    // 我们在那儿监听。
    const out = execFileSync("lsof", ["-nP", `-iTCP:${daemon.wsPort}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
    });
    const listens = out
      .split("\n")
      .slice(1)
      .filter((l) => l.includes("(LISTEN)"))
      .map((l) => l.trim().split(/\s+/).at(-2));
    expect(listens.length).toBeGreaterThan(0);
    for (const addr of listens) {
      expect(addr, `WS 监听在 ${addr}，本该只在 127.0.0.1`).toBe(`127.0.0.1:${daemon.wsPort}`);
    }
  });

  it("从非 loopback 的本机地址打过来，到不了 daemon", async () => {
    const addrs = Object.values(os.networkInterfaces())
      .flat()
      .filter((a): a is NonNullable<typeof a> => !!a && a.family === "IPv4" && !a.internal)
      .map((a) => a.address);
    for (const addr of addrs) {
      // TCP 层可能被本机代理接住（见上一条用例的实测），所以判据是
      // **拿不拿得到 daemon 的应答**，而不是握不握得上手。
      const answered = await new Promise<boolean>((resolve) => {
        const s = net.connect(daemon.wsPort!, addr);
        let got = "";
        const done = (v: boolean) => {
          s.destroy();
          resolve(v);
        };
        s.on("connect", () =>
          s.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "core/info" })}\n`),
        );
        s.on("data", (d) => {
          got += d.toString();
          if (got.includes("@liangai/pulpo-core")) done(true);
        });
        s.on("error", () => done(false));
        setTimeout(() => done(false), 3000);
      });
      expect(answered, `${addr}:${daemon.wsPort} 居然答了 daemon 的内容`).toBe(false);
    }
  });

  it("同一个方法在两条传输上返回一致的结果", async () => {
    const a = await unix.call("core/info");
    const b = await ws.call("core/info");
    expect(a.name).toBe(b.name);
    expect(a.pid).toBe(b.pid);
    expect(a.topics).toEqual(b.topics);
    expect(a.transports).toEqual(b.transports);
  });

  it("方法表在两条传输上完全一致", async () => {
    const a = await unix.call("core/methods");
    const b = await ws.call("core/methods");
    expect(a.methods).toEqual(b.methods);
    expect(a.methods).toEqual(daemon.methods);
  });

  it("错误码在两条传输上一致", async () => {
    const a = await unix.raw("不存在的方法");
    const b = await ws.raw("不存在的方法");
    expect(a.error.code).toBe(-32601);
    expect(b.error.code).toBe(-32601);
  });

  it("参数校验错误回 -32602", async () => {
    const res = await ws.raw("session/new", { agentId: "zcode" });
    expect(res.error.code).toBe(-32602);
    expect(res.error.message).toMatch(/cwd/);
  });

  it("坏 JSON 回 -32700，连接不断", async () => {
    const sock = net.connect(daemon.socketPath!);
    sock.setEncoding("utf8");
    await new Promise<void>((r) => sock.once("connect", () => r()));
    const line = await new Promise<string>((resolve) => {
      sock.once("data", (d: string) => resolve(d));
      sock.write("{ 这不是 JSON\n");
    });
    expect(JSON.parse(line.trim()).error.code).toBe(-32700);
    sock.destroy();
  });

  it("批量请求：数组进、数组出", async () => {
    const sock = net.connect(daemon.socketPath!);
    sock.setEncoding("utf8");
    await new Promise<void>((r) => sock.once("connect", () => r()));
    const line = await new Promise<string>((resolve) => {
      sock.once("data", (d: string) => resolve(d));
      sock.write(
        `${JSON.stringify([
          { jsonrpc: "2.0", id: 1, method: "core/info" },
          { jsonrpc: "2.0", method: "不产生响应的通知" },
          { jsonrpc: "2.0", id: 2, method: "agent/list" },
        ])}\n`,
      );
    });
    const batch = JSON.parse(line.trim());
    expect(Array.isArray(batch)).toBe(true);
    expect(batch.map((m: { id: number }) => m.id)).toEqual([1, 2]);
    sock.destroy();
  });

  it("订阅是每连接独立的", async () => {
    await unix.call("subscribe", { topics: ["task/update"] });
    const onUnix = await unix.call("subscribe", { topics: [] });
    expect(onUnix.subscribed).toEqual(["task/update"]);
    const onWs = await ws.call("subscribe", { topics: [] });
    expect(onWs.subscribed).toEqual([]);
    await unix.call("unsubscribe", { topics: ["task/update"] });
    expect((await unix.call("subscribe", { topics: [] })).subscribed).toEqual([]);
  });

  it("订阅未知主题被拒", async () => {
    const res = await ws.raw("subscribe", { topics: ["没这个主题"] });
    expect(res.error.code).toBe(-32602);
  });

  it("agent/list 只给引导信息，不含任何能力断言", async () => {
    const agents = await ws.call("agent/list");
    expect(agents).toHaveLength(1);
    expect(agents[0].agentId).toBe("zcode");
    // 测试环境把 adapter 路径指到仓内 packages/adapters/zcode
    expect(agents[0].command).toBe(t.env.PULPO_ZCODE_ACP);
    expect(agents[0]).not.toHaveProperty("delivery");
    expect(agents[0]).not.toHaveProperty("models");
  });

  it("没有活动会话、也没有缓存、又不给 cwd 时明确报错，而不是编一份出来", async () => {
    const res = await ws.raw("agent/descriptor", { agentId: "zcode" });
    expect(res.error.code).toBe(-32602);
    expect(res.error.message).toMatch(/cwd/);
  });

  it("未知 agent 一律 NotFound", async () => {
    const res = await ws.raw("agent/descriptor", { agentId: "根本没有这个渠道" });
    expect(res.error.code).toBe(-32001);
  });

  it("停掉 daemon 后 socket 文件被清掉，不留残留", async () => {
    const t2 = makeTestEnv("cleanup");
    const d2 = await startDaemon(t2);
    const p = d2.socketPath!;
    expect(fs.existsSync(p)).toBe(true);
    await d2.stop();
    expect(fs.existsSync(p)).toBe(false);
    t2.cleanup();
  });

  it("残留的死 socket 文件会被自动清掉并重新监听", async () => {
    const t3 = makeTestEnv("stale");
    const d3 = await startDaemon(t3);
    const p = d3.socketPath!;
    await d3.stop();
    // 手工造一个"上次崩溃留下的"socket 文件
    fs.writeFileSync(p, "");
    expect(fs.existsSync(p)).toBe(true);
    const d4 = await startDaemon(t3);
    expect(d4.socketPath).toBe(p);
    const c = await RpcClient.unix(p);
    expect((await c.call("core/info")).pid).toBe(process.pid);
    c.close();
    await d4.stop();
    t3.cleanup();
  });

  it("同一个 socket 上已有活 daemon 时，第二个不抢，直接报错", async () => {
    const t4 = makeTestEnv("conflict");
    const d5 = await startDaemon(t4);
    await expect(startDaemon(t4)).rejects.toThrow(/已经有一个 pulpo-core 在跑/);
    await d5.stop();
    t4.cleanup();
  });
});
