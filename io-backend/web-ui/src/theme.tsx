import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { theme as antdTheme } from "antd";
import type { ThemeConfig } from "antd";
import * as echarts from "echarts";

type ThemeMode = "dark" | "light";

const STORAGE_KEY = "hmi-io-theme";

interface ThemeContextValue {
  mode: ThemeMode;
  isDark: boolean;
  toggle: () => void;
  antdConfig: ThemeConfig;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const darkEchartsTheme = {
  color: ["#3b82f6", "#22c55e", "#f59e0b", "#ef4444", "#06b6d4", "#a78bfa"],
  backgroundColor: "transparent",
  textStyle: { color: "#8899b4" },
  title: { textStyle: { color: "#e8edf4" } },
  legend: { textStyle: { color: "#8899b4" } },
  categoryAxis: {
    axisLine: { lineStyle: { color: "#1e293b" } },
    axisLabel: { color: "#8899b4" },
    splitLine: { lineStyle: { color: "#1e293b" } },
  },
  valueAxis: {
    axisLine: { lineStyle: { color: "#1e293b" } },
    axisLabel: { color: "#8899b4" },
    splitLine: { lineStyle: { color: "rgba(148,163,184,0.1)" } },
  },
  tooltip: {
    backgroundColor: "#111c30",
    borderColor: "rgba(148,163,184,0.2)",
    textStyle: { color: "#e8edf4" },
  },
};

const lightEchartsTheme = {
  color: ["#3b82f6", "#22c55e", "#f59e0b", "#ef4444", "#06b6d4", "#a78bfa"],
  backgroundColor: "transparent",
  textStyle: { color: "#556580" },
  title: { textStyle: { color: "#1f2937" } },
  legend: { textStyle: { color: "#556580" } },
  categoryAxis: {
    axisLine: { lineStyle: { color: "#d1d5db" } },
    axisLabel: { color: "#556580" },
    splitLine: { lineStyle: { color: "#e5e7eb" } },
  },
  valueAxis: {
    axisLine: { lineStyle: { color: "#d1d5db" } },
    axisLabel: { color: "#556580" },
    splitLine: { lineStyle: { color: "rgba(31,41,55,0.08)" } },
  },
  tooltip: {
    backgroundColor: "#ffffff",
    borderColor: "rgba(31,41,55,0.12)",
    textStyle: { color: "#1f2937" },
  },
};

echarts.registerTheme("app", darkEchartsTheme);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, mode);
    document.documentElement.setAttribute("data-theme", mode);
    echarts.registerTheme(
      "app",
      mode === "dark" ? darkEchartsTheme : lightEchartsTheme,
    );
  }, [mode]);

  const value = useMemo<ThemeContextValue>(() => {
    const isDark = mode === "dark";
    const antdConfig: ThemeConfig = {
      algorithm: isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
      token: {
        colorPrimary: "#3b82f6",
        borderRadius: 6,
        fontFamily:
          '"Segoe UI", "Microsoft YaHei", system-ui, -apple-system, sans-serif',
      },
      components: {
        Layout: {
          siderBg: isDark ? "#0d1526" : "#f5f7fa",
          headerBg: isDark ? "#111c30" : "#ffffff",
          headerHeight: 56,
          bodyBg: isDark ? "#0a0e17" : "#f0f2f5",
        },
        Table: { headerBg: isDark ? "#141f33" : "#fafafa" },
        Card: { headerBg: isDark ? "transparent" : "#fafafa" },
      },
    };
    return {
      mode,
      isDark,
      toggle: () => setMode((m) => (m === "dark" ? "light" : "dark")),
      antdConfig,
    };
  }, [mode]);

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
