# @liangai/pulpo-core

The orchestration daemon behind [pulpo](https://github.com/Liang-HZ/pulpo) — a desktop shell that
brings several coding-agent channels (Qoder, WorkBuddy, WorkBuddy AI, Claude, Codex, opencode,
ZCode) under one interface. It only translates protocols: it never proxies a model API, never holds
an API key, and never keeps a copy of a session (each agent's own store stays the single source of
truth).

`@liangai/pulpo-core` is the process that speaks **ACP** (Agent Client Protocol): it starts each channel's
agent, holds its sessions, reads capability descriptors from the agent's own handshake, keeps a thin
session graph, reads transcripts through from native storage, picks a delivery tier for follow-up
messages, and brokers one-level cross-channel delegation. Everything is exposed over a single
JSON-RPC 2.0 method table.

## Contract

[`PROTOCOL.md`](./PROTOCOL.md) ships with this package and is the complete contract: transports,
the full method table, notifications, error codes and worked examples. It is the only document a
client needs.

## Install

```bash
npm i -g @liangai/pulpo-core        # the `pulpo-core` daemon + CLI
npm i @liangai/pulpo-core           # ...or as a library
```

## Run

```bash
pulpo-core                      # unix socket + ws://127.0.0.1:27183 (loopback only)
pulpo-core --ws-port 0          # random free port
pulpo-core --no-ws              # unix socket only
pulpo-core --help
```

| Environment variable | Meaning |
|---|---|
| `PULPO_HOME` | state and runtime root, default `~/.pulpo` |
| `PULPO_SOCKET` | full override of the unix socket path |
| `PULPO_WS_PORT` | WebSocket port, `0` = random free port |
| `PULPO_ZCODE_ACP` | path to the ZCode ACP adapter |
| `PULPO_COMPANION` / `PULPO_COMPANION_BIN` | turn companion injection off / point at its bin |

## Library

The daemon is also usable as a library — the package exports the kernel, descriptor, graph, read,
delivery, broker and server modules:

```js
import { PulpoDaemon } from "@liangai/pulpo-core";

const daemon = new PulpoDaemon({ version: "0.1.1" });
const addr = await daemon.start();
```

## License

Apache-2.0 — see [LICENSE](https://github.com/Liang-HZ/pulpo/blob/main/LICENSE).
