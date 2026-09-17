// 投递回执。壳只翻译 outcome，不美化：档位原文、逐档过程全都摊开。
// 这是排查"为什么我的补充消息没进去"的唯一入口，所以 detail 一个字都不能省。
//
// 回执条 4 秒后淡出，但**排队中的消息**在 composer 上方保留一个可展开的队列列表
// （那部分在 Composer 里）。

import { useEffect, useState } from "react";
import type { DeliveryReceipt } from "../lib/protocol";
import { receiptLabel } from "../lib/steering";
import { Code, Disclosure } from "./ui";

const TONE = {
  ok: "text-success",
  muted: "text-fg-muted",
  warn: "text-warning",
} as const;

/** composer 上方那条 28 高的回执条。淡入 150ms，4 秒后淡出 200ms，再卸载。 */
export function ReceiptBar({ receipt }: { receipt: DeliveryReceipt }) {
  const [fading, setFading] = useState(false);
  const [visible, setVisible] = useState(true);
  const label = receiptLabel(receipt);

  useEffect(() => {
    setVisible(true);
    setFading(false);
    const fade = setTimeout(() => setFading(true), 4000);
    const unmount = setTimeout(() => setVisible(false), 4200);
    return () => {
      clearTimeout(fade);
      clearTimeout(unmount);
    };
  }, [receipt]);

  if (!visible) return null;
  return (
    <div
      data-testid="receipt-bar"
      data-outcome={label.outcome}
      role="status"
      className={`fade-in flex h-8 items-center gap-2 px-1 text-caption transition-opacity duration-200 ${
        TONE[label.tone]
      } ${fading ? "opacity-0" : "opacity-100"}`}
    >
      <span>{label.text}</span>
      {label.outcome !== "injected" ? <span className="text-fg-subtle">· {label.detail}</span> : null}
    </div>
  );
}

/** 挂在用户气泡下方的完整回执（含逐档过程）。排查用，不淡出。 */
export function Receipt({
  receipt,
  align = "start",
}: {
  receipt: DeliveryReceipt;
  align?: "start" | "end";
}) {
  const label = receiptLabel(receipt);
  return (
    <div
      data-testid="receipt"
      data-outcome={label.outcome}
      className={`flex flex-col gap-1 ${align === "end" ? "items-end" : "items-start"}`}
    >
      <span className={`text-caption ${TONE[label.tone]}`}>
        {label.text} · {label.detail}
      </span>
      {/* core 说回合在跑、目标却说没有回合——这是投递窗口还没打开，不是消息丢了 */}
      {label.outcome === "no_active_turn" && receipt.turnActive ? (
        <p className="text-caption leading-relaxed text-warning">
          core 认为这条会话的回合正在跑，目标却回了"没有进行中的回合"——回合刚发出、
          目标那边还没真正开始。这条没进去，等它跑起来再补一次。
        </p>
      ) : null}
      {/* 阶梯都试过了却还是不可用，唯一的线索在目标的原始应答里——实测 ZCode 会在
          会话刚建好的头几百毫秒回 `{"outcome":"failed", … "FOREIGN KEY constraint failed"}`，
          不摊开这段就没人查得出来为什么。`failed` 同理：机制在、这次没成，原因在 raw 里。 */}
      {(label.outcome === "unsupported" || label.outcome === "failed") && receipt.raw ? (
        <Disclosure summary="目标的原始应答" defaultOpen>
          <Code>{JSON.stringify(receipt.raw, null, 2)}</Code>
        </Disclosure>
      ) : null}
      {receipt.attempts?.length ? (
        <Disclosure summary="逐档投递过程" count={receipt.attempts.length}>
          <ul className="flex flex-col gap-1 text-caption text-fg-muted">
            {receipt.attempts.map((a, i) => (
              <li key={i}>
                {a.tier} · {a.status}
                {a.detail ? ` · ${a.detail}` : ""}
              </li>
            ))}
          </ul>
        </Disclosure>
      ) : null}
    </div>
  );
}
