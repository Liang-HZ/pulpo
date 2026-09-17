// e2e 的真实链路：一个临时 PULPO_HOME 下的 core daemon + 真 ZCode adapter。
// 不造假数据——聊天流、工具卡、派活状态全部来自真的跑一轮。

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const shellRoot = resolve(here, "..");
export const repoRoot = resolve(shellRoot, "../..");

export const ENV_FILE = resolve(shellRoot, "test-results/e2e-env.json");

export interface HarnessEnv {
  wsPort: number;
  pulpoHome: string;
  cwd: string;
  daemonPid: number;
}

/**
 * 把 core 现编译一份到**壳自己的** test-results 下再跑。
 *
 * 为什么不直接用 `packages/core/bin/pulpo-core`：那个 bin 指向 `packages/core/dist`，
 * 而 dist 是不是最新完全取决于别人有没有 build。e2e 要验的是"壳对着**当前**的
 * PROTOCOL 能不能跑通"，所以自己编一份，既不读陈旧产物、也一个字节都不写进
 * packages/core。
 */
function buildCore(): string {
  const out = resolve(shellRoot, "test-results/core-dist");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  execFileSync("npx", ["tsc", "-p", "tsconfig.json", "--outDir", out], {
    cwd: resolve(repoRoot, "packages/core"),
    stdio: "inherit",
  });
  // 编译产物要能解析到 core 的依赖（ws 等），并能找到"包根"（paths.ts 往上找 package.json）
  copyFileSync(resolve(repoRoot, "packages/core/package.json"), resolve(out, "package.json"));
  try {
    symlinkSync(resolve(repoRoot, "packages/core/node_modules"), resolve(out, "node_modules"));
  } catch {
    // 已经存在就算了
  }
  const entry = resolve(out, "run.mjs");
  writeFileSync(
    entry,
    'import { main } from "./cli.js";\nmain().catch((e) => { process.stderr.write(String(e?.message ?? e) + "\\n"); process.exit(1); });\n',
    "utf-8",
  );
  return entry;
}

export function readEnv(): HarnessEnv {
  return JSON.parse(readFileSync(ENV_FILE, "utf-8")) as HarnessEnv;
}

let daemon: ChildProcess | null = null;

/**
 * 起一个只属于这次测试的 daemon：
 * - `PULPO_HOME` 指到临时目录，绝不碰 `~/.pulpo`；
 * - `PULPO_WS_PORT=0` 让内核挑一个空闲端口，从此不存在"端口被占"这回事；
 * - `PULPO_ZCODE_ACP` 指到仓库里的 adapter。
 */
export async function startHarness(): Promise<HarnessEnv> {
  const pid = process.pid;
  const pulpoHome = `/tmp/pulpo-shell-test-${pid}/home`;
  const cwd = `/tmp/pulpo-shell-test-${pid}/ws`;
  mkdirSync(pulpoHome, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(`${cwd}/note.txt`, "hello pulpo\n", "utf-8");
  // 回合级撤销靠工作区的 git 快照（PROTOCOL §4.12）：不是 git 仓库就没有这个能力，
  // 「撤销」按钮会如实不渲染。要验这条链路，工作区必须先是个仓库。
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["add", "-A"], { cwd });
  execFileSync(
    "git",
    ["-c", "user.email=e2e@pulpo.local", "-c", "user.name=pulpo-e2e", "commit", "-qm", "init"],
    { cwd },
  );
  mkdirSync(dirname(ENV_FILE), { recursive: true });

  const entry = buildCore();
  const adapter = resolve(repoRoot, "packages/adapters/zcode/bin/zcode-acp");

  daemon = spawn(process.execPath, [entry, "--ws-port", "0"], {
    env: {
      ...process.env,
      PULPO_HOME: pulpoHome,
      PULPO_ZCODE_ACP: adapter,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const wsPort = await new Promise<number>((res, rej) => {
    const timer = setTimeout(() => rej(new Error("pulpo-core 30 秒内没报就绪")), 30_000);
    let buffer = "";
    daemon!.stderr?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = /ws=(\d+)/.exec(buffer);
      if (match?.[1]) {
        clearTimeout(timer);
        res(Number(match[1]));
      }
    });
    daemon!.on("exit", (code) => {
      clearTimeout(timer);
      rej(new Error(`pulpo-core 提前退出（code=${code}）：${buffer}`));
    });
  });

  const env: HarnessEnv = { wsPort, pulpoHome, cwd, daemonPid: daemon.pid ?? -1 };
  writeFileSync(ENV_FILE, JSON.stringify(env), "utf-8");
  return env;
}

/** 按 pid 收干净：只杀自己起的那个，临时目录一并删掉。 */
export async function stopHarness(): Promise<void> {
  let env: HarnessEnv | null = null;
  try {
    env = readEnv();
  } catch {
    env = null;
  }
  const pid = env?.daemonPid ?? daemon?.pid;
  if (pid && pid > 0) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // 已经没了
    }
    // 给它 3 秒收子进程（agent 子进程挂在它下面），还不走就 SIGKILL
    for (let i = 0; i < 30; i += 1) {
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 正常路径：已经退了
    }
  }
  if (env) rmSync(`/tmp/pulpo-shell-test-${process.pid}`, { recursive: true, force: true });
  daemon = null;
}
