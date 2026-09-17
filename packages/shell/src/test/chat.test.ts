import { describe, expect, it } from "vitest";
import {
  appendNotice,
  appendUser,
  applyUpdate,
  attachReceipt,
  emptyChat,
  type ChatState,
  type ToolCard,
} from "../lib/chat";
import type { DeliveryReceipt, SessionUpdate } from "../lib/protocol";
import { transcriptToChat } from "../lib/store";

const feed = (updates: SessionUpdate[], start: ChatState = emptyChat()): ChatState =>
  updates.reduce((state, update, i) => applyUpdate(state, update, 1000 + i), start);

const chunk = (kind: string, text: string): SessionUpdate => ({
  sessionUpdate: kind,
  content: { type: "text", text },
});

function onlyTool(state: ChatState): ToolCard {
  const item = state.items.find((i) => i.kind === "tool");
  if (!item || item.kind !== "tool") throw new Error("流里没有工具卡");
  return item.card;
}

describe("逐 token 的正文与思考", () => {
  it("连续的正文片段合成一条，不是一片碎消息", () => {
    const state = feed([
      chunk("agent_message_chunk", "hello"),
      chunk("agent_message_chunk", " "),
      chunk("agent_message_chunk", "pulpo"),
    ]);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ kind: "assistant", text: "hello pulpo" });
  });

  it("正文与思考各自成条，互不吞并", () => {
    const state = feed([
      chunk("agent_thought_chunk", "先看看"),
      chunk("agent_thought_chunk", "文件"),
      chunk("agent_message_chunk", "好的"),
      chunk("agent_thought_chunk", "再想想"),
    ]);
    expect(state.items.map((i) => i.kind)).toEqual(["thought", "assistant", "thought"]);
    expect(state.items[0]).toMatchObject({ text: "先看看文件" });
    expect(state.items[2]).toMatchObject({ text: "再想想" });
  });

  it("中间插了工具卡之后，后面的正文另起一条", () => {
    const state = feed([
      chunk("agent_message_chunk", "前半"),
      { sessionUpdate: "tool_call", toolCallId: "c1", title: "Bash", status: "pending" },
      chunk("agent_message_chunk", "后半"),
    ]);
    expect(state.items.map((i) => i.kind)).toEqual(["assistant", "tool", "assistant"]);
  });

  it("空片段不产生空消息", () => {
    expect(feed([chunk("agent_message_chunk", "")]).items).toHaveLength(0);
  });

  it("每条消息的 id 稳定且互不重复（React key 靠它）", () => {
    const state = feed([
      chunk("agent_message_chunk", "a"),
      { sessionUpdate: "tool_call", toolCallId: "c1", title: "t", status: "pending" },
      chunk("agent_thought_chunk", "b"),
      { sessionUpdate: "怪东西" },
    ]);
    const ids = state.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("工具卡状态机（三段式）", () => {
  const first: SessionUpdate = {
    sessionUpdate: "tool_call",
    toolCallId: "zc-call_1",
    title: "cat /tmp/note.txt",
    kind: "execute",
    status: "pending",
    content: [],
    rawInput: { command: "cat /tmp/note.txt" },
  };

  it("pending → in_progress → completed，只有一张卡", () => {
    const state = feed([
      first,
      { sessionUpdate: "tool_call_update", toolCallId: "zc-call_1", status: "in_progress", title: "Bash" },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "zc-call_1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "hello pulpo" } }],
      },
    ]);
    expect(state.items.filter((i) => i.kind === "tool")).toHaveLength(1);
    const card = onlyTool(state);
    expect(card.status).toBe("completed");
    expect(card.sawFirstCard).toBe(true);
    expect(card.content.map((c) => c.text)).toEqual(["hello pulpo"]);
  });

  it("首卡的标题最具体，后续 update 的标题另存成工具名，不互相覆盖", () => {
    const state = feed([
      first,
      { sessionUpdate: "tool_call_update", toolCallId: "zc-call_1", status: "in_progress", title: "Bash" },
    ]);
    const card = onlyTool(state);
    expect(card.title).toBe("cat /tmp/note.txt");
    expect(card.toolName).toBe("Bash");
  });

  it("failed 也是终态，能如实落到卡上", () => {
    const state = feed([
      first,
      { sessionUpdate: "tool_call_update", toolCallId: "zc-call_1", status: "failed" },
    ]);
    expect(onlyTool(state).status).toBe("failed");
  });

  it("多次 update 带内容时逐段累积，不互相顶掉", () => {
    const state = feed([
      first,
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "zc-call_1",
        content: [{ type: "content", content: { type: "text", text: "第一段" } }],
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "zc-call_1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "第二段" } }],
      },
    ]);
    expect(onlyTool(state).content.map((c) => c.text)).toEqual(["第一段", "第二段"]);
  });

  it("状态没带时保留上一个状态，不无声回落到 pending", () => {
    const state = feed([
      first,
      { sessionUpdate: "tool_call_update", toolCallId: "zc-call_1", status: "in_progress" },
      { sessionUpdate: "tool_call_update", toolCallId: "zc-call_1", title: "Bash" },
    ]);
    expect(onlyTool(state).status).toBe("in_progress");
  });

  it("认不出的状态串不当成合法状态", () => {
    const state = feed([
      first,
      { sessionUpdate: "tool_call_update", toolCallId: "zc-call_1", status: "微妙" },
    ]);
    expect(onlyTool(state).status).toBe("pending");
  });

  it("两张卡各走各的状态机，按 toolCallId 分开", () => {
    const state = feed([
      first,
      { sessionUpdate: "tool_call", toolCallId: "zc-call_2", title: "Write", status: "pending" },
      { sessionUpdate: "tool_call_update", toolCallId: "zc-call_1", status: "completed" },
    ]);
    const cards = state.items.filter((i) => i.kind === "tool");
    expect(cards).toHaveLength(2);
    expect(cards.map((c) => (c.kind === "tool" ? c.card.status : ""))).toEqual([
      "completed",
      "pending",
    ]);
  });

  it("没有 toolCallId 的工具帧不建卡（宁可丢一帧也不建错卡）", () => {
    expect(feed([{ sessionUpdate: "tool_call", title: "无主" }]).items).toHaveLength(0);
  });

  describe("兜底：只收到 update、没收到首卡", () => {
    it("照样建出卡来，状态取 update 说的，并记下首帧没收到", () => {
      const state = feed([
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "zc-call_9",
          status: "completed",
          title: "Bash",
          content: [{ type: "content", content: { type: "text", text: "输出" } }],
        },
      ]);
      const card = onlyTool(state);
      expect(card.sawFirstCard).toBe(false);
      expect(card.status).toBe("completed");
      expect(card.title).toBe("Bash");
      expect(card.toolName).toBe("Bash");
      expect(card.content.map((c) => c.text)).toEqual(["输出"]);
    });

    // `tool_call_update` 没带 status 时按
    // `rawOutput.length > 0 ? "in_progress" : "pending"` 推断，**不要当成 completed**。
    // 有回参就说明它已经在跑了；什么都没有就只能算还没开始。
    it("update 连状态都没带时按有没有回参推断，绝不当成已完成", () => {
      expect(feed([{ sessionUpdate: "tool_call_update", toolCallId: "z" }]).items).toHaveLength(1);
      expect(onlyTool(feed([{ sessionUpdate: "tool_call_update", toolCallId: "z" }])).status).toBe(
        "pending",
      );
      expect(
        onlyTool(
          feed([{ sessionUpdate: "tool_call_update", toolCallId: "z", rawOutput: "有回参了" }]),
        ).status,
      ).toBe("in_progress");
    });

    it("首卡迟到时补上，sawFirstCard 翻成 true，卡不重复", () => {
      const state = feed([
        { sessionUpdate: "tool_call_update", toolCallId: "zc-call_9", status: "in_progress" },
        {
          sessionUpdate: "tool_call",
          toolCallId: "zc-call_9",
          title: "cat note.txt",
          status: "pending",
          rawInput: { command: "cat note.txt" },
        },
      ]);
      expect(state.items.filter((i) => i.kind === "tool")).toHaveLength(1);
      const card = onlyTool(state);
      expect(card.sawFirstCard).toBe(true);
      expect(card.title).toBe("cat note.txt");
      expect(card.rawInput).toEqual({ command: "cat note.txt" });
    });
  });
});

describe("其余 sessionUpdate", () => {
  it("usage_update 落在会话级，不进消息流", () => {
    const state = feed([
      { sessionUpdate: "usage_update", used: 80_353, size: 1_000_000, cost: { amount: 0, currency: "USD" } },
    ]);
    expect(state.items).toHaveLength(0);
    expect(state.usage).toEqual({ used: 80_353, size: 1_000_000, cost: { amount: 0, currency: "USD" } });
  });

  it("后来的 usage_update 覆盖前一条", () => {
    const state = feed([
      { sessionUpdate: "usage_update", used: 1, size: 10 },
      { sessionUpdate: "usage_update", used: 2, size: 10 },
    ]);
    expect(state.usage?.used).toBe(2);
  });

  it("plan 是整份替换，不堆成一串", () => {
    const state = feed([
      { sessionUpdate: "plan", entries: [{ content: "第一步", status: "pending" }] },
      {
        sessionUpdate: "plan",
        entries: [
          { content: "第一步", status: "completed" },
          { content: "第二步", status: "pending" },
        ],
      },
    ]);
    const plans = state.items.filter((i) => i.kind === "plan");
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ entries: [{ status: "completed" }, { status: "pending" }] });
  });

  it("config_option_update 同时更新配置项与当前模式", () => {
    const state = feed([
      {
        sessionUpdate: "config_option_update",
        configOptions: [
          { id: "mode", name: "安全模式", currentValue: "acceptEdits" },
          { id: "model", name: "Model", currentValue: "Demo Plan/glm-5.3-flash" },
        ],
      },
    ]);
    expect(state.currentModeId).toBe("acceptEdits");
    expect(state.configOptions?.map((o) => o.id)).toEqual(["mode", "model"]);
    expect(state.items).toHaveLength(0);
  });

  it("current_mode_update 单独也生效", () => {
    expect(feed([{ sessionUpdate: "current_mode_update", currentModeId: "plan" }]).currentModeId).toBe(
      "plan",
    );
  });

  it("available_commands_update 存成斜杠命令表", () => {
    const state = feed([
      {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "compact", description: "压缩上下文" }],
      },
    ]);
    expect(state.availableCommands).toHaveLength(1);
  });

  it("原生 subagent 登记一次，重复的 spawned 不叠加；状态变化就地更新", () => {
    const state = feed([
      { sessionUpdate: "subagent_spawned", subagentSessionId: "sub-1", title: "查文档" },
      { sessionUpdate: "subagent_spawned", subagentSessionId: "sub-1", title: "查文档" },
      { sessionUpdate: "subagent_state_update", subagentSessionId: "sub-1", status: "done" },
    ]);
    expect(state.subagents).toHaveLength(1);
    expect(state.subagents[0]).toMatchObject({ subagentSessionId: "sub-1", state: "done" });
  });

  it("认不出的片段落成 unknown，原文一字不落地留着", () => {
    const state = feed([{ sessionUpdate: "某种新东西", 自定义字段: 42 } as SessionUpdate]);
    expect(state.items[0]).toMatchObject({ kind: "unknown", sessionUpdate: "某种新东西" });
    expect(state.items[0]).toMatchObject({ raw: { 自定义字段: 42 } });
  });
});

describe("本地消息与回执", () => {
  it("用户消息进流，回执挂到那一条上", () => {
    let state = appendUser(emptyChat(), "补一句", 1);
    const itemId = state.items[0]!.id;
    const receipt: DeliveryReceipt = {
      outcome: "injected",
      tier: "concurrent",
      requestedTier: "extension",
      sessionRef: "zcode#a",
      deliveredAt: 2,
    };
    state = attachReceipt(state, itemId, receipt);
    expect(state.items[0]).toMatchObject({ kind: "user", receipt: { outcome: "injected" } });
  });

  it("回执挂到不存在的消息上时原样返回，不炸", () => {
    const state = appendUser(emptyChat(), "x", 1);
    const receipt = { outcome: "queued", tier: "queue", sessionRef: "a", deliveredAt: 1 } as DeliveryReceipt;
    expect(attachReceipt(state, "不存在", receipt)).toBe(state);
  });

  it("通知项带语气，失败用 bad", () => {
    const state = appendNotice(emptyChat(), "连接断了", "bad", 1);
    expect(state.items[0]).toMatchObject({ kind: "notice", tone: "bad" });
  });
});

describe("读穿的全文 → 聊天项", () => {
  it("text / thought / tool_call 各自转成对应的项，结构性片段不占流", () => {
    const chat = transcriptToChat([
      {
        messageId: "m1",
        role: "user",
        createdAt: 1,
        parts: [{ kind: "text", text: "读一下 note.txt" }],
      },
      {
        messageId: "m2",
        role: "assistant",
        createdAt: 2,
        parts: [
          { kind: "step_start" },
          { kind: "thought", text: "先 cat" },
          {
            kind: "tool_call",
            tool: { name: "Bash", callId: "c1", status: "completed", input: { command: "cat" }, output: "hello" },
          },
          { kind: "text", text: "hello" },
          { kind: "step_finish" },
        ],
      },
    ]);
    expect(chat.items.map((i) => i.kind)).toEqual(["user", "thought", "tool", "assistant"]);
    const tool = chat.items[2]!;
    expect(tool.kind === "tool" && tool.card.status).toBe("completed");
    expect(tool.kind === "tool" && tool.card.content[0]?.text).toBe("hello");
  });

  it("引擎的 running 映射成 in_progress", () => {
    const chat = transcriptToChat([
      { messageId: "m", role: "assistant", parts: [{ kind: "tool_call", tool: { status: "running" } }] },
    ]);
    const tool = chat.items[0];
    expect(tool?.kind === "tool" && tool.card.status).toBe("in_progress");
  });

  it("认不出的片段同样保留原文", () => {
    const chat = transcriptToChat([
      { messageId: "m", role: "assistant", parts: [{ kind: "unknown", raw: { 原文: 1 } }] },
    ]);
    expect(chat.items[0]).toMatchObject({ kind: "unknown", sessionUpdate: "unknown" });
  });

  it("空转录不产生任何项", () => {
    expect(transcriptToChat([]).items).toHaveLength(0);
  });
});
