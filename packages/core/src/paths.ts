import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * pulpo 的本地状态根目录。
 *
 * 默认 `~/.pulpo`；`PULPO_HOME` 覆盖（测试必须覆盖到临时目录，否则会污染
 * 用户机器上的真实状态）。这里存的只有"薄状态"——派活边、任务登记——
 * 不存任何会话消息副本（铁律：会话零副本）。
 */
export function pulpoHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PULPO_HOME?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), ".pulpo");
}

/** 薄状态目录：`$PULPO_HOME/state`。 */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(pulpoHome(env), "state");
}

/** 运行时目录：`$PULPO_HOME/run`（socket、pid 文件）。 */
export function runDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(pulpoHome(env), "run");
}

/**
 * daemon 的 unix socket 路径。默认 `$PULPO_HOME/run/core.sock`，
 * `PULPO_SOCKET` 整条覆盖。
 *
 * macOS 的 unix socket 路径上限是 104 字节（含结尾 NUL）——超长直接
 * EINVAL。调用方在选择 `PULPO_HOME` 时要留意（daemon 启动时会断言）。
 */
export function socketPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PULPO_SOCKET?.trim();
  return override ? path.resolve(override) : path.join(runDir(env), "core.sock");
}

/** macOS/BSD sockaddr_un.sun_path 容量（含结尾 NUL）。 */
export const MAX_UNIX_SOCKET_PATH = 104;

export function assertSocketPathFits(p: string): void {
  const bytes = Buffer.byteLength(p, "utf8");
  if (bytes + 1 > MAX_UNIX_SOCKET_PATH) {
    throw new Error(
      `unix socket 路径过长：${bytes} 字节（上限 ${MAX_UNIX_SOCKET_PATH - 1}）：${p}。` +
        `请把 PULPO_HOME 或 PULPO_SOCKET 指到更短的路径。`,
    );
  }
}

/** WebSocket 监听端口（只绑 127.0.0.1）。默认 27183，`PULPO_WS_PORT` 覆盖。 */
export const DEFAULT_WS_PORT = 27183;

export function wsPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PULPO_WS_PORT?.trim();
  if (!raw) return DEFAULT_WS_PORT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`PULPO_WS_PORT 非法：${raw}（要 0..65535，0 = 随机空闲端口）`);
  }
  return n;
}

/**
 * 本包（`packages/core`）的根目录——从模块自身位置向上找 package.json。
 * src/ 直跑和 dist/ 编译产物都能得到同一个答案。
 */
export function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("找不到 @liangai/pulpo-core 的包根目录（向上 10 层都没有 package.json）");
}

/** 仓库里 `packages/` 目录。 */
export function packagesRoot(): string {
  return path.dirname(packageRoot());
}

export function ensureDir(p: string): string {
  fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  return p;
}
