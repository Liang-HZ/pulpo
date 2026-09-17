# pulpo core — 本地控制协议

`pulpo-core` 是 pulpo 的编排 daemon。它以 **ACP client** 的身份持有各渠道 agent 的
子进程与会话，对上用 **JSON-RPC 2.0** 暴露全部能力。

本文是 `packages/shell`（桌面壳）与 `packages/companion`（MCP 伴生）唯一需要的契约：
照着它实现即可，不必读 core 的源码。

---

## 1. 连接

两条传输，**跑完全相同的一套 JSON-RPC**：同样的方法表、同样的参数与返回、
同样的通知、同样的错误码。选哪条只看客户端方便。

| 传输 | 地址 | 分帧 |
|---|---|---|
| unix socket | `$PULPO_HOME/run/core.sock`（默认 `~/.pulpo/run/core.sock`；`PULPO_SOCKET` 整条覆盖） | **换行分隔**：一行一条 JSON-RPC 消息，消息内部不含裸换行 |
| WebSocket | `ws://127.0.0.1:27183`（`PULPO_WS_PORT` 覆盖；**只绑 loopback**） | **一帧一条**：一条 WebSocket 文本帧 = 一条 JSON-RPC 消息 |

- 两条传输可以同时开，也可以各自关掉（`--no-socket` / `--no-ws`）。
- Tauri webview 开不了 unix socket，shell 直连 WebSocket；unix socket 给命令行与
  同机进程（companion）用。P3 多端复用 WebSocket 这条。
- **通知走同一条连接**：客户端订阅什么主题，就从自己这条连接上收什么推送。
  订阅是**每连接独立**的，不跨连接共享。
- socket 文件权限 `0600`。WebSocket 不做鉴权——它只绑 `127.0.0.1`，
  信任边界就是本机用户。

### 启动

```bash
pulpo-core                       # 两条传输都开，用默认地址
pulpo-core --ws-port 0           # WebSocket 用随机空闲端口（测试用）
pulpo-core --socket /tmp/x.sock  # 指定 socket 路径
pulpo-core --no-ws               # 只开 unix socket
pulpo-core --help
```

就绪后往 stderr 打一行：
`pulpo-core 0.1.0 就绪 pid=<pid> socket=<path> ws=<port>`。
需要知道实际端口时（`--ws-port 0`），连上后调 `core/info` 读
`transports.wsPort`。

**环境变量**

| 变量 | 作用 |
|---|---|
| `PULPO_HOME` | 状态与运行目录根，默认 `~/.pulpo` |
| `PULPO_SOCKET` | 整条覆盖 unix socket 路径 |
| `PULPO_WS_PORT` | WebSocket 端口，`0` = 随机空闲端口 |
| `PULPO_ZCODE_ACP` | ZCode adapter 可执行文件路径（默认 `packages/adapters/zcode/bin/zcode-acp`） |
| `PULPO_COMPANION` | `off` 关掉 companion 注入（默认开） |
| `PULPO_COMPANION_BIN` | companion 可执行文件路径（默认 `packages/companion/bin/pulpo-companion`） |
| `ZCODE_CJS` | ZCode 引擎入口，读取层用（默认 `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`） |

> macOS 的 unix socket 路径上限是 104 字节。`PULPO_HOME` 过长时 daemon 启动直接
> 报错，不会静默失败。

---

## 2. 消息格式

标准 JSON-RPC 2.0。

**请求**

```json
{"jsonrpc":"2.0","id":1,"method":"core/info","params":{}}
```

**成功**

```json
{"jsonrpc":"2.0","id":1,"result":{"name":"@liangai/pulpo-core","version":"0.1.0"}}
```

**失败**

```json
{"jsonrpc":"2.0","id":1,"error":{"code":-32003,"message":"recursion blocked (one-level dispatch only)","data":{"legacyExitCode":3,"sessionRef":"zcode#abc"}}}
```

**通知**（daemon → 客户端，没有 `id`，不需要应答）

```json
{"jsonrpc":"2.0","method":"task/update","params":{"taskId":"…","status":"done"}}
```

- 支持**批量请求**：发一个 JSON 数组，回一个数组（只含有 `id` 的那些的响应）。
  数组里全是通知时不回任何东西。
- 客户端发的通知（无 `id`）一律不产生响应，未知方法也不产生。
- `id` 只能是 string / number / null。

### 核心标识

**`sessionRef`** = `<agentId>#<agent 原生 sessionId>`，例如
`zcode#zc-sess_47f2f33a-dc34-4e46-9725-00da1bb08e81`。
`#` 之后原样就是 agent 自己的会话 id——pulpo 不发明 id，也不建映射表。

**`taskId`** = UUID，派活任务的登记号，pulpo 自己生成。

---

## 3. 方法总表

```
agent/descriptor
agent/list
companion/identify
core/info
core/methods
core/shutdown
delivery/queue
delivery/send
elicitation/respond
graph/edges
graph/nodes
graph/tree
permission/pending
permission/respond
read/list
read/transcript
session/cancel
session/changes
session/close
session/fork
session/list
session/load
session/new
session/open
session/prompt
session/request
session/resume
session/revert
session/set_config_option
session/set_mode
subscribe
task/cancel
task/delegate
task/get
task/list
task/send_input
unsubscribe
```

---

## 4. 方法详表

### 4.1 基础

#### `core/info`
参数：无。

返回：
```json
{
  "name": "@liangai/pulpo-core", "version": "0.1.0", "protocol": 1, "pid": 23076,
  "transports": { "socketPath": "/Users/x/.pulpo/run/core.sock", "wsPort": 27183 },
  "topics": ["session/update","task/update","permission/requested","elicitation/requested","agent/exit"]
}
```

#### `core/methods`
参数：无。返回 `{ "methods": string[] }`（字典序）。

#### `core/shutdown`
参数：无。返回 `{ "ok": true }`，随后 daemon 关停所有 agent 子进程并退出。

---

### 4.2 订阅

#### `subscribe`
参数 `{ "topics"?: string[] }`。省略 `topics` = 订阅全部主题；传 `[]` = 不新增订阅
（可用来查当前订阅了什么）。

返回 `{ "subscribed": string[] }`。

主题只能是这五个，其余报 `-32602`：

| 主题 | 何时推 |
|---|---|
| `session/update` | agent 的 `session/update` 流（正文 / 思考 / 工具卡 / 子代理 …） |
| `task/update` | 派活任务状态变化 |
| `permission/requested` | agent 请求授权，等客户端裁决 |
| `elicitation/requested` | agent 反过来问用户 |
| `agent/exit` | agent 子进程退出 |

#### `unsubscribe`
参数 `{ "topics"?: string[] }`。省略 = 全退订。返回 `{ "subscribed": string[] }`。

---

### 4.3 agent 与能力描述符

#### `agent/list`
参数：无。返回数组：
```json
[{ "agentId":"zcode", "label":"ZCode",
   "command":"/…/packages/adapters/zcode/bin/zcode-acp", "args":[],
   "reader":"zcode",
   "storage":{"kind":"engine-store","location":"ZCode app-server session store"} }]
```

这是**引导表**——只回答"怎么启动、去哪拉自描述"，**不含任何能力断言**。
能力要问 `agent/descriptor`。

#### `agent/descriptor`
参数 `{ "agentId": string, "sessionRef"?: string, "cwd"?: string, "refresh"?: boolean }`。
不给 `sessionRef` 时取该 agent 最近开的一条会话。

返回里**一定带 `source`**，说明这份能力是怎么来的：

| `source` | 含义 | 代价 |
|---|---|---|
| `live` | 来自一条**活动会话**的自描述 | 无 |
| `cached` | 来自上一次自描述的缓存，`cachedAt` 是它的时间戳 | 无 |
| `probed` | 现开一条会话读完自描述、**立刻关掉** | 起一次 agent 子进程（实测 ZCode 约 2.8s） |

优先级 `live` > `cached` > `probed`；`refresh: true` 跳过缓存直接现探。
既没有活动会话、也没有缓存时**必须给 `cwd`**（要开会话就得有工作目录），
不给就报 `-32602`。

壳里的派活表单可以直接用 `cached` / `probed` 这两条列模型——
但要注意它们是"agent 上次/刚才说的话"，不是中心权威表：
core 从不硬编码任何能力，缓存里存的只有 agent 自己的自描述与它的原文。

返回 `CapabilityDescriptor`：

```jsonc
{
  "agentId": "zcode",
  "protocolVersion": 1,
  "delivery": {
    "steering": {
      "supported": true,          // agent 自己广告的
      "tier": "extension",        // 实际档位（可能被修正层收紧过）
      "boundary": "step|turn|unknown",
      "idle": "promptRequired|startsNewTurn|unknown",
      "settlesOwnerTurn": false,
      "method": "_session/steering"
    },
    "queue": { "supported": true, "drainAt": "turnEnd" }
  },
  "sessions": { "list": true, "load": false, "resume": true, "fork": true, "close": true, "delete": false },
  "models": [
    { "id": "Coding Plan/glm-5.3-flash", "label": "glm-5.3-flash",
      "efforts": ["low","high","max","medium"], "defaultEffort": "medium",
      "totalContextTokens": 1000000 }
  ],
  "currentModelId": "Coding Plan/glm-5.3-flash",
  "efforts": ["low","high","max","medium"],
  "currentEffort": "medium",
  "modes": [
    { "id": "default",           "name": "变更前确认", "risk": "safe" },
    { "id": "acceptEdits",       "name": "自动编辑",   "risk": "elevated" },
    { "id": "plan",              "name": "计划模式",   "risk": "safe" },
    { "id": "bypassPermissions", "name": "完全访问",   "risk": "full" }
  ],
  "currentModeId": "default",
  "subagents": { "spawn": false, "modelOverride": false, "effortOverride": false, "liveMessaging": false },
  "transports": { "acp": true, "mcp": [] },
  "storage": { "kind": "engine-store", "location": "…", "reader": "zcode" },
  "revert": { "supported": "available", "kind": "shell-git-snapshot" },
  "raw": { "initialize": { … }, "newSession": { … } },
  "corrections": [ … ],
  "aggregatedAt": 1789545999553,
  "source": "live"
}
```

**怎么读这份东西**

- `models[].id` 与 `currentModelId` 是 **agent 自己的写法，原样保留**（ZCode 的形如
  `<渠道名>/<模型名>`，含中文）。UI 直接展示、直接回传，不要改写、不要建映射。
- `raw.initialize` / `raw.newSession` 是 agent 自描述的原文，要看原生细节就读这里。
- **`modes[].risk`**（`safe` / `elevated` / `full`）是访问模式的危险等级，
  UI 据此决定模式 chip 要不要变橙。**事实源仍是 agent**：它在 mode 对象里自报
  `risk` / `_meta.risk` / `dangerLevel` / `permissionLevel` 时直接采信；
  什么都没报时才由修正覆盖表补一条**带实测证据**的等级（会进 `corrections`，
  路径形如 `modes[bypassPermissions].risk`）。等级只能往高了补
  （`undefined → safe → elevated → full`），把高危改低会被当场拒绝。
  **UI 一律不许做字符串匹配**（`modeId.includes("yolo")` 是明令禁止的）。
  字段缺失 = 这个 agent 既没自报、覆盖表也没有证据 → 按"未知"渲染，不要猜。
- **`revert`** 是这条会话的回合级撤销能力（见 §4.12），与会话的 `cwd` 绑定：
  `{"supported":"available","kind":"shell-git-snapshot"}` 表示 cwd 在 git 仓库里，
  可以 `session/changes` / `session/revert`；不在仓库里就是
  `{"supported":"unavailable","kind":"none","reason":"notGitRepo"}`。
- `corrections` 是**壳侧收紧过的地方**，空数组表示壳完全采信 agent 自述。
  每条都能回答"为什么壳跟 agent 说的不一样"。**示例**（某个 agent 广告了 steering
  但扩展方法实际不存在时，收紧记录长这样；仓内的 ZCode adapter 0.7.0 是真实现，
  它的 `corrections` 就是空数组）：

```jsonc
{
  "id": "zcode.steering-advertised-but-absent",
  "path": "delivery.steering.tier",
  "from": "extension", "to": "concurrent",
  "reason": "initialize 的 `_meta.steering.supported` 广告了 steering，但扩展方法未实现…",
  "evidence": "实测 `_session/steering` 应答：{\"code\":-32601,…}",
  "versionCondition": "任意 ZCode adapter 版本，当 `_session/steering` 实际返回 -32601 时命中"
}
```

  修正层**只收紧**：只会让能力变弱（档位往后、布尔位 true→false）。
  想放宽只有一条路——让 agent 在自描述里说。
  注意上例里 `delivery.steering.supported` 仍然是 `true`：我们改的是**实际档位**，
  不改 agent 的自述。UI 要显示"agent 说支持但实测不可用"就看这两者的差。

---

### 4.4 会话生命周期

#### `session/new`
参数 `{ "agentId": string, "cwd": string(绝对路径), "mcpServers"?: object[] }`。

> **companion 注入**：core 会在你给的 `mcpServers` 后面**追加一条** `@liangai/pulpo-companion`
> （stdio，`name: "pulpo"`），于是这条会话里的 agent 拿到跨渠道派活的四件套。
> `PULPO_COMPANION=off` 关掉；companion 没构建过（`dist/cli.js` 不在）时也不注入——
> 少一个工具好过让 agent 去启一个必崩的 MCP server。`task/delegate` 建出来的目标会话
> 同样注入，于是被派活的 agent 再派活时会撞上一层熔断。详见 §4.11。

返回：
```json
{ "sessionRef":"zcode#zc-sess_…", "sessionId":"zc-sess_…", "agentId":"zcode",
  "cwd":"/path", "descriptor":{…}, "raw":{…} }
```
`raw` 是 agent 的 `session/new` 应答原文（含 `models` / `configOptions` /
`modes` / `availableCommands`）。

> 进程模型：**一会话一进程**。每次 `session/new` 起一个新的 agent 子进程。

#### `session/list`
参数 `{ "agentId": string, "cwd": string }`。
返回 `{ "sessions": SessionInfo[] }` —— agent 的 `session/list` 原始结果，
元素形如 `{ sessionId, cwd, title?, updatedAt? }`。**不做归一**。

#### `session/resume`
参数 `{ "sessionRef": string, "cwd": string }`
或 `{ "agentId": string, "sessionId": string, "cwd": string }`。
返回 `{ "sessionRef", "descriptor", "raw" }`。

#### `session/load`
参数 `{ "agentId", "sessionId", "cwd" }`。透传 agent 的 `session/load`，返回其原始应答。
agent 的 `agentCapabilities.loadSession` 为 false 时会报错（ZCode 就是 false）。

#### `session/fork`
参数 `{ "sessionRef": string }`。返回 `{ "sessionRef": "<新的>", "raw": {…} }`。

> **ZCode 的实测行为**：它的 fork 是**工作区检查点分叉**，检查点只在会话里真的
> 发生过文件编辑之后才有。没有检查点时 agent 回
> `No workspace checkpoint is available yet.`，core 把这个错误**原样透出**，
> 不伪造成功。UI 要么按需禁用 fork，要么把 agent 的原话显示出来。

#### `session/close`
参数 `{ "sessionRef": string }`。返回 `{ "ok": true }`。
关掉 agent 侧会话并收掉那个子进程。之后再操作这条会话一律 `-32001`。

#### `session/open`
参数：无。返回当前在册的会话：
```json
[{ "sessionRef":"zcode#…", "agentId":"zcode", "sessionId":"…", "cwd":"/path",
   "turnActive": false, "createdAt": 1789545… }]
```
`turnActive` 是投递阶梯的裁决依据，UI 也可以据此显示"正在跑"。

---

### 4.5 回合

#### `session/prompt`
参数 `{ "sessionRef": string }` 加内容二选一：
- `"prompt": ContentBlock[]`（ACP 原生形状，如 `[{"type":"text","text":"…"}]`）
- `"text": string`（便捷写法，等价于一个 text block）

返回 agent 的 `PromptResponse`，如 `{ "stopReason": "end_turn" }`
（其余取值：`cancelled` / `max_tokens` / `refusal` … 由 agent 决定）。

**这是个长请求**——整轮跑完才返回。过程中的正文 / 思考 / 工具卡全部走
`session/update` 通知。客户端要么订阅通知、要么忍受长等待，不要给它设短超时。

**回合边界走订阅通道**：core 在代理这个请求，所以它知道回合什么时候开始、
什么时候结束——这两件事合成成 `turn_started` / `turn_finished` 推给**所有**
订阅者（见 §5.1）。没发 prompt 的那一端（多端、旁观的壳）也因此看得到边界。
`turnId` 是 core 生成的 UUID，`session/changes` / `session/revert` 用它定位回合。

凡是 core 代理的回合都发这两条：`session/prompt`、`task/delegate` 起的回合、
以及 `delivery/send` 在空闲时开的新回合（`startTurnIfIdle`）。

#### `session/cancel`
参数 `{ "sessionRef": string }`。返回 `{ "ok": true }`。
同时把这条会话上挂着的审批请求全部按 `cancelled` 结算（ACP 的要求）。

#### `session/set_mode`
参数 `{ "sessionRef": string, "modeId": string }`。`modeId` 取自
`descriptor.modes[].id`。返回 agent 的原始应答。

#### `session/set_config_option`
参数 `{ "sessionRef": string, "configId": string, "value": string }`。
`configId` 取自 `raw.newSession.configOptions[].id`——ZCode 的是
`model` / `reasoning_effort` / `mode`。返回 agent 的原始应答。

#### `session/request`（扩展方法逃生口）
参数 `{ "sessionRef": string, "method": string, "params"?: object }`。
把 `{sessionId, ...params}` 发给 agent 的任意方法（包括 `_session/steering`、
`_session/goal` 这类扩展）。返回 agent 的原始应答，错误原样透出。

**投递补充消息请用 `delivery/send`**，别用这个——那条路才有档位裁决与回执。

---

### 4.6 投递阶梯

#### `delivery/send`
参数：
```jsonc
{
  "sessionRef": "zcode#…",
  "text": "补充一句",                  // 或 "prompt": ContentBlock[]
  "attribution": "来自派活方 agent X",  // 可选：归属标注，原生端可见
  "fromSessionRef": "zcode#…",         // 可选：谁发的，记进会话图
  "delivery": {                        // 可选：per-request 投递偏好
    "tier": "concurrent",              // 想要的档位（只能比 descriptor 更保守）
    "maxTier": "queue",                // 允许降到的最弱档，默认 "queue"
    "allowInterrupt": false,           // 允许档 4 打断当前步，默认 false
    "startTurnIfIdle": false           // 空闲时开新回合，默认 false
  }
}
```

返回 `DeliveryReceipt`（下面是实测原文：目标实现了 `_session/steering`，投递时它空闲）：
```jsonc
{
  "outcome": "no_active_turn",
  "tier": "extension",                  // 实际走的档；unsupported 时为 null
  "requestedTier": "extension",         // 降级前算出来的目标档
  "attempts": [                         // 依次试了哪些档、各自结果
    { "tier": "extension", "status": "ok" }
  ],
  // 目标的原始应答。档位被目标否掉时 attempts 里会多出
  // `{ "tier":"extension","status":"unsupported","detail":"目标回 method not found…" }`
  // 这样的记录，再往下降一档。
  "raw": { "outcome": "promptRequired", "reason": "noRunningTurn" },
  "turnActive": false,                  // 决策时目标有没有进行中的回合
  "sessionRef": "zcode#…",
  "deliveredAt": 1789545999553
}
```

**五档阶梯**

| 档 | `tier` | 机制 |
|---|---|---|
| 1 | `native` | agent 的原生 steering 原语（如 Codex `turn/steer`） |
| 2 | `extension` | `_session/steering` 扩展方法 |
| 3 | `concurrent` | 回合进行中并发投一条 prompt，由目标自己裁决怎么并入（可能是步内，也可能是下一个安全边界） |
| 4 | `soft-interrupt` | 打断当前步再重投（**要显式 `allowInterrupt: true`**，UI 必须明示代价） |
| 5 | `queue` | 壳内排队，目标回合结束时 drain |

**回执枚举**

| `outcome` | 含义 |
|---|---|
| `injected` | **已投给目标，目标收下了**。注意这不等于"已经并进了当前这一步"——步内注入是档 2 的语义；档 3 的 `injected` 意思是目标按它自己的规矩并入（实测 ZCode：引擎原生拒绝并发 send，adapter 串行化，补充消息**不丢**，在当前回合结束后执行）。要区分就看 `tier`。 |
| `queued` | **只进了壳的队列，还没到 agent** |
| `no_active_turn` | 目标当时没有进行中的回合（对应 steering 的 `promptRequired`） |
| `completed_race` | 决策到投递之间回合结束了 |
| `failed` | **目标收下了这一档的调用，但它自己报了失败**。机制在、这次没成——不是 `unsupported`。目标给的原因原样在 `raw` 里。实测样本：`{"outcome":"failed","_meta":{"steering":{"reason":"fault.command.executionFailed","detail":"FOREIGN KEY constraint failed"}}}`，对应回执 `{"outcome":"failed","tier":"extension","attempts":[{"tier":"extension","status":"failed","detail":"目标自报失败：fault.command.executionFailed：FOREIGN KEY constraint failed"}]}`。**不会再往下降级**——同一条消息重投一遍只会重复失败 |
| `unsupported` | 阶梯上没有一档可用 |

`attempts[].status` 的取值与含义：
`ok`（这一档调用成功、目标给了明确应答——收没收下看 `outcome`）/
`failed`（**目标自报失败**，此时 `outcome` 必为 `failed`，两者一致）/
`unsupported`（这一档目标不认，继续降级）/ `error`（调用本身出错）/
`skipped`（条件不满足没试，或空窗重试的那条记录）。

**规矩**

- 起点档位由 `descriptor.delivery.steering.tier` 决定。请求方只能往**保守**方向压
  （`tier` 比 descriptor 更弱才生效），**不能往上抬**——能力是 agent 说了算。
- 每一档都**问目标**，回执如实来自目标的应答，壳不代答、不美化。
  目标给了我们不认识的 outcome 字符串，一律记成 `unsupported`，绝不当成 `injected`。
- 某一档被目标以 `-32601` 否掉时，core 把这条实测证据写进修正层收紧 descriptor，
  之后同一会话不再白跑那一档。收紧的过程在 `agent/descriptor` 的 `corrections` 里可查。
- 扩展档报的**不是** `-32601` 的错（如引擎崩了）会原样抛出，**不悄悄降级**。
- 每次投递都会在会话图上记一条 `supplement` 边，带档位与回执。
- **回合刚开始的 2 秒空窗会自动重试一次**。`session/prompt` 发出之后，
  目标往往还要几百毫秒才真正开跑；这段时间里 core 已经把 `turnActive` 置真，
  目标却对 steering 回 `promptRequired`——这是空窗，不是"真的没有回合"。
  所以 core 的判据是**目标开没开口**（本回合有没有来过 `session/update`）：
  拿到 `no_active_turn` 且回合开始不足 2s、目标还没开口时，等它开口再投一次，
  重试如实写进 `attempts`（中间那条 `{"status":"skipped","detail":"…重试一次"}`）。
  目标已经开过口还回 `promptRequired` 的，就是真的没有活动回合，原样回执。

#### `delivery/queue`
参数 `{ "sessionRef": string }`。
返回 `{ "queued": [{ "sessionRef", "content", "queuedAt" }] }` —— 该会话壳内排队
但还没投出去的消息。

---

### 4.7 会话图

节点**只记位置，不存任何消息副本**。正文一律用 `read/*` 读穿原生存储。

#### `graph/nodes`
参数：无。返回 `{ "nodes": GraphNode[] }`：
```json
{ "id":"zcode#…", "kind":"root|delegation-child|native-subagent",
  "agentId":"zcode", "sessionId":"…", "cwd":"/path", "title":"…",
  "createdAt":1789…, "updatedAt":1789… }
```

#### `graph/edges`
参数（全部可选）`{ "kind"?: "delegate"|"supplement"|"result", "from"?, "to"?, "taskId"? }`。
返回 `{ "edges": GraphEdge[] }`。

```jsonc
// delegate：谁派给谁，带模型与思考强度
{ "id":"…","kind":"delegate","from":"zcode#parent","to":"zcode#child",
  "via":"agent",            // agent（companion 派的）| human（人从壳里派的）
  "taskId":"…","task":"…","modelId":"…","effort":"low","createdAt":1789… }

// supplement：一条补充消息及其档位与回执
{ "id":"…","kind":"supplement","from":"zcode#parent","to":"zcode#child",
  "tier":"concurrent","outcome":"no_active_turn",
  "attribution":"来自派活方 agent zcode","createdAt":1789… }

// result：结论与 native session 位置（不存转录）
{ "id":"…","kind":"result","from":"zcode#child","to":"zcode#parent",
  "taskId":"…","status":"done|failed|cancelled","summary":"…",
  "nativeSessionRef":"zcode#child","createdAt":1789… }
```

#### `graph/tree`
参数 `{ "sessionRef": string }`。返回以它为根的轨迹树 —— **右栏就画这个**：
```jsonc
{ "id":"zcode#root", "kind":"root", …,
  "children":[
    { "id":"zcode#child", "kind":"delegation-child",
      "viaTaskId":"…", "modelId":"…", "effort":"low",
      "children":[ { "id":"zcode#zcsub-1", "kind":"native-subagent", "children":[] } ] }
  ] }
```
节点不在图里时报 `-32001`。成环不会无限递归（重复节点的子树截断为空）。

**人从壳里派活也建边**。`from` 是：请求里给的 `fromSessionRef`（壳当时打开的
那条会话），没给就是伪节点 `"human"`（`graph/nodes` 里有它，`kind: "root"`、
`agentId: "human"`）。于是 `graph/tree { sessionRef: "human" }` 就是"我自己派出去的
全部任务"，右栏照样画得出派活层。

**`via` 决定熔断**：只有 `via: "agent"` 的边构成"被派活会话"关系。
人派出来的会话不受一层熔断限制——它自己还能再派（一层熔断只管
agent 之间）。老数据没有 `via` 字段的，一律按 `agent` 解释（保守）。

**两类子节点的规矩不同**：
- `delegation-child` 是**我们派出去的**跨 agent 子会话 → 人可以直发（`task/send_input`）；
- `native-subagent` 是 agent 自己的原生子代理 → **只观测、不越级注入**。
  core 不提供对它直发的方法，这是设计，不是缺口。

---

### 4.8 读取层（只读、读穿）

`session/list`（协议面）管列表与恢复；读取层管**全文**。读取器只读，不写、不缓存。

#### `read/list`
参数 `{ "agentId": string, "cwd": string, "limit"?: number }`。
返回 `{ "sessions": SessionSummary[] }`：
```json
{ "sessionRef":"zcode#sess_…", "agentId":"zcode", "sessionId":"sess_…",
  "title":"…", "cwd":"/path", "updatedAt":1789…, "status":"idle" }
```

> 注意 `sessionId` 是**引擎里的原生 id**（`sess_…`），而 ACP 面的 `sessionRef`
> 带 adapter 前缀（`zc-sess_…`）。要把 ACP 会话喂给读取层，去掉 `zc-` 前缀。

#### `read/transcript`
参数 `{ "agentId", "sessionId", "cwd" }` 或 `{ "sessionRef", "cwd" }`，
外加分页 `{ "limit"?: number, "before"?: string }`。

- `limit` 默认 **50**，上限 1000，必须是正整数（否则 `-32602`）；
- **从尾部往前翻**：不给 `before` 就是最后 `limit` 条；给了就是那条消息**之前**的
  `limit` 条。`before` 取上一页返回的 `cursor`，找不到就报 `-32602`（不静默兜底）；
- 返回里的 `messages` 仍按时间正序。

返回统一消息模型（分页字段在最外层）：
```jsonc
{
  "sessionRef":"zcode#sess_…", "agentId":"zcode", "sessionId":"sess_…",
  "title":"…", "cwd":"/path",
  "readBy":"zcode", "readAt":1789…,        // 这是读穿快照，不是副本，core 不落盘
  "hasMore": true,                         // 这一页之前还有更早的消息
  "cursor": "msg_…",                       // 下一页的 before；没有更早的就是 null
  "total": 128,                            // 这条会话一共多少条消息
  "cached": false,                         // 这一页有没有命中短期缓存
  "messages":[
    { "messageId":"msg_…", "role":"user|assistant|system|unknown",
      "createdAt":1789…,
      "model":{"providerId":"…","modelId":"…","variant":"high"},
      "parts":[
        { "kind":"text", "partId":"part_…", "text":"…", "raw":{…} },
        { "kind":"thought", "text":"…", "raw":{…} },
        { "kind":"tool_call", "raw":{…},
          "tool":{ "name":"Bash","callId":"call_…",
                   "status":"pending|running|completed|failed",
                   "input":{…}, "output":"…", "title":"Bash",
                   "startedAt":1789…, "completedAt":1789…,
                   // 派生字段，见 §5.1：算不出就没有这个字段
                   "changeStat":[{"path":"/ws/a.ts","added":3,"removed":0}] } },
        { "kind":"step_start|step_finish|timeline|unknown", "raw":{…} }
      ],
      "raw":{…} }
  ]
}
```

- 不认识的原生片段一律 `kind:"unknown"`，**原文留在 `raw` 里，绝不丢弃**。
- 要展示原生细节（工具卡的完整入参回参、模型切换轨迹）就读 `raw`。

> **ZCode 读取层的一个必须知道的副作用**：引擎的 `session/read` 只对 active 会话
> 有效（历史会话直接读回 `-32004 Session is not active`），所以读一条历史会话要先
> `session/resume` 把它激活，读完立刻 `session/close` 还原。这是引擎的读取方式，
> 不是在建第二存储——读到的内容一律不落盘。代价是**一次 `read/transcript` 要几秒**
> （实测首页 2.4s），UI 要按异步处理。
>
> **分页不会把这个代价乘倍**：core 一次读全量、在内存里切页，并给这份读穿快照
> 一个 **30 秒 TTL 的进程内缓存**（同一 key 的并发读只真读一次）。实测同一条会话
> 第二页 **0ms**（`cached: true`）。缓存只在内存、有过期、不落盘——事实源仍是
> agent 的原生存储，没有第二存储。要强制重读就等 TTL 过，或换一条会话。

---

### 4.9 派活 broker

语义对照原生四件套：spawn / **send_input** / poll / close。

#### `task/delegate`
参数：
```jsonc
{
  "agentId": "zcode",
  "task": "任务描述",
  "cwd": "/绝对路径",
  "modelId": "Coding Plan/glm-5.3-flash",  // 可选，必须在目标 descriptor.models 里
  "effort": "low",                              // 可选，必须在 descriptor.efforts 里
  "callerRef": "zcode#parent",                  // 可选：发起方会话（agent 派活必填）
  "fromSessionRef": "zcode#open",               // 可选：人派活时壳当时打开的会话
  "delivery": { … }                             // 可选：后续补充消息的默认偏好
}
```

返回：
```json
{ "taskId":"uuid", "sessionRef":"zcode#…", "capabilityRef": { …CapabilityDescriptor… } }
```

**`callerRef` 是熔断的关键**：
- companion 从某个 agent 会话里派活时，**必须**填自己所在的会话；
- 人从壳里直接派活**不填**——人不受一层限制，人派出来的会话自己还能再派。

**人派活照样进会话图**（`fromSessionRef` 或伪节点 `human`，见 §4.7）：
delegate 边、result 边都建，只是 `via: "human"`、不构成熔断关系。
壳的右栏因此画得出"我派出去的那一层"。

**立刻返回**，不等任务跑完。回合在后台跑，结论用 `task/get` 轮询或订阅
`task/update`。

**模型 / effort 不认识时当场报 `-32602`**，不会静默回落到默认值：
```json
{"code":-32602,"message":"zcode 不认识模型 xxx；它自报的可选项：…"}
```
`agentId` 没暴露 effort 配置项时报 `-32002`。

#### `task/get`
参数 `{ "taskId": string }`。返回 `TaskRecord`：
```jsonc
{
  "taskId":"…", "agentId":"zcode", "sessionRef":"zcode#…",
  "parentRef":"zcode#parent"|null,
  "originRef":"zcode#parent"|"zcode#open"|"human",  // 派活的发起节点（图上的边挂它）
  "caller":"agent"|"human",
  "task":"…", "cwd":"/path", "modelId":"…", "effort":"low",
  "status":"queued|running|awaiting_approval|done|failed|cancelled",
  "summary":"目标的最终回答",      // 结论，不是转录
  "stopReason":"end_turn",
  "error":"…",                     // 只在 failed 时有
  "usage": {                       // 可选，见下
    "inputTokens": 1200, "outputTokens": 340, "toolCalls": 8,
    "contextUsed": 12400, "contextTotal": 1000000
  },
  "createdAt":1789…, "updatedAt":1789…
}
```

**`usage` 的来源与规矩**：
- `contextUsed` / `contextTotal` / `inputTokens` / `outputTokens` 来自 **agent 自己报的**
  `usage_update`（实测 ZCode adapter 推 `{used, size, cost}` → 前两项）；
- `toolCalls` 是 **core 自己数的**：本回合出现过的不同 `toolCallId` 个数；
- **拿不到的字段一律省略，一个 `0` 都不会出现**；一项都拿不到时整个 `usage` 字段不给。
  UI 按"字段缺失 → 整块不渲染"处理，不要显示 `0 tok`。
  （实测依据：ZCode adapter 的 `_fetch_usage()` / `_send_usage()` 在引擎没给数时
  会推字面量 `0`。真回合不可能消耗 0 token，所以 core 把 `0` 当成"没报"丢掉。）
- **只存结论与 native session 位置，不存转录**。要完整轨迹就拿 `sessionRef`
  去 `read/transcript`。
- daemon 重启后，上次没善终的 `running` / `queued` / `awaiting_approval` 任务
  **如实标成 `failed`**（`error` 写明原因），不装作还在跑。

#### `task/list`
参数（可选）`{ "status"?: TaskStatus, "parentRef"?: string }`。
返回 `{ "tasks": TaskRecord[] }`。

#### `task/cancel`
参数 `{ "taskId": string }`。返回 `{ "ok": true }`；任务已经结束时如实回 `{ "ok": false }`。

#### `task/send_input`
参数：
```jsonc
{
  "taskId": "…",            // 或 "sessionRef": "zcode#…"，二选一
  "message": "补充内容",
  "attribution": "来自派活方 agent zcode",   // 可选，会加在消息前，原生端可见
  "delivery": { … }                          // 可选，同 delivery/send
}
```
返回 `DeliveryReceipt`（同 4.6）。

---

### 4.10 companion 注入与身份

#### `companion/identify`
参数 `{ "token": string, "waitMs"?: number }`。
返回 `{ "sessionRef": string, "agentId": string, "cwd": string }`。

**为什么要有这一步**：一层熔断要求 companion 知道自己被注入在哪条会话里，而注入发生在
`session/new` 请求发出**之前**——那一刻会话 id 还不存在，写不进环境变量。所以 core 注入的是
一次性令牌：

```jsonc
// core 追加进 session/new 的 mcpServers（ACP stdio 形状，env 是 {name,value} 数组）
{ "name": "pulpo",
  "command": "/…/packages/companion/bin/pulpo-companion",
  "args": [],
  "env": [ { "name": "PULPO_SESSION_TOKEN", "value": "<uuid>" },
           { "name": "PULPO_HOME",          "value": "/…/.pulpo" },
           { "name": "PULPO_SOCKET",        "value": "/…/.pulpo/run/core.sock" } ] }
```

core 拿到 sessionId 之后登记 `token → sessionRef`；companion 第一次用到身份时调这个方法换。
令牌可能比登记先到，所以 core 会等最多 `waitMs`（默认 30000，上限 30000）再决定认不认。
认不出来报 `-32001`——companion 这时直接报错，**不退化成"人直接调用"**，否则熔断就被绕过去了。

`session/resume` 同样注入（引擎把客户端 MCP 当 per-load 配置，复活时必须重挂）。

> 环境里直接给 `PULPO_SESSION_REF=<agentId>#<sessionId>` 时 companion 以它为准，
> 不再换令牌——手工接线与测试走这条。两者都没有 = 人直接调用：允许派活（不受一层限制），
> 回执里标 `caller: "human"`。

> **实测**：ZCode 引擎在调 MCP 工具（如 `mcp__pulpo__list_agents`）前会发
> `session/request_permission`。没有客户端裁决时 core 按默认拒绝结算（§4.11），那次工具调用
> 就失败。**壳必须真的应答这些审批**，否则注入的工具在模型那边形同虚设。

---

### 4.11 审批

pulpo 本身就是 ACP client，agent 的 `session/request_permission` 天然到壳内。

**core 不自动放行**。没有客户端应答就等到超时（默认 5 分钟），
超时按**默认拒绝**结算：优先选 agent 给的 `reject_once` 选项，没有就回 ACP 的
`cancelled`。

#### `permission/pending`
参数：无。返回 `{ "pending": PendingApproval[] }`（形状见下面的通知）。

#### `permission/respond`
参数：
```json
{ "requestId":"uuid", "outcome":"selected", "optionId":"allow_once_xxx" }
```
或 `{ "requestId":"uuid", "outcome":"cancelled" }`。

返回 `{ "ok": true }`。

请求已经结算过（超时了，或别的客户端先答了）时报 `-32004`。
UI 收到这个错误应当把卡片收掉，而不是重试。

#### `permission/requested` 的 `_meta`（审批卡片要用）

`params.request` 是 **agent 原始参数的原样透传**，core 一个字段都不动——
包括 `request._meta`。ACP 生态里客户端会用到的两处（**存在时**照用，
**不存在就当没有**，绝不要伪造）：

```jsonc
"request": {
  "sessionId": "zc-sess_…",
  "toolCall": { "toolCallId":"call_…", "kind":"edit", "title":"Write: …" },
  "options":  [ … ],
  "_meta": {
    "permission": {
      "version": 1,
      "description": "允许写入这三个文件",
      "defaultToNo": false,          // true → UI 把否定项做成主按钮
      "changes": [                   // 授权范围说明，最多渲染 6 条
        { "description":"本次运行内允许写入 src/**",
          "lifetime": { "scope":"session", "storage":"memory" } }
      ]
    }
  }
}
```

**按钮渲染规矩**（UI 侧）：顺序**原样照 agent 给的顺序**，文字用 `name`
（不改写）；强调哪个**看 `kind` 不看位置**——`kind` 以 `reject` 开头的是否定项，
默认强调肯定项，`_meta.permission.defaultToNo === true` 时整个反过来。
`options` 是 agent 自描述的一部分，**重排或补齐它等于伪造 agent 的意思**。

> **实测（仓内 ZCode adapter，真引擎跑一轮写文件抓到的原文）**：
> 它的权限请求**没有 `_meta`**，只有 `sessionId` / `toolCall` / `options` 三项：
>
> ```json
> {
>   "sessionId": "zc-sess_3ab629ea-1b31-44b1-bf05-6a8a233b7af2",
>   "toolCall": {
>     "toolCallId": "call_6f5c3414bd9c41dfbbc230d8",
>     "kind": "edit",
>     "title": "Write: {\"file_path\": \"/tmp/pulpo-core-gaps-47110/ws/three.txt\", \"content\": \"a\\nb\\nc\\n\"}"
>   },
>   "options": [
>     { "optionId": "allow_once",   "name": "Allow once",   "kind": "allow_once" },
>     { "optionId": "allow_always", "name": "Always allow", "kind": "allow_always" },
>     { "optionId": "reject_once",  "name": "Reject",       "kind": "reject_once" }
>   ]
> }
> ```
>
> 所以 `_meta` 是**可选**的：UI 必须在它缺失时正常工作（不显示授权范围说明、
> 按默认规则强调肯定项），不能因为读不到 `_meta.permission` 就渲染不出卡片。

#### `elicitation/respond`

参数 `{ "requestId": string, "action": "accept"|"decline"|"cancel", "content"?: any }`。
返回 `{ "ok": true }`。请求已结算时报 `-32004`，`action` 非法报 `-32602`。

`action: "accept"` 时 `content` **原样**回给 agent（ACP elicitation 的应答形状
`{action, content}`）——agent 问的是结构化问题，只回一个 optionId 答不全。
`decline` / `cancel` 不带内容。

> `permission/respond` 仍然能答 elicitation（老路径：`selected` → `accept` +
> `{optionId}`，`cancelled` → `decline`），但新客户端请用这个方法。
> 没人答时到点按 `decline` 结算。

---

### 4.12 回合级文件改动（审查 / 撤销）

回合开始时，core 用一个**临时 index** 给工作区拍一棵 git 树
（`GIT_INDEX_FILE=<tmp> git add -A` → `git write-tree`），只记那个 40 位
tree hash；对象本体在**用户仓库自己的 `.git/objects`** 里。
pulpo 一个字节的文件内容都不存——仍然是零副本。

- 快照拍在 **prompt 发出去之前**（晚一毫秒都可能漏掉第一个写入）；
- cwd 不在 git 仓库里就不拍，descriptor 的 `revert` 如实标
  `{"supported":"unavailable","kind":"none","reason":"notGitRepo"}`，
  两个方法也如实回不可用——**绝不假装能撤销**；
- `.gitignore` 照常生效（`node_modules` 之类不进快照）。
  实测成本：在 pulpo 仓库本身（含 node_modules）拍一棵树 **首次 216ms、
  之后 56–57ms**；集成测试的小工作区 **28–36ms**。

> ZCode 引擎自己有 checkpoint / rewind（`v4/conversation/fileRewindPreview`、
> `rewind.triggered`）。那是 agent 的原生能力，P1 接上后**优先于**这里的壳内
> git 快照。

#### `session/changes`
参数 `{ "sessionRef": string, "turnId"?: string, "all"?: boolean,
"paths"?: string[], "includeDiff"?: boolean }`。
`turnId` 缺省 = 该会话最近一个回合。

返回：
```jsonc
{
  "sessionRef":"zcode#zc-sess_…", "turnId":"28bcd085-…",
  "revert":"available",              // unavailable 时带 reason
  "files":[
    { "path":"three.txt","added":3,"removed":0,"status":"added",
      "afterBlob":"de98044…" },      // 回合结束时的 blob hash（撤销的安全线）
    { "path":"keep.txt", "added":1,"removed":1,"status":"modified","afterBlob":"c5213b1…" }
  ],
  "diff":"…",                        // 只在 includeDiff:true 时有
  "computedAt":1789…
}
```

- 路径相对**仓库根**；`status` 是 `added|modified|deleted`；
- **默认只算本回合工具碰过的路径**（`derived.changeStat` 的并集），
  `all: true` 才算整个工作区，`paths` 可以点名；
- 每次调用都**现拍一棵当前工作区的树**再比——所以它报的是**此刻**的差异：
  回合结束后人又手改了也会如实出现，不是回放。

#### `session/revert`
参数 `{ "sessionRef": string, "turnId"?: string, "paths"?: string[] }`。
不给 `paths` = 本回合改过的全部文件；`turnId` 缺省 = 最近一个回合。

返回 `{ "turnId", "reverted": string[], "skipped": [{ "path", "reason" }] }`。

做法：快照里有这个路径 → 用快照内容写回；快照里没有、现在有 = 本回合新建 → 删掉。

**两条安全线**（命中就跳过，绝不覆盖）：
- 当前文件内容的 blob hash **≠** 回合结束时记下的 `afterBlob`
  → `"当前文件已被外部修改（内容与本回合结束时不一致），不覆盖"`；
  文件被外部删掉同理；
- 本回合根本没碰过这个路径 → `"本回合没有改过这个文件，不动它"`。
  缺 `afterBlob`（回合结束时读不到）→ `"缺少 checkpoint…"`。

---

## 5. 通知

订阅之后从**同一条连接**收到，格式是标准 JSON-RPC 通知。

### `session/update`
```json
{"jsonrpc":"2.0","method":"session/update","params":{
  "sessionRef":"zcode#zc-sess_…", "agentId":"zcode", "sessionId":"zc-sess_…",
  "update": { "sessionUpdate":"agent_message_chunk", "content":{"type":"text","text":"收"} },
  "notification": { …agent 的原始通知… }
}}
```

`update` 原样就是 agent 的 ACP `SessionUpdate`，core **不改写**。常见取值：

| `sessionUpdate` | 内容 |
|---|---|
| `agent_message_chunk` | 正文逐 token，`content.text` |
| `agent_thought_chunk` | 思考逐 token |
| `tool_call` / `tool_call_update` | 工具卡（完整入参回参） |
| `current_mode_update` | 模式变了 |
| `config_option_update` | 模型 / 思考强度变了 |
| `available_commands_update` | 斜杠命令列表 |
| `usage_update` | 用量（实测 ZCode adapter 推 `{used, size, cost}`：已用上下文 / 上下文窗口 / 费用）。core 会把它聚合进 `TaskRecord.usage`（§4.9） |
| `subagent_spawned` / `subagent_state_update` | 原生子代理 |

#### 派生字段 `derived`（core 算的，不改 agent 原文）

同一条通知里除了 agent 的 `update` 原文，可能还有一个**旁路字段** `derived`。
这是 core 算出来的东西，**永远不进 `update`**——agent 的原文一个字节都不改写。

**`derived.changeStat`**：这次工具调用改了哪些文件、各自几加几减。

```jsonc
// 实测原文（真引擎跑一轮"写一个三行文件"抓到的）
{"jsonrpc":"2.0","method":"session/update","params":{
  "sessionRef":"zcode#zc-sess_0f4db185-f3d1-44b6-a805-cb94601374e8",
  "agentId":"zcode","sessionId":"zc-sess_0f4db185-f3d1-44b6-a805-cb94601374e8",
  "update":{
    "toolCallId":"zc-call_a1eb53e36b014b42a14c836b",
    "status":"completed",
    "content":[{"type":"content","content":{"type":"text",
      "text":"File created successfully at: /tmp/pulpo-core-gaps-38690/ws/three.txt …"}}],
    "sessionUpdate":"tool_call_update"},
  "notification":{ …agent 的原始通知… },
  "derived":{"changeStat":[
    {"path":"/tmp/pulpo-core-gaps-38690/ws/three.txt","added":3,"removed":0}]}
}}
```

怎么算的（两级兜底，都不需要 agent 配合）：

1. `content` 里有 `{type:"diff", path, oldText, newText}` 块 → 就地合成 unified diff
   再数（2 行上下文，封顶 8 文件 / 1200 行）。**只数 `+` / `-` 行**，
   不是 `newLines - oldLines`（那是净变化）；
2. 没有 diff 块 → 直接按工具入参数行：
   `Write → added=行数(content)`；`Edit → added=行数(new_string), removed=行数(old_string)`；
   `MultiEdit → 对 edits[] 累加`；`NotebookEdit → added=行数(new_source)`。
   路径取 `file_path | notebook_path | path | display_file_path` 第一个有值的，
   按路径去重（7 次 edit 落在 3 个路径上就是 3 个文件）。

**提交时机**：`tool_call`（入参到手）时只**暂存**，等对应的结算通知回来
（`status: "completed"` 且不是 error）才提交——所以 `derived.changeStat` 出现在
**结算那一条**通知上，失败的编辑一行都不算。
**两级都算不出就没有这个字段**，不会出现 `added: 0` 这种假数据。
派生字段不落盘（零副本）。

同样的字段也出现在 `read/transcript` 的 `parts[].tool.changeStat` 上（§4.8）。

#### 壳内合成事件：`turn_started` / `turn_finished`

回合边界走**同一条** `session/update` 订阅通道，但**不冒充 agent 的 update**：
这类通知**没有 `update` 字段**，只有 `derived.event`。客户端按
「有 `update` = agent 原文 / 有 `derived.event` = 壳内合成」区分。

```jsonc
// 实测原文
{"jsonrpc":"2.0","method":"session/update","params":{
  "sessionRef":"zcode#zc-sess_5a08a7a9-f206-4816-b632-aa302103d7d4",
  "agentId":"zcode","sessionId":"zc-sess_5a08a7a9-f206-4816-b632-aa302103d7d4",
  "derived":{"event":"turn_started",
             "turnId":"28bcd085-2a41-4612-80a0-354fd4c10f54",
             "startedAt":1789554265896}}}

{"jsonrpc":"2.0","method":"session/update","params":{
  "sessionRef":"zcode#zc-sess_5a08a7a9-f206-4816-b632-aa302103d7d4",
  "agentId":"zcode","sessionId":"zc-sess_5a08a7a9-f206-4816-b632-aa302103d7d4",
  "derived":{"event":"turn_finished",
             "turnId":"28bcd085-2a41-4612-80a0-354fd4c10f54",
             "startedAt":1789554265896,"endedAt":1789554301307,
             "stopReason":"end_turn",
             "changes":{"files":2,"added":4,"removed":1,"revert":"available"}}}}
```

- 凡是 core 代理的回合都发这两条（`session/prompt` / `task/delegate` /
  `delivery/send` 开的新回合），**所有订阅者**都收得到；
- `turn_finished.stopReason` 是 agent 给的；回合以异常告终时是 `"error"`
  并带 `error` 字段（原文），不吞；
- `turn_finished.changes` 是本回合的文件改动摘要，
  `{files, added, removed, revert}`，`revert: "unavailable"` 时带 `reason`。
  UI 的「文件改动汇总卡」直接用它，逐文件明细展开时再调 `session/changes`；
- `turn_finished` 在收尾快照拍完之后推，**可能比 `session/prompt` 的返回稍晚**
  （实测几十毫秒）。要等它就订阅，别假设它先于响应到达。

**子代理内容流的路由规矩**（ZCode 实测）：`subagent_spawned` 落在**父会话**的
`sessionRef` 上并带 `subagentSessionId`；而该子代理自己的正文 / 思考 / 工具卡落在
`sessionRef = <agentId>#<subagentSessionId>` 上。UI 按 `subagentSessionId` 关联路由。
core 收到 `subagent_spawned` 会自动把它登记成会话图里的 `native-subagent` 节点，
所以 `graph/tree` 里直接就有。

### `task/update`
params 就是完整的 `TaskRecord`（见 4.9）。任务每次状态变化推一条。

### `permission/requested`
```jsonc
{"jsonrpc":"2.0","method":"permission/requested","params":{
  "requestId":"uuid",
  "sessionRef":"zcode#…",
  "agentId":"zcode",
  "request": { …agent 的 session/request_permission 原始参数，含 toolCall… },
  "options": [ { "optionId":"…", "name":"允许一次", "kind":"allow_once" },
               { "optionId":"…", "name":"拒绝",     "kind":"reject_once" } ],
  "createdAt":1789…, "expiresAt":1789…
}}
```
`kind` 取值：`allow_once` / `allow_always` / `reject_once` / `reject_always`。
渲染成审批卡片，用户点了之后用 `requestId` + `optionId` 调 `permission/respond`。
`expiresAt` 到点还没人答，core 自己按默认拒绝结算。

### `elicitation/requested`
```json
{"jsonrpc":"2.0","method":"elicitation/requested","params":{
  "requestId":"uuid","sessionRef":"zcode#…","agentId":"zcode",
  "params":{ …agent 的原始参数… },
  "createdAt":1789…, "expiresAt":1789… }}
```
agent 反过来问用户。用 `elicitation/respond`（§4.11）带 `requestId` 应答，
`accept` 时 `content` 原样回给 agent。没人答就到点按 `decline` 结算。
`permission/pending` 里也看得到这些请求（`kind: "elicitation"`）。

### `agent/exit`
```json
{"jsonrpc":"2.0","method":"agent/exit","params":{"agentId":"zcode","code":0,"signal":null}}
```
该 agent 进程上的会话会一并从 `session/open` 里消失。

---

## 6. 错误码

| 码 | 名称 | 含义 |
|---|---|---|
| `-32700` | ParseError | JSON 解析失败 |
| `-32600` | InvalidRequest | 不是合法的 JSON-RPC 2.0 消息 |
| `-32601` | MethodNotFound | 未知方法 |
| `-32602` | InvalidParams | 参数不合法（缺字段、类型不对、模型/effort 目标不认识…） |
| `-32603` | InternalError | core 内部错误 |
| `-32000` | AgentError | agent 侧失败，原始错误在 `data.cause`，`data.agentId` / `data.method` 说明出处 |
| `-32001` | NotFound | 没有这条会话 / 任务 / 图节点；或 agent 进程已退出 |
| `-32002` | Unsupported | agent 不具备该能力（descriptor 说不支持，或 agent 回 -32601） |
| `-32003` | RecursionBlocked | 一层熔断，见下 |
| `-32004` | ApprovalTimeout | 审批请求已经结算过了（超时或被别人答了） |
| `-32005` | ShuttingDown | daemon 正在关停 |

### 一层熔断（`-32003`）

被派活的会话再往外派活会被拒。判据：该 `sessionRef` 出现在某条 `delegate` 边的
**child** 位置。

```json
{"jsonrpc":"2.0","id":9,"error":{
  "code":-32003,
  "message":"recursion blocked (one-level dispatch only)",
  "data":{"legacyExitCode":3,"sessionRef":"zcode#child"}}}
```

`message` 与 `data.legacyExitCode` 保留 exit code 3 这一既有语义，不变。
熔断状态跟着会话图落盘，daemon 重启后仍然生效。

> agent **自己的原生 subagent 不受此限**——默认允许、只观测、不劫持。
> 一层熔断只管 pulpo 的跨 agent 派活链。

---

## 7. 状态与存储

`$PULPO_HOME` 下只有**薄状态**，丢了可以从各 agent 的原生 `session/list` 重建：

| 文件 | 内容 |
|---|---|
| `state/session-graph.json` | 会话图：节点（只有位置）、三类边、native subagent 父子关系 |
| `state/tasks.json` | 任务登记：状态、结论、用量、native session 位置 |
| `state/turns.json` | 回合快照账本（§4.12）：**只有 git tree hash / blob hash / 加减行数**，没有任何文件内容 |
| `state/descriptors.json` | 各 agent 最近一次的**自描述**（descriptor + 它的原文），供无会话时应答 `agent/descriptor`。不是权威表：新的自描述一到就整条覆盖 |
| `run/core.sock` | unix socket（权限 0600，daemon 退出时删掉） |

**这里没有、也不会有任何会话消息副本**。会话正文的唯一事实源是各 agent 的原生存储，
core 只读穿。

daemon 启动时发现残留的 socket 文件会先探一下：探得通说明已有 daemon 在跑（报错，
不抢）；探不通就是上次崩溃留下的，直接删掉重新监听。

---

## 8. 两个完整例子

### 8.1 开一条会话、跑一轮、看流

```jsonc
// → 订阅
{"jsonrpc":"2.0","id":1,"method":"subscribe","params":{"topics":["session/update"]}}
// ← {"jsonrpc":"2.0","id":1,"result":{"subscribed":["session/update"]}}

// → 开会话
{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"agentId":"zcode","cwd":"/tmp/ws"}}
// ← {"jsonrpc":"2.0","id":2,"result":{"sessionRef":"zcode#zc-sess_ab…","descriptor":{…},…}}

// → 切模型与思考强度（configId 来自 raw.newSession.configOptions）
{"jsonrpc":"2.0","id":3,"method":"session/set_config_option",
 "params":{"sessionRef":"zcode#zc-sess_ab…","configId":"reasoning_effort","value":"high"}}

// → 发一轮（这个请求要等整轮跑完）
{"jsonrpc":"2.0","id":4,"method":"session/prompt",
 "params":{"sessionRef":"zcode#zc-sess_ab…","text":"改一下 README"}}

// ← 回合边界（壳内合成，没有 update 字段）
{"jsonrpc":"2.0","method":"session/update","params":{"sessionRef":"zcode#zc-sess_ab…",
  "derived":{"event":"turn_started","turnId":"28bcd085-…","startedAt":1789…}}}

// ← 期间源源不断的通知
{"jsonrpc":"2.0","method":"session/update","params":{"sessionRef":"zcode#zc-sess_ab…",
  "update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"先看看…"}}}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionRef":"zcode#zc-sess_ab…",
  "update":{"sessionUpdate":"tool_call","toolCallId":"call_1","title":"Read","status":"pending"}}}

// ← 可能插进来的审批
{"jsonrpc":"2.0","method":"permission/requested","params":{
  "requestId":"7f1e…","sessionRef":"zcode#zc-sess_ab…","agentId":"zcode",
  "options":[{"optionId":"o1","name":"允许一次","kind":"allow_once"},
             {"optionId":"o2","name":"拒绝","kind":"reject_once"}],"request":{…}}}

// → 用户点了"允许一次"
{"jsonrpc":"2.0","id":5,"method":"permission/respond",
 "params":{"requestId":"7f1e…","outcome":"selected","optionId":"o1"}}

// ← 工具结算的那一条带派生统计（agent 原文不变）
{"jsonrpc":"2.0","method":"session/update","params":{"sessionRef":"zcode#zc-sess_ab…",
  "update":{"sessionUpdate":"tool_call_update","toolCallId":"call_2","status":"completed"},
  "derived":{"changeStat":[{"path":"/tmp/ws/README.md","added":3,"removed":1}]}}}

// ← 最后 id=4 才返回
{"jsonrpc":"2.0","id":4,"result":{"stopReason":"end_turn"}}

// ← 回合结束（自带改动摘要，可能比上面的响应稍晚几十毫秒）
{"jsonrpc":"2.0","method":"session/update","params":{"sessionRef":"zcode#zc-sess_ab…",
  "derived":{"event":"turn_finished","turnId":"28bcd085-…","stopReason":"end_turn",
             "endedAt":1789…,"changes":{"files":1,"added":3,"removed":1,"revert":"available"}}}}

// → 审查这一轮改了什么（逐文件明细）
{"jsonrpc":"2.0","id":6,"method":"session/changes",
 "params":{"sessionRef":"zcode#zc-sess_ab…","turnId":"28bcd085-…"}}

// → 不满意就整轮撤销（人手改过的文件会被跳过并说明原因）
{"jsonrpc":"2.0","id":7,"method":"session/revert",
 "params":{"sessionRef":"zcode#zc-sess_ab…","turnId":"28bcd085-…"}}
// ← {"jsonrpc":"2.0","id":7,"result":{"turnId":"28bcd085-…",
//      "reverted":["README.md"],"skipped":[]}}
```

### 8.2 派活 + 补充消息 + 看轨迹

```jsonc
// → 派活（带模型与思考强度）。companion 必须带 callerRef；人派活不带。
{"jsonrpc":"2.0","id":10,"method":"task/delegate","params":{
  "agentId":"zcode","task":"把 utils 里的重复代码合并掉","cwd":"/repo",
  "modelId":"Coding Plan/glm-5.3-flash","effort":"high",
  "callerRef":"zcode#zc-sess_parent"}}
// ← {"jsonrpc":"2.0","id":10,"result":{
//      "taskId":"1b2c…","sessionRef":"zcode#zc-sess_child","capabilityRef":{…}}}

// ← 状态推送
{"jsonrpc":"2.0","method":"task/update","params":{"taskId":"1b2c…","status":"running",…}}

// → 跑到一半补一句（走投递阶梯）
{"jsonrpc":"2.0","id":11,"method":"task/send_input","params":{
  "taskId":"1b2c…","message":"顺便把 test 也跟着改","attribution":"来自派活方 agent zcode"}}
// ← 回执如实：走到了扩展档（`_session/steering`），目标在当前回合里收下了
// {"jsonrpc":"2.0","id":11,"result":{"outcome":"injected","tier":"extension",
//   "requestedTier":"extension",
//   "attempts":[{"tier":"extension","status":"ok"}],
//   "turnActive":true,…}}

// ← 跑完
{"jsonrpc":"2.0","method":"task/update","params":{
  "taskId":"1b2c…","status":"done","stopReason":"end_turn","summary":"合并了 3 处…"}}

// → 右栏画轨迹树
{"jsonrpc":"2.0","id":12,"method":"graph/tree","params":{"sessionRef":"zcode#zc-sess_parent"}}

// → 要子会话全文就读穿（注意去掉 adapter 的 zc- 前缀）
{"jsonrpc":"2.0","id":13,"method":"read/transcript","params":{
  "agentId":"zcode","sessionId":"sess_child","cwd":"/repo"}}

// → 被派活的会话想再往外派 → 熔断
{"jsonrpc":"2.0","id":14,"method":"task/delegate","params":{
  "agentId":"zcode","task":"再派一层","cwd":"/repo","callerRef":"zcode#zc-sess_child"}}
// ← {"jsonrpc":"2.0","id":14,"error":{"code":-32003,
//     "message":"recursion blocked (one-level dispatch only)",
//     "data":{"legacyExitCode":3,"sessionRef":"zcode#zc-sess_child"}}}
```
