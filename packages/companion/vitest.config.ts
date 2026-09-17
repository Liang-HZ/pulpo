import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // 集成测试要真起 core daemon + ZCode 引擎并跑真实回合。
    testTimeout: 300_000,
    hookTimeout: 300_000,
    teardownTimeout: 60_000,
    // 每个集成测试文件各持一个引擎子进程，并发会互相抢 → 串行。
    fileParallelism: false,
    reporters: ["verbose"],
  },
});
