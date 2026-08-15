// ============================================================
// ECharts 按需引入（F11）：只用到的 LineChart + 基础组件 + Canvas 渲染器。
// 所有使用方（useEChart / theme.tsx）统一从本模块取 echarts 实例，
// 不再 `import * as echarts from "echarts"` 全量打包。
// ============================================================

import * as echarts from "echarts/core";
import { LineChart, type LineSeriesOption } from "echarts/charts";
import {
  GridComponent,
  LegendComponent,
  TooltipComponent,
  type GridComponentOption,
  type LegendComponentOption,
  type TooltipComponentOption,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
// 坐标轴选项类型只在 echarts 根类型中导出（type-only，不影响打包体积）
import type { XAXisComponentOption, YAXisComponentOption } from "echarts";

echarts.use([
  LineChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  CanvasRenderer,
]);

/** 本应用图表选项类型（按需组合；新图表类型需在此登记） */
export type AppEChartsOption = echarts.ComposeOption<
  | LineSeriesOption
  | GridComponentOption
  | TooltipComponentOption
  | LegendComponentOption
  | XAXisComponentOption
  | YAXisComponentOption
>;

export { echarts };
