import { PulpoDaemon } from "./server/daemon.js";
import { socketPath, wsPort } from "./paths.js";

const VERSION = "0.1.1";

function usage(): string {
  return [
    "pulpo-core — pulpo 编排核心 daemon",
    "",
    "用法：pulpo-core [选项]",
    "",
    "  --socket <path>   unix socket 路径（默认 $PULPO_HOME/run/core.sock）",
    "  --no-socket       不开 unix socket",
    "  --ws-port <n>     WebSocket 端口，只绑 127.0.0.1（默认 27183；0 = 随机空闲端口）",
    "  --no-ws           不开 WebSocket",
    "  --quiet           不打日志",
    "  -h, --help        本帮助",
    "",
    "环境变量：",
    "  PULPO_HOME        状态与运行目录根（默认 ~/.pulpo）",
    "  PULPO_SOCKET      整条覆盖 unix socket 路径",
    "  PULPO_WS_PORT     WebSocket 端口",
    "  PULPO_ZCODE_ACP   ZCode adapter 可执行文件路径",
    "",
    "协议见 PROTOCOL.md。",
  ].join("\n");
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  let sock: string | null | undefined;
  let ws: number | null | undefined;
  let quiet = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-h":
      case "--help":
        process.stdout.write(`${usage()}\n`);
        return;
      case "--socket":
        sock = argv[++i];
        break;
      case "--no-socket":
        sock = null;
        break;
      case "--ws-port":
        ws = Number.parseInt(argv[++i] ?? "", 10);
        if (!Number.isInteger(ws)) throw new Error("--ws-port 要一个整数");
        break;
      case "--no-ws":
        ws = null;
        break;
      case "--quiet":
        quiet = true;
        break;
      default:
        throw new Error(`未知参数：${a}（--help 看用法）`);
    }
  }

  const daemon = new PulpoDaemon({
    version: VERSION,
    ...(sock === undefined ? {} : { socketPath: sock }),
    ...(ws === undefined ? {} : { wsPort: ws }),
    ...(quiet ? {} : { onLog: (line: string) => process.stderr.write(`${line}\n`) }),
  });

  const addr = await daemon.start();
  if (!quiet) {
    process.stderr.write(
      `pulpo-core ${VERSION} 就绪 pid=${process.pid} ` +
        `socket=${addr.socketPath ?? "(关)"} ws=${addr.wsPort ?? "(关)"}\n`,
    );
  }

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    void daemon.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export { socketPath, wsPort };
