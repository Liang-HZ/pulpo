import { defineConfig } from "@playwright/test";

/**
 * 真实链路验收：core daemon（临时 PULPO_HOME）+ 真 ZCode adapter + `dev:web`。
 * 一个 worker、不重试——真的跑一轮 agent，重试只会多烧额度、掩盖问题。
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  workers: 1,
  retries: 0,
  fullyParallel: false,
  timeout: 300_000,
  expect: { timeout: 120_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "pnpm dev:web",
    url: "http://localhost:5173",
    reuseExistingServer: false,
    stdout: "pipe",
    timeout: 60_000,
  },
});
