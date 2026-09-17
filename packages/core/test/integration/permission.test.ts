import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PulpoDaemon } from "../../src/server/daemon.js";
import { RpcClient, haveZcode, makeTestEnv, startDaemon, waitFor, type TestEnv } from "../helpers.js";

/**
 * 审批链路（真实 ZCode 引擎）。
 *
 * 选一个必然触发权限的短任务：写一个文件。默认安全模式是"变更前确认"，
 * 引擎的 `interaction/requestPermission` 经 adapter 变成 ACP 的
 * `session/request_permission`，再经 daemon 变成 socket 通知
 * `permission/requested` —— 全链路四跳都要走通。
 */
describe.runIf(haveZcode())("审批链路（真实 ZCode 引擎）", () => {
  let t: TestEnv;
  let daemon: PulpoDaemon;
  let c: RpcClient;
  let sessionRef: string;
  let target: string;

  beforeAll(async () => {
    t = makeTestEnv("perm");
    // 审批超时设短一点，方便验证"超时按默认拒绝"。
    daemon = await startDaemon(t, { approvalTimeoutMs: 8000 });
    c = await RpcClient.unix(daemon.socketPath!);
    await c.call("subscribe", { topics: ["permission/requested", "session/update"] });
    target = path.join(t.ws, "pulpo-approval.txt");
  });

  afterAll(async () => {
    c?.close();
    await daemon?.stop();
    t?.cleanup();
  });

  it("默认不自动放行：没人应答就一直挂着", async () => {
    const res = await c.call("session/new", { agentId: "zcode", cwd: t.ws });
    sessionRef = res.sessionRef;
    // 安全模式必须是"变更前确认"，否则这条用例验不到东西。
    expect(res.descriptor.currentModeId).toBe("default");
  });

  it("写文件触发审批 → 通知到达 → 应答放行 → 文件真的落地", async () => {
    const seen: any[] = [];
    const off = c.onNotification((m) => {
      if (m.method === "permission/requested") seen.push(m.params);
    });

    const turn = c.call("session/prompt", {
      sessionRef,
      text: `用 Write 工具创建文件 ${target}，内容就写 pulpo-ok 四个字符。不要做别的事，不要解释。`,
    });

    await waitFor(() => seen.length > 0, { what: "permission/requested 通知", timeoutMs: 180_000 });
    const req = seen[0];
    expect(req.requestId).toBeTruthy();
    expect(req.sessionRef).toBe(sessionRef);
    expect(req.agentId).toBe("zcode");
    expect(Array.isArray(req.options)).toBe(true);
    expect(req.options.length).toBeGreaterThan(0);
    // 原始请求里带着 agent 给的工具调用详情
    expect(req.request).toBeTruthy();

    // 挂起期间：pending 列表里查得到
    const pending = await c.call("permission/pending");
    expect(pending.pending.map((p: any) => p.requestId)).toContain(req.requestId);

    const allow =
      req.options.find((o: any) => o.kind === "allow_once") ??
      req.options.find((o: any) => o.kind === "allow_always") ??
      req.options[0];
    await c.call("permission/respond", {
      requestId: req.requestId,
      outcome: "selected",
      optionId: allow.optionId,
    });

    // 已结算的请求不能再应答
    const again = await c.raw("permission/respond", {
      requestId: req.requestId,
      outcome: "cancelled",
    });
    expect(again.error.code).toBe(-32004);

    const res = await turn;
    expect(res.stopReason).toBe("end_turn");
    expect(fs.existsSync(target), `${target} 本该被写出来`).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toContain("pulpo-ok");
    off();
  });

  it("写过文件之后有了工作区检查点，session/fork 就能成", async () => {
    const res = await c.call("session/fork", { sessionRef });
    expect(res.sessionRef).toMatch(/^zcode#/);
    expect(res.sessionRef).not.toBe(sessionRef);
  });

  it("审批超时按默认拒绝结算，绝不默认放行", async () => {
    const { defaultDeny } = await import("../../src/server/approvals.js");
    // 有拒绝选项就选它
    expect(
      defaultDeny([
        { optionId: "a", kind: "allow_once" },
        { optionId: "r", kind: "reject_once" },
      ]),
    ).toEqual({ outcome: "selected", optionId: "r" });
    // 没有拒绝选项就回 ACP 的 cancelled —— 不是 selected 到某个放行项
    expect(defaultDeny([{ optionId: "a", kind: "allow_once" }])).toEqual({ outcome: "cancelled" });
    expect(defaultDeny([])).toEqual({ outcome: "cancelled" });
  });

  it("超时真的会发生：挂着不理，到点自己按拒绝结算", async () => {
    const { ApprovalHub } = await import("../../src/server/approvals.js");
    const hub = new ApprovalHub({ timeoutMs: 300 });
    const t0 = Date.now();
    const res = await hub.request({
      sessionRef: "zcode#x",
      agentId: "zcode",
      request: { options: [{ optionId: "deny", kind: "reject_once" }] },
    });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(res.outcome).toEqual({ outcome: "selected", optionId: "deny" });
    expect(hub.list()).toHaveLength(0);
  });

  it("会话被取消时，挂着的审批一律按 cancelled 结算（ACP 的要求）", async () => {
    const { ApprovalHub } = await import("../../src/server/approvals.js");
    const hub = new ApprovalHub({ timeoutMs: 60_000 });
    const p = hub.request({ sessionRef: "zcode#y", agentId: "zcode", request: { options: [] } });
    await waitFor(() => hub.list().length === 1, { timeoutMs: 2000, what: "审批挂起" });
    expect(hub.cancelForSession("zcode#y")).toBe(1);
    expect((await p).outcome).toEqual({ outcome: "cancelled" });
  });

  it("策略可以自动裁决，但必须是上层显式设的", async () => {
    const { ApprovalHub } = await import("../../src/server/approvals.js");
    const withPolicy = new ApprovalHub({
      timeoutMs: 200,
      policy: () => ({ outcome: "selected", optionId: "auto" }),
    });
    expect((await withPolicy.request({ sessionRef: "a", agentId: "z", request: {} })).outcome)
      .toEqual({ outcome: "selected", optionId: "auto" });
    // 没设策略的那个 hub（上面那条用例）走的是超时默认拒绝——两者行为截然不同
  });
});
