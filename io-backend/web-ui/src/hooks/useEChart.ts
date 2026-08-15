import { useEffect, useRef } from "react";
import { echarts, type AppEChartsOption } from "../lib/echarts";

/**
 * Mount an ECharts instance bound to a div.
 * 主题只由 theme.tsx 维护（registerTheme("app", ...)），此处仅消费；
 * 实例来自 lib/echarts（按需注册的 echarts/core）。
 */
export function useEChart(option: AppEChartsOption | null) {
  const ref = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

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
    chartRef.current?.setOption(option ?? {}, { notMerge: true });
  }, [option]);

  return ref;
}
