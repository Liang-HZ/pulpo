# @pulpo/shell

pulpo 的桌面壳。它是 [`@pulpo/core`](../core/PROTOCOL.md) 的一个客户端，**只走 core 的
127.0.0.1 WebSocket（JSON-RPC）**——没有第二种传输，也没有任何桌面独占的数据通路。
Tauri IPC 只用于三件本机特权动作：选目录、在文件管理器里打开目录、读本机 git 状态。

因此同一份前端代码在纯浏览器里跑起来是完整的，后面上 Android 不需要改造。

## 三栏尺寸

左栏会话列表 **288**（可拖拽 200–420，⌘B 折到 0）/ 中栏会话列 **768**（水平居中，
可用区不小于 420）/ 右栏 **320**（可拖拽 240–560，⌘E 折到 0）/ 标题栏 **48** /
仓库行 **32** / 提醒条 **32** / 底部状态条 **28** / Composer 输入区 min **128**、
max **360** 后内滚。间距只有七档（4 / 8 / 12 / 16 / 24 / 32 / 48），不出现档位外数值。

## 目录

```
src/
  main.tsx                    入口：亮/暗跟随系统（把偏好落到 <html> 的 class 上）
  App.tsx                     三栏骨架 + composer 槽位 + 快捷键 + 左右栏拖拽/折叠
  index.css                   @theme 与全部 token：标度 / 色阶 / 字体 / 动效 / 焦点环
  platform.ts                 唯一一处能力探测（Tauri vs 浏览器）、core 地址、git 状态
  lib/
    protocol.ts               core 契约的类型（只声明壳真的读的字段，其余留在 raw 里）
    rpc.ts                    JSON-RPC 客户端：请求应答配对 / 通知分发 / 退避重连
    chat.ts                   session/update 流 → 消息模型（含工具卡三段式状态机）
    segments.ts               工作段折叠的两层判定：段边界（遇到正文就断开）+ 段内分桶
    changes.ts                行数统计与聚合：changeStat / diff 块 / 入参三条路
    tools.ts                  工具认读：kind → 图标标签、入参形状嗅探、标题时态
    diff.ts                   oldText/newText → unified diff 行；长输出折叠
    markdown.ts               极小 markdown 解析（八种块，无依赖）
    steering.ts               投递档位 → 文案；回执枚举 → 文案（含 failed）
    policy.ts                 stopReason 白名单 / 未读判定 / 访问模式风险等级 / 记忆文件
    viewstate.ts              模块级展开记忆、栏宽与缩放、未读游标的 localStorage
    store.ts                  useSyncExternalStore 的全局 store（唯一状态源）
  components/
    ui.tsx                    零件层：九态与五态都做在这里（Button/Chip/StatusDot/…）
    Icon.tsx                  自绘图标（24 网格 stroke 1.75，42 个）
    Chrome.tsx                标题栏 48 / 仓库行 32 / 提醒条 32 / 底部状态条 28
    Sidebar.tsx               左栏 288：导航 + 分组（按 cwd）+ 会话行 + 底部用户区
    ChatColumn.tsx            中栏：会话列 768 + 滚动跟随/回底 + 消息动作行 + 五态
    WorkSegment.tsx           工作段折叠：两层判定 + 桶 + 自动收起 + 展开记忆
    ToolCard.tsx              工具卡六态（ACP 四态 + denied/stopped）+ diff 块 + 输出折叠
    ChangeSummaryCard.tsx     文件改动汇总卡：汇总 / 逐文件 / 审查 / 撤销
    ApprovalCard.tsx          审批卡片与追问；结算后收成一行记录
    Composer.tsx              输入区：min 128 / max 360、四态发送按钮、chip 条
    Receipt.tsx               投递回执：回执条 + 完整回执（逐档过程）
    Inspector.tsx             右栏 320：环境 / 子代理与任务 / 待审批 / 计划 / 来源 / 记忆
    DelegateForm.tsx          派活表单：渠道 + 任务 + cwd + 模型 ID + 思考强度 + delivery
    CommandPalette.tsx        ⌘K：会话检索（未读优先）
  test/                       vitest：240 个用例（reducer / 分区 / 档位文案 / 对比度 …）
e2e/                          Playwright：真 daemon + 真 ZCode adapter 的端到端（4 条）
src-tauri/                    Rust：拉起/复用本机 core daemon + 目录对话框 + git 状态
```

## 命令

| 命令 | 作用 |
|---|---|
| `pnpm --filter @pulpo/shell dev:web` | 纯浏览器开发（5173）。core 要自己先起：`./packages/core/bin/pulpo-core` |
| `pnpm --filter @pulpo/shell dev` | Tauri 的前端开发服务器（1420），一般由 `tauri dev` 带起来 |
| `pnpm --filter @pulpo/shell tauri dev` | 桌面开发；Rust 侧会保证本机有一个能连的 core |
| `pnpm --filter @pulpo/shell tauri build` | 出 macOS 包（`.app` + `.dmg`） |
| `pnpm --filter @pulpo/shell test` | vitest |
| `pnpm --filter @pulpo/shell typecheck` | tsc |
| `pnpm --filter @pulpo/shell e2e` | Playwright：临时 `PULPO_HOME` 起真 daemon + 仓库里的真 ZCode adapter |

浏览器里可以用 `?ws=<端口>` 或 `?ws=ws://…` 指定 core 的地址，默认 `ws://127.0.0.1:27183`。

## 与 core 的关系

- 会话内容**一律读穿**：列表来自 `session/list` + `read/list`，全文来自
  `read/transcript { limit, before }`（先拉最后 50 条，往上翻带上一页的 `cursor`），
  壳不存任何消息副本，关掉它什么都不会丢。
- 能力**一律问 agent**：模型清单、思考强度、投递档位、访问模式的风险等级都来自
  `agent/descriptor`。拿不到就如实说拿不到（该渠道还没有活动会话），不给默认值兜底。
- 投递补充消息走 `delivery/send` / `task/send_input` 的阶梯，回执**原样翻译**：
  `injected` 只代表目标收下了，是不是并进了当前这一步要看 `tier`；`failed`（目标收下了
  但自报失败）与 `unsupported`（阶梯上没有一档可用）是两回事，不合并。目标回了枚举外
  的字符串时按 `unsupported` 处理，但原文与目标的原始应答都摊在卡片上。
- **回合边界**走 `session/update` 的壳内合成事件 `derived.event = turn_started /
  turn_finished`（没有 `update` 字段）；`turn_finished.changes` 直接驱动文件改动汇总卡。
  没有这两条的老 core 上，壳在发 prompt 的那一刻本地合成一对边界，功能不缩水。
- **工具改动的行数**优先取 core 的旁路字段 `derived.changeStat`（结算那条通知上），
  其次是 ACP 的 diff 块，最后按工具入参行数算；三条都算不出来就**不渲染统计**。
- 撤销走 `session/changes` / `session/revert`（回合级 git 快照）；
  `skipped` 与原因一条不吞，全部摊在横幅里。
- 追问用 `elicitation/respond` 作答；`permission/pending` 里的追问条目按追问卡渲染，
  不会退化成一张没有按钮的审批卡。

壳用到的 core 方法：`core/info`、`subscribe`、`agent/list`、`agent/descriptor`、
`session/new` `list` `open` `resume` `load` `fork` `close` `prompt` `cancel`
`set_config_option` `set_mode` `changes` `revert`、`delivery/send` `delivery/queue`、
`task/delegate` `list` `send_input` `cancel`、`graph/nodes` `edges` `tree`、
`read/list` `read/transcript`、`permission/pending` `respond`、`elicitation/respond`，
以及五个通知主题（`session/update`、`task/update`、`permission/requested`、
`elicitation/requested`、`agent/exit`）。没用到的只有 `core/methods`、`core/shutdown`、
`unsubscribe`、`session/request`（扩展方法逃生口）、`task/get`（`task/list` + `task/update`
已覆盖）、`companion/identify`（companion 自己的事）。

## 视觉

数值与色彩集中在 `src/index.css` 一个文件里：Tailwind 的默认档位全部清空
（`--color-*: initial` 等），标度外的值连类名都不存在；色阶是 `--c-*` 两份
（亮/暗），语义色指向它们，组件里只用语义名。亮暗跟随系统。

对比度不是肉眼判断——`src/test/contrast.test.ts` 把实际用到的每一个色对都算出来断言，
浅色深色各一遍，并把当前色板的实算值钉住（±0.05）：动色值必须先把这里的数改掉。

## 与主流桌面端（ZCode / Claude Code / Codex / WorkBuddy）的取舍

下面每一条都是"对标产品那么做、我们这么做"的差异，每条都写了理由。

| 对标做法 | 本实现 | 理由 |
|---|---|---|
| 左栏导航第三项放「自动化」 | 「派活」 | 本项目不做自动化；跨渠道派活是一等入口 |
| 「已置顶」会话组 | 不做 | 置顶是会话的属性，`read/list` 没有这个字段；壳自己记一份就是第二份会话状态（会话零副本） |
| 会话行右端的改动统计 `+N −N` | 不渲染 | `read/list` 不给每条会话的改动行数；拿不到就不显示，不塞 0 |
| 底部用户区（头像 + 套餐 chip） | 显示「本机 core <版本>」 | pulpo 没有账号体系；这里放连接与版本这条真信息 |
| 标题栏右侧 `[终端][改动]` | `[刷新][左栏][右栏][更多]` | 不做终端；改动汇总在会话流里，不重复入口 |
| 标题栏左右内边距 13 | 12（`px-3`） | 13 不在七档间距里，取最近的 12；差 1px，不引入档位外数值 |
| 运行中摘要显示最后一个子工具的动作 | 显示桶摘要 | 桶摘要来自**已结算**的工具，不随每个新工具跳字；同一份数据、更稳的标签 |
| 展开体渲染命令块与完整输出 | 渲染结论（`TaskRecord.summary`） | core 只存结论与 native session 位置，不存转录（零副本）；完整轨迹走「查看轨迹」读穿 |
| 消息动作行有 `赞 / 踩 / 朗读` | 只有 `复制 / 分叉` | 前两个没有语义（core 没有反馈通道），朗读在桌面壳里没有原生实现；不做点了没反应的按钮 |
| 输入区左侧 `+ 附件 / 麦克风` | 不渲染 | 没有能力证据（descriptor 里没有附件/语音的广告），core 的 `session/prompt` 在壳里也只走文本；放两个死按钮是在暗示能力存在 |
| 排队列表可拖拽排序 / 可删 / 立即发送 | 只读列表 | PROTOCOL 的 `delivery/queue` 没有排序、删除、立即发送的方法；壳不发明写操作 |
| 仓库行的「提交或推送」 | 只读（分支 + 改动统计） | P0 不含 git 写操作；core 只有回合级快照/撤销。按钮点了没反应比没有按钮更糟 |
| 额度提醒条（按 10% 档位重现） | 只有连接提醒 | core 没有额度数据源（descriptor 与通知里都没有），不编一个百分比 |
| 右栏「产物」分区 | 不渲染 | core 没有"产物"这个一等概念；本轮产生/引用的对象已在「来源」里 |
| 「记忆已更新」点开看 diff | 一行说明 | 没有 `memory_updated` 通知；这一行是壳按文件名推断的，文案里如实写了 |
| 流式 `tool_call_update` 用 rAF 批量 | 统一 16ms 定时队列 | rAF 在后台标签页会暂停，流会在切走页面时卡住；16ms 定时器两处都稳 |
| 客户端窗口化长转录 | 服务端分页（50 条/页） | `read/transcript` 的分页把挂载量天然压在用户翻过的页数内，不做虚拟滚动 |
| `⌘,` 设置面板 | 不做 | 唯一可设的是界面缩放（`⌘=` / `⌘-` / `⌘0`），一个面板装一个滑杆不值得 |
| `@theme` 放独立的 `theme.css` | 放 `src/index.css` | 一个文件装全部 token，对比度测试直接从它解析色值 |

## 设计约束

- 数值只从 `index.css` 的标度里取，写 `p-2` 不写 `p-[9px]`；两个具体组件尺寸
  （会话行 26、回到底部按钮 36）走 `--spacing-row` / `--spacing-jump` 两个命名 token——
  它们不在七档间距里，命名成 row/jump 而不是数字，避免被当成新的间距档位。
- 每个状态都配文字：状态点 + aria-label、diff 颜色 + `+/-` 字符、用量颜色 + 百分比。
- 渠道差异如实暴露：模式名、回执档位、`stopReason` 原文、agent 的报错原话。
- 数据区五态（空 / 加载 / 部分 / 错误 / 理想）都实现，空态给引导文案 + 主行动。
- 每个 Enter 处理器都包 IME 守卫；折叠态、滚动位置、hover 态不进 React state 树。
- 不引 UI 组件库 / 状态库 / 路由：运行时依赖只有 react / react-dom 与三个 Tauri 官方包。
