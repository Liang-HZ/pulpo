import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// 两种模式跑同一份前端代码：
//   default —— Tauri 开发服务器（固定 1420 端口，Tauri 要求 strictPort）
//   web     —— 纯浏览器（5173），用于验收与 Playwright e2e
// 前端不依赖任何桌面独占 API，两种模式下都直连 core 的 127.0.0.1 WebSocket。
export default defineConfig(({ mode }) => {
  const isWeb = mode === "web";
  return {
    plugins: [react(), tailwindcss()],
    clearScreen: false,
    build: isWeb ? { outDir: "dist-web", emptyOutDir: true } : { outDir: "dist", emptyOutDir: true },
    server: isWeb
      ? { port: 5173, strictPort: true }
      : {
          port: 1420,
          strictPort: true,
          host: process.env.TAURI_DEV_HOST || false,
          watch: { ignored: ["**/src-tauri/**"] },
        },
  };
});
