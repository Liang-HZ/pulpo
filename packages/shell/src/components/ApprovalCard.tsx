// 审批卡片与追问。
//
// **壳内原生渲染，插在会话流里**——它是对话的一部分，不是浮层，也不弹系统对话框。
// pulpo 本身就是 ACP client，agent 的 `session/request_permission` 天然到壳内。
//
// core 不自动放行：没人应答就等到超时（默认 5 分钟），超时按默认拒绝结算。
// 所以剩余时间必须显示出来——用户得知道"不理它"的后果。

import { useEffect, useRef, useState } from "react";
import type { Approval } from "../lib/store";
import { AppStore } from "../lib/store";
import { clockTime, relativePath } from "../lib/format";
import { Icon } from "./Icon";
import { Button, Chip, Disclosure, Code, Field, inputClass } from "./ui";

const LIFETIME_LABEL: Record<string, string> = {
  session: "本会话",
  run: "本次运行",
  user: "写入用户设置",
  project: "写入项目设置",
  "project-local": "写入项目本地设置",
  persistent: "永久保存",
};

/** 摘要行按 toolCall.kind 生成，文案照 ZCode 的原文 */
function summarize(approval: Approval): string {
  const n = approval.files.length;
  switch (approval.toolKind) {
    case "edit":
      return n > 1 ? `编辑 ${n} 个文件` : n === 1 ? "编辑文件" : "编辑";
    case "delete":
      return n > 1 ? `删除 ${n} 个文件` : "删除";
    case "execute":
      return "执行命令";
    case "fetch":
      return "访问网络";
    default:
      return approval.title;
  }
}

function Countdown({ expiresAt }: { expiresAt: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  if (!expiresAt) return null;
  const left = Math.max(0, Math.round((expiresAt - now) / 1000));
  if (left > 30) return null;
  return (
    <span className="tabular text-caption text-warning">
      {left > 0 ? `${left} 秒后按拒绝结算` : "已超时，按拒绝处理"}
    </span>
  );
}

export function PermissionCard({ approval, store, cwd }: { approval: Approval; store: AppStore; cwd?: string | null }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [focus, setFocus] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const expired = approval.expiresAt !== null && approval.expiresAt <= Date.now();

  const options = approval.options;
  // 强调哪个**不看位置，看 kind**；`defaultToNo` 为真时整个反过来。
  // options 的顺序原样照 agent 给的——重排或补齐它等于伪造 agent 的意思。
  const defaultToNo = approval.meta?.defaultToNo === true;
  const wanted = (kind: string): boolean => {
    const isReject = kind.startsWith("reject");
    return defaultToNo ? isReject : !isReject;
  };
  // 整屏只有一个高饱和实心焦点：同向的选项里只强调**第一个**，其余走描边。
  const emphasisedId = options.find((o) => wanted(o.kind))?.optionId;
  const emphasise = (option: { optionId: string }): boolean => option.optionId === emphasisedId;

  const respond = async (optionId: string): Promise<void> => {
    setBusy(optionId);
    await store.respondApproval(approval, { outcome: "selected", optionId });
    setBusy(null);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      void store.respondApproval(approval, { outcome: "cancelled" });
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowRight") {
      e.preventDefault();
      setFocus((i) => (i + 1) % Math.max(1, options.length));
    }
    if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
      e.preventDefault();
      setFocus((i) => (i - 1 + options.length) % Math.max(1, options.length));
    }
  };

  useEffect(() => {
    const buttons = box.current?.querySelectorAll<HTMLButtonElement>("[data-option]");
    buttons?.[focus]?.focus();
  }, [focus]);

  return (
    <article
      data-testid="approval-card"
      ref={box}
      onKeyDown={onKeyDown}
      className={[
        "flex flex-col gap-2 rounded-lg border-l-2 border-warning bg-warning-surface p-3",
        expired ? "opacity-100 grayscale" : "",
      ].join(" ")}
    >
      <header className="flex items-center gap-2">
        <Icon name="alert-triangle" size={16} className="text-warning" />
        <span className="text-ui font-medium text-fg">需要权限</span>
        <Countdown expiresAt={approval.expiresAt} />
        <span className="flex-1" />
        {approval.queueDepth ? (
          <Chip variant="outline">+{approval.queueDepth} 排队中</Chip>
        ) : null}
        {approval.toolKind ? <Chip variant="outline">{approval.toolKind}</Chip> : null}
      </header>

      <p className="text-ui text-fg">{summarize(approval)}</p>

      {approval.files.length ? (
        <div className="flex flex-col gap-1">
          <p className="text-caption text-fg-muted">涉及文件</p>
          <div className="flex flex-wrap gap-1">
            {approval.files.slice(0, 5).map((path) => (
              <Chip key={path} variant="outline">
                {relativePath(path, cwd)}
              </Chip>
            ))}
            {approval.files.length > 5 ? (
              <Chip variant="neutral">+{approval.files.length - 5}</Chip>
            ) : null}
          </div>
        </div>
      ) : null}

      {approval.meta?.description ? (
        <p className="text-caption leading-relaxed text-fg-muted">{approval.meta.description}</p>
      ) : null}

      {approval.meta?.changes?.length ? (
        <ul className="flex flex-col gap-1">
          {approval.meta.changes.slice(0, 6).map((change, i) => (
            <li key={i} className="flex items-start gap-2 text-caption text-fg-muted">
              <Chip variant="outline">
                {LIFETIME_LABEL[change.lifetime?.scope ?? ""] ??
                  change.lifetime?.scope ??
                  "范围未说明"}
              </Chip>
              <span className="min-w-0 flex-1 leading-relaxed">{change.description}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {approval.rawInput ? (
        <Disclosure summary="完整参数">
          <Code>{JSON.stringify(approval.rawInput, null, 2)}</Code>
        </Disclosure>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <Button
            key={option.optionId}
            data-option=""
            size="lg"
            tone={
              emphasise(option)
                ? "primary"
                : option.kind.startsWith("reject")
                  ? "danger"
                  : "outline"
            }
            loading={busy === option.optionId}
            disabled={busy !== null && busy !== option.optionId}
            onClick={() => void respond(option.optionId)}
          >
            {option.name}
          </Button>
        ))}
      </div>
      <p className="text-caption text-fg-subtle">使用 Tab / 上下键选择，回车确认</p>
    </article>
  );
}

export function ElicitationCard({ approval, store }: { approval: Approval; store: AppStore }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const answerable = Boolean(approval.requestId);

  return (
    <article
      data-testid="elicitation-card"
      className="flex flex-col gap-2 rounded-lg border-l-2 border-brand bg-surface p-3"
    >
      <header className="flex items-center gap-2">
        <Icon name="brain" size={16} className="text-brand" />
        <span className="text-ui font-medium text-fg">agent 在问你</span>
      </header>
      <p className="text-body leading-relaxed text-fg">{approval.message ?? approval.title}</p>

      {approval.fields.map((field) => (
        <Field
          key={field.name}
          label={field.title}
          required={field.required}
          {...(field.description ? { help: field.description } : {})}
        >
          {({ id, describedBy }) => (
            <input
              id={id}
              aria-describedby={describedBy}
              value={values[field.name] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [field.name]: e.target.value }))}
              className={`${inputClass()} h-6`}
            />
          )}
        </Field>
      ))}

      <div className="flex flex-wrap gap-2">
        {approval.fields.length ? (
          <Button
            tone="primary"
            size="lg"
            loading={sending}
            disabled={!answerable}
            onClick={() => {
              setSending(true);
              void store.respondElicitation(approval, values).finally(() => setSending(false));
            }}
          >
            回答
          </Button>
        ) : null}
        {approval.options.map((option) => (
          <Button
            key={option.optionId}
            size="lg"
            tone={option.kind?.startsWith("reject") ? "danger" : "primary"}
            onClick={() =>
              void store.respondApproval(approval, {
                outcome: "selected",
                optionId: option.optionId,
              })
            }
          >
            {option.name}
          </Button>
        ))}
        <Button
          size="lg"
          tone="danger"
          disabled={!answerable}
          onClick={() => void store.respondApproval(approval, { outcome: "cancelled" })}
        >
          拒绝
        </Button>
      </div>

      {!answerable ? (
        <p className="text-caption leading-relaxed text-warning">
          这条追问没带 requestId，core 的待办列表里也对不上，无法应答——它会按拒绝超时结算。
        </p>
      ) : null}
    </article>
  );
}

/** 结算后的记录行：卡片不消失，收成一行 */
export function ApprovalRecord({ decision, title, at }: { decision: string; title: string; at: number }) {
  return (
    <p className="flex items-center gap-2 text-caption text-fg-subtle">
      <Icon name="check" size={12} />
      <span className="min-w-0 max-w-[60%] truncate">{title}</span>
      <span>·</span>
      <span>{decision}</span>
      <span>·</span>
      <span className="tabular">{clockTime(at)}</span>
    </p>
  );
}
