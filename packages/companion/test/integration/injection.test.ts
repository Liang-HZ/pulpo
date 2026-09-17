import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PulpoDaemon } from "@liangai/pulpo-core";
import {
  RpcClient,
  adapterLogs,
  haveZcode,
  makeTestEnv,
  startDaemon,
  type TestEnv,
} from "../helpers.js";

/**
 * 端到端注入（真实 core + 真实 ZCode 引擎 + 真实模型）。
 *
 * core 在 `session/new` 时把 companion 作为 stdio MCP server 注入进会话，
 * env 里带一次性令牌；companion 用 `companion/identify` 换回自己所在的
 * sessionRef。这条用例证明**注入链路真的通到引擎**：让模型自己去调
 * `list_agents`，再从转录里找那次工具调用。
 */
describe.runIf(haveZcode())("companion 注入到真实引擎会话", () => {
  let t: TestEnv;
  let daemon: PulpoDaemon;
  let c: RpcClient;
  let sessionRef: string;
  const updates: any[] = [];
  const approvals: any[] = [];

  beforeAll(async () => {
    t = makeTestEnv("inject");
    daemon = await startDaemon(t);
    c = await RpcClient.unix(daemon.socketPath!);
    await c.call("subscribe", { topics: ["session/update", "permission/requested"] });
    // 引擎调 MCP 工具前会向客户端要授权（实测：companion 的 list_agents 也走这条）。
    // 壳的角色就是裁决方——没人答的话 core 会在 5 分钟后按默认拒绝结算。
    c.onNotification((m) => {
      if (m.method !== "permission/requested") return;
      const allow =
        m.params.options.find((o: any) => o.kind === "allow_always") ??
        m.params.options.find((o: any) => o.kind === "allow_once");
      approvals.push(m.params);
      void c.call("permission/respond", {
        requestId: m.params.requestId,
        outcome: "selected",
        optionId: allow.optionId,
      });
    });
    const res = await c.call("session/new", { agentId: "zcode", cwd: t.ws });
    sessionRef = res.sessionRef;
  });

  afterAll(async () => {
    c?.close();
    await daemon?.stop();
    t?.cleanup();
  });

  it("引擎侧看得到 companion 的工具调用（模型自己调 list_agents）", async () => {
    const res = await c.call(
      "session/prompt",
      {
        sessionRef,
        text:
          "调用 pulpo 的 list_agents 工具，把它返回的 agent_type 原样列出来。" +
          "不要调用别的工具，不要做别的事。",
      },
      280_000,
    );
    expect(res.stopReason).toBe("end_turn");

    for (const n of c.notifications) {
      if (n.method === "session/update") updates.push(n.params);
    }
    const toolCalls = updates
      .filter((u) => u.sessionRef === sessionRef)
      .map((u) => u.update)
      .filter((u: any) => u?.sessionUpdate === "tool_call" || u?.sessionUpdate === "tool_call_update");
    // 引擎给 MCP 工具的名字是 `mcp__<server>__<tool>`；后续的 tool_call_update
    // 只带 toolCallId，所以按 id 把一次调用的全部片段收拢。
    const callIds = new Set(
      toolCalls
        .filter((u: any) => typeof u.title === "string" && u.title.includes("list_agents"))
        .map((u: any) => u.toolCallId),
    );
    const companionCalls = toolCalls.filter((u: any) => callIds.has(u.toolCallId));
    // 原始证据落在本测试的临时目录里（随 cleanup 一起清掉，不在 /tmp 留垃圾）。
    fs.writeFileSync(
      path.join(t.root, "injection-evidence.json"),
      JSON.stringify(companionCalls, null, 2),
    );
    expect(companionCalls.length).toBeGreaterThan(0);

    // 工具确实跑成功了，而且回的是 companion 的聚合结果（含 zcode 这一路）。
    // 引擎确实为这次 MCP 工具调用要过授权（壳内审批卡片的真实来源）
    expect(approvals.length).toBeGreaterThan(0);
    expect(JSON.stringify(approvals)).toContain("list_agents");

    const done = companionCalls.filter((u: any) => u.status === "completed");
    expect(done.length).toBeGreaterThan(0);
    expect(JSON.stringify(done)).toContain("zcode");
  });

  it("模型的回答里带上了 companion 返回的渠道 id", async () => {
    const text = updates
      .filter(
        (u) => u.sessionRef === sessionRef && u.update?.sessionUpdate === "agent_message_chunk",
      )
      .map((u) => u.update.content?.text ?? "")
      .join("");
    expect(text).toContain("zcode");
  });

  it("注入用的是令牌换身份：companion 在会话里认得自己是谁", async () => {
    // 令牌只有 core 知道；identify 换回来的必须正是这条会话。
    const open = await c.call("session/open");
    expect(open.map((s: any) => s.sessionRef)).toContain(sessionRef);
    const bogus = await c.raw(
      "companion/identify",
      { token: "根本不存在的令牌", waitMs: 500 },
      40_000,
    );
    expect(bogus.error.code).toBe(-32001);
  });

  it("adapter 日志里能看到 companion 被透传给引擎（注入的实测证据）", () => {
    const logs = adapterLogs(t);
    expect(logs).toContain("MCP FULL");
    expect(logs).toContain('"name": "pulpo"');
    expect(logs).toContain("PULPO_SESSION_TOKEN");
    expect(logs).toContain("bin/pulpo-companion");
  });

  it("PULPO_COMPANION=off 时一个 MCP 都不透传（另起一条 core 对照）", async () => {
    const off = makeTestEnv("inject-off");
    off.env.PULPO_COMPANION = "off";
    const d2 = await startDaemon(off);
    try {
      const c2 = await RpcClient.unix(d2.socketPath!);
      await c2.call("session/new", { agentId: "zcode", cwd: off.ws });
      const identify = await c2.raw("companion/identify", { token: "x", waitMs: 200 }, 40_000);
      expect(identify.error.code).toBe(-32001);
      const logs = adapterLogs(off);
      expect(logs).toContain('"mcpServers": []');
      expect(logs).not.toContain("MCP FULL");
      expect(logs).not.toContain("PULPO_SESSION_TOKEN");
      c2.close();
    } finally {
      await d2.stop();
      off.cleanup();
    }
  });
});
