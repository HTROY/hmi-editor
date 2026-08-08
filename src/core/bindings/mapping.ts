import type { ValueMapping } from "../types";

// ============================================================
// mapping — 值映射引擎（绑定与动画共用）
// 输入变量原始值 → 按 mapping 类型输出目标值
// ============================================================

export type MappedValue = number | boolean | string | string[];

export function applyValueMapping(
  mapping: ValueMapping,
  rawValue: number | boolean
): MappedValue {
  switch (mapping.type) {
    case "direct":
      return rawValue;

    case "enum": {
      // DI 0/1 → 颜色字符串等
      const key = String(rawValue);
      return mapping.map[key] ?? rawValue;
    }

    case "range": {
      if (typeof rawValue !== "number") return rawValue;
      // 将 rawValue 从 [from[0], from[1]] 线性映射到 [to[0], to[1]]
      const [fromMin, fromMax] = mapping.from;
      const [toMin, toMax] = mapping.to;
      if (fromMax === fromMin) return toMin;
      const ratio = (rawValue - fromMin) / (fromMax - fromMin);
      return Math.round((toMin + ratio * (toMax - toMin)) * 100) / 100;
    }

    case "stateColor": {
      // 数值直接作为颜色值使用 (0xFF0000 格式)
      if (typeof rawValue === "number") {
        return "#" + rawValue.toString(16).padStart(6, "0");
      }
      return rawValue ? "#00FF00" : "#808080";
    }

    case "bitmask":
      return applyBitmask(mapping, rawValue);

    default:
      return rawValue;
  }
}

function applyBitmask(
  mapping: ValueMapping & { type: "bitmask" },
  rawValue: number | boolean
): string[] {
  if (typeof rawValue !== "number") return [];
  const activeStates: string[] = [];
  for (const bit of mapping.bits) {
    if (rawValue & Math.pow(2, bit)) {
      const state = mapping.states[Math.pow(2, bit)];
      if (state) activeStates.push(state);
    }
  }
  return activeStates;
}
