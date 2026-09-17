import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PulpoDaemon } from "../../src/server/daemon.js";
import { objectExists } from "../../src/git/snapshot.js";
import { RpcClient, haveZcode, makeTestEnv, startDaemon, waitFor, type TestEnv } from "../helpers.js";

/**
 * 契约覆盖的端到端验收（真实 ZCode 引擎、真实模型）：
 * 行数统计 changeStat / 回合边界 / 模式危险等级 / 用量聚合 / 转录分页 /
 * 权限 `_meta` 样本 / 回合级改动与撤销 / descriptor 缓存与通知 requestId。
 *
 * 只跑**一轮**模型（渠道额度如 Coding Plan 按滚动窗口计量），prompt 尽量短，其余全靠这一轮的
 * 产物做断言。
 */
describe.runIf(haveZcode())("契约端到端（真实 ZCode 引擎）", () => {
  const ROOT = `/tmp/pulpo-core-gaps-${process.pid}`;
  let t: TestEnv;
  let daemon: PulpoDaemon;
  let c: RpcClient;
  let modelId: string;
  let taskId: string;
  let childRef: string;
  let turnId: string;
  const updates: any[] = [];
  const permissionSamples: any[] = [];
  let threeTxtAfterTurn = "";

  const three = () => path.join(t.ws, "three.txt");
  const keep = () => path.join(t.ws, "keep.txt");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: t.ws, encoding: "utf8" });

  beforeAll(async () => {
    t = makeTestEnv("gaps", ROOT);
    // 工作区是个真 git 仓库——回合级快照 / 撤销要它。
    execFileSync("git", ["init", "-q", t.ws]);
    git("config", "user.email", "test@pulpo.local");
    git("config", "user.name", "pulpo test");
    fs.writeFileSync(keep(), "old-1\nold-2\n");
    git("add", "-A");
    git("commit", "-qm", "init");

    daemon = await startDaemon(t, {
      // 审批如实走通道，但测试里当场放行——这一轮要的是编辑真的发生。
      // 同时把 agent 的原始请求留一份，作为 PROTOCOL 的文档样本。
      approvalPolicy: (a) => {
        permissionSamples.push({ requestId: a.requestId, request: a.request, options: a.options });
        const allow = a.options.find((o) => o.kind === "allow_once") ?? a.options[0];
        return allow ? { outcome: "selected", optionId: allow.optionId } : { outcome: "cancelled" };
      },
    });
    c = await RpcClient.unix(daemon.socketPath!);
    await c.call("subscribe", { topics: ["session/update", "task/update"] });
    c.onNotification((m) => {
      if (m.method === "session/update") updates.push(m.params);
    });
  });

  afterAll(async () => {
    c?.close();
    await daemon?.stop();
    t?.cleanup();
  });

  it("没有活动会话时 agent/descriptor 也答得出（现探一次，标 source=probed）", async () => {
    const d = await c.call("agent/descriptor", { agentId: "zcode", cwd: t.ws });
    expect(d.source).toBe("probed");
    expect(d.models.length).toBeGreaterThan(0);
    expect(d.currentModelId).toBeTruthy();
    modelId = d.currentModelId;
    // 模式危险等级到位，UI 不必做字符串匹配
    const byId = Object.fromEntries(d.modes.map((m: any) => [m.id, m.risk]));
    expect(byId).toMatchObject({
      default: "safe",
      plan: "safe",
      acceptEdits: "elevated",
      bypassPermissions: "full",
    });
    // 等级是覆盖表补的，每条都可审计
    const riskCorrections = d.corrections.filter((x: any) => x.path.includes("risk"));
    expect(riskCorrections.length).toBe(4);
    expect(riskCorrections[0].evidence).toMatch(/_decide_permission|MODE_TO_ENGINE/);
    // 工作区在 git 仓库里 → 回合级撤销可用
    expect(d.revert).toMatchObject({ supported: "available", kind: "shell-git-snapshot" });
  });

  it("探完就关：探测不会留下活动会话", async () => {
    expect(await c.call("session/open")).toEqual([]);
  });

  it("再问一次时走缓存（source=cached，带时间戳），不再起进程", async () => {
    const d = await c.call("agent/descriptor", { agentId: "zcode" });
    expect(d.source).toBe("cached");
    expect(typeof d.cachedAt).toBe("number");
    expect(d.currentModelId).toBe(modelId);
  });

  it("跑一轮真回合：写一个三行文件 + 改一个已有文件", async () => {
    const res = await c.call("task/delegate", {
      agentId: "zcode",
      task:
        `用 Write 工具新建文件 ${three()}，内容正好三行：第一行 a，第二行 b，第三行 c。` +
        `再用 Edit 工具把 ${keep()} 里的 old-2 改成 new-2。做完就停，不要解释。`,
      cwd: t.ws,
      modelId,
    });
    taskId = res.taskId;
    childRef = res.sessionRef;
    await waitFor(
      () => ["done", "failed", "cancelled"].includes(daemon.broker.getTask(taskId).status),
      { what: "任务跑完", timeoutMs: 240_000 },
    );
    const task = daemon.broker.getTask(taskId);
    expect(task.status).toBe("done");
    expect(fs.existsSync(three())).toBe(true);
    threeTxtAfterTurn = fs.readFileSync(three(), "utf8");
    expect(threeTxtAfterTurn.trimEnd().split("\n")).toHaveLength(3);
  });

  it("订阅端拿到 turn_started → tool_call(derived.changeStat) → turn_finished", async () => {
    const mine = updates.filter((u) => u.sessionRef === childRef);
    const startedAt = mine.findIndex((u) => u.derived?.event === "turn_started");
    expect(startedAt).toBeGreaterThanOrEqual(0);
    turnId = mine[startedAt].derived.turnId;
    expect(typeof mine[startedAt].derived.startedAt).toBe("number");
    expect(mine[startedAt].update).toBeUndefined(); // 壳内合成，不冒充 agent 的 update

    // changeStat 只挂在结算后的那条工具通知上，且 added = 3（三行文件）
    const statIdx = mine.findIndex((u) =>
      (u.derived?.changeStat ?? []).some(
        (s: any) => s.path.endsWith("three.txt") && s.added === 3,
      ),
    );
    expect(statIdx).toBeGreaterThan(startedAt);
    const statNotification = mine[statIdx];
    expect(statNotification.update.sessionUpdate).toMatch(/^tool_call(_update)?$/);
    expect(statNotification.update.derived).toBeUndefined(); // agent 原文没被改写
    // eslint-disable-next-line no-console
    console.log("[changeStat 样本]", JSON.stringify(statNotification, null, 2).slice(0, 2000));

    await waitFor(
      () => updates.some((u) => u.sessionRef === childRef && u.derived?.event === "turn_finished"),
      { what: "turn_finished", timeoutMs: 60_000 },
    );
    const finished = updates.filter(
      (u) => u.sessionRef === childRef && u.derived?.event === "turn_finished",
    );
    expect(finished).toHaveLength(1);
    const d = finished[0].derived;
    expect(d.turnId).toBe(turnId);
    expect(d.stopReason).toBeTruthy();
    expect(d.endedAt).toBeGreaterThanOrEqual(d.startedAt);
    // turn_finished 自带改动摘要，UI 直接渲染文件改动汇总卡
    expect(d.changes).toMatchObject({ revert: "available" });
    expect(d.changes.files).toBeGreaterThanOrEqual(1);
    expect(d.changes.added).toBeGreaterThanOrEqual(3);
    // eslint-disable-next-line no-console
    console.log("[turn_finished 样本]", JSON.stringify(finished[0], null, 2));
    // eslint-disable-next-line no-console
    console.log(
      "[turn_started 样本]",
      JSON.stringify(mine[startedAt], null, 2),
    );
  });

  it("task/get 的 usage 来自 agent 自报 + core 自己数的工具次数", async () => {
    const task = await c.call("task/get", { taskId });
    expect(task.usage).toBeTruthy();
    expect(task.usage.toolCalls).toBeGreaterThanOrEqual(1);
    for (const [k, v] of Object.entries(task.usage)) {
      expect(typeof v).toBe("number"); // 拿不到的字段是省略，不是 0
      expect(v as number).toBeGreaterThan(0);
      expect(k).toMatch(/^(inputTokens|outputTokens|toolCalls|contextUsed|contextTotal)$/);
    }
  });

  it("人从壳里派的活也进会话图，右栏画得出派活层", async () => {
    const tree = await c.call("graph/tree", { sessionRef: "human" });
    expect(tree.children.map((x: any) => x.id)).toContain(childRef);
    const { edges } = await c.call("graph/edges", { kind: "delegate", to: childRef });
    expect(edges[0]).toMatchObject({ from: "human", via: "human" });
    const results = await c.call("graph/edges", { kind: "result", from: childRef });
    expect(results.edges[0]).toMatchObject({ to: "human", status: "done" });
  });

  it("read/transcript 分页，limit=1 时 hasMore=true，翻页不重复读穿", async () => {
    const bare = childRef.slice("zcode#".length).replace(/^zc-/, "");
    const t0 = Date.now();
    const first = await c.call("read/transcript", {
      agentId: "zcode",
      sessionId: bare,
      cwd: t.ws,
      limit: 1,
    });
    const firstMs = Date.now() - t0;
    expect(first.messages).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    expect(first.cursor).toBeTruthy();
    expect(first.total).toBeGreaterThan(1);
    expect(first.cached).toBe(false);

    const t1 = Date.now();
    const second = await c.call("read/transcript", {
      agentId: "zcode",
      sessionId: bare,
      cwd: t.ws,
      limit: 1,
      before: first.cursor,
    });
    const secondMs = Date.now() - t1;
    expect(second.messages).toHaveLength(1);
    expect(second.messages[0].messageId).not.toBe(first.messages[0].messageId);
    expect(second.cached).toBe(true);
    // 翻页走缓存：第二页必须显著快于第一页的 resume→read→close
    expect(secondMs).toBeLessThan(Math.max(200, firstMs / 2));
    // eslint-disable-next-line no-console
    console.log(`[分页] 首页 ${firstMs}ms（真读穿）/ 次页 ${secondMs}ms（缓存）`);
  });

  it("读取层的工具片段同样带 changeStat", async () => {
    const bare = childRef.slice("zcode#".length).replace(/^zc-/, "");
    const page = await c.call("read/transcript", { agentId: "zcode", sessionId: bare, cwd: t.ws });
    const stats = page.messages
      .flatMap((m: any) => m.parts)
      .filter((p: any) => p.kind === "tool_call" && p.tool?.changeStat)
      .flatMap((p: any) => p.tool.changeStat);
    expect(stats.some((s: any) => s.path.endsWith("three.txt") && s.added === 3)).toBe(true);
  });

  it("抓到一条真实的权限请求样本（_meta 原样透传）", () => {
    expect(permissionSamples.length).toBeGreaterThan(0);
    const sample = permissionSamples[0];
    expect(sample.request).toBeTruthy();
    expect(Array.isArray(sample.options)).toBe(true);
    // eslint-disable-next-line no-console
    console.log("[permission 样本]", JSON.stringify(sample, null, 2).slice(0, 3000));
  });

  it("session/changes 报出新建与修改两条，行数与工具统计对得上", async () => {
    const changes = await c.call("session/changes", { sessionRef: childRef, turnId });
    const byPath = Object.fromEntries(changes.files.map((f: any) => [f.path, f]));
    expect(byPath["three.txt"]).toMatchObject({ status: "added", added: 3, removed: 0 });
    expect(byPath["keep.txt"]).toMatchObject({ status: "modified" });
    expect(changes.revert).toBe("available");
    const snap = daemon.turns.get(turnId)!;
    expect(await objectExists(t.ws, snap.treeBefore!)).toBe(true);
    // eslint-disable-next-line no-console
    console.log(`[changes] 快照耗时 ms=${JSON.stringify(snap.snapshotMs)} tree=${snap.treeBefore}`);
  });

  it("用户手改过的文件 revert 时被跳过，不覆盖用户的改动", async () => {
    fs.writeFileSync(three(), "人后来自己改的\n");
    const res = await c.call("session/revert", { sessionRef: childRef, turnId });
    const skipped = res.skipped.find((s: any) => s.path === "three.txt");
    expect(skipped).toBeTruthy();
    expect(skipped.reason).toContain("已被外部修改");
    expect(fs.readFileSync(three(), "utf8")).toBe("人后来自己改的\n");
    // keep.txt 没被手改 → 正常回滚到回合开始时的内容
    expect(res.reverted).toContain("keep.txt");
    expect(fs.readFileSync(keep(), "utf8")).toBe("old-1\nold-2\n");
  });

  it("内容与回合结束时一致时，本回合新建的文件被删掉", async () => {
    fs.writeFileSync(three(), threeTxtAfterTurn);
    const res = await c.call("session/revert", { sessionRef: childRef, turnId, paths: ["three.txt"] });
    expect(res.reverted).toEqual(["three.txt"]);
    expect(fs.existsSync(three())).toBe(false);
  });

  it("prompt 发出 200ms 后投递，空窗不再回 promptRequired（采样验证）", async () => {
    const opened = await c.call("session/new", { agentId: "zcode", cwd: t.ws });
    const ref = opened.sessionRef;
    const samples: any[] = [];
    try {
      for (let i = 0; i < 2; i++) {
        const turn = c.call("session/prompt", {
          sessionRef: ref,
          text: `第 ${i + 1} 次：只回答一个字：好。不要调用任何工具。`,
        });
        const sentAt = Date.now();
        await new Promise((r) => setTimeout(r, 200));
        const receipt = await c.call("delivery/send", {
          sessionRef: ref,
          text: "（这条只是投递探针，忽略它，继续原来的回答）",
        });
        samples.push({
          waitedMs: Date.now() - sentAt,
          outcome: receipt.outcome,
          attempts: receipt.attempts,
        });
        await turn.catch(() => undefined);
      }
    } finally {
      await c.call("session/close", { sessionRef: ref }).catch(() => undefined);
    }
    // eslint-disable-next-line no-console
    console.log("[D 采样]", JSON.stringify(samples, null, 2));
    for (const s of samples) {
      // 空窗消失的判据：200ms 就投也能被目标收下，不再是 no_active_turn
      expect(s.outcome).toBe("injected");
    }
  });

  it("薄状态：回合快照只存 hash 与行数，没有任何文件内容", () => {
    const raw = fs.readFileSync(daemon.turns.filePath, "utf8");
    expect(raw).toContain(turnId);
    expect(raw).not.toContain("old-1");
    expect(raw).not.toContain(threeTxtAfterTurn);
    // 有的是 hash 与行数
    const snap = JSON.parse(raw).turns.find((x: any) => x.turnId === turnId);
    expect(snap.treeBefore).toMatch(/^[0-9a-f]{40}$/);
    expect(snap.files.every((f: any) => typeof f.added === "number")).toBe(true);
    // 修好符号链接（/tmp ↔ /private/tmp）之后，本回合碰过的路径记全了
    expect(snap.touched).toContain("three.txt");
  });
});
