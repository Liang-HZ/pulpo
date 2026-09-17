import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * ZCode 引擎（app-server）的最小只读客户端。
 *
 * 引擎说的**不是** JSON-RPC 2.0——行分隔的 `{id, method, params}` / `{id, result}`，
 * 没有 `jsonrpc` 字段。所以这里手写一个极小的对等端，不复用 ACP SDK。
 *
 * 四条实测出来的硬约束（不满足就读不到东西）：
 *
 *  1. `session/read` 只对 **active** 会话有效。对 store 里的历史会话直接调
 *     会回 `-32004 Session is not active` —— 必须先 `session/resume`。
 *  2. `session/resume` 之前要先 `workspace/updateProviderRegistry` 把
 *     `~/.zcode/v2/config.json` 里的渠道推给该 workspace，否则引擎判模型不可用。
 *     workspace 二元组必须用 `session/list` 记录里带的那一份，不能自己编。
 *  3. 引擎会**反向请求** `session/requestRuntimePreferences`。不应答或应答
 *     空对象，`session/resume` 会以 ZodError 失败
 *     （`nativeSearchEnhancementsEnabled: expected boolean, received undefined`）。
 *  4. 引擎启动时在 `$TMPDIR` 下建 `znr-<uuid>.sock`（长度 = len(TMPDIR)+46）。
 *     macOS unix socket 路径上限 104 字节，TMPDIR 过长时 listen() EINVAL、
 *     引擎当场崩。所以这里把过长的 TMPDIR 换成短目录。
 */

export const DEFAULT_ZCODE_CJS =
  "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";

export function zcodeCjsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.ZCODE_CJS?.trim() || DEFAULT_ZCODE_CJS;
}

/** 给引擎子进程准备环境：只动 TMPDIR，其余原样继承。 */
export function engineEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  const td = (out.TMPDIR ?? "/tmp").replace(/\/+$/, "") || "/";
  if (Buffer.byteLength(td) + 1 + 45 > 103) {
    const short = "/tmp/pulpo-zcode-tmp";
    fs.mkdirSync(short, { recursive: true, mode: 0o700 });
    out.TMPDIR = short;
  }
  return out;
}

export interface EngineWorkspace {
  workspacePath: string;
  workspaceKey: string;
}

export interface EngineSessionInfo {
  sessionId: string;
  title?: string;
  status?: string;
  createdAt?: number;
  updatedAt?: number;
  sessionKind?: string;
  mode?: string;
  workspace?: EngineWorkspace;
}

interface EngineMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export class ZcodeEngineError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | undefined,
    message: string,
    readonly data?: unknown,
  ) {
    super(`zcode engine ${method} 失败：${message}`);
    this.name = "ZcodeEngineError";
  }
}

export class ZcodeEngine {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf = "";
  private nextId = 1000;
  private readonly pending = new Map<number, (m: EngineMessage) => void>();
  private stderrPath: string | null = null;

  constructor(
    private readonly opts: { cwd: string; env?: NodeJS.ProcessEnv; cjs?: string } ,
  ) {}

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  get alive(): boolean {
    return !!this.proc && this.proc.exitCode === null;
  }

  start(): void {
    if (this.proc) return;
    const env = engineEnv(this.opts.env ?? process.env);
    const cjs = this.opts.cjs ?? zcodeCjsPath(this.opts.env ?? process.env);
    if (!fs.existsSync(cjs)) {
      throw new Error(`找不到 ZCode 引擎入口：${cjs}（ZCODE_CJS 可覆盖）`);
    }
    this.stderrPath = path.join(os.tmpdir(), `pulpo-zcode-engine-${process.pid}-${Date.now()}.log`);
    const proc = spawn(process.execPath, [cjs, "app-server", "--stdio"], {
      cwd: this.opts.cwd,
      env: env as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", fs.openSync(this.stderrPath, "w")],
    }) as ChildProcessWithoutNullStreams;
    this.proc = proc;
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.onData(chunk));
    proc.on("exit", () => {
      for (const [, resolve] of this.pending) {
        resolve({ error: { code: -1, message: "engine exited" } });
      }
      this.pending.clear();
    });
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg: EngineMessage;
      try {
        msg = JSON.parse(line) as EngineMessage;
      } catch {
        continue;
      }
      if (msg.method && msg.id !== undefined) {
        this.answerEngineRequest(msg);
        continue;
      }
      if (msg.method) continue; // 引擎的推送（session/event 等）——读取器不关心
      if (msg.id !== undefined) {
        const resolve = this.pending.get(msg.id);
        if (resolve) {
          this.pending.delete(msg.id);
          resolve(msg);
        }
      }
    }
  }

  /**
   * 应答引擎反向请求。只读路径上会遇到两条，都给最保守的答案：
   * 不启用原生搜索增强、不注入官方 MCP 鉴权头。其余一律空对象。
   */
  private answerEngineRequest(msg: EngineMessage): void {
    let result: unknown = {};
    if (msg.method === "session/requestRuntimePreferences") {
      result = { nativeSearchEnhancementsEnabled: false };
    } else if (msg.method === "interaction/requestOfficialMcpAuthHeaders") {
      result = { headersApplied: false };
    }
    this.send({ id: msg.id, result });
  }

  private send(obj: unknown): void {
    if (!this.proc) throw new Error("zcode 引擎未启动");
    this.proc.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  async call<T = unknown>(method: string, params: unknown, timeoutMs = 40_000): Promise<T> {
    if (!this.proc) this.start();
    const id = ++this.nextId;
    const msg = await new Promise<EngineMessage>((resolve) => {
      this.pending.set(id, resolve);
      this.send({ id, method, params });
      const t = setTimeout(() => {
        if (this.pending.delete(id)) {
          resolve({ error: { code: -32000, message: `超时 ${timeoutMs}ms` } });
        }
      }, timeoutMs);
      t.unref?.();
    });
    if (msg.error) {
      throw new ZcodeEngineError(method, msg.error.code, msg.error.message ?? "未知错误", msg.error.data);
    }
    return msg.result as T;
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    if (!proc || proc.exitCode !== null) return;
    const pid = proc.pid;
    await new Promise<void>((resolve) => {
      proc.once("exit", () => resolve());
      try {
        proc.kill("SIGTERM");
      } catch {
        return resolve();
      }
      setTimeout(() => {
        if (proc.exitCode === null && pid !== undefined) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* 已经没了 */
          }
        }
      }, 2000).unref();
      setTimeout(resolve, 5000).unref();
    });
  }
}

/**
 * `~/.zcode/v2/config.json` → 引擎 provider 注册表。
 * resume 的前置条件：不推这个，引擎会判该 workspace 的模型不可用。
 */
export function buildProviderRegistry(
  env: NodeJS.ProcessEnv = process.env,
): { revision: string; generatedAt: number; providers: unknown[] } | null {
  const home = env.HOME ?? os.homedir();
  const file = path.join(home, ".zcode", "v2", "config.json");
  let v2: { provider?: Record<string, ProviderConfig> };
  try {
    v2 = JSON.parse(fs.readFileSync(file, "utf8")) as { provider?: Record<string, ProviderConfig> };
  } catch {
    return null;
  }
  const providers: unknown[] = [];
  for (const [pid, pc] of Object.entries(v2.provider ?? {})) {
    if (pc.enabled === false || pc.systemDisabledReason) continue;
    const apiKey = pc.options?.apiKey;
    if (!apiKey) continue;
    const kind = pc.kind === "anthropic" ? "anthropic" : "openai-compatible";
    const models = Object.entries(pc.models ?? {}).map(([modelId, mc]) => ({
      modelId,
      ...(mc?.limit?.context ? { contextWindow: mc.limit.context } : {}),
      ...(mc?.limit?.output ? { maxOutputTokens: mc.limit.output } : {}),
    }));
    if (!models.length) continue;
    providers.push({
      providerId: pid,
      kind,
      apiFormat: kind === "anthropic" ? "anthropic-messages" : "openai-chat-completions",
      label: pc.name ?? pid,
      source: "workspace",
      baseURL: pc.options?.baseURL,
      apiKey: { source: "inline", value: apiKey },
      models,
    });
  }
  if (!providers.length) return null;
  return { revision: `pulpo-${Date.now()}`, generatedAt: Date.now(), providers };
}

interface ProviderConfig {
  enabled?: boolean;
  systemDisabledReason?: string;
  kind?: string;
  name?: string;
  options?: { apiKey?: string; baseURL?: string };
  models?: Record<string, { limit?: { context?: number; output?: number } }>;
}
