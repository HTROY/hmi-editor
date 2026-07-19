import React, { useEffect, useRef } from "react";
import type { HistoryPoint, TrendConfig } from "../../../core/historian/types";

// ============================================================
// TrendChart — 趋势曲线图（Canvas 渲染）
// ============================================================

interface TrendChartProps {
  points: HistoryPoint[];
  config: TrendConfig;
  width?: number;
  height?: number;
  showGrid?: boolean;
}

export function TrendChart({
  points,
  config,
  width = 260,
  height = 160,
  showGrid = true,
}: TrendChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.width = width * devicePixelRatio;
    canvas.height = height * devicePixelRatio;
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";

    const ctx = canvas.getContext("2d")!;
    ctx.scale(devicePixelRatio, devicePixelRatio);

    const pad = { top: 20, right: 10, bottom: 24, left: 45 };
    const chartW = width - pad.left - pad.right;
    const chartH = height - pad.top - pad.bottom;

    // 清空
    ctx.clearRect(0, 0, width, height);

    // 背景
    ctx.fillStyle = "#1A1A2A";
    ctx.fillRect(0, 0, width, height);

    if (points.length < 2) {
      ctx.fillStyle = "#444";
      ctx.font = "12px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("等待数据...", width / 2, height / 2);
      return;
    }

    const minVal = config.min;
    const maxVal = config.max;
    const valRange = maxVal - minVal || 1;

    // 网格
    if (showGrid) {
      ctx.strokeStyle = "#2A2A3A";
      ctx.lineWidth = 0.5;
      const gridLines = 4;
      for (let i = 0; i <= gridLines; i++) {
        const y = pad.top + (chartH / gridLines) * i;
        ctx.beginPath();
        ctx.moveTo(pad.left, y);
        ctx.lineTo(width - pad.right, y);
        ctx.stroke();

        // Y 轴标签
        const val = maxVal - (valRange / gridLines) * i;
        ctx.fillStyle = "#666";
        ctx.font = "9px sans-serif";
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        ctx.fillText(val.toFixed(1), pad.left - 4, y);
      }
    }

    // 数据线
    const visible = points.slice(-200);
    const timeRange =
      visible[visible.length - 1].timestamp - visible[0].timestamp || 1;

    ctx.beginPath();
    ctx.strokeStyle = config.color;
    ctx.lineWidth = 1.5;

    for (let i = 0; i < visible.length; i++) {
      const x =
        pad.left +
        ((visible[i].timestamp - visible[0].timestamp) / timeRange) * chartW;
      const y = pad.top + (1 - (visible[i].value - minVal) / valRange) * chartH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // 填充渐变
    const gradient = ctx.createLinearGradient(0, pad.top, 0, pad.top + chartH);
    gradient.addColorStop(0, config.color + "33");
    gradient.addColorStop(1, config.color + "05");
    ctx.fillStyle = gradient;
    ctx.lineTo(pad.left + chartW, pad.top + chartH);
    ctx.lineTo(pad.left, pad.top + chartH);
    ctx.closePath();
    ctx.fill();

    // 当前值
    const lastPoint = visible[visible.length - 1];
    if (lastPoint) {
      const lastX = pad.left + chartW;
      const lastY =
        pad.top + (1 - (lastPoint.value - minVal) / valRange) * chartH;

      // 当前值指示点
      ctx.fillStyle = config.color;
      ctx.beginPath();
      ctx.arc(lastX, lastY, 3, 0, Math.PI * 2);
      ctx.fill();

      // 当前值文本
      ctx.fillStyle = "#E0E0E0";
      ctx.font = "bold 12px sans-serif";
      ctx.textAlign = "right";
      ctx.textBaseline = "bottom";
      ctx.fillText(lastPoint.value.toFixed(1), lastX - 6, lastY - 6);

      // 单位
      if (config.unit) {
        ctx.fillStyle = "#888";
        ctx.font = "10px sans-serif";
        ctx.textBaseline = "top";
        ctx.fillText(config.unit, lastX - 6, lastY + 4);
      }

      // X 轴时间
      const d = new Date(lastPoint.timestamp);
      const timeStr = d.toLocaleTimeString("zh-CN", { hour12: false });
      ctx.fillStyle = "#666";
      ctx.font = "9px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(timeStr, pad.left + chartW, pad.top + chartH + 4);
      ctx.fillText(
        new Date(visible[0].timestamp).toLocaleTimeString("zh-CN", {
          hour12: false,
        }),
        pad.left,
        pad.top + chartH + 4,
      );
    }

    // 标题
    ctx.fillStyle = "#A0A0B0";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(config.label, pad.left, 4);
  }, [points, config, width, height, showGrid]);

  return (
    <canvas ref={canvasRef} style={{ borderRadius: 4, display: "block" }} />
  );
}
