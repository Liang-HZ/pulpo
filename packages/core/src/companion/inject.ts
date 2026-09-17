import fs from "node:fs";
import path from "node:path";
import { packagesRoot, socketPath as defaultSocketPath } from "../paths.js";

/**
 * companion 注入。
 *
 * core 在 `session/new` 时把 `@liangai/pulpo-companion` 作为 stdio MCP server 塞进目标
 * agent 的会话里，agent 于是拿到跨渠道派活的四件套。注入是**默认开**的，
 * `PULPO_COMPANION=off` 关掉。
 *
 * **身份**：一层熔断要求 companion 知道自己被注入在哪条会话里。但注入发生在
 * `session/new` 请求发出之前——那一刻 sessionId 还不存在，写不进
 * `PULPO_SESSION_REF`。所以这里塞的是一次性**令牌**：core 拿到 sessionId 之后
 * 把 `token → sessionRef` 登记下来，companion 第一次用到身份时调
 * `companion/identify` 换。（环境里直接给 `PULPO_SESSION_REF` 也认，手工接线用。）
 */
export const COMPANION_SERVER_NAME = "pulpo";

export interface CompanionEnvVar {
  name: string;
  value: string;
}

/** ACP `session/new` 的 mcpServers 元素（stdio 形态）。 */
export interface CompanionMcpServer {
  name: string;
  command: string;
  args: string[];
  env: CompanionEnvVar[];
}

export function companionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.PULPO_COMPANION?.trim().toLowerCase();
  return !(v === "off" || v === "0" || v === "false" || v === "no");
}

/** companion 可执行文件路径：`PULPO_COMPANION_BIN` > 仓内默认路径。 */
export function companionBin(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PULPO_COMPANION_BIN?.trim();
  if (override) return path.resolve(override);
  return path.join(packagesRoot(), "companion", "bin", "pulpo-companion");
}

/**
 * companion 是否真的可用。bin 是个薄壳，真正的入口是它 import 的
 * `dist/cli.js`——没构建过就只有 bin 没有 dist，这时**不注入**：让 agent 会话
 * 少一个工具，好过让它启动一个必然崩掉的 MCP server。
 */
export function companionAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  const bin = companionBin(env);
  if (!fs.existsSync(bin)) return false;
  const entry = path.join(path.dirname(path.dirname(bin)), "dist", "cli.js");
  return fs.existsSync(entry);
}

export interface CompanionInjectionContext {
  /** core 的 unix socket 路径（daemon 起完才知道）。null = 这条传输没开。 */
  socketPath?: string | null;
  /** core 的 WebSocket 端口，socket 没开时 companion 用它回落。 */
  wsPort?: number | null;
}

/** 生成一条注入用的 mcpServers 记录。`token` 由调用方生成并负责登记。 */
export function companionMcpServer(
  token: string,
  env: NodeJS.ProcessEnv,
  ctx: CompanionInjectionContext = {},
): CompanionMcpServer {
  const vars: CompanionEnvVar[] = [{ name: "PULPO_SESSION_TOKEN", value: token }];
  if (env.PULPO_HOME) vars.push({ name: "PULPO_HOME", value: env.PULPO_HOME });
  const sock = ctx.socketPath ?? (env.PULPO_SOCKET ? defaultSocketPath(env) : null);
  if (sock) vars.push({ name: "PULPO_SOCKET", value: sock });
  if (ctx.wsPort) vars.push({ name: "PULPO_CORE_WS", value: String(ctx.wsPort) });
  return {
    name: COMPANION_SERVER_NAME,
    command: companionBin(env),
    args: [],
    env: vars,
  };
}
