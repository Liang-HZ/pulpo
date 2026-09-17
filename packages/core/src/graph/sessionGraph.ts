import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ensureDir, stateDir } from "../paths.js";
import type { DeliveryOutcome, DeliveryTier } from "../descriptor/types.js";
import type { SessionRef } from "../acp/kernel.js";

/**
 * 会话图。
 *
 * **节点不存内容**——节点只记"这条会话在哪个 agent 的哪个原生 id 下"，
 * 正文一律由读取层读穿原生存储。所以这里存的全是薄状态：丢了可以从
 * 各 agent 的原生 `session/list` + 本地任务登记重建。
 */

export type NodeKind = "root" | "delegation-child" | "native-subagent";
export type EdgeKind = "delegate" | "supplement" | "result";

export interface GraphNode {
  /** = sessionRef（`<agentId>#<sessionId>`）。原生 id 就是节点身份。 */
  id: SessionRef;
  kind: NodeKind;
  agentId: string;
  sessionId: string;
  cwd?: string;
  title?: string;
  createdAt: number;
  updatedAt: number;
}

/** 人从壳里派活时，delegate 边的 from 落在这个伪节点上。 */
export const HUMAN_NODE: SessionRef = "human";

export interface DelegateEdge {
  id: string;
  kind: "delegate";
  from: SessionRef;
  to: SessionRef;
  /**
   * 谁发起的这次派活。
   *  - `agent`：companion 从某条 agent 会话里派的 → 目标受一层熔断约束；
   *  - `human`：人从壳里派的 → **不构成熔断关系**，目标自己还能再派
   *    （一层熔断只管 agent 之间）。
   * 老数据没有这个字段，一律按 `agent` 解释（保守）。
   */
  via?: "human" | "agent";
  taskId: string;
  modelId?: string;
  effort?: string;
  task: string;
  createdAt: number;
}

export interface SupplementEdge {
  id: string;
  kind: "supplement";
  from: SessionRef | null;
  to: SessionRef;
  /** 实际走的档位；unsupported 时为 null。 */
  tier: DeliveryTier | null;
  outcome: DeliveryOutcome;
  /** 归属标注：补充消息写入目标会话时标的来源。 */
  attribution?: string;
  createdAt: number;
}

export interface ResultEdge {
  id: string;
  kind: "result";
  from: SessionRef;
  to: SessionRef;
  taskId: string;
  status: "done" | "failed" | "cancelled";
  /** 只报结论与 native session 位置，不存转录。 */
  summary?: string;
  nativeSessionRef: SessionRef;
  createdAt: number;
}

export type GraphEdge = DelegateEdge | SupplementEdge | ResultEdge;

interface GraphFile {
  version: 1;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** native subagent → 父会话。也是薄状态（从原生会话流可重建）。 */
  subagentParents: [SessionRef, SessionRef][];
}

const EMPTY: GraphFile = { version: 1, nodes: [], edges: [], subagentParents: [] };

export class SessionGraph {
  private nodes = new Map<SessionRef, GraphNode>();
  private edges: GraphEdge[] = [];
  /** native subagent → 父会话。读取层/会话流发现 subagent 时登记。 */
  private subagentParents = new Map<SessionRef, SessionRef>();
  private readonly file: string;
  private dirty = false;

  constructor(opts: { env?: NodeJS.ProcessEnv; file?: string } = {}) {
    this.file = opts.file ?? path.join(stateDir(opts.env ?? process.env), "session-graph.json");
    this.load();
  }

  get filePath(): string {
    return this.file;
  }

  private load(): void {
    let parsed: GraphFile = EMPTY;
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const j = JSON.parse(raw) as GraphFile;
      if (j && j.version === 1 && Array.isArray(j.nodes) && Array.isArray(j.edges)) parsed = j;
    } catch {
      // 文件不存在 / 坏了都当空图——薄状态可重建，不为它挂掉 daemon。
      parsed = EMPTY;
    }
    this.nodes = new Map(parsed.nodes.map((n) => [n.id, n]));
    this.edges = [...parsed.edges];
    this.subagentParents = new Map(parsed.subagentParents ?? []);
  }

  /** 原子落盘（先写临时文件再 rename）。 */
  save(): void {
    if (!this.dirty) return;
    ensureDir(path.dirname(this.file));
    const payload: GraphFile = {
      version: 1,
      nodes: [...this.nodes.values()],
      edges: this.edges,
      subagentParents: [...this.subagentParents.entries()],
    };
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.dirty = false;
  }

  upsertNode(node: Omit<GraphNode, "createdAt" | "updatedAt"> & Partial<Pick<GraphNode, "createdAt">>): GraphNode {
    const now = Date.now();
    const prev = this.nodes.get(node.id);
    const merged: GraphNode = {
      ...prev,
      ...node,
      createdAt: prev?.createdAt ?? node.createdAt ?? now,
      updatedAt: now,
    };
    this.nodes.set(merged.id, merged);
    this.dirty = true;
    return merged;
  }

  getNode(id: SessionRef): GraphNode | undefined {
    return this.nodes.get(id);
  }

  listNodes(): GraphNode[] {
    return [...this.nodes.values()];
  }

  addDelegate(e: Omit<DelegateEdge, "id" | "kind" | "createdAt">): DelegateEdge {
    const edge: DelegateEdge = { ...e, id: randomUUID(), kind: "delegate", createdAt: Date.now() };
    this.edges.push(edge);
    this.dirty = true;
    return edge;
  }

  addSupplement(e: Omit<SupplementEdge, "id" | "kind" | "createdAt">): SupplementEdge {
    const edge: SupplementEdge = { ...e, id: randomUUID(), kind: "supplement", createdAt: Date.now() };
    this.edges.push(edge);
    this.dirty = true;
    return edge;
  }

  addResult(e: Omit<ResultEdge, "id" | "kind" | "createdAt">): ResultEdge {
    const edge: ResultEdge = { ...e, id: randomUUID(), kind: "result", createdAt: Date.now() };
    this.edges.push(edge);
    this.dirty = true;
    return edge;
  }

  listEdges(filter?: { kind?: EdgeKind; from?: SessionRef; to?: SessionRef; taskId?: string }): GraphEdge[] {
    return this.edges.filter((e) => {
      if (filter?.kind && e.kind !== filter.kind) return false;
      if (filter?.from && e.from !== filter.from) return false;
      if (filter?.to && e.to !== filter.to) return false;
      if (filter?.taskId && (e as { taskId?: string }).taskId !== filter.taskId) return false;
      return true;
    });
  }

  /**
   * 一层熔断的判据：这条会话是不是某条 delegate 边的 **child**（被派活方）。
   * 是的话，它再往外派活就要被拒。
   */
  isDelegationChild(ref: SessionRef): boolean {
    return this.edges.some(
      (e) => e.kind === "delegate" && e.to === ref && (e.via ?? "agent") === "agent",
    );
  }

  /** 某条会话派出去的所有子会话。 */
  childrenOf(ref: SessionRef): DelegateEdge[] {
    return this.edges.filter((e): e is DelegateEdge => e.kind === "delegate" && e.from === ref);
  }

  /**
   * 轨迹树：以 `root` 为根，向下展开 delegate 子会话与 native subagent 节点。
   * 只给结构与位置，正文由调用方按需读穿。
   */
  tree(root: SessionRef): TreeNode | null {
    const node = this.nodes.get(root);
    if (!node) return null;
    const seen = new Set<SessionRef>();
    const build = (id: SessionRef): TreeNode | null => {
      if (seen.has(id)) return null; // 防环
      seen.add(id);
      const n = this.nodes.get(id);
      if (!n) return null;
      const children: TreeNode[] = [];
      for (const e of this.edges) {
        if (e.kind === "delegate" && e.from === id) {
          const c = build(e.to);
          if (c) children.push({ ...c, viaTaskId: e.taskId, modelId: e.modelId, effort: e.effort });
        }
      }
      // native subagent：读取层发现后 upsert 成节点，父子关系记在 parentRef 上。
      for (const n2 of this.nodes.values()) {
        if (n2.kind === "native-subagent" && n2.id.startsWith(`${n.agentId}#`)) {
          const parent = this.subagentParents.get(n2.id);
          if (parent === id) {
            const c = build(n2.id);
            if (c) children.push(c);
          }
        }
      }
      return { ...n, children };
    };
    return build(root);
  }

  registerNativeSubagent(parent: SessionRef, child: SessionRef, opts: { agentId: string; sessionId: string; title?: string }): GraphNode {
    this.subagentParents.set(child, parent);
    this.dirty = true;
    return this.upsertNode({
      id: child,
      kind: "native-subagent",
      agentId: opts.agentId,
      sessionId: opts.sessionId,
      title: opts.title,
    });
  }

  parentOfSubagent(child: SessionRef): SessionRef | undefined {
    return this.subagentParents.get(child);
  }
}

export interface TreeNode extends GraphNode {
  children: TreeNode[];
  viaTaskId?: string;
  modelId?: string;
  effort?: string;
}
