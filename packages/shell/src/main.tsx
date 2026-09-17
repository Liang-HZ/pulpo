import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";

/**
 * 亮 / 暗两套**跟随系统**。把系统偏好落到 `<html>` 的 class 上，
 * 让 CSS 变量与 `dark:` 变体走同一条判定——只写 media 查询的话，`dark:` 变体
 * （比如暗色下不用阴影）不会跟着走。CSS 里仍保留 media 兜底，防 JS 未执行时闪白。
 */
const media = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
const applyTheme = (): void => {
  const root = document.documentElement;
  const dark = Boolean(media?.matches);
  root.classList.toggle("dark", dark);
  root.classList.toggle("light", !dark);
};
applyTheme();
media?.addEventListener("change", applyTheme);

const root = document.getElementById("root");
if (!root) throw new Error("找不到 #root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
