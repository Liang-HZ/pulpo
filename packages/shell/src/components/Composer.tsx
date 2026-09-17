// composer 与 steering 输入态。
//
// 回合进行中 composer **不禁用**——这是 pulpo 的差异化：
// **同一位置、同一个输入框、同一个按钮**，只有发送按钮的形状与回执条随实际档位变。
//
// 左侧控件里没有「附件」与「麦克风」：core 的 `session/prompt` 只收文本，
// 放两个点了没反应的按钮是在暗示能力存在。见 README 的"与主流桌面端的取舍"。

import { useEffect, useRef, useState } from "react";
import type { CapabilityDescriptor, ConfigOption, ModeRisk, QueuedMessage, SteeringTier } from "../lib/protocol";
import type { Usage } from "../lib/chat";
import { riskVariant, riskWarns, usageLevel } from "../lib/policy";
import { AppStore } from "../lib/store";
import { Icon } from "./Icon";
import { Button, Chip, MenuItem, Popover } from "./ui";

/** 上下文用量环：>80% 变 warning、>95% 变 danger，并且**必须**同时给出百分比文字 */
function UsageRing({ usage }: { usage: Usage }) {
  if (!usage.size) return null;
  const ratio = Math.min(1, usage.used / usage.size);
  const level = usageLevel(usage.used, usage.size);
  const color =
    level === "danger"
      ? "var(--color-danger)"
      : level === "warning"
        ? "var(--color-warning)"
        : "var(--color-brand)";
  const r = 8;
  const c = 2 * Math.PI * r;
  const title = `上下文已用 ${usage.used.toLocaleString("zh-CN")} / 总量 ${usage.size.toLocaleString("zh-CN")}`;
  return (
    <span className="flex items-center gap-1" title={title}>
      <svg width={20} height={20} viewBox="0 0 20 20" role="img" aria-label={title}>
        <circle cx="10" cy="10" r={r} fill="none" stroke="var(--color-border)" strokeWidth="2" />
        <circle
          cx="10"
          cy="10"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="2"
          strokeDasharray={`${c * ratio} ${c}`}
          strokeLinecap="round"
          transform="rotate(-90 10 10)"
        />
      </svg>
      {level !== "normal" ? (
        <span
          className={`tabular text-caption ${level === "danger" ? "text-danger" : "text-warning"}`}
        >
          {Math.round(ratio * 100)}%
        </span>
      ) : null}
    </span>
  );
}

function OptionChip({ option, onPick }: { option: ConfigOption; onPick: (value: string) => void }) {
  const current = option.options?.find((o) => o.value === option.currentValue);
  return (
    <Popover
      label={option.name}
      align="end"
      side="top"
      trigger={({ toggle, ...rest }) => (
        <Chip variant="outline" menu onClick={toggle} aria-label={option.name} {...rest}>
          {current?.name ?? option.currentValue ?? option.name}
        </Chip>
      )}
    >
      {(close) => (
        <>
          {(option.options ?? []).map((o) => (
            <MenuItem
              key={o.value}
              selected={o.value === option.currentValue}
              onClick={() => {
                onPick(o.value);
                close();
              }}
            >
              {o.name}
            </MenuItem>
          ))}
        </>
      )}
    </Popover>
  );
}

export function Composer({
  store,
  sessionRef,
  turnActive,
  descriptor,
  configOptions,
  usage,
  queued,
  isNew,
  receipt,
}: {
  store: AppStore;
  sessionRef: string;
  turnActive: boolean;
  descriptor: CapabilityDescriptor | undefined;
  configOptions: ConfigOption[];
  usage: Usage | null;
  queued: QueuedMessage[];
  isNew: boolean;
  receipt: React.ReactNode;
}) {
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const [showQueue, setShowQueue] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setText("");
  }, [sessionRef]);

  // min 128，长到 max 360 后内滚
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(360, Math.max(128, el.scrollHeight))}px`;
  }, [text]);

  const tier: SteeringTier | null = descriptor?.delivery.steering.tier ?? null;
  const modeOption = configOptions.find((o) => o.id === "mode");
  // 模式清单优先取 descriptor（只有它带 risk）；configOptions 只提供当前值与写回方法。
  const modes: Array<{ id: string; name: string; risk?: ModeRisk }> =
    descriptor?.modes ??
    modeOption?.options?.map((o) => ({ id: o.value, name: o.name })) ??
    [];
  const currentModeId = modeOption?.currentValue ?? descriptor?.currentModeId;
  const currentMode = modes.find((m) => m.id === currentModeId);
  const model = configOptions.find((o) => o.id === "model");
  const effort = configOptions.find((o) => o.id === "reasoning_effort" || o.id === "effort");

  const submit = async (): Promise<void> => {
    const value = text;
    if (!value.trim()) return;
    setText("");
    await store.send(sessionRef, value);
    input.current?.focus();
  };

  const placeholder = turnActive
    ? "补充一句，会按渠道能力如实投递…"
    : isNew
      ? "描述你要做的事"
      : "提出后续修改要求…";

  return (
    <div className="flex flex-col gap-2 px-4 pb-3">
      {receipt}

      {queued.length ? (
        <div className="rounded-lg border border-border bg-surface">
          <button
            type="button"
            onClick={() => setShowQueue((v) => !v)}
            aria-expanded={showQueue}
            className="flex h-8 w-full cursor-pointer items-center gap-2 px-3 text-caption text-fg-muted transition-[background-color] hover:bg-hover"
          >
            <Icon
              name="chevron-right"
              size={12}
              className={`transition-transform duration-200 ${showQueue ? "rotate-90" : ""}`}
            />
            壳内排队中的补充消息 · {queued.length}
            <span className="flex-1" />
            <span className="text-fg-subtle">这些还没到 agent，会在这一回合结束时投出去</span>
          </button>
          {showQueue ? (
            <ul className="flex flex-col gap-1 border-t border-border p-2">
              {queued.map((q, i) => (
                <li key={i} className="flex items-center gap-2 text-caption text-fg">
                  <span className="tabular text-fg-subtle">
                    {new Date(q.queuedAt).toLocaleTimeString("zh-CN")}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {typeof q.content === "string" ? q.content : JSON.stringify(q.content)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className={[
          "flex flex-col rounded-xl border bg-surface transition-[border-color]",
          // 聚焦时换 brand 边框且**不加 ring**，避免双层
          focused ? "border-brand" : "border-control",
        ].join(" ")}
      >
        <div className="relative">
          <textarea
            ref={input}
            value={text}
            rows={1}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // IME 守卫是必须的：中文输入法下 Enter 是"确认候选"
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
              // Esc：第一次清 composer，第二次才 session/cancel
              if (e.key === "Escape") {
                e.preventDefault();
                if (text) setText("");
                else if (turnActive) void store.cancel(sessionRef);
              }
            }}
            aria-label={turnActive ? "补充消息" : "发给 agent 的消息"}
            placeholder={placeholder}
            className="max-h-(--layout-composer-max) min-h-(--layout-composer-min) w-full resize-none bg-transparent p-3 pr-12 text-body text-fg placeholder:text-fg-subtle focus:outline-none"
          />
          {/* 发送按钮：24×24 圆形，贴输入区右下，距边 12。四态：
              回合进行中**不是禁用**：有字时它照样提交（走 delivery/send），
              空的时候才变成「停止这一回合」的方形按钮。 */}
          <button
            type={turnActive && !text.trim() ? "button" : "submit"}
            data-testid="send-button"
            data-tier={turnActive ? (tier ?? "unknown") : "idle"}
            disabled={!turnActive && !text.trim()}
            onClick={turnActive && !text.trim() ? () => void store.cancel(sessionRef) : undefined}
            aria-label={turnActive ? (text.trim() ? "投递补充消息" : "停止这一回合") : "发送"}
            title={turnActive && !text.trim() ? "停止这一回合" : turnActive ? "投递补充消息" : "发送"}
            className={[
              "absolute right-3 bottom-3 inline-flex size-6 items-center justify-center rounded-full",
              "transition-[background-color,color]",
              turnActive && !text.trim()
                ? "cursor-pointer bg-transparent text-danger hover:bg-hover"
                : text.trim()
                  ? "cursor-pointer bg-brand text-brand-fg hover:brightness-110"
                  : "cursor-not-allowed bg-hover text-fg-subtle",
              queued.length ? "ring-1 ring-brand" : "",
            ].join(" ")}
          >
            {turnActive && !text.trim() ? (
              <Icon name="square" size={12} />
            ) : (
              <Icon name="arrow-up" size={14} />
            )}
            {queued.length ? (
              <span className="tabular absolute -top-1 -right-1 min-w-3 rounded-full bg-brand px-0.5 text-caption leading-none text-brand-fg">
                {queued.length}
              </span>
            ) : null}
          </button>
        </div>

        <div className="flex h-8 items-center gap-2 px-3">
          {/* 访问模式 chip 是**全屏唯一的橙色**。文案随渠道原生模式如实变化，不做统一改名。
              危险等级只来自 descriptor 的 `modes[].risk`，**绝不**靠字符串匹配 modeId。
              有些渠道把模式放在 configOptions 里、有些只在 ACP 原生的 modes 里——
              chip 是同一个，只有写回的方法不同。 */}
          {modes.length ? (
            <Popover
              label="访问模式"
              side="top"
              trigger={({ toggle, ...rest }) => (
                <Chip
                  variant={riskVariant(currentMode?.risk)}
                  menu
                  data-testid="mode-chip"
                  data-risk={currentMode?.risk ?? "unknown"}
                  onClick={toggle}
                  {...(riskWarns(currentMode?.risk) ? { icon: "alert-triangle" as const } : {})}
                  {...rest}
                >
                  {currentMode?.name ?? currentModeId ?? "访问模式"}
                </Chip>
              )}
            >
              {(close) => (
                <>
                  {modes.map((m) => (
                    <MenuItem
                      key={m.id}
                      selected={m.id === currentModeId}
                      onClick={() => {
                        if (modeOption) void store.setConfigOption(sessionRef, modeOption.id, m.id);
                        else void store.setMode(sessionRef, m.id);
                        close();
                      }}
                    >
                      {m.name}
                    </MenuItem>
                  ))}
                </>
              )}
            </Popover>
          ) : null}

          <span className="flex-1" />

          {model ? (
            <OptionChip
              option={model}
              onPick={(v) => void store.setConfigOption(sessionRef, model.id, v)}
            />
          ) : null}
          {effort ? (
            <OptionChip
              option={effort}
              onPick={(v) => void store.setConfigOption(sessionRef, effort.id, v)}
            />
          ) : null}
          {usage ? <UsageRing usage={usage} /> : null}
        </div>
      </form>
    </div>
  );
}

/** 空态里那个"选个渠道开始"的主行动 */
export function ComposerPlaceholder({ onNew }: { onNew: () => void }) {
  return (
    <div className="px-4 pb-3">
      <div className="flex min-h-(--layout-composer-min) flex-col items-start justify-center gap-2 rounded-xl border border-border bg-surface p-3">
        <p className="text-ui text-fg-muted">先打开一条会话，或者新建一条。</p>
        <Button tone="primary" size="lg" onClick={onNew}>
          新建任务
        </Button>
      </div>
    </div>
  );
}
