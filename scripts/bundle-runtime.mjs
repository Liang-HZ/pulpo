#!/usr/bin/env node
/**
 * 把 core / companion / zcode adapter 收敛成一份**不依赖 node_modules** 的运行时目录，
 * 供 `tauri build` 打进 `.app` 的 `Contents/Resources`。
 *
 * 为什么需要它：仓库里的 `packages/<pkg>/dist` 是要 import 运行时的（core 要 ws 与
 * ACP SDK，companion 要 MCP SDK 与 zod）。pnpm 的 `node_modules` 全是相对符号链接，
 * 直接拷进 app 包必然断链。所以这里用 esbuild 把每个包的入口**连同依赖打成一个文件**，
 * 再按仓库原有的 `packages/` 目录形状摆好——这样 core 自己的路径解析
 * （`packageRoot()` / `packagesRoot()`，见 packages/core/src/paths.ts）在 app 包里
 * 得到的答案与在仓库里完全一致，adapter 与 companion 都不需要额外的环境变量。
 *
 * 产物（默认 `packages/shell/src-tauri/runtime/`）：
 *
 *   runtime/packages/
 *     core/      package.json · bin/pulpo-core · dist/cli.js（单文件，含依赖）
 *     companion/ package.json · bin/pulpo-companion · dist/cli.js（单文件，含依赖）
 *     adapters/zcode/bin/zcode-acp（Python 单文件，原样拷）
 *
 * 注意：入口取 `dist/cli.js`（它**导出** `main` 但自己不调用），`bin/pulpo-core`
 * 原样拷过去由它 `import { main }` 并调用——两边形状与仓库里完全一致。
 * 反过来拿 bin 当入口会把调用也打进产物，导致 bin 二次启动。
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outRoot = path.join(repoRoot, "packages", "shell", "src-tauri", "runtime");

/** esbuild 打包 CJS 依赖时，`require()` 在 ESM 输出里得有个真身。 */
const BANNER =
  'import{createRequire as __pulpoCreateRequire}from"module";' +
  "const require=__pulpoCreateRequire(import.meta.url);";

/**
 * 找 esbuild 可执行文件。它是 vite 的传递依赖，所以不一定有顶层 `node_modules/.bin` 入口；
 * 依次试：顶层 .bin → pnpm 的提升 bin → .pnpm 里任意一个 esbuild@*。
 */
function findEsbuild() {
  const direct = [
    path.join(repoRoot, "node_modules", ".bin", "esbuild"),
    path.join(repoRoot, "node_modules", ".pnpm", "node_modules", ".bin", "esbuild"),
  ];
  for (const candidate of direct) {
    if (fs.existsSync(candidate)) return candidate;
  }
  const store = path.join(repoRoot, "node_modules", ".pnpm");
  if (fs.existsSync(store)) {
    const hit = fs
      .readdirSync(store)
      .filter((name) => name.startsWith("esbuild@"))
      .sort()
      .reverse()
      .map((name) => path.join(store, name, "node_modules", "esbuild", "bin", "esbuild"))
      .find((p) => fs.existsSync(p));
    if (hit) return hit;
  }
  throw new Error(
    "找不到 esbuild。它是 vite 的传递依赖，先跑一次 `pnpm install` 再试。" +
      "（也可以显式 `pnpm add -Dw esbuild`）",
  );
}

/** 打一个包：入口 → 单文件。返回产物的字节数。 */
function bundle(esbuild, entry, outfile) {
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  const result = spawnSync(
    esbuild,
    [
      entry,
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--target=node22",
      `--banner:js=${BANNER}`,
      `--outfile=${outfile}`,
      "--log-level=warning",
    ],
    { cwd: repoRoot, stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error(`esbuild 打包失败（exit ${result.status}）：${path.relative(repoRoot, entry)}`);
  }
  return fs.statSync(outfile).size;
}

/** 把包摆成运行时目录里的一层：package.json + bin + dist/cli.js（单文件）。 */
function stagePackage(esbuild, name) {
  const src = path.join(repoRoot, "packages", name);
  const dest = path.join(outRoot, "packages", name);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.join(dest, "bin"), { recursive: true });

  const binName = name === "core" ? "pulpo-core" : "pulpo-companion";
  fs.copyFileSync(path.join(src, "package.json"), path.join(dest, "package.json"));
  const binPath = path.join(dest, "bin", binName);
  fs.copyFileSync(path.join(src, "bin", binName), binPath);
  fs.chmodSync(binPath, 0o755);

  const size = bundle(esbuild, path.join(src, "dist", "cli.js"), path.join(dest, "dist", "cli.js"));
  return { name, dest, size };
}

/** zcode adapter 是单文件 Python，原样拷过去，保持 core 期望的相对位置。 */
function stageAdapter() {
  const src = path.join(repoRoot, "packages", "adapters", "zcode", "bin", "zcode-acp");
  const dest = path.join(outRoot, "packages", "adapters", "zcode", "bin", "zcode-acp");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, 0o755);
  return { name: "zcode-adapter", dest, size: fs.statSync(dest).size };
}

const kib = (bytes) => `${(bytes / 1024).toFixed(0)} KB`;

function main() {
  const esbuild = findEsbuild();
  fs.mkdirSync(outRoot, { recursive: true });

  const done = [
    stagePackage(esbuild, "core"),
    stagePackage(esbuild, "companion"),
    stageAdapter(),
  ];

  let total = 0;
  for (const item of done) {
    total += item.size;
    process.stdout.write(`  ${item.name.padEnd(14)} ${kib(item.size).padStart(8)}  →  ${path.relative(repoRoot, item.dest)}\n`);
  }
  process.stdout.write(`运行时目录就绪：${path.relative(repoRoot, outRoot)}（共 ${kib(total)}）\n`);
}

main();
