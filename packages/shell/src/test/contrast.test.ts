import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * 对比度是硬门槛，不是肉眼判断——把色板里真正用到的色对逐个算出来断言。
 * 色值直接从 `src/index.css` 解析，改了 token 而忘了复核对比度时这里会红。
 *
 * 色板还给了一组"实算值"。下面第二组用例把那几个数字也钉住（±0.05），
 * 这样文档与实现对不上的时候是**测试**先红，而不是交付之后才发现文档在说谎。
 */
const css = readFileSync(fileURLToPath(new URL("../index.css", import.meta.url)), "utf-8");

function token(name: string, scope: "light" | "dark"): string {
  // 亮色取 `:root {` 那一段，暗色取 `.dark {` 那一段
  const lightStart = css.indexOf(":root {");
  const darkStart = css.indexOf(".dark {");
  const region =
    scope === "light" ? css.slice(lightStart, darkStart) : css.slice(darkStart);
  const match = new RegExp(`--${name}:\\s*([^;]+);`).exec(region);
  if (!match?.[1]) throw new Error(`token --${name} 在 ${scope} 段里找不到`);
  return match[1].trim();
}

function relativeLuminance(hex: string): number {
  const h = hex.replace("#", "");
  const channels = [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// [说明, 前景 token, 背景 token, 最低比值]
const pairs: Array<[string, string, string, number]> = [
  ["正文 on canvas", "c-fg-1", "c-canvas", 4.5],
  ["正文 on chrome", "c-fg-1", "c-chrome", 4.5],
  ["正文 on surface", "c-fg-1", "c-surface", 4.5],
  ["次要文字 on canvas", "c-fg-2", "c-canvas", 4.5],
  ["次要文字 on chrome", "c-fg-2", "c-chrome", 4.5],
  ["次要文字 on surface", "c-fg-2", "c-surface", 4.5],
  ["弱化文字 on canvas", "c-fg-3", "c-canvas", 4.5],
  ["弱化文字 on chrome", "c-fg-3", "c-chrome", 4.5],
  ["brand on canvas", "c-brand", "c-canvas", 4.5],
  ["brand on chrome", "c-brand", "c-chrome", 4.5],
  ["brand 实心按钮的文字", "c-brand-fg", "c-brand", 4.5],
  ["success on canvas", "c-success", "c-canvas", 4.5],
  ["warning on canvas", "c-warning", "c-canvas", 4.5],
  ["danger on canvas", "c-danger", "c-canvas", 4.5],
  ["warning on warning-surface（访问模式 chip）", "c-warning", "c-warning-surface", 4.5],
  ["diff-add on diff-add-surface", "c-diff-add", "c-diff-add-surface", 4.5],
  ["diff-remove on diff-remove-surface", "c-diff-remove", "c-diff-remove-surface", 4.5],
  ["气泡文字 on 气泡底", "c-bubble-fg", "c-bubble", 4.5],
  // UI 元件门槛 3:1
  ["控件描边 on chrome", "c-control", "c-chrome", 3],
  ["控件描边 on surface", "c-control", "c-surface", 3],
  ["焦点环（brand）on canvas", "c-brand", "c-canvas", 3],
];

describe.each(["light", "dark"] as const)("%s 主题对比度", (scope) => {
  it.each(pairs)("%s（%s on %s）≥ %d:1", (_label, fg, bg, min) => {
    expect(contrast(token(fg, scope), token(bg, scope))).toBeGreaterThanOrEqual(min);
  });
});

/** 色板写下的实算值。文档与实现对不上时这里先红。 */
const documented: Array<[string, "light" | "dark", string, string, number]> = [
  ["亮 text-1 / canvas", "light", "c-fg-1", "c-canvas", 16.18],
  ["亮 text-2 / canvas", "light", "c-fg-2", "c-canvas", 7.0],
  // 色板把这一格写成 5.10，按 WCAG 公式实算是 **5.00**（#63706F on #FAFCFC）。
  // 两个数都过 4.5 的门槛，差别只在那一位小数上——这里钉实算值。
  ["亮 text-3 / canvas", "light", "c-fg-3", "c-canvas", 5.0],
  ["亮 brand / canvas", "light", "c-brand", "c-canvas", 6.14],
  ["亮 control / chrome", "light", "c-control", "c-chrome", 3.29],
  ["亮 diff-add / diff-add-surface", "light", "c-diff-add", "c-diff-add-surface", 5.4],
  ["亮 气泡", "light", "c-bubble-fg", "c-bubble", 12.59],
  ["暗 text-1 / canvas", "dark", "c-fg-1", "c-canvas", 13.69],
  ["暗 text-2 / canvas", "dark", "c-fg-2", "c-canvas", 7.9],
  ["暗 control / chrome", "dark", "c-control", "c-chrome", 4.48],
  ["暗 气泡", "dark", "c-bubble-fg", "c-bubble", 10.76],
];

describe("色板的实算值", () => {
  it.each(documented)("%s = %s", (_label, scope, fg, bg, expected) => {
    expect(contrast(token(fg, scope), token(bg, scope))).toBeCloseTo(expected, 1);
  });

  it("暗色的实心 brand 按钮用近黑字：白字压 brand 不合格", () => {
    const brand = token("c-brand", "dark");
    expect(contrast("#FFFFFF", brand)).toBeLessThan(3);
    expect(contrast(token("c-brand-fg", "dark"), brand)).toBeGreaterThanOrEqual(4.5);
  });

  it("暗色不是反转：层级靠背景提亮，chrome 最暗、surface 最亮", () => {
    const lum = (n: string): number => relativeLuminance(token(n, "dark"));
    expect(lum("c-chrome")).toBeLessThan(lum("c-canvas"));
    expect(lum("c-canvas")).toBeLessThan(lum("c-surface"));
  });
});
