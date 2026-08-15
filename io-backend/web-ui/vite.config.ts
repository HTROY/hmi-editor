/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@hmi/contracts": path.resolve(
        __dirname,
        "../../packages/contracts/src/index.ts"
      ),
    },
  },
  server: {
    port: 5174,
    // 允许 dev server 读取仓库根的 packages/contracts（@hmi/contracts 别名）
    fs: { allow: [path.resolve(__dirname, "../..")] },
    proxy: {
      "/api": {
        target: "http://localhost:8081",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // ECharts 按需引入（echarts/core + charts/components/renderers + zrender）
        // 后统一收进 "echarts" 块；antd/图标/dayjs 进 "antd"；react 家族按
        // 包名精确匹配（避免把 react-is 之类误收进 react 块造成循环 chunk）。
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return undefined;
          if (
            id.includes("echarts") ||
            id.includes("zrender") ||
            id.includes("tslib")
          ) {
            return "echarts";
          }
          if (
            id.includes("antd") ||
            id.includes("@ant-design") ||
            id.includes("dayjs")
          ) {
            return "antd";
          }
          if (
            /node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(
              id
            )
          ) {
            return "react";
          }
          return undefined;
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});
