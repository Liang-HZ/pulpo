import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DelegationBroker } from "../../src/broker/delegate.js";
import { SessionGraph } from "../../src/graph/sessionGraph.js";
import { DeliveryLadder } from "../../src/delivery/ladder.js";
import { ErrorCode, RpcError } from "../../src/errors.js";
import type { AcpKernel } from "../../src/acp/kernel.js";

let dir: string;
let graph: SessionGraph;
let broker: DelegationBroker;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join("/tmp", `pulpo-breaker-${process.pid}-`));
  graph = new SessionGraph({ file: path.join(dir, "graph.json") });
  const kernel = {} as unknown as AcpKernel;
  broker = new DelegationBroker({
    kernel,
    graph,
    ladder: new DeliveryLadder(kernel),
    stateFile: path.join(dir, "tasks.json"),
  });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("一层熔断（被派活的会话不得再往外派）", () => {
  it("人直接派活不受限（callerRef 为空）", () => {
    expect(() => broker.assertMayDelegate(null)).not.toThrow();
    expect(() => broker.assertMayDelegate(undefined)).not.toThrow();
  });

  it("根会话可以派活", () => {
    graph.upsertNode({ id: "zcode#root", kind: "root", agentId: "zcode", sessionId: "root" });
    expect(() => broker.assertMayDelegate("zcode#root")).not.toThrow();
  });

  it("被派活的会话再往外派 → 拒绝", () => {
    graph.addDelegate({ from: "zcode#root", to: "zcode#child", taskId: "t1", task: "干活" });
    expect(() => broker.assertMayDelegate("zcode#child")).toThrow(RpcError);
  });

  it("错误码与 data 对齐 exit 3 语义", () => {
    graph.addDelegate({ from: "zcode#root", to: "zcode#child", taskId: "t1", task: "干活" });
    let caught: RpcError | null = null;
    try {
      broker.assertMayDelegate("zcode#child");
    } catch (err) {
      caught = err as RpcError;
    }
    expect(caught).toBeInstanceOf(RpcError);
    expect(caught!.code).toBe(ErrorCode.RecursionBlocked);
    expect(caught!.code).toBe(-32003);
    expect(caught!.message).toBe("recursion blocked (one-level dispatch only)");
    expect(caught!.data).toMatchObject({ legacyExitCode: 3, sessionRef: "zcode#child" });
  });

  it("派活方自己也是别人的派活方时仍可派（只熔断被派活方）", () => {
    graph.addDelegate({ from: "zcode#a", to: "zcode#b", taskId: "t1", task: "x" });
    expect(() => broker.assertMayDelegate("zcode#a")).not.toThrow();
    expect(() => broker.assertMayDelegate("zcode#b")).toThrow(RpcError);
  });

  it("熔断状态跟着会话图落盘，重启后仍然生效", () => {
    graph.addDelegate({ from: "zcode#root", to: "zcode#child", taskId: "t1", task: "干活" });
    graph.save();
    const reloaded = new SessionGraph({ file: graph.filePath });
    const kernel = {} as unknown as AcpKernel;
    const broker2 = new DelegationBroker({
      kernel,
      graph: reloaded,
      ladder: new DeliveryLadder(kernel),
      stateFile: path.join(dir, "tasks2.json"),
    });
    expect(() => broker2.assertMayDelegate("zcode#child")).toThrow(RpcError);
  });
});

describe("任务登记（薄状态）", () => {
  it("没有任务时 getTask 报 NotFound", () => {
    try {
      broker.getTask("不存在");
      throw new Error("本该抛错");
    } catch (err) {
      expect((err as RpcError).code).toBe(ErrorCode.NotFound);
    }
  });

  it("重启后仍在 running 的任务如实标成 failed，不装作还在跑", () => {
    const file = path.join(dir, "tasks3.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        tasks: [
          {
            taskId: "t1",
            agentId: "zcode",
            sessionRef: "zcode#s",
            parentRef: null,
            task: "x",
            cwd: "/tmp",
            status: "running",
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
    );
    const kernel = {} as unknown as AcpKernel;
    const b = new DelegationBroker({
      kernel,
      graph,
      ladder: new DeliveryLadder(kernel),
      stateFile: file,
    });
    const t = b.getTask("t1");
    expect(t.status).toBe("failed");
    expect(t.error).toMatch(/core 重启/);
  });
});
