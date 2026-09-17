# @liangai/pulpo-companion — 跨渠道派活的 MCP 伴生 · cross-channel delegation MCP companion

一个 **stdio MCP 服务器**。core 在开会话时把它注入进各渠道 agent 的会话里，于是那个 agent
多出五个工具：看有哪些渠道、把子任务派给别的渠道、给派出去的任务补话、查结论、撤销。

A **stdio MCP server**. When core opens a session it injects the companion into that channel
agent's session, giving the agent five more tools: see which channels exist, delegate a subtask
to another channel, add input to a delegated task, read its conclusion, and cancel it.

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

它在 npm 上（`npm i @liangai/pulpo-companion`），但实际由 core 通过 `PULPO_COMPANION_BIN`
拉起，一般不手工装；从源码构建则 `pnpm --filter @liangai/pulpo-companion build`。

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

## English

`@liangai/pulpo-companion` is a **stdio MCP server**. When core opens a session it injects the
companion into that channel agent's session, giving the agent five more tools: see which channels
exist, delegate a subtask to another channel, add input to a delegated task, read its conclusion,
and cancel it.

```
agent session ──MCP stdio──▶ pulpo-companion ──JSON-RPC over unix socket──▶ pulpo-core
                                                                            └─ task/* delivery/*
```

The companion **holds no state, starts no agent and stores no transcript of its own**: every tool
lands on a core method (the contract is
[PROTOCOL.md](https://github.com/Liang-HZ/pulpo/blob/main/packages/core/PROTOCOL.md)). The
one-level breaker is decided in core too; the companion's only job is to report truthfully
"who I am".

### Tools

| Tool | Arguments | Returns |
|---|---|---|
| `list_agents` | none | `{ caller, agents: [{ agent_type, label, current_model_id, current_thinking_effort, available_models[{model_id,label,efforts,default_effort,total_context_tokens}], available_efforts, delivery, descriptor_available }] }` |
| `delegate_to_agent` | `agent_type`, `task`, `working_dir?`, `model_id?`, `thinking_effort?`, `delivery?` | `{ task_id, session_ref, capability_ref, caller, working_dir }` |
| `send_input` | `task_id?` \| `session_ref?` (exactly one), `message`, `delivery?` | `{ outcome, tier, requested_tier, attempts, turn_active, session_ref, attribution, caller }` |
| `get_task` | `task_id` | `{ task_id, status, summary, summary_source, session_ref, agent_type, model_id, thinking_effort, stop_reason, working_dir, caller }` |
| `cancel_task` | `task_id` | `{ ok, reason? }` |

`delivery` is an object: `tier` / `max_tier` (`native` \| `extension` \| `concurrent` \|
`soft-interrupt` \| `queue`), `allow_interrupt`, `start_turn_if_idle`. A tier can only be pushed
toward the conservative end, never raised — the capability is the target agent's own to declare.
For the meaning of the receipt enum `injected` / `queued` / `no_active_turn` / `completed_race` /
`unsupported`, see
[PROTOCOL.md](https://github.com/Liang-HZ/pulpo/blob/main/packages/core/PROTOCOL.md) §4.6.

A tool returns one JSON text; on error `isError=true` and the body carries core's error code and
message.

**Where values come from**: `agent_type` comes from `list_agents`; `model_id` /
`thinking_effort` come from that same result's `available_models` / `available_efforts` for that
channel (model ids are the channel's own spelling and may contain non-ASCII characters — **pass
them back verbatim**). Give the target a value it does not recognise and core answers `-32602` on
the spot; it never silently falls back to a default.

**Attribution**: a message sent by `send_input` carries the prefix
`[来自派活方 <agent_type>:<session_ref>]` (when a human calls the companion directly it is
`[来自派活方 human:直接调用 companion]`), followed by a newline and the body — the target agent
sees in its own native UI who added the message.

**One-level limit**: a session that was itself delegated is refused by core if it calls
`delegate_to_agent` again, with `code: -32003` and `legacyExitCode: 3` in the error. An agent's
own native subagents are unaffected.

### Caller identity

| Source | Behaviour |
|---|---|
| `PULPO_SESSION_REF=<agentId>#<sessionId>` | reported directly to core as the callerRef |
| `PULPO_SESSION_TOKEN=<uuid>` (given by core at injection time) | exchanged via `companion/identify` for the sessionRef |
| neither | a human calling directly: delegation is allowed and every receipt says `caller: "human"` |

Core injects the companion **before the `session/new` request goes out** — at that moment the
session id does not exist yet, so what gets injected is a one-time token rather than a sessionRef;
once core has the sessionId it records `token → sessionRef`, and the companion exchanges the
token the first time it needs its identity. If the token is not recognised the tool errors
outright and **never degrades to human** (otherwise the one-level breaker could be bypassed).

### Running

It is on npm (`npm i @liangai/pulpo-companion`), but core normally launches it through
`PULPO_COMPANION_BIN`; installing it by hand is unusual. From this repo's source,
`pnpm --filter @liangai/pulpo-companion build` builds it.

```bash
pulpo-companion          # stdio MCP server, launched by an MCP client
pulpo-companion --help
```

| Environment variable | Meaning |
|---|---|
| `PULPO_HOME` | core's state root (default `~/.pulpo`); the socket is `$PULPO_HOME/run/core.sock` |
| `PULPO_SOCKET` | full override of core's unix socket path |
| `PULPO_CORE_WS` | core's WebSocket port (the fallback when core runs with `--no-socket`) |
| `PULPO_SESSION_REF` / `PULPO_SESSION_TOKEN` | caller identity, see above |
| `PULPO_DEFAULT_CWD` | fallback for `working_dir` when delegating (the process cwd is the fallback of last resort) |

The core-side switches are `PULPO_COMPANION=off` (turn injection off) and `PULPO_COMPANION_BIN`
(point at its bin path).

### Observed behaviour (learned the hard way)

- **Engines ask for permission for MCP tool calls.** Before calling `mcp__pulpo__list_agents`,
  the ZCode engine sends `session/request_permission`; with no client answering, core settles it
  as a default deny (5-minute timeout by default) and that tool call fails. The shell (or a test)
  must really adjudicate these requests.
- **Engines name MCP tools `mcp__<server>__<tool>`**; later `tool_call_update` notifications only
  carry `toolCallId` and never repeat the tool name — the fragments of one call must be gathered
  by id.
- **`get_task`'s summary does not pad.** It prefers the conclusion in core's task registry (the
  agent text of the target turn); if that is empty and the turn has ended, it reads through to the
  target session for the latest agent text; if there still is none it honestly stays empty and
  says why.

### Tests

```bash
pnpm --filter @liangai/pulpo-companion test
```

- Unit (20): tool list and schemas, argument validation, identity resolution
  (`PULPO_SESSION_REF` / token / human), attribution, breaker error surfacing, the three summary
  sources. Uses a fake core; runs in seconds.
- Integration (12, real core + real ZCode engine + real model):
  `list_agents → delegate_to_agent(model_id + thinking_effort) → poll get_task to done →
  send_input → cancel_task`; the breaker when a delegated session delegates again; and
  **end-to-end injection** — let the model itself call `list_agents` and check that tool call and
  its return in the transcript.
