import path from "node:path";
import { packagesRoot } from "../paths.js";

/**
 * 引导表（bootstrap registry）——**不是权威能力表**。
 *
 * 这里只回答两个问题：某个 agent id 怎么启动、它的自描述从哪拿。
 * 能力一律由 agent 自己在 `initialize` / `session/new` 里说，见 `build.ts`。
 */
export interface AgentBootstrap {
  agentId: string;
  /** 展示名（UI 用，不参与任何能力判断）。 */
  label: string;
  /** 可执行文件路径。`resolveCommand` 负责环境变量覆盖。 */
  command: string;
  args: string[];
  /** 额外环境变量（合并进 agent 子进程环境）。 */
  env?: Record<string, string>;
  /** 覆盖 `command` 的环境变量名。 */
  commandEnvVar?: string;
  /** 读取器 id（`read/registry.ts`）；没有读取器就是 null。 */
  reader: string | null;
  storage: { kind: "engine-store" | "jsonl" | "sqlite" | "unknown"; location?: string };
}

/** zcode adapter 的仓内默认路径：`packages/adapters/zcode/bin/zcode-acp`。 */
export function defaultZcodeAdapterPath(): string {
  return path.join(packagesRoot(), "adapters", "zcode", "bin", "zcode-acp");
}

export const BOOTSTRAP: Record<string, AgentBootstrap> = {
  zcode: {
    agentId: "zcode",
    label: "ZCode",
    command: defaultZcodeAdapterPath(),
    args: [],
    commandEnvVar: "PULPO_ZCODE_ACP",
    reader: "zcode",
    storage: { kind: "engine-store", location: "ZCode app-server session store" },
  },
};

export function bootstrapFor(agentId: string): AgentBootstrap | undefined {
  return BOOTSTRAP[agentId];
}

export function listBootstrap(): AgentBootstrap[] {
  return Object.values(BOOTSTRAP);
}

/**
 * 解析 agent 可执行文件路径。
 * 优先级：显式 override > 引导表声明的环境变量 > 引导表默认路径。
 */
export function resolveCommand(
  boot: AgentBootstrap,
  opts: { override?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  if (opts.override?.trim()) return opts.override.trim();
  const env = opts.env ?? process.env;
  if (boot.commandEnvVar) {
    const fromEnv = env[boot.commandEnvVar]?.trim();
    if (fromEnv) return fromEnv;
  }
  return boot.command;
}
