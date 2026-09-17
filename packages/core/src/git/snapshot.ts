import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { ensureDir, runDir, stateDir } from "../paths.js";
import type { SessionRef } from "../acp/kernel.js";
import { normalizePathKey } from "../derive/changeStat.js";

const exec = promisify(execFile);

/**
 * 回合级文件改动：快照 / 审查 / 撤销（会话流里的「审查」「撤销」两个按钮）。
 *
 * 做法是**借仓库自己的 objectdb**：回合开始时用一个临时 index
 * （`GIT_INDEX_FILE=<tmp> git add -A` → `git write-tree`）拍一棵树，
 * 我们只记那个 40 位 tree hash。对象本体在用户仓库的 `.git/objects` 里，
 * pulpo 一个字节的文件内容都不存——仍然是零副本。
 *
 * cwd 不在 git 仓库里就不拍，如实标 `revert: "unavailable"` +
 * `reason: "notGitRepo"`，绝不假装能撤销。
 *
 * > 优先级说明：ZCode 引擎自己有 checkpoint / rewind（`v4/conversation/
 * > fileRewindPreview`、`rewind.triggered`）。那条是 agent 的原生能力，
 * > P1 接上后优先于这里的壳内 git 快照。
 */

export type RevertAvailability = "available" | "unavailable";

export interface TurnFileChange {
  path: string;
  added: number;
  removed: number;
  status: "added" | "modified" | "deleted";
  /** 回合结束时该文件的 blob hash——撤销前用它判断"人后来又手改过没有"。 */
  afterBlob?: string;
}

export interface TurnSnapshot {
  sessionRef: SessionRef;
  turnId: string;
  cwd: string;
  repoRoot: string | null;
  startedAt: number;
  endedAt?: number;
  /** 回合开始时的工作区树。 */
  treeBefore?: string;
  /** 回合结束时的工作区树。 */
  treeAfter?: string;
  revert: RevertAvailability;
  /** `revert: "unavailable"` 时说明原因（`notGitRepo` / `gitFailed:<原文>`）。 */
  reason?: string;
  /** 回合里工具声称改过的路径（`derived.changeStat` 的并集），相对仓库根。 */
  touched: string[];
  /** 回合结束时算出来的整仓改动（相对 `treeBefore`）。 */
  files: TurnFileChange[];
  /** 拍快照实际耗时（ms），两次都记——性能回归看这个。 */
  snapshotMs?: { before?: number; after?: number };
}

export interface ChangesResult {
  sessionRef: SessionRef;
  turnId: string;
  revert: RevertAvailability;
  reason?: string;
  files: TurnFileChange[];
  diff?: string;
  /** 快照与当前工作区的对比时刻。 */
  computedAt: number;
}

export interface RevertResult {
  turnId: string;
  reverted: string[];
  skipped: { path: string; reason: string }[];
}

interface TurnsFile {
  version: 1;
  turns: TurnSnapshot[];
}

/** git blob hash（`git hash-object` 的算法，省一次子进程）。 */
export function blobHash(buf: Buffer): string {
  const h = createHash("sha1");
  h.update(`blob ${buf.length}\0`);
  h.update(buf);
  return h.digest("hex");
}

export async function gitRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["rev-parse", "--show-toplevel"], { cwd });
    const root = stdout.trim();
    return root || null;
  } catch {
    return null;
  }
}

/**
 * 用临时 index 给整个工作区拍一棵树。
 *
 * `git add -A` 在**空的临时 index** 上跑 = 把工作区当前内容整个入索引
 * （`.gitignore` 照常生效，所以 `node_modules` 之类不会进来），
 * `git write-tree` 落成对象。原仓库的真 index 一个字节都不动。
 */
export async function snapshotTree(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ tree: string; ms: number }> {
  const idx = path.join(ensureDir(runDir(env)), `idx-${process.pid}-${randomUUID()}.tmp`);
  const t0 = Date.now();
  try {
    const childEnv = { ...env, GIT_INDEX_FILE: idx };
    await exec("git", ["add", "-A"], { cwd: repoRoot, env: childEnv, maxBuffer: 64 * 1024 * 1024 });
    const { stdout } = await exec("git", ["write-tree"], { cwd: repoRoot, env: childEnv });
    return { tree: stdout.trim(), ms: Date.now() - t0 };
  } finally {
    fs.rmSync(idx, { force: true });
  }
}

/** 两棵树之间的逐文件加减行与状态。 */
export async function diffTrees(
  repoRoot: string,
  a: string,
  b: string,
  paths: string[] = [],
): Promise<TurnFileChange[]> {
  const args = ["diff", "--numstat", "--no-renames", a, b];
  if (paths.length) args.push("--", ...paths);
  const { stdout } = await exec("git", args, { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
  const statusArgs = ["diff", "--name-status", "--no-renames", a, b];
  if (paths.length) statusArgs.push("--", ...paths);
  const { stdout: statusOut } = await exec("git", statusArgs, {
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024,
  });

  const status = new Map<string, "added" | "modified" | "deleted">();
  for (const line of statusOut.split("\n")) {
    if (!line.trim()) continue;
    const [code, p] = line.split("\t");
    if (!p) continue;
    status.set(p, code === "A" ? "added" : code === "D" ? "deleted" : "modified");
  }

  const out: TurnFileChange[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [addedRaw, removedRaw, p] = line.split("\t");
    if (!p) continue;
    out.push({
      path: p,
      // 二进制文件 git 给 `-`：如实记 0，不瞎猜行数。
      added: addedRaw === "-" ? 0 : Number.parseInt(addedRaw ?? "0", 10) || 0,
      removed: removedRaw === "-" ? 0 : Number.parseInt(removedRaw ?? "0", 10) || 0,
      status: status.get(p) ?? "modified",
    });
  }
  return out;
}

export async function diffText(
  repoRoot: string,
  a: string,
  b: string,
  paths: string[] = [],
): Promise<string> {
  const args = ["diff", "--no-renames", a, b];
  if (paths.length) args.push("--", ...paths);
  const { stdout } = await exec("git", args, { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

async function treeHasPath(repoRoot: string, tree: string, p: string): Promise<boolean> {
  try {
    await exec("git", ["cat-file", "-e", `${tree}:${p}`], { cwd: repoRoot });
    return true;
  } catch {
    return false;
  }
}

async function readFromTree(repoRoot: string, tree: string, p: string): Promise<Buffer> {
  const { stdout } = await exec("git", ["cat-file", "blob", `${tree}:${p}`], {
    cwd: repoRoot,
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
  } as never);
  return stdout as unknown as Buffer;
}

/** 对象在不在仓库的 objectdb 里（测试断言快照真的落进了 git 对象库）。 */
export async function objectExists(repoRoot: string, hash: string): Promise<boolean> {
  try {
    await exec("git", ["cat-file", "-e", hash], { cwd: repoRoot });
    return true;
  } catch {
    return false;
  }
}

/**
 * 回合快照账本。**只存 hash 与行数，不存文件内容**，落在
 * `$PULPO_HOME/state/turns.json`（薄状态，丢了只是没法撤销历史回合）。
 */
export class TurnSnapshotStore {
  private readonly turns = new Map<string, TurnSnapshot>();
  private readonly file: string;
  private readonly env: NodeJS.ProcessEnv;
  /** 每条会话最多留几个回合快照。 */
  private readonly keepPerSession: number;

  constructor(opts: { env?: NodeJS.ProcessEnv; file?: string; keepPerSession?: number } = {}) {
    this.env = opts.env ?? process.env;
    this.file = opts.file ?? path.join(stateDir(this.env), "turns.json");
    this.keepPerSession = opts.keepPerSession ?? 20;
    this.load();
  }

  get filePath(): string {
    return this.file;
  }

  private load(): void {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, "utf8")) as TurnsFile;
      if (j?.version === 1 && Array.isArray(j.turns)) {
        for (const t of j.turns) this.turns.set(t.turnId, t);
      }
    } catch {
      /* 没有文件 = 没有历史快照 */
    }
  }

  save(): void {
    ensureDir(path.dirname(this.file));
    const payload: TurnsFile = { version: 1, turns: [...this.turns.values()] };
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  get(turnId: string): TurnSnapshot | undefined {
    return this.turns.get(turnId);
  }

  /** 某条会话最近一次（有快照记录的）回合。 */
  latest(sessionRef: SessionRef): TurnSnapshot | undefined {
    let best: TurnSnapshot | undefined;
    for (const t of this.turns.values()) {
      if (t.sessionRef !== sessionRef) continue;
      if (!best || t.startedAt > best.startedAt) best = t;
    }
    return best;
  }

  list(sessionRef?: SessionRef): TurnSnapshot[] {
    return [...this.turns.values()]
      .filter((t) => (sessionRef ? t.sessionRef === sessionRef : true))
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  /** 回合开始：拍快照。非 git 目录如实标 unavailable，不报错、不挡回合。 */
  async begin(params: { sessionRef: SessionRef; turnId: string; cwd: string }): Promise<TurnSnapshot> {
    const snap: TurnSnapshot = {
      sessionRef: params.sessionRef,
      turnId: params.turnId,
      cwd: params.cwd,
      repoRoot: null,
      startedAt: Date.now(),
      revert: "unavailable",
      touched: [],
      files: [],
    };
    const root = await gitRoot(params.cwd);
    if (!root) {
      snap.reason = "notGitRepo";
    } else {
      snap.repoRoot = root;
      try {
        const { tree, ms } = await snapshotTree(root, this.env);
        snap.treeBefore = tree;
        snap.revert = "available";
        snap.snapshotMs = { before: ms };
      } catch (err) {
        snap.reason = `gitFailed:${(err as Error).message}`;
      }
    }
    this.turns.set(snap.turnId, snap);
    this.prune(params.sessionRef);
    this.save();
    return snap;
  }

  /** 回合里工具改过哪些路径（用于 `session/changes` 的默认过滤）。 */
  noteTouched(turnId: string, paths: string[]): void {
    const snap = this.turns.get(turnId);
    if (!snap) return;
    const root = snap.repoRoot;
    for (const p of paths) {
      const rel = root ? toRepoRelative(root, p) : normalizePathKey(p);
      if (rel && !snap.touched.includes(rel)) snap.touched.push(rel);
    }
  }

  /** 回合结束：再拍一棵树，算出本回合的整仓改动与每个文件的 after blob。 */
  async finish(turnId: string): Promise<TurnSnapshot | undefined> {
    const snap = this.turns.get(turnId);
    if (!snap) return undefined;
    snap.endedAt = Date.now();
    if (snap.revert === "available" && snap.repoRoot && snap.treeBefore) {
      try {
        const { tree, ms } = await snapshotTree(snap.repoRoot, this.env);
        snap.treeAfter = tree;
        snap.snapshotMs = { ...(snap.snapshotMs ?? {}), after: ms };
        snap.files = await diffTrees(snap.repoRoot, snap.treeBefore, tree);
        for (const f of snap.files) {
          if (f.status === "deleted") continue;
          const abs = path.join(snap.repoRoot, f.path);
          try {
            f.afterBlob = blobHash(fs.readFileSync(abs));
          } catch {
            /* 回合刚结束文件又没了：撤销时会按"缺少 checkpoint"跳过 */
          }
        }
      } catch (err) {
        snap.revert = "unavailable";
        snap.reason = `gitFailed:${(err as Error).message}`;
      }
    }
    this.save();
    return snap;
  }

  /** 回合改动摘要（`turn_finished` 通知直接带这个）。 */
  summary(turnId: string): { files: number; added: number; removed: number; revert: RevertAvailability; reason?: string } | undefined {
    const snap = this.turns.get(turnId);
    if (!snap) return undefined;
    const files = filterFiles(snap, snap.touched.length ? snap.touched : undefined);
    const out = {
      files: files.length,
      added: files.reduce((n, f) => n + f.added, 0),
      removed: files.reduce((n, f) => n + f.removed, 0),
      revert: snap.revert,
    };
    return snap.reason ? { ...out, reason: snap.reason } : out;
  }

  /**
   * `session/changes`：快照树与**当前工作区**的差异。
   * 默认只算本回合工具碰过的路径；`all: true` 算整个工作区。
   */
  async changes(params: {
    sessionRef: SessionRef;
    turnId?: string;
    all?: boolean;
    paths?: string[];
    includeDiff?: boolean;
  }): Promise<ChangesResult> {
    const snap = params.turnId ? this.turns.get(params.turnId) : this.latest(params.sessionRef);
    if (!snap) {
      return {
        sessionRef: params.sessionRef,
        turnId: params.turnId ?? "",
        revert: "unavailable",
        reason: "noSnapshot",
        files: [],
        computedAt: Date.now(),
      };
    }
    const base: ChangesResult = {
      sessionRef: snap.sessionRef,
      turnId: snap.turnId,
      revert: snap.revert,
      files: [],
      computedAt: Date.now(),
    };
    if (snap.reason) base.reason = snap.reason;
    if (snap.revert !== "available" || !snap.repoRoot || !snap.treeBefore) return base;

    const scope = params.paths?.length
      ? params.paths.map((p) => toRepoRelative(snap.repoRoot!, p)).filter(Boolean)
      : params.all
        ? []
        : snap.touched;
    // 一律现拍一棵当前工作区的树再比：回合在跑时它是实时进度，回合结束后
    // 它包含用户后来的手改——`session/changes` 报的是**此刻**的差异，不是回放。
    const { tree: current } = await snapshotTree(snap.repoRoot, this.env);
    base.files = await diffTrees(snap.repoRoot, snap.treeBefore, current, scope);
    for (const f of base.files) {
      const known = snap.files.find((x) => x.path === f.path);
      if (known?.afterBlob) f.afterBlob = known.afterBlob;
    }
    if (params.includeDiff) {
      base.diff = await diffText(snap.repoRoot, snap.treeBefore, current, scope);
    }
    return base;
  }

  /**
   * `session/revert`：把路径恢复成回合开始时的样子。
   *
   * 两条安全线：
   *  - 快照之后**人又手改过**（当前内容 hash ≠ 回合结束时记下的 hash）→ 跳过，
   *    原样保留用户的改动；
   *  - 本回合根本没碰过这个路径 → 跳过（不拿快照去覆盖无关文件）。
   */
  async revert(params: {
    sessionRef: SessionRef;
    turnId: string;
    paths?: string[];
  }): Promise<RevertResult> {
    const snap = this.turns.get(params.turnId);
    if (!snap) return { turnId: params.turnId, reverted: [], skipped: [{ path: "*", reason: "没有这个回合的快照" }] };
    const out: RevertResult = { turnId: snap.turnId, reverted: [], skipped: [] };
    if (snap.revert !== "available" || !snap.repoRoot || !snap.treeBefore) {
      out.skipped.push({ path: "*", reason: `快照不可用：${snap.reason ?? "unknown"}` });
      return out;
    }
    const root = snap.repoRoot;
    const wanted = params.paths?.length
      ? params.paths.map((p) => toRepoRelative(root, p)).filter(Boolean)
      : snap.files.map((f) => f.path);

    for (const rel of wanted) {
      const known = snap.files.find((f) => f.path === rel);
      if (!known) {
        out.skipped.push({ path: rel, reason: "本回合没有改过这个文件，不动它" });
        continue;
      }
      const abs = path.join(root, rel);
      const exists = fs.existsSync(abs);
      if (known.status !== "deleted") {
        if (!known.afterBlob) {
          out.skipped.push({ path: rel, reason: "缺少 checkpoint（回合结束时读不到这个文件）" });
          continue;
        }
        const now = exists ? blobHash(fs.readFileSync(abs)) : null;
        if (now !== known.afterBlob) {
          out.skipped.push({
            path: rel,
            reason: exists
              ? "当前文件已被外部修改（内容与本回合结束时不一致），不覆盖"
              : "当前文件已被外部删除，不还原",
          });
          continue;
        }
      }
      try {
        if (await treeHasPath(root, snap.treeBefore, rel)) {
          const buf = await readFromTree(root, snap.treeBefore, rel);
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, buf);
        } else if (exists) {
          // 快照里没有、现在有 = 本回合新建 → 删掉。
          fs.rmSync(abs, { force: true });
        }
        out.reverted.push(rel);
      } catch (err) {
        out.skipped.push({ path: rel, reason: `写回失败：${(err as Error).message}` });
      }
    }
    return out;
  }

  private prune(sessionRef: SessionRef): void {
    const mine = this.list(sessionRef);
    if (mine.length <= this.keepPerSession) return;
    for (const t of mine.slice(0, mine.length - this.keepPerSession)) this.turns.delete(t.turnId);
  }
}

function filterFiles(snap: TurnSnapshot, scope?: string[]): TurnFileChange[] {
  if (!scope?.length) return snap.files;
  const set = new Set(scope);
  return snap.files.filter((f) => set.has(f.path));
}

/**
 * 绝对路径 → 相对仓库根；已经是相对路径就原样归一。
 *
 * **必须解符号链接**：macOS 上 `/tmp` 是 `/private/tmp` 的符号链接，
 * `git rev-parse --show-toplevel` 给的是 `/private/tmp/...`，而 agent 报的
 * 工具路径是 `/tmp/...`。不解链接就会算出 `../../..` 前缀、被判成"仓库外"，
 * 于是本回合"碰过的路径"永远是空的——实测踩到过，不是理论风险。
 */
export function toRepoRelative(repoRoot: string, p: string): string {
  const norm = normalizePathKey(p);
  if (!path.isAbsolute(norm)) return norm.replace(/^\.\//, "");
  const direct = path.relative(repoRoot, path.resolve(norm));
  if (!direct.startsWith("..")) return normalizePathKey(direct);
  const rel = path.relative(realpath(repoRoot), realpath(path.resolve(norm)));
  return rel.startsWith("..") ? "" : normalizePathKey(rel);
}

/** 解符号链接；路径还不存在时按最近的存在的祖先解。 */
function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    const parent = path.dirname(p);
    if (parent === p) return p;
    return path.join(realpath(parent), path.basename(p));
  }
}
