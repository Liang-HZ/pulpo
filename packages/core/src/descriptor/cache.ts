import fs from "node:fs";
import path from "node:path";
import { ensureDir, stateDir } from "../paths.js";
import type { CapabilityDescriptor } from "./types.js";

/**
 * descriptor 缓存。
 *
 * 问题：`agent/descriptor` 原本要求"必须先有活动会话"，但派活表单在人还没
 * 开任何会话时就要列模型。
 *
 * 解法**不是**在壳里硬编码一张能力表（那违反铁律），而是：
 *  - agent 每次自描述（`session/new` / `session/resume`）都把这份 descriptor
 *    存下来；没有会话时先给这份**有时间戳的历史自描述**（`source: "cached"`）；
 *  - 连缓存都没有就现探一次（`source: "probed"`：开一条会话、读自描述、关掉）。
 *
 * 缓存里**只有 descriptor**——能力自描述与它的原文（`raw.initialize` /
 * `raw.newSession`），没有任何会话消息。不是第二事实源：它永远是"上一次
 * agent 自己说的话"，新的自描述一到就整条覆盖。
 */

interface CacheFile {
  version: 1;
  entries: { agentId: string; cwd: string; cachedAt: number; descriptor: CapabilityDescriptor }[];
}

export interface CachedDescriptor {
  agentId: string;
  cwd: string;
  cachedAt: number;
  descriptor: CapabilityDescriptor;
}

export class DescriptorCache {
  private readonly entries = new Map<string, CachedDescriptor>();
  private readonly file: string;

  constructor(opts: { env?: NodeJS.ProcessEnv; file?: string } = {}) {
    this.file = opts.file ?? path.join(stateDir(opts.env ?? process.env), "descriptors.json");
    this.load();
  }

  get filePath(): string {
    return this.file;
  }

  private load(): void {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, "utf8")) as CacheFile;
      if (j?.version === 1 && Array.isArray(j.entries)) {
        for (const e of j.entries) this.entries.set(e.agentId, e);
      }
    } catch {
      /* 没有缓存文件就是没有历史自描述 */
    }
  }

  save(): void {
    ensureDir(path.dirname(this.file));
    const payload: CacheFile = { version: 1, entries: [...this.entries.values()] };
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  put(agentId: string, cwd: string, descriptor: CapabilityDescriptor): void {
    this.entries.set(agentId, {
      agentId,
      cwd,
      cachedAt: Date.now(),
      // 存快照，之后 descriptor 被就地收紧也不影响已存的这份。
      descriptor: JSON.parse(JSON.stringify(descriptor)) as CapabilityDescriptor,
    });
    this.save();
  }

  get(agentId: string): CachedDescriptor | undefined {
    return this.entries.get(agentId);
  }

  list(): CachedDescriptor[] {
    return [...this.entries.values()];
  }
}
