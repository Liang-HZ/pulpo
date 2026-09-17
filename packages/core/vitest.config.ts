import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // 集成测试要真的起 ZCode 引擎并跑一轮模型，单测秒级。
    testTimeout: 300_000,
    hookTimeout: 300_000,
    teardownTimeout: 60_000,
    // 集成测试各自持有一个引擎子进程，并发跑会互相抢引擎 → 串行。
    fileParallelism: false,
    reporters: ["verbose"],
  },
});
