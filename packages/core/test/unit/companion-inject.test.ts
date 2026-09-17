import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  COMPANION_SERVER_NAME,
  companionAvailable,
  companionBin,
  companionEnabled,
  companionMcpServer,
} from "../../src/companion/inject.js";

/** 造一个"构建过的" companion 包布局：bin + dist/cli.js。 */
function fakeCompanion(): { bin: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join("/tmp", `pulpo-companion-fake-${process.pid}-`));
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  const bin = path.join(root, "bin", "pulpo-companion");
  fs.writeFileSync(bin, "#!/usr/bin/env node\n", { mode: 0o755 });
  fs.writeFileSync(path.join(root, "dist", "cli.js"), "export const main = () => {};\n");
  return { bin, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe("companion 注入", () => {
  it("默认开启，PULPO_COMPANION=off 关闭", () => {
    expect(companionEnabled({})).toBe(true);
    expect(companionEnabled({ PULPO_COMPANION: "on" })).toBe(true);
    for (const off of ["off", "OFF", "0", "false", "no"]) {
      expect(companionEnabled({ PULPO_COMPANION: off })).toBe(false);
    }
  });

  it("bin 路径：PULPO_COMPANION_BIN 覆盖仓内默认路径", () => {
    expect(companionBin({})).toMatch(/packages\/companion\/bin\/pulpo-companion$/);
    expect(companionBin({ PULPO_COMPANION_BIN: "/tmp/x/bin/pulpo-companion" })).toBe(
      "/tmp/x/bin/pulpo-companion",
    );
  });

  it("companion 没构建过（只有 bin、没有 dist）时不注入——不让 agent 去启一个必崩的 MCP server", () => {
    const f = fakeCompanion();
    expect(companionAvailable({ PULPO_COMPANION_BIN: f.bin })).toBe(true);
    fs.rmSync(path.join(path.dirname(path.dirname(f.bin)), "dist"), { recursive: true });
    expect(companionAvailable({ PULPO_COMPANION_BIN: f.bin })).toBe(false);
    expect(companionAvailable({ PULPO_COMPANION_BIN: "/no/such/bin" })).toBe(false);
    f.cleanup();
  });

  it("注入记录是 ACP 的 stdio MCP server 形状，env 带令牌与 core 地址", () => {
    const f = fakeCompanion();
    const entry = companionMcpServer(
      "tok-1",
      { PULPO_COMPANION_BIN: f.bin, PULPO_HOME: "/tmp/home" },
      { socketPath: "/tmp/home/run/core.sock", wsPort: 27183 },
    );
    expect(entry.name).toBe(COMPANION_SERVER_NAME);
    expect(entry.command).toBe(f.bin);
    expect(entry.args).toEqual([]);
    // ACP 的 env 是 {name,value} 数组（引擎的 schema 要数组，map 会被整条拒掉）
    expect(entry.env).toEqual([
      { name: "PULPO_SESSION_TOKEN", value: "tok-1" },
      { name: "PULPO_HOME", value: "/tmp/home" },
      { name: "PULPO_SOCKET", value: "/tmp/home/run/core.sock" },
      { name: "PULPO_CORE_WS", value: "27183" },
    ]);
    f.cleanup();
  });

  it("socket 没开时只带 WebSocket 端口，companion 据此回落", () => {
    const f = fakeCompanion();
    const entry = companionMcpServer("tok-2", { PULPO_COMPANION_BIN: f.bin }, { socketPath: null, wsPort: 5555 });
    expect(entry.env.map((e) => e.name)).toEqual(["PULPO_SESSION_TOKEN", "PULPO_CORE_WS"]);
    f.cleanup();
  });
});
