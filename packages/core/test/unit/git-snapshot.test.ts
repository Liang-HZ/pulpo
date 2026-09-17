import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  TurnSnapshotStore,
  blobHash,
  gitRoot,
  objectExists,
  snapshotTree,
  toRepoRelative,
} from "../../src/git/snapshot.js";

const ROOT = fs.mkdtempSync(path.join("/tmp", `pulpo-git-snap-${process.pid}-`));
const REPO = path.join(ROOT, "repo");
const HOME = path.join(ROOT, "home");
const ENV: NodeJS.ProcessEnv = { ...process.env, PULPO_HOME: HOME, TMPDIR: "/tmp" };

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8" });
}

function store(): TurnSnapshotStore {
  return new TurnSnapshotStore({ env: ENV, file: path.join(HOME, "state", "turns.json") });
}

beforeAll(() => {
  fs.mkdirSync(REPO, { recursive: true });
  fs.mkdirSync(HOME, { recursive: true });
  execFileSync("git", ["init", "-q", REPO]);
  git("config", "user.email", "test@pulpo.local");
  git("config", "user.name", "pulpo test");
  fs.writeFileSync(path.join(REPO, ".gitignore"), "ignored/\n");
  fs.writeFileSync(path.join(REPO, "keep.txt"), "old-1\nold-2\n");
  fs.mkdirSync(path.join(REPO, "ignored"), { recursive: true });
  fs.writeFileSync(path.join(REPO, "ignored", "junk.bin"), "x".repeat(1000));
  git("add", "-A");
  git("commit", "-qm", "init");
});

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("非 git 目录：如实标 unavailable（不假装能撤销）", () => {
  it("begin 不报错，revert 标 unavailable + notGitRepo", async () => {
    const plain = path.join(ROOT, "plain");
    fs.mkdirSync(plain, { recursive: true });
    const s = store();
    const snap = await s.begin({ sessionRef: "zcode#a", turnId: "t-plain", cwd: plain });
    expect(snap.revert).toBe("unavailable");
    expect(snap.reason).toBe("notGitRepo");
    expect(snap.treeBefore).toBeUndefined();
    expect(await gitRoot(plain)).toBeNull();

    const changes = await s.changes({ sessionRef: "zcode#a", turnId: "t-plain" });
    expect(changes.revert).toBe("unavailable");
    expect(changes.files).toEqual([]);

    const rev = await s.revert({ sessionRef: "zcode#a", turnId: "t-plain" });
    expect(rev.reverted).toEqual([]);
    expect(rev.skipped[0]!.reason).toContain("notGitRepo");
  });

  it("根本没有这个回合的快照时也如实说，不抛", async () => {
    const s = store();
    const rev = await s.revert({ sessionRef: "zcode#a", turnId: "不存在" });
    expect(rev.skipped[0]!.reason).toContain("没有这个回合的快照");
  });
});

describe("git 仓库：快照 → 改动 → 撤销", () => {
  it("快照树进了仓库自己的 objectdb（我们只留 hash）", async () => {
    const s = store();
    const snap = await s.begin({ sessionRef: "zcode#s", turnId: "t1", cwd: REPO });
    expect(snap.revert).toBe("available");
    expect(snap.treeBefore).toMatch(/^[0-9a-f]{40}$/);
    expect(await objectExists(REPO, snap.treeBefore!)).toBe(true);
    // 落盘的只有 hash，没有任何文件内容
    const raw = fs.readFileSync(s.filePath, "utf8");
    expect(raw).not.toContain("old-1");
  });

  it(".gitignore 生效：被忽略的文件不进快照", async () => {
    const { tree } = await snapshotTree(REPO, ENV);
    const ls = execFileSync("git", ["ls-tree", "-r", "--name-only", tree], {
      cwd: REPO,
      encoding: "utf8",
    });
    expect(ls).toContain("keep.txt");
    expect(ls).not.toContain("ignored/junk.bin");
  });

  it("session/changes 报新建与修改两条，行数正确", async () => {
    const s = store();
    await s.begin({ sessionRef: "zcode#s", turnId: "t2", cwd: REPO });
    fs.writeFileSync(path.join(REPO, "new.txt"), "a\nb\nc\n");
    fs.writeFileSync(path.join(REPO, "keep.txt"), "old-1\nchanged\n");
    s.noteTouched("t2", [path.join(REPO, "new.txt"), path.join(REPO, "keep.txt")]);
    await s.finish("t2");

    const changes = await s.changes({ sessionRef: "zcode#s", turnId: "t2" });
    const byPath = Object.fromEntries(changes.files.map((f) => [f.path, f]));
    expect(byPath["new.txt"]).toMatchObject({ added: 3, removed: 0, status: "added" });
    expect(byPath["keep.txt"]).toMatchObject({ added: 1, removed: 1, status: "modified" });

    const summary = s.summary("t2")!;
    expect(summary).toMatchObject({ files: 2, added: 4, removed: 1, revert: "available" });

    const withDiff = await s.changes({ sessionRef: "zcode#s", turnId: "t2", includeDiff: true });
    expect(withDiff.diff).toContain("+changed");
  });

  it("默认只算本回合碰过的路径，all:true 才算整个工作区", async () => {
    const s = store();
    await s.begin({ sessionRef: "zcode#s", turnId: "t3", cwd: REPO });
    fs.writeFileSync(path.join(REPO, "touched.txt"), "1\n");
    fs.writeFileSync(path.join(REPO, "untouched.txt"), "1\n");
    s.noteTouched("t3", ["touched.txt"]);
    await s.finish("t3");

    const scoped = await s.changes({ sessionRef: "zcode#s", turnId: "t3" });
    expect(scoped.files.map((f) => f.path)).toEqual(["touched.txt"]);
    const all = await s.changes({ sessionRef: "zcode#s", turnId: "t3", all: true });
    expect(all.files.map((f) => f.path).sort()).toEqual(["touched.txt", "untouched.txt"]);
  });

  it("revert：新建的删掉、改过的回到回合开始时的内容", async () => {
    const s = store();
    const before = fs.readFileSync(path.join(REPO, "keep.txt"), "utf8");
    await s.begin({ sessionRef: "zcode#s", turnId: "t4", cwd: REPO });
    fs.writeFileSync(path.join(REPO, "brand-new.txt"), "x\ny\n");
    fs.writeFileSync(path.join(REPO, "keep.txt"), `${before}加了一行\n`);
    s.noteTouched("t4", ["brand-new.txt", "keep.txt"]);
    await s.finish("t4");

    const res = await s.revert({ sessionRef: "zcode#s", turnId: "t4" });
    expect(res.skipped).toEqual([]);
    expect(res.reverted.sort()).toEqual(["brand-new.txt", "keep.txt"]);
    expect(fs.existsSync(path.join(REPO, "brand-new.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(REPO, "keep.txt"), "utf8")).toBe(before);
  });

  it("用户在回合之后手改过 → 跳过并说明，绝不覆盖用户的改动", async () => {
    const s = store();
    const file = path.join(REPO, "hand-edited.txt");
    fs.writeFileSync(file, "v1\n");
    await s.begin({ sessionRef: "zcode#s", turnId: "t5", cwd: REPO });
    fs.writeFileSync(file, "v2-by-agent\n");
    s.noteTouched("t5", ["hand-edited.txt"]);
    await s.finish("t5");

    // 人又手改了一次
    fs.writeFileSync(file, "v3-by-human\n");
    const res = await s.revert({ sessionRef: "zcode#s", turnId: "t5" });
    expect(res.reverted).toEqual([]);
    expect(res.skipped[0]).toMatchObject({ path: "hand-edited.txt" });
    expect(res.skipped[0]!.reason).toContain("已被外部修改");
    expect(fs.readFileSync(file, "utf8")).toBe("v3-by-human\n");
  });

  it("只撤销指定路径；本回合没碰过的路径一律跳过", async () => {
    const s = store();
    await s.begin({ sessionRef: "zcode#s", turnId: "t6", cwd: REPO });
    fs.writeFileSync(path.join(REPO, "one.txt"), "1\n");
    fs.writeFileSync(path.join(REPO, "two.txt"), "2\n");
    await s.finish("t6");
    const res = await s.revert({
      sessionRef: "zcode#s",
      turnId: "t6",
      paths: ["one.txt", "从没碰过.txt"],
    });
    expect(res.reverted).toEqual(["one.txt"]);
    expect(res.skipped[0]!.reason).toContain("本回合没有改过");
    expect(fs.existsSync(path.join(REPO, "one.txt"))).toBe(false);
    expect(fs.existsSync(path.join(REPO, "two.txt"))).toBe(true);
    fs.rmSync(path.join(REPO, "two.txt"));
  });

  it("绝对路径与相对路径都能喂进来", () => {
    expect(toRepoRelative(REPO, path.join(REPO, "a", "b.ts"))).toBe("a/b.ts");
    expect(toRepoRelative(REPO, "./a/b.ts")).toBe("a/b.ts");
    expect(toRepoRelative(REPO, "/etc/passwd")).toBe("");
  });

  it("blobHash 与 git hash-object 一致", () => {
    const buf = Buffer.from("hello\n");
    const expected = execFileSync("git", ["hash-object", "--stdin"], {
      cwd: REPO,
      input: buf,
      encoding: "utf8",
    }).trim();
    expect(blobHash(buf)).toBe(expected);
  });

  it("快照账本按会话裁剪，不会无限长", async () => {
    const s = new TurnSnapshotStore({
      env: ENV,
      file: path.join(HOME, "state", "turns-small.json"),
      keepPerSession: 2,
    });
    for (let i = 0; i < 5; i++) {
      await s.begin({ sessionRef: "zcode#p", turnId: `p${i}`, cwd: REPO });
    }
    expect(s.list("zcode#p")).toHaveLength(2);
  });
});

describe("快照耗时（性能实测，写进报告）", () => {
  it("在 pulpo 仓库本身（含 node_modules，.gitignore 生效）拍一棵树", async () => {
    const repoRoot = await gitRoot(path.resolve(import.meta.dirname, "..", ".."));
    expect(repoRoot).toBeTruthy();
    const runs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const { ms } = await snapshotTree(repoRoot!, ENV);
      runs.push(ms);
    }
    const best = Math.min(...runs);
    // 数字进报告；这里只守一条明显的回归线（一次快照不该到秒级）。
    // eslint-disable-next-line no-console
    console.log(`[snapshot] pulpo 仓库拍树耗时 ms=${runs.join(",")} 最快=${best}`);
    expect(best).toBeLessThan(3000);
  });
});
