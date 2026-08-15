/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@hmi/contracts": path.resolve(
        __dirname,
        "./packages/contracts/src/index.ts"
      ),
    },
  },
  test: {
    // 主编辑器测试只覆盖 src/；web-ui 是独立工程（自带 vitest 配置）
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "io-backend/**",
      "scripts/**",
    ],
  },
});
