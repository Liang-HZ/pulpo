import { expect, test, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readEnv, shellRoot } from "./harness";

const env = readEnv();
const SHOTS = resolve(shellRoot, "test-results/shots");
mkdirSync(SHOTS, { recursive: true });

/**
 * ZCode 的默认安全模式是"变更前确认"，写文件会弹审批。让它一直挂着会拖到 core 的
 * 5 分钟超时，所以后台盯着审批卡片、见一张点一次"允许一次"——顺带把审批卡片这条路
 * 也真的走过一遍。
 */
function autoApprove(page: Page): { count: () => number; stop: () => void } {
  let approved = 0;
  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      const card = page.locator('[data-testid="approval-card"]').first();
      if (await card.isVisible().catch(() => false)) {
        const allow = card.getByRole("button", { name: /Allow once|允许一次/ });
        if (await allow.isVisible().catch(() => false)) {
          await allow.click().catch(() => undefined);
          approved += 1;
        }
      }
      await page.waitForTimeout(400).catch(() => undefined);
    }
  };
  void loop();
  return {
    count: () => approved,
    stop: () => {
      stopped = true;
    },
  };
}

async function openWorkspaceSession(page: Page): Promise<void> {
  await page.goto(`/?ws=${env.wsPort}`);
  await expect(page.locator('[data-testid="connection"]')).toHaveAttribute("data-phase", "open", {
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "新建任务", exact: true }).first().click();
  await page.getByLabel(/工作目录/).fill(env.cwd);
  await page.getByRole("button", { name: "新建会话" }).click();
}

test("一条真链路：跑一轮 → 折叠段 → 工具卡 → 改动汇总卡 → 审查 → 撤销 → 派活", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  await page.setViewportSize({ width: 1280, height: 860 });

  await openWorkspaceSession(page);
  const approver = autoApprove(page);

  // 模型 chip 来自 descriptor 的自描述，不是写死的清单
  const modelChip = page.locator('[data-testid="mode-chip"]');
  await expect(modelChip).toBeVisible({ timeout: 60_000 });
  // 危险等级只来自 descriptor 的 modes[].risk
  expect(await modelChip.getAttribute("data-risk")).not.toBe("unknown");

  // ── 跑一轮 ────────────────────────────────────────────────────────────────
  const composer = page.getByLabel("发给 agent 的消息");
  await composer.fill(
    "Read note.txt, then create three.txt with exactly 3 lines. Then reply done.",
  );
  await page.getByTestId("send-button").click();

  // 回合一开始，同一个输入框换成 steering 输入框——位置没变，无障碍名字变了
  await expect(page.getByTestId("send-button")).not.toHaveAttribute("data-tier", "idle", {
    timeout: 60_000,
  });
  const steering = page.getByLabel("补充消息");
  await expect(steering).toBeVisible();
  await steering.fill("（补充）写完就好，不用再做别的。");
  await page.getByTestId("send-button").click();
  const receipt = page.getByTestId("receipt").first();
  await expect(receipt, "补充消息必须给出回执，不能悄无声息").toBeVisible({ timeout: 60_000 });
  const receiptOutcome = await receipt.getAttribute("data-outcome");
  expect(
    // PROTOCOL §4.6 的六个回执：failed 是「目标收下了这一档但自报失败」，
    // 与 unsupported 是两回事，两个都要能出现在界面上。
    ["injected", "queued", "no_active_turn", "completed_race", "failed", "unsupported"],
    "core 必须回 PROTOCOL §4.6 里的回执枚举",
  ).toContain(receiptOutcome);
  // 档位**原样显示**，不翻译成自造词
  await expect(receipt).toContainText(
    /native|extension|concurrent|soft-interrupt|queue|无可用档位/,
  );

  // ── 折叠段：跑完自动收起，点开之后记住展开态 ──────────────────────────────
  const segment = page.locator('[data-testid="work-segment"]').first();
  await expect(segment).toBeVisible({ timeout: 180_000 });
  await expect(segment, "段跑完的瞬间自动收起").toHaveAttribute("data-open", "false", {
    timeout: 180_000,
  });
  // 收起态的样子：整串工具调用收成一行——这一刻刚好拍得到
  await page.screenshot({ path: `${SHOTS}/01-chat-collapsed.png`, fullPage: false });
  await segment.getByTestId("segment-toggle").click();
  await expect(segment).toHaveAttribute("data-open", "true");
  const segmentLabel = (await segment.getByTestId("segment-toggle").textContent())?.trim() ?? "";
  expect(segmentLabel, "折叠行要说清这一段干了什么").toMatch(/已工作|探索|更改|终端|思考|用了/);

  // ── 工具卡四态：卡在段里面，展开段之后才谈得上"看得见" ──────────
  const toolCard = page.locator('[data-testid="tool-card"]').first();
  await expect(toolCard).toBeVisible({ timeout: 60_000 });
  await expect(toolCard).toHaveAttribute("data-state", /pending|in_progress|completed|failed/);

  // ── 回合结束 ──────────────────────────────────────────────────────────────
  await expect(page.getByTestId("send-button")).toHaveAttribute("data-tier", "idle", {
    timeout: 240_000,
  });

  // ── 文件改动汇总卡：数字必须和 core 的 turn_finished 一致 ─────────────────
  const summary = page.locator('[data-testid="change-summary"]').first();
  await expect(summary, "跑完一轮写过文件，就该有这张卡").toBeVisible({ timeout: 60_000 });
  expect(
    await summary.getAttribute("data-source"),
    "数字要来自 core 的 turn_finished.changes，不是壳内估算",
  ).toBe("core");
  const files = Number(await summary.getAttribute("data-files"));
  const added = Number(await summary.getAttribute("data-added"));
  expect(files).toBeGreaterThan(0);
  expect(added).toBeGreaterThan(0);
  await expect(summary).toContainText(`${files} 个文件已更改`);

  await page.screenshot({ path: `${SHOTS}/02-chat-light.png`, fullPage: false });

  // 展开记忆：切走再切回来，段还是展开的（模块级 Map）
  await expect(segment).toHaveAttribute("data-open", "true");

  // ── 审查：打开 diff ───────────────────────────────────────────────────────
  await summary.getByTestId("changes-review").click();
  const diff = page.getByTestId("changes-diff");
  await expect(diff, "审查要真的把 diff 打开").toBeVisible({ timeout: 60_000 });
  await expect(diff).toContainText("diff --git");
  await expect(diff).toContainText("three.txt");
  await page.screenshot({ path: `${SHOTS}/03-changes-review.png`, fullPage: false });

  // ── 撤销：文件真的回到回合之前 ────────────────────────────────────────────
  const target = resolve(env.cwd, "three.txt");
  expect(existsSync(target), "回合里应该真的创建了 three.txt").toBe(true);
  await summary.getByTestId("changes-undo").click();
  await summary.getByTestId("changes-undo-confirm").click();
  await expect(summary).toContainText("已撤销", { timeout: 60_000 });
  expect(existsSync(target), "撤销之后本回合新建的文件应该没了").toBe(false);
  expect(readFileSync(resolve(env.cwd, "note.txt"), "utf-8")).toBe("hello pulpo\n");

  // ── 消息动作行：hover 才出现，纯 CSS ─────────────────────────────────────
  const assistantMessage = page.locator(".group\\/message").last();
  await assistantMessage.hover();
  await expect(assistantMessage.getByRole("button", { name: "复制" }).first()).toBeVisible();

  // ── 派活：模型取 descriptor 的 currentModelId，不写死 ─────────────────────
  await page.getByTestId("toggle-delegate").click();
  const delegateModel = page.getByTestId("delegate-model");
  await expect(delegateModel).toBeVisible();
  await expect(page.getByText("读不到 zcode 的能力描述符")).toHaveCount(0);
  expect(
    (await delegateModel.inputValue()).length,
    "派活表单的模型必须来自 descriptor 的自描述",
  ).toBeGreaterThan(0);
  await page
    .getByTestId("delegate-task")
    .fill("在工作目录下新建 delegated.txt，内容写 ok，然后回复 done。");
  await page.getByTestId("delegate-submit").click();

  // ── 右栏子代理条目 ────────────────────────────────────────────────────────
  const taskNode = page.locator('[data-testid="task-node"]').first();
  await expect(taskNode).toBeVisible({ timeout: 60_000 });
  await expect(taskNode).toHaveAttribute("data-status", /queued|running|awaiting_approval/);
  await taskNode.getByPlaceholder("补充一句…").fill("（补充）写完就好，不用再多做。");
  await taskNode.getByRole("button", { name: "投递" }).click();
  await expect(taskNode.getByTestId("receipt"), "task/send_input 也必须给出回执").toBeVisible({
    timeout: 60_000,
  });
  await expect(taskNode).toHaveAttribute("data-status", "done", { timeout: 240_000 });

  await page.screenshot({ path: `${SHOTS}/04-delegated.png`, fullPage: false });

  expect(approver.count(), "这条链路里至少应该真的应答过一次审批").toBeGreaterThan(0);
  approver.stop();

  expect(consoleErrors, "控制台不许有报错").toEqual([]);
});

test("连不上 core 时提醒条明示并自己重试，不静默装作正常", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  // 指向一个没人监听的端口：连接永远建不起来，界面必须说清楚
  await page.goto("/?ws=1");

  const status = page.locator('[data-testid="connection"]');
  await expect(status).toHaveAttribute("data-phase", /connecting|reconnecting/, {
    timeout: 30_000,
  });
  await expect(status).toHaveAttribute("data-phase", "reconnecting", { timeout: 30_000 });
  await expect(page.getByText("与 core 的连接已断开")).toBeVisible();
  await expect(page.getByRole("button", { name: "重连" })).toBeVisible();
  // 断开原因必须写出来，不许只给一个红点
  const reason = page.getByTestId("connection-reason");
  expect((await reason.textContent())?.trim().length ?? 0).toBeGreaterThan(0);

  await page.screenshot({ path: `${SHOTS}/05-disconnected.png`, fullPage: false });
});

test("1280 与 1024 两个宽度下都没有横向滚动，三栏骨架尺寸与文档一致", async ({ page }) => {
  await page.goto(`/?ws=${env.wsPort}`);
  await expect(page.locator('[data-testid="connection"]')).toHaveAttribute("data-phase", "open", {
    timeout: 30_000,
  });

  for (const width of [1280, 1024]) {
    await page.setViewportSize({ width, height: 860 });
    await page.waitForTimeout(300);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${width}px 宽度下出现了横向滚动`).toBeLessThanOrEqual(0);

    const boxes = await page.evaluate(() => {
      const sidebar = document.querySelector('[aria-label="会话列表"]');
      const inspector = document.querySelector('[aria-label="轨迹树"]');
      const titleBar = document.querySelector("header");
      return {
        sidebar: sidebar?.getBoundingClientRect().width ?? 0,
        inspector: inspector?.getBoundingClientRect().width ?? 0,
        titleBar: titleBar?.getBoundingClientRect().height ?? 0,
      };
    });
    // 尺寸表：左栏 288（挤压时不低于 200）、右栏 320（不低于 240）、标题栏 48
    expect(boxes.titleBar).toBe(48);
    expect(boxes.sidebar).toBeGreaterThanOrEqual(200);
    expect(boxes.sidebar).toBeLessThanOrEqual(288);
    expect(boxes.inspector).toBeGreaterThanOrEqual(240);
    expect(boxes.inspector).toBeLessThanOrEqual(320);
  }

  // 对话列宽 768（三家一致）
  await page.setViewportSize({ width: 1600, height: 860 });
  await page.waitForTimeout(300);
  const columnWidth = await page.evaluate(() => {
    const scroller = document.querySelector('[data-testid="chat-scroll"]');
    return (scroller?.firstElementChild as HTMLElement | null)?.getBoundingClientRect().width ?? 0;
  });
  expect(columnWidth).toBe(768);

  // ── 左右栏折叠：⌘B 折到 0、⌘E 折到 0，再按一次回来 ────────────
  const width = (label: string): Promise<number> =>
    page.evaluate(
      (l) => document.querySelector(`[aria-label="${l}"]`)?.getBoundingClientRect().width ?? 0,
      label,
    );
  await page.keyboard.press("Meta+b");
  await expect
    .poll(() => page.locator('[aria-label="会话列表"]').count(), { timeout: 3000 })
    .toBe(0);
  // 折起来之后标题栏最左边留一个展开按钮
  await expect(page.getByRole("button", { name: "展开左栏（⌘B）", exact: true })).toBeVisible();
  await page.keyboard.press("Meta+b");
  await expect.poll(() => width("会话列表")).toBe(288);

  await page.keyboard.press("Meta+e");
  await expect
    .poll(() => page.locator('[aria-label="轨迹树"]').count(), { timeout: 3000 })
    .toBe(0);
  await page.keyboard.press("Meta+e");
  await expect.poll(() => width("轨迹树")).toBe(320);

  // 分隔条双击复位到默认宽：拖窄之后双击回到 288 / 320
  const grab = page.locator('[role="separator"][aria-label="调整左栏宽度"]');
  const box = (await grab.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, 400);
  await page.mouse.down();
  await page.mouse.move(box.x - 80, 400, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => width("会话列表")).toBeLessThan(288);
  await grab.dblclick();
  await expect.poll(() => width("会话列表")).toBe(288);

  // 界面缩放：⌘= / ⌘0 改 --ui-scale
  const scale = (): Promise<string> =>
    page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--ui-scale").trim());
  await page.keyboard.press("Meta+=");
  await expect.poll(scale).toBe("1.1");
  await page.keyboard.press("Meta+0");
  await expect.poll(scale).toBe("1");
});

test.describe("深色主题跟随系统", () => {
  test.use({ colorScheme: "dark" });

  test("暗色下底色是近黑、层级靠背景提亮，正文照样看得见", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.goto(`/?ws=${env.wsPort}`);
    await expect(page.locator('[data-testid="connection"]')).toHaveAttribute("data-phase", "open", {
      timeout: 30_000,
    });

    const tokens = await page.evaluate(() => {
      const s = getComputedStyle(document.documentElement);
      return {
        canvas: s.getPropertyValue("--c-canvas").trim(),
        chrome: s.getPropertyValue("--c-chrome").trim(),
        surface: s.getPropertyValue("--c-surface").trim(),
        brandFg: s.getPropertyValue("--c-brand-fg").trim(),
      };
    });
    // 暗色表，一个值都不许漂
    expect(tokens.canvas.toLowerCase()).toBe("#191f20");
    expect(tokens.chrome.toLowerCase()).toBe("#14191a");
    expect(tokens.surface.toLowerCase()).toBe("#202829");
    // 暗色的实心 brand 按钮用近黑字，不是白字
    expect(tokens.brandFg.toLowerCase()).toBe("#0a1516");

    await page.screenshot({ path: `${SHOTS}/06-dark.png`, fullPage: false });
  });
});
