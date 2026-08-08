import type {
  AnimationControl,
  AnimationDef,
  AnimationParams,
  ValueMapping,
} from "../types";
import { applyValueMapping, type MappedValue } from "./mapping";

// ============================================================
// animation — 五类动画的纯函数实现
// 归一化 / 参数默认值 / 变量控制解析 / 逐帧状态计算
// 不依赖 DOM，可在 Vitest 中直接测试
// ============================================================

export const ANIMATION_TYPES = [
  "blink",
  "rotate",
  "move",
  "scale",
  "colorShift",
] as const;

export type AnimationType = (typeof ANIMATION_TYPES)[number];

let animSeq = 0;
export function generateAnimationId(): string {
  return "anim_" + Date.now().toString(36) + "_" + ++animSeq;
}

export function defaultAnimationParams(type: AnimationType): AnimationParams {
  switch (type) {
    case "blink":
      return { frequency: 1, minOpacity: 0.2 };
    case "rotate":
      return { angleSpeed: 60, direction: 1 };
    case "move":
      return {
        amplitudeX: 20,
        amplitudeY: 0,
        moveFrequency: 1,
        phase: 0,
      };
    case "scale":
      return { minScale: 1, maxScale: 1.2, scaleFrequency: 1 };
    case "colorShift":
      return { hueRange: 180, hueSpeed: 120 };
  }
}

/** 把旧工程/半填写的动画定义归一化为完整 AnimationDef */
export function normalizeAnimation(
  def: Partial<AnimationDef> | null | undefined
): AnimationDef {
  const type = ANIMATION_TYPES.includes((def?.type ?? "") as AnimationType)
    ? (def!.type as AnimationType)
    : "blink";

  let bind: AnimationControl | null = def?.bind ?? null;
  if (!bind && def?.bindVariable) {
    bind = {
      variableId: def.bindVariable,
      control: "speed",
      mapping: { type: "direct" },
    };
  }

  return {
    id: def?.id ?? generateAnimationId(),
    type,
    enabled: def?.enabled ?? true,
    speed: def?.speed ?? 1,
    params: { ...defaultAnimationParams(type), ...(def?.params ?? {}) },
    bind,
  };
}

export function normalizeAnimations(
  defs: Partial<AnimationDef>[] | null | undefined
): AnimationDef[] {
  if (!Array.isArray(defs)) return [];
  return defs
    .filter((d): d is Partial<AnimationDef> => !!d && typeof d === "object")
    .map(normalizeAnimation);
}

/** 单帧动画状态：由 Renderer 叠加到图元绘制上 */
export interface AnimationFrameState {
  opacity?: number;
  rotation?: number; // 旋转偏移（deg）
  dx?: number;
  dy?: number;
  scaleX?: number;
  scaleY?: number;
  hueRotate?: number; // 色相偏移（deg）
}

export interface AnimationRuntime {
  enabled: boolean;
  /** 时间倍率（含动画自身 speed 与变量 speed 控制） */
  speedMul: number;
  /** 强度倍率（默认 1，由变量 strength 控制） */
  strengthMul: number;
}

function toFiniteNumber(value: MappedValue): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function isTruthy(value: MappedValue): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== false && value !== 0 && value !== "0" && value !== "";
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * 解析动画的变量控制：未绑定变量时按固定参数循环；
 * 绑定时把变量值经值映射转为速度/强度倍率或启停开关。
 */
export function resolveAnimationControl(
  anim: Partial<AnimationDef>,
  getValue: (variableId: string) => { value: number | boolean } | undefined
): AnimationRuntime {
  const runtime: AnimationRuntime = {
    enabled: anim.enabled !== false,
    speedMul: anim.speed ?? 1,
    strengthMul: 1,
  };
  const ctrl = anim.bind;
  if (!ctrl || !ctrl.variableId) return runtime;

  const vv = getValue(ctrl.variableId);
  if (!vv) return runtime;

  const mapped = applyValueMapping(ctrl.mapping, vv.value);
  if (ctrl.control === "enabled") {
    runtime.enabled = runtime.enabled && isTruthy(mapped);
  } else {
    const n = toFiniteNumber(mapped);
    if (n !== null) {
      if (ctrl.control === "speed") {
        runtime.speedMul *= clamp(n, 0, 10);
      } else {
        runtime.strengthMul = clamp(n, 0, 10);
      }
    }
  }
  return runtime;
}

/**
 * 计算某个动画在当前相位下的帧状态。
 * elapsedSeconds 是经 speedMul 放大的累计动画时间。
 */
export function computeAnimationFrame(
  anim: Partial<AnimationDef>,
  elapsedSeconds: number,
  runtime: AnimationRuntime
): AnimationFrameState {
  const p = anim.params ?? {};
  const t = elapsedSeconds;
  const s = runtime.strengthMul;

  switch (anim.type) {
    case "blink": {
      const freq = p.frequency ?? 1;
      const minOpacity = p.minOpacity ?? 0.2;
      const depth = 1 - minOpacity;
      // 0..1 余弦波：t=0 全亮，半周期最暗
      const wave = (1 - Math.cos(2 * Math.PI * freq * t)) / 2;
      return { opacity: 1 - depth * wave * s };
    }

    case "rotate": {
      const angleSpeed = p.angleSpeed ?? 60;
      const dir = p.direction === -1 ? -1 : 1;
      return { rotation: dir * angleSpeed * s * t };
    }

    case "move": {
      const ax = (p.amplitudeX ?? 20) * s;
      const ay = (p.amplitudeY ?? 0) * s;
      const freq = p.moveFrequency ?? 1;
      const phase = p.phase ?? 0;
      const angle = 2 * Math.PI * freq * t + phase;
      return { dx: ax * Math.sin(angle), dy: ay * Math.sin(angle) };
    }

    case "scale": {
      // 强度围绕 1 缩放区间，强度 0 时静止为原始尺寸
      const minScale = 1 + ((p.minScale ?? 1) - 1) * s;
      const maxScale = 1 + ((p.maxScale ?? 1.2) - 1) * s;
      const freq = p.scaleFrequency ?? 1;
      const wave = (1 + Math.sin(2 * Math.PI * freq * t)) / 2;
      const sc = minScale + (maxScale - minScale) * wave;
      return { scaleX: sc, scaleY: sc };
    }

    case "colorShift": {
      const range = (p.hueRange ?? 180) * s;
      const speed = p.hueSpeed ?? 120;
      // 在 ±range/2 范围内按正弦摆动
      const offset = (range / 2) * Math.sin((t * speed * Math.PI) / 180);
      return { hueRotate: offset };
    }

    default:
      return {};
  }
}

/** 合并同一图元多个动画的帧状态 */
export function mergeAnimationFrames(
  target: AnimationFrameState | null,
  frame: AnimationFrameState
): AnimationFrameState {
  if (!target) return { ...frame };
  const out = target;
  if (frame.opacity !== undefined) {
    out.opacity = (out.opacity ?? 1) * frame.opacity;
  }
  if (frame.rotation !== undefined) {
    out.rotation = (out.rotation ?? 0) + frame.rotation;
  }
  if (frame.dx !== undefined) out.dx = (out.dx ?? 0) + frame.dx;
  if (frame.dy !== undefined) out.dy = (out.dy ?? 0) + frame.dy;
  if (frame.scaleX !== undefined) {
    out.scaleX = (out.scaleX ?? 1) * frame.scaleX;
  }
  if (frame.scaleY !== undefined) {
    out.scaleY = (out.scaleY ?? 1) * frame.scaleY;
  }
  if (frame.hueRotate !== undefined) {
    out.hueRotate = (out.hueRotate ?? 0) + frame.hueRotate;
  }
  return out;
}
