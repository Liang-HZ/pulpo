import type { SessionReader } from "./model.js";
import { ZcodeReader } from "./zcode.js";

/**
 * 读取器注册表：每渠道一个读取器。
 * 本期只实现 zcode；其余渠道（Claude/Codex/Qoder/WorkBuddy/opencode）
 * 在 P1–P2 各自加一个实现，接口不变。
 */
export type ReaderFactory = (opts: { cwd: string; env?: NodeJS.ProcessEnv }) => SessionReader;

const FACTORIES: Record<string, ReaderFactory> = {
  zcode: (opts) => new ZcodeReader(opts),
};

export class ReaderRegistry {
  private readonly live = new Map<string, SessionReader>();

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  /** 按 readerId + cwd 复用读取器（每个读取器持有一个引擎子进程，开销不小）。 */
  get(readerId: string, cwd: string): SessionReader {
    const key = `${readerId}#${cwd}`;
    const existing = this.live.get(key);
    if (existing) return existing;
    const factory = FACTORIES[readerId];
    if (!factory) throw new Error(`没有 ${readerId} 的读取器`);
    const reader = factory({ cwd, env: this.env });
    this.live.set(key, reader);
    return reader;
  }

  has(readerId: string): boolean {
    return readerId in FACTORIES;
  }

  async disposeAll(): Promise<void> {
    const all = [...this.live.values()];
    this.live.clear();
    await Promise.all(all.map((r) => r.dispose().catch(() => undefined)));
  }
}
