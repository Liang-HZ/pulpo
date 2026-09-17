import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRANSCRIPT_LIMIT,
  TranscriptCache,
  paginate,
} from "../../src/read/paging.js";
import type { UnifiedTranscript } from "../../src/read/model.js";

function transcript(n: number): UnifiedTranscript {
  return {
    sessionRef: "zcode#sess_x",
    agentId: "zcode",
    sessionId: "sess_x",
    cwd: "/tmp/ws",
    readBy: "zcode",
    readAt: 1,
    messages: Array.from({ length: n }, (_, i) => ({
      messageId: `m${i}`,
      role: i % 2 ? ("assistant" as const) : ("user" as const),
      parts: [],
      raw: {},
    })),
  };
}

describe("转录分页", () => {
  it("默认给最后 50 条，并报 hasMore 与 cursor", () => {
    const page = paginate(transcript(120));
    expect(page.messages).toHaveLength(DEFAULT_TRANSCRIPT_LIMIT);
    expect(page.messages[0]!.messageId).toBe("m70");
    expect(page.messages.at(-1)!.messageId).toBe("m119");
    expect(page.hasMore).toBe(true);
    expect(page.cursor).toBe("m70");
    expect(page.total).toBe(120);
  });

  it("按 cursor 往上翻，翻到头 hasMore=false、cursor=null", () => {
    const t = transcript(7);
    const first = paginate(t, { limit: 3 });
    expect(first.messages.map((m) => m.messageId)).toEqual(["m4", "m5", "m6"]);
    const second = paginate(t, { limit: 3, before: first.cursor! });
    expect(second.messages.map((m) => m.messageId)).toEqual(["m1", "m2", "m3"]);
    const third = paginate(t, { limit: 3, before: second.cursor! });
    expect(third.messages.map((m) => m.messageId)).toEqual(["m0"]);
    expect(third.hasMore).toBe(false);
    expect(third.cursor).toBeNull();
  });

  it("消息数少于一页时 hasMore=false", () => {
    const page = paginate(transcript(3), { limit: 10 });
    expect(page.messages).toHaveLength(3);
    expect(page.hasMore).toBe(false);
    expect(page.cursor).toBeNull();
  });

  it("limit 非法 / cursor 找不到时明确报 -32602，不静默兜底", () => {
    expect(() => paginate(transcript(3), { limit: 0 })).toThrowError(/limit/);
    expect(() => paginate(transcript(3), { limit: 1.5 })).toThrowError(/limit/);
    expect(() => paginate(transcript(3), { before: "没这条" })).toThrowError(/before/);
  });

  it("没有 messageId 的消息用 #下标 做游标", () => {
    const t = transcript(4);
    for (const m of t.messages) m.messageId = "";
    const page = paginate(t, { limit: 2 });
    expect(page.cursor).toBe("#2");
    expect(paginate(t, { limit: 2, before: "#2" }).messages).toHaveLength(2);
  });
});

describe("读穿快照缓存（TTL，不落盘）", () => {
  it("TTL 内复用同一次读穿：翻页不把 resume→read→close 的代价乘倍", async () => {
    let now = 1000;
    let loads = 0;
    const cache = new TranscriptCache({ ttlMs: 500, now: () => now });
    const load = async () => {
      loads++;
      return transcript(5);
    };
    const a = await cache.get("k", load);
    expect(a.cached).toBe(false);
    const b = await cache.get("k", load);
    expect(b.cached).toBe(true);
    expect(loads).toBe(1);

    now += 501; // 过期
    const c = await cache.get("k", load);
    expect(c.cached).toBe(false);
    expect(loads).toBe(2);
  });

  it("并发取同一 key 只真读一次", async () => {
    let loads = 0;
    const cache = new TranscriptCache({ ttlMs: 1000 });
    const load = async () => {
      loads++;
      await new Promise((r) => setTimeout(r, 20));
      return transcript(2);
    };
    await Promise.all([cache.get("k", load), cache.get("k", load), cache.get("k", load)]);
    expect(loads).toBe(1);
  });

  it("读失败不留下坏缓存", async () => {
    const cache = new TranscriptCache({ ttlMs: 1000 });
    await expect(cache.get("k", async () => { throw new Error("引擎炸了"); })).rejects.toThrow("引擎炸了");
    expect(cache.has("k")).toBe(false);
    const ok = await cache.get("k", async () => transcript(1));
    expect(ok.cached).toBe(false);
  });

  it("sweep 清掉过期项", async () => {
    let now = 0;
    const cache = new TranscriptCache({ ttlMs: 100, now: () => now });
    await cache.get("k", async () => transcript(1));
    now = 200;
    expect(cache.sweep()).toBe(1);
    expect(cache.size).toBe(0);
  });
});
