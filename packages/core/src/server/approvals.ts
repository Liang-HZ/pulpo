import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { SessionRef } from "../acp/kernel.js";

/**
 * 审批通道。
 *
 * pulpo 本身就是 ACP client，`session/request_permission` 天然到壳内——
 * 这里把它转成 socket 通知 `permission/requested`，等客户端 `permission/respond`。
 *
 * **不自动放行**。没有客户端应答就等到超时，超时按**默认拒绝**结算：
 * 优先选 agent 给的 `reject_once` 选项，没有就回 ACP 的 `cancelled`。
 */

export interface PermissionOption {
  optionId: string;
  name?: string;
  kind?: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export interface PendingApproval {
  requestId: string;
  /**
   * `permission` = agent 请求授权（`session/request_permission`）；
   * `elicitation` = agent 反过来问用户（`elicitation/create`）。
   * 两者走同一个等待/超时机制，但应答方法和应答形状不同（见 PROTOCOL §4.11）。
   */
  kind: "permission" | "elicitation";
  sessionRef: SessionRef;
  agentId: string;
  /** agent 原样给的 `session/request_permission` 参数（含 toolCall 与 options）。 */
  request: unknown;
  options: PermissionOption[];
  createdAt: number;
  expiresAt: number;
}

export type ApprovalDecision =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" }
  /**
   * elicitation 的应答。`content` 原样回给 agent——
   * agent 问的是结构化问题，只回一个 optionId 是答不全的。
   */
  | { outcome: "elicit"; action: "accept" | "decline" | "cancel"; content?: unknown };

/** 上层可设的自动策略。默认没有策略 = 一律转给客户端人工审批。 */
export type ApprovalPolicy = (
  approval: PendingApproval,
) => ApprovalDecision | null | undefined;

export class ApprovalHub extends EventEmitter {
  private readonly pending = new Map<string, {
    approval: PendingApproval;
    settle: (d: ApprovalDecision) => void;
    timer: NodeJS.Timeout;
  }>();

  /** 默认超时 5 分钟。到点按默认拒绝结算。 */
  constructor(private readonly opts: { timeoutMs?: number; policy?: ApprovalPolicy } = {}) {
    super();
  }

  get timeoutMs(): number {
    return this.opts.timeoutMs ?? 300_000;
  }

  list(): PendingApproval[] {
    return [...this.pending.values()].map((p) => ({ ...p.approval }));
  }

  /**
   * 接住一条 agent 的权限请求。返回 ACP 的 `RequestPermissionResponse`。
   * 有策略先问策略；策略不表态就发通知等人。
   */
  async request(params: {
    sessionRef: SessionRef;
    agentId: string;
    request: unknown;
    kind?: "permission" | "elicitation";
  }): Promise<{ outcome: ApprovalDecision }> {
    const raw = (params.request ?? {}) as { options?: PermissionOption[] };
    const approval: PendingApproval = {
      requestId: randomUUID(),
      kind: params.kind ?? "permission",
      sessionRef: params.sessionRef,
      agentId: params.agentId,
      request: params.request,
      options: Array.isArray(raw.options) ? raw.options : [],
      createdAt: Date.now(),
      expiresAt: Date.now() + this.timeoutMs,
    };

    const policyDecision = this.opts.policy?.(approval);
    if (policyDecision) {
      this.emit("settled", { approval, decision: policyDecision, by: "policy" });
      return { outcome: policyDecision };
    }

    const decision = await new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(approval.requestId)) {
          const fallback = defaultDeny(approval.options);
          this.emit("settled", { approval, decision: fallback, by: "timeout" });
          this.emit("expired", { ...approval });
          resolve(fallback);
        }
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(approval.requestId, { approval, settle: resolve, timer });
      this.emit(approval.kind === "elicitation" ? "elicitation_requested" : "requested", {
        ...approval,
      });
    });
    return { outcome: decision };
  }

  /** 客户端应答。requestId 不存在（已超时/已结算）时返回 false。 */
  respond(requestId: string, decision: ApprovalDecision): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.settle(decision);
    this.emit("settled", { approval: entry.approval, decision, by: "client" });
    return true;
  }

  /** 会话被取消时，把挂着的权限请求一律按取消结算（ACP 的要求）。 */
  cancelForSession(sessionRef: SessionRef): number {
    let n = 0;
    for (const [id, entry] of [...this.pending]) {
      if (entry.approval.sessionRef !== sessionRef) continue;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.settle({ outcome: "cancelled" });
      this.emit("settled", { approval: entry.approval, decision: { outcome: "cancelled" }, by: "cancel" });
      n++;
    }
    return n;
  }

  /** daemon 关停：全部按取消结算，不留悬挂请求。 */
  shutdown(): void {
    for (const [id, entry] of [...this.pending]) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.settle({ outcome: "cancelled" });
    }
  }
}

/** 默认拒绝：优先用 agent 自己给的拒绝选项，没有就回 ACP 的 cancelled。 */
export function defaultDeny(options: PermissionOption[]): ApprovalDecision {
  const reject =
    options.find((o) => o.kind === "reject_once") ??
    options.find((o) => o.kind === "reject_always");
  return reject ? { outcome: "selected", optionId: reject.optionId } : { outcome: "cancelled" };
}
