import { invalidParams } from "../errors.js";
import type { UnifiedMessage, UnifiedTranscript } from "./model.js";

/**
 * 转录分页。
 *
 * 为什么不在读取器里分页：ZCode 读一条历史会话的代价是
 * `session/resume` → `session/read` → `session/close`，实测一次几秒。
 * 真按页去读，翻 5 页就是 5 次 resume——**分页不能把这个代价乘倍**。
 * 所以一次读全量，在内存里切页，并给一个**短 TTL 的缓存**（默认 30s）
 * 让连续翻页复用同一次读穿。
 *
 * 缓存是进程内的、有过期的、不落盘的读穿快照，和「零副本」不冲突：
 * 事实源仍是 agent 的原生存储，我们没有建第二存储，也没有任何持久化。
 */

/** 默认一页 50 条（UI 先拉最后 50，往上滚再要更早的）。 */
export const DEFAULT_TRANSCRIPT_LIMIT = 50;
/** 缓存存活时间。过期即丢，再翻页就重新读穿。 */
export const TRANSCRIPT_CACHE_TTL_MS = 30_000;

export interface TranscriptPage {
  sessionRef: string;
  agentId: string;
  sessionId: string;
  title?: string;
  cwd?: string;
  readBy: string;
  readAt: number;
  messages: UnifiedMessage[];
  /** 这一页之前还有更早的消息。 */
  hasMore: boolean;
  /** 下一页的 `before`；没有更早的消息时是 null。 */
  cursor: string | null;
  /** 这条会话一共多少条消息（切页前的全量条数）。 */
  total: number;
  /** 这一页是不是命中了缓存（没有重新 resume→read→close）。 */
  cached: boolean;
}

/** 消息游标：优先用原生 messageId，没有 id 的用 `#<下标>`。 */
export function messageCursor(m: UnifiedMessage, index: number): string {
  return m.messageId ? m.messageId : `#${index}`;
}

function indexOfCursor(messages: UnifiedMessage[], cursor: string): number {
  const byId = messages.findIndex((m) => m.messageId === cursor);
  if (byId >= 0) return byId;
  const m = /^#(\d+)$/.exec(cursor);
  if (m) {
    const i = Number.parseInt(m[1]!, 10);
    if (i >= 0 && i < messages.length) return i;
  }
  return -1;
}

/**
 * 在全量转录上切一页。
 *
 * 语义：**从尾部往前翻**。不给 `before` 就是最后 `limit` 条；
 * 给了 `before` 就是那条消息**之前**的 `limit` 条。返回的 `messages`
 * 仍然按时间正序，`cursor` 指向本页第一条（下一次传给 `before`）。
 */
export function paginate(
  transcript: UnifiedTranscript,
  opts: { limit?: number; before?: string } = {},
  cached = false,
): TranscriptPage {
  const all = transcript.messages;
  const limit = normalizeLimit(opts.limit);
  let end = all.length;
  if (opts.before !== undefined) {
    const i = indexOfCursor(all, opts.before);
    if (i < 0) {
      throw invalidParams(`before 游标在这条会话里找不到：${opts.before}`);
    }
    end = i;
  }
  const start = Math.max(0, end - limit);
  const page = all.slice(start, end);
  const out: TranscriptPage = {
    sessionRef: transcript.sessionRef,
    agentId: transcript.agentId,
    sessionId: transcript.sessionId,
    readBy: transcript.readBy,
    readAt: transcript.readAt,
    messages: page,
    hasMore: start > 0,
    cursor: start > 0 && page.length ? messageCursor(page[0]!, start) : null,
    total: all.length,
    cached,
  };
  if (transcript.title !== undefined) out.title = transcript.title;
  if (transcript.cwd !== undefined) out.cwd = transcript.cwd;
  return out;
}

function normalizeLimit(limit: unknown): number {
  if (limit === undefined || limit === null) return DEFAULT_TRANSCRIPT_LIMIT;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) {
    throw invalidParams(`limit 必须是正整数，收到 ${JSON.stringify(limit)}`);
  }
  return Math.min(limit, 1000);
}

interface Entry {
  at: number;
  transcript?: UnifiedTranscript;
  inflight?: Promise<UnifiedTranscript>;
}

/**
 * 读穿快照的短期缓存。**只在内存里，有 TTL，不落盘**。
 * 同一 key 的并发读只会真读一次（in-flight 复用）。
 */
export class TranscriptCache {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? TRANSCRIPT_CACHE_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  get size(): number {
    return this.entries.size;
  }

  /** 缓存里有没有一份**没过期**的快照。 */
  has(key: string): boolean {
    const e = this.entries.get(key);
    if (!e?.transcript) return false;
    if (this.now() - e.at >= this.ttlMs) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  async get(
    key: string,
    load: () => Promise<UnifiedTranscript>,
  ): Promise<{ transcript: UnifiedTranscript; cached: boolean }> {
    const e = this.entries.get(key);
    if (e?.transcript && this.now() - e.at < this.ttlMs) {
      return { transcript: e.transcript, cached: true };
    }
    if (e?.inflight) return { transcript: await e.inflight, cached: true };
    const inflight = load();
    this.entries.set(key, { at: this.now(), inflight });
    try {
      const transcript = await inflight;
      this.entries.set(key, { at: this.now(), transcript });
      return { transcript, cached: false };
    } catch (err) {
      this.entries.delete(key);
      throw err;
    }
  }

  invalidate(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  /** 清掉过期项（daemon 关停 / 定期调用；不清也只是占一点内存）。 */
  sweep(): number {
    let n = 0;
    for (const [k, e] of [...this.entries]) {
      if (e.transcript && this.now() - e.at >= this.ttlMs) {
        this.entries.delete(k);
        n++;
      }
    }
    return n;
  }
}
