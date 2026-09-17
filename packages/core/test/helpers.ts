import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { PulpoDaemon, type DaemonOptions } from "../src/server/daemon.js";

/**
 * 集成测试用的 ZCode adapter：仓内的 `packages/adapters/zcode/bin/zcode-acp`
 * （0.7.0，`_session/steering` 真实现）。`PULPO_ZCODE_ACP` 仍可整条覆盖。
 */
export const ZCODE_ACP =
  process.env.PULPO_ZCODE_ACP?.trim() ||
  path.resolve(import.meta.dirname, "..", "..", "adapters", "zcode", "bin", "zcode-acp");

export function haveZcode(): boolean {
  return fs.existsSync(ZCODE_ACP) && fs.existsSync(
    process.env.ZCODE_CJS ?? "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
  );
}

/** 每个测试一套独立的临时目录：PULPO_HOME、工作区、socket 全在里面。 */
export interface TestEnv {
  root: string;
  home: string;
  ws: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

export function makeTestEnv(tag: string, fixedRoot?: string): TestEnv {
  // 短路径：unix socket 路径上限 104 字节，$TMPDIR 在 macOS 上很长。
  const root = fixedRoot
    ? (fs.rmSync(fixedRoot, { recursive: true, force: true }),
      fs.mkdirSync(fixedRoot, { recursive: true }),
      fixedRoot)
    : fs.mkdtempSync(path.join("/tmp", `pulpo-core-test-${process.pid}-${tag}-`));
  const home = path.join(root, "home");
  const ws = path.join(root, "ws");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(ws, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PULPO_HOME: home,
    PULPO_ZCODE_ACP: ZCODE_ACP,
    // 引擎在 $TMPDIR 下建 socket，路径过长会 EINVAL 崩掉。
    TMPDIR: "/tmp",
  };
  return {
    root,
    home,
    ws,
    env,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

export async function startDaemon(
  t: TestEnv,
  extra: Partial<DaemonOptions> = {},
): Promise<PulpoDaemon> {
  const daemon = new PulpoDaemon({
    env: t.env,
    wsPort: 0, // 随机空闲端口，绝不写死
    ...extra,
  });
  await daemon.start();
  return daemon;
}

/** JSON-RPC 客户端，socket / ws 两种传输共用同一套调用语义。 */
export class RpcClient {
  private id = 0;
  private readonly pending = new Map<number, (m: any) => void>();
  readonly notifications: { method: string; params: any }[] = [];
  private readonly listeners = new Set<(m: any) => void>();

  private constructor(
    private readonly write: (text: string) => void,
    private readonly closeFn: () => void,
  ) {}

  static async unix(socketPath: string): Promise<RpcClient> {
    const sock = net.connect(socketPath);
    sock.setEncoding("utf8");
    const c = new RpcClient(
      (text) => sock.write(`${text}\n`),
      () => sock.destroy(),
    );
    let buf = "";
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) c.onMessage(line);
      }
    });
    await new Promise<void>((resolve, reject) => {
      sock.once("connect", resolve);
      sock.once("error", reject);
    });
    return c;
  }

  static async websocket(port: number): Promise<RpcClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const c = new RpcClient(
      (text) => ws.send(text),
      () => ws.close(),
    );
    ws.on("message", (data) => c.onMessage(data.toString()));
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    return c;
  }

  private onMessage(text: string): void {
    let m: any;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (Array.isArray(m)) {
      for (const one of m) this.onMessage(JSON.stringify(one));
      return;
    }
    if (m.id !== undefined && m.method === undefined) {
      const resolve = this.pending.get(m.id);
      if (resolve) {
        this.pending.delete(m.id);
        resolve(m);
      }
      return;
    }
    if (m.method) {
      this.notifications.push({ method: m.method, params: m.params });
      for (const l of this.listeners) l(m);
    }
  }

  onNotification(fn: (m: any) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 发请求并返回完整的 JSON-RPC 响应（含 error，测试要断言错误码）。 */
  raw(method: string, params?: unknown, timeoutMs = 240_000): Promise<any> {
    const id = ++this.id;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      const t = setTimeout(() => {
        if (this.pending.delete(id)) {
          resolve({ error: { code: -1, message: `请求超时 ${timeoutMs}ms: ${method}` } });
        }
      }, timeoutMs);
      t.unref?.();
    });
  }

  /** 发请求，出错就抛——正常路径用这个。 */
  async call<T = any>(method: string, params?: unknown, timeoutMs = 240_000): Promise<T> {
    const res = await this.raw(method, params, timeoutMs);
    if (res.error) {
      throw new Error(`${method} 失败：${res.error.code} ${res.error.message}`);
    }
    return res.result as T;
  }

  notify(method: string, params?: unknown): void {
    this.write(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  close(): void {
    this.closeFn();
  }
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  opts: { timeoutMs?: number; intervalMs?: number; what?: string } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const intervalMs = opts.intervalMs ?? 200;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`等待超时（${timeoutMs}ms）：${opts.what ?? "条件未满足"}`);
}

export { os };
