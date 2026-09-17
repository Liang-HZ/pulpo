import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CoreClient, resolveCoreAddress } from "./coreClient.js";
import { createCompanionServer } from "./server.js";

/**
 * companion 的入口：stdio MCP 服务器。
 *
 * 被 core 作为 MCP server 注入进各 agent 的会话（`session/new` 的 mcpServers），
 * 也可以由人手工挂到任意 MCP 客户端上——那时没有会话身份，回执里标
 * `caller: "human"`，不受一层熔断限制。
 *
 * stdout 只属于 MCP 协议，任何日志都往 stderr。
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stderr.write(
      [
        "pulpo-companion —— pulpo 的 MCP 伴生（跨渠道派活四件套）",
        "",
        "用法：pulpo-companion            （stdio MCP 服务器，由 MCP 客户端拉起）",
        "",
        "环境变量：",
        "  PULPO_HOME           core 的状态根目录（默认 ~/.pulpo），socket 取 $PULPO_HOME/run/core.sock",
        "  PULPO_SOCKET         整条覆盖 core 的 unix socket 路径",
        "  PULPO_CORE_WS        core 的 WebSocket 端口（socket 不可用时的回落）",
        "  PULPO_SESSION_REF    companion 所在会话的 sessionRef（一层熔断的判据）",
        "  PULPO_SESSION_TOKEN  core 注入时给的一次性令牌，用 companion/identify 换 sessionRef",
        "  PULPO_DEFAULT_CWD    派活时 working_dir 的兜底值",
        "",
      ].join("\n"),
    );
    return;
  }
  const client = new CoreClient(resolveCoreAddress(process.env));
  const server = createCompanionServer({ client, env: process.env });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `pulpo-companion ${process.pid} 已就绪，core=${client.describeAddress}，` +
      `session=${process.env.PULPO_SESSION_REF ?? process.env.PULPO_SESSION_TOKEN ?? "(human)"}\n`,
  );
  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
    process.stdin.on("close", () => resolve());
  });
  client.close();
}
