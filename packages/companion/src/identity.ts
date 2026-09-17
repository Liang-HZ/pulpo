import type { CoreClient } from "./coreClient.js";

/**
 * 调用方身份。
 *
 * companion 被 core 注入进某条会话时，core 会在它的环境里放一个**一次性
 * 令牌**（`PULPO_SESSION_TOKEN`）：注入发生在 `session/new` 请求发出之前，
 * 那时会话 id 还不存在，所以塞不进 `PULPO_SESSION_REF`；core 在拿到
 * sessionId 之后把令牌登记成 `token → sessionRef`，companion 第一次用到身份时
 * 用 `companion/identify` 换。
 *
 * 环境里直接给了 `PULPO_SESSION_REF` 时以它为准（人工接线、测试用这条）。
 * 两者都没有 = 人直接开的 companion：允许派活，但回执里标 `caller: "human"`。
 */
export type Caller =
  | { kind: "agent"; sessionRef: string; agentId: string; cwd?: string }
  | { kind: "human" };

export function callerAgentId(caller: Caller): string {
  if (caller.kind === "human") return "human";
  return caller.agentId;
}

/** 归属标注：补充消息写进目标会话时，原生端看得见来源。 */
export function attributionFor(caller: Caller): string {
  return caller.kind === "agent"
    ? `来自派活方 ${caller.agentId}:${caller.sessionRef}`
    : "来自派活方 human:直接调用 companion";
}

export interface IdentityOptions {
  env: NodeJS.ProcessEnv;
  client: CoreClient;
  /** 令牌换 sessionRef 的等待上限：注入与 session/new 应答之间有个窗口。 */
  identifyTimeoutMs?: number;
}

export class CallerIdentity {
  private cached: Caller | null = null;

  constructor(private readonly opts: IdentityOptions) {}

  /** 同步可得的部分：只看环境变量，不连 core。单测用这条。 */
  get declared(): { sessionRef?: string; token?: string } {
    const sessionRef = this.opts.env.PULPO_SESSION_REF?.trim();
    const token = this.opts.env.PULPO_SESSION_TOKEN?.trim();
    return {
      ...(sessionRef ? { sessionRef } : {}),
      ...(token ? { token } : {}),
    };
  }

  async resolve(): Promise<Caller> {
    if (this.cached) return this.cached;
    const { sessionRef, token } = this.declared;
    if (sessionRef) {
      const i = sessionRef.indexOf("#");
      if (i <= 0) {
        throw new Error(
          `PULPO_SESSION_REF 格式错误：${sessionRef}（应为 <agentId>#<sessionId>）`,
        );
      }
      this.cached = { kind: "agent", sessionRef, agentId: sessionRef.slice(0, i) };
      return this.cached;
    }
    if (token) {
      const res = await this.opts.client.call<{
        sessionRef: string;
        agentId: string;
        cwd?: string;
      }>("companion/identify", { token }, this.opts.identifyTimeoutMs ?? 30_000);
      this.cached = {
        kind: "agent",
        sessionRef: res.sessionRef,
        agentId: res.agentId,
        ...(res.cwd ? { cwd: res.cwd } : {}),
      };
      return this.cached;
    }
    this.cached = { kind: "human" };
    return this.cached;
  }
}
