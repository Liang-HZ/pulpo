# @liangai/pulpo-companion — 跨渠道派活的 MCP 伴生

一个 **stdio MCP 服务器**。core 在开会话时把它注入进各渠道 agent 的会话里，于是那个 agent
多出五个工具：看有哪些渠道、把子任务派给别的渠道、给派出去的任务补话、查结论、撤销。

```
agent 会话 ──MCP stdio──▶ pulpo-companion ──JSON-RPC over unix socket──▶ pulpo-core
                                                                          └─ task/* delivery/*
```

companion **自己不持状态、不起 agent、不存转录**：每个工具都落到 core 的方法上
（契约见 [PROTOCOL.md](https://github.com/Liang-HZ/pulpo/blob/main/packages/core/PROTOCOL.md)）。
一层熔断也在 core 判，companion 只负责如实上报
"我是谁"。

## 工具

| 工具 | 参数 | 返回 |
|---|---|---|
| `list_agents` | 无 | `{ caller, agents: [{ agent_type, label, current_model_id, current_thinking_effort, available_models[{model_id,label,efforts,default_effort,total_context_tokens}], available_efforts, delivery, descriptor_available }] }` |
| `delegate_to_agent` | `agent_type`, `task`, `working_dir?`, `model_id?`, `thinking_effort?`, `delivery?` | `{ task_id, session_ref, capability_ref, caller, working_dir }` |
| `send_input` | `task_id?` \| `session_ref?`（二选一）, `message`, `delivery?` | `{ outcome, tier, requested_tier, attempts, turn_active, session_ref, attribution, caller }` |
| `get_task` | `task_id` | `{ task_id, status, summary, summary_source, session_ref, agent_type, model_id, thinking_effort, stop_reason, working_dir, caller }` |
| `cancel_task` | `task_id` | `{ ok, reason? }` |

`delivery` 是一个对象：`tier` / `max_tier`（`native` \| `extension` \| `concurrent` \|
`soft-interrupt` \| `queue`）、`allow_interrupt`、`start_turn_if_idle`。档位只能往保守方向压，
抬不上去——能力由目标 agent 自己说了算。回执枚举 `injected` / `queued` / `no_active_turn` /
`completed_race` / `unsupported` 的含义见
[PROTOCOL.md](https://github.com/Liang-HZ/pulpo/blob/main/packages/core/PROTOCOL.md) §4.6。

工具返回的是一段 JSON 文本；出错时 `isError=true`，正文里带 core 的错误码与原文。

**取值从哪来**：`agent_type` 来自 `list_agents`；`model_id` / `thinking_effort` 来自同一份结果里
该渠道的 `available_models` / `available_efforts`（模型 id 是渠道自己的写法，可能含中文，
**原样回传**）。给了目标不认识的值，core 当场报 `-32602`，不会静默回落到默认值。

**归属标注**：`send_input` 投出去的消息带 `[来自派活方 <agent_type>:<session_ref>]` 前缀
（人直接调用时是 `[来自派活方 human:直接调用 companion]`），换行后接正文——目标 agent 在自己的
原生界面里看得到这条消息是谁补的。

**一层限制**：被派活出来的会话再调 `delegate_to_agent` 会被 core 拒绝，错误里带
`code: -32003` 与 `legacyExitCode: 3`。agent 自己的原生
subagent 不受此限。

## 调用方身份

| 来源 | 行为 |
|---|---|
| `PULPO_SESSION_REF=<agentId>#<sessionId>` | 直接作为 callerRef 报给 core |
| `PULPO_SESSION_TOKEN=<uuid>`（core 注入时给） | 调 `companion/identify` 换回 sessionRef |
| 两者都没有 | 人直接调用：允许派活，所有回执里 `caller: "human"` |

core 注入 companion 的时刻是 `session/new` **请求发出之前**——那一刻会话 id 还不存在，
所以注入的是一次性令牌而不是 sessionRef；core 拿到 sessionId 后登记 `token → sessionRef`，
companion 第一次用到身份时换。令牌认不出来时工具直接报错，**不会退化成 human**
（否则一层熔断就被绕过去了）。

## 运行

```bash
pulpo-companion          # stdio MCP 服务器，由 MCP 客户端拉起
pulpo-companion --help
```

| 环境变量 | 作用 |
|---|---|
| `PULPO_HOME` | core 的状态根目录（默认 `~/.pulpo`），socket 取 `$PULPO_HOME/run/core.sock` |
| `PULPO_SOCKET` | 整条覆盖 core 的 unix socket 路径 |
| `PULPO_CORE_WS` | core 的 WebSocket 端口（core 以 `--no-socket` 起时的回落） |
| `PULPO_SESSION_REF` / `PULPO_SESSION_TOKEN` | 调用方身份，见上 |
| `PULPO_DEFAULT_CWD` | 派活时 `working_dir` 的兜底值（再兜底才是进程 cwd） |

core 侧的开关是 `PULPO_COMPANION=off`（关掉注入）与 `PULPO_COMPANION_BIN`（指定 bin 路径）。

## 实测行为（这些是踩过的）

- **引擎会为 MCP 工具调用要授权**。ZCode 引擎调 `mcp__pulpo__list_agents` 前会发
  `session/request_permission`；没有客户端应答时 core 按默认拒绝结算（默认 5 分钟超时），
  那次工具调用就失败。壳（或测试）必须真的裁决这些请求。
- **引擎给 MCP 工具的名字是 `mcp__<server>__<tool>`**，后续的 `tool_call_update` 只带
  `toolCallId`，不再重复工具名——要按 id 把一次调用的片段收拢。
- **`get_task` 的 summary 不占位**：优先用 core 任务登记里的结论（目标那一轮的 agent 正文）；
  为空且回合已结束时读穿目标会话取最近一条 agent 文本；还是没有就如实留空并写明原因。

## 测试

```bash
pnpm --filter @liangai/pulpo-companion test
```

- 单元（20 条）：工具清单与 schema、参数校验、身份解析（`PULPO_SESSION_REF` / 令牌 / human）、
  归属标注、熔断错误透出、summary 的三条来源。用假 core，秒级。
- 集成（12 条，真 core + 真 ZCode 引擎 + 真模型）：
  `list_agents → delegate_to_agent(model_id + thinking_effort) → get_task 轮询到 done →
  send_input → cancel_task`；以被派活会话身份再派活的熔断；以及**端到端注入**——让模型自己调
  `list_agents`，从转录里核对那次工具调用与它的返回。
