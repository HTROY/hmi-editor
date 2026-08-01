import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import type { EChartsOption } from "echarts";
import { useTheme } from "../theme";

/** Mount an ECharts instance bound to a div; re-themes on dark/light switch. */
export function useEChart(option: EChartsOption | null) {
  const ref = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const { isDark } = useTheme();

  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current, "app");
    chartRef.current = chart;
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(ref.current);
    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (chart) {
      echarts.registerTheme("app", {
        color: ["#3b82f6", "#22c55e", "#f59e0b", "#ef4444", "#06b6d4", "#a78bfa"],
        backgroundColor: "transparent",
        textStyle: { color: isDark ? "#8899b4" : "#556580" },
        categoryAxis: {
          axisLine: { lineStyle: { color: isDark ? "#1e293b" : "#d1d5db" } },
          axisLabel: { color: isDark ? "#8899b4" : "#556580" },
          splitLine: { lineStyle: { color: isDark ? "#1e293b" : "#e5e7eb" } },
        },
        valueAxis: {
          axisLine: { lineStyle: { color: isDark ? "#1e293b" : "#d1d5db" } },
          axisLabel: { color: isDark ? "#8899b4" : "#556580" },
          splitLine: {
            lineStyle: { color: isDark ? "rgba(148,163,184,0.1)" : "rgba(31,41,55,0.08)" },
          },
        },
        tooltip: {
          backgroundColor: isDark ? "#111c30" : "#ffffff",
          borderColor: isDark ? "rgba(148,163,184,0.2)" : "rgba(31,41,55,0.12)",
          textStyle: { color: isDark ? "#e8edf4" : "#1f2937" },
        },
      });
      chart.setOption(option ?? {}, { notMerge: true });
    }
  }, [option, isDark]);

  return ref;
}
