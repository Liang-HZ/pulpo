import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PulpoDaemon } from "@pulpo/core";

/** 仓内的 ZCode adapter（0.7.0）。`PULPO_ZCODE_ACP` 可整条覆盖。 */
export const ZCODE_ACP =
  process.env.PULPO_ZCODE_ACP?.trim() ||
  path.resolve(import.meta.dirname, "..", "..", "adapters", "zcode", "bin", "zcode-acp");

export const ZCODE_CJS =
  process.env.ZCODE_CJS ?? "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";

/** companion 的 bin（被 core 注入、也被测试直接拉起）。 */
export const COMPANION_BIN = path.resolve(import.meta.dirname, "..", "bin", "pulpo-companion");

export function haveZcode(): boolean {
  return fs.existsSync(ZCODE_ACP) && fs.existsSync(ZCODE_CJS);
}

export interface TestEnv {
  root: string;
  home: string;
  ws: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

/**
 * 每个测试一套独立的临时目录。cwd 用 `/tmp/pulpo-companion-test-<pid>-<tag>-*`：
 * unix socket 路径上限 104 字节，macOS 的 `$TMPDIR` 太长撑不下。
 */
export function makeTestEnv(tag: string): TestEnv {
  const root = fs.mkdtempSync(path.join("/tmp", `pulpo-companion-test-${process.pid}-${tag}-`));
  const home = path.join(root, "home");
  const ws = path.join(root, "ws");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(ws, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PULPO_HOME: home,
    PULPO_ZCODE_ACP: ZCODE_ACP,
    PULPO_COMPANION_BIN: COMPANION_BIN,
    // adapter 的诊断日志按测试隔离：注入进引擎的 MCP 清单从这里取实测证据。
    ZCODE_ACP_LOG_DIR: path.join(root, "adapter-log"),
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

/** adapter 落在本测试临时目录下的全部诊断日志（注入证据从这里读）。 */
export function adapterLogs(t: TestEnv): string {
  const dir = path.join(t.root, "adapter-log");
  if (!fs.existsSync(dir)) return "";
  return fs
    .readdirSync(dir)
    .map((f) => {
      try {
        return fs.readFileSync(path.join(dir, f), "utf8");
      } catch {
        return "";
      }
    })
    .join("\n");
}

export async function startDaemon(t: TestEnv): Promise<PulpoDaemon> {
  const daemon = new PulpoDaemon({ env: t.env, wsPort: null });
  await daemon.start();
  return daemon;
}

/** core 的 JSON-RPC 客户端（unix socket，换行分帧）。测试直接驱动 core 用。 */
export class RpcClient {
  private id = 0;
  private readonly pending = new Map<number, (m: any) => void>();
  readonly notifications: { method: string; params: any }[] = [];
  private readonly listeners = new Set<(m: any) => void>();

  private constructor(
    private readonly write: (t: string) => void,
    private readonly closeFn: () => void,
  ) {}

  static async unix(socketPath: string): Promise<RpcClient> {
    const sock = net.connect(socketPath);
    sock.setEncoding("utf8");
    const c = new RpcClient(
      (t) => sock.write(`${t}\n`),
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

  private onMessage(text: string): void {
    let m: any;
    try {
      m = JSON.parse(text);
    } catch {
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

  notify(method: string, params?: unknown): void {
    this.write(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  raw(method: string, params?: unknown, timeoutMs = 300_000): Promise<any> {
    const id = ++this.id;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          resolve({ error: { code: -1, message: `请求超时 ${timeoutMs}ms：${method}` } });
        }
      }, timeoutMs);
      timer.unref?.();
    });
  }

  async call<T = any>(method: string, params?: unknown, timeoutMs = 300_000): Promise<T> {
    const res = await this.raw(method, params, timeoutMs);
    if (res.error) throw new Error(`${method} 失败：${res.error.code} ${res.error.message}`);
    return res.result as T;
  }

  close(): void {
    this.closeFn();
  }
}

/** 起一个 MCP 客户端，通过 stdio 连到 companion 的 bin（真实子进程）。 */
export async function connectCompanion(opts: {
  socketPath: string;
  sessionRef?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ client: Client; close: () => Promise<void> }> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    PULPO_SOCKET: opts.socketPath,
    ...(opts.sessionRef ? { PULPO_SESSION_REF: opts.sessionRef } : {}),
  };
  for (const [k, v] of Object.entries(opts.env ?? {})) if (v !== undefined) env[k] = String(v);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [COMPANION_BIN],
    env,
    stderr: "inherit",
  });
  const client = new Client({ name: "pulpo-companion-test", version: "0.1.0" });
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await client.close();
    },
  };
}

/** 工具返回的是 JSON 文本，测试里统一解回对象。 */
export function toolJson(res: any): any {
  const text = (res.content ?? [])
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("");
  return JSON.parse(text);
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  opts: { timeoutMs?: number; intervalMs?: number; what?: string } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const intervalMs = opts.intervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`等待超时（${timeoutMs}ms）：${opts.what ?? "条件未满足"}`);
}
