import { describe, expect, it } from "vitest";
import {
  computeAnimationFrame,
  defaultAnimationParams,
  mergeAnimationFrames,
  normalizeAnimation,
  resolveAnimationControl,
} from "./animation";
import type { AnimationDef } from "../types";

function makeAnim(overrides: Partial<AnimationDef> = {}): AnimationDef {
  return {
    id: "a1",
    type: "blink",
    enabled: true,
    speed: 1,
    params: defaultAnimationParams("blink"),
    bind: null,
    ...overrides,
  };
}

describe("normalizeAnimation", () => {
  it("旧工程缺 id/params 时补默认值", () => {
    const def = normalizeAnimation({ type: "rotate" });
    expect(def.id).toBeTruthy();
    expect(def.enabled).toBe(true);
    expect(def.speed).toBe(1);
    expect(def.params).toEqual({
      angleSpeed: 60,
      direction: 1,
    });
    expect(def.bind).toBeNull();
  });

  it("旧字段 bindVariable 归一化为 bind（speed + direct）", () => {
    const def = normalizeAnimation({
      type: "blink",
      bindVariable: "STA1_FAN_1_STATUS",
    });
    expect(def.bind).toEqual({
      variableId: "STA1_FAN_1_STATUS",
      control: "speed",
      mapping: { type: "direct" },
    });
  });

  it("未知类型回退为 blink", () => {
    expect(normalizeAnimation({ type: "warp" as any }).type).toBe("blink");
  });
});

describe("computeAnimationFrame", () => {
  const runtime = { enabled: true, speedMul: 1, strengthMul: 1 };

  it("blink 在 0s 全亮、半周期最暗", () => {
    const anim = makeAnim({
      type: "blink",
      params: { frequency: 1, minOpacity: 0.2 },
    });
    expect(computeAnimationFrame(anim, 0, runtime).opacity).toBeCloseTo(1);
    expect(computeAnimationFrame(anim, 0.5, runtime).opacity).toBeCloseTo(0.2);
    expect(computeAnimationFrame(anim, 1, runtime).opacity).toBeCloseTo(1);
  });

  it("rotate 按角速度累计角度", () => {
    const anim = makeAnim({
      type: "rotate",
      params: { angleSpeed: 90, direction: -1 },
    });
    expect(computeAnimationFrame(anim, 2, runtime).rotation).toBeCloseTo(-180);
  });

  it("move 按振幅与正弦相位输出位移", () => {
    const anim = makeAnim({
      type: "move",
      params: { amplitudeX: 40, amplitudeY: 10, moveFrequency: 1, phase: 0 },
    });
    const frame = computeAnimationFrame(anim, 0.25, runtime);
    expect(frame.dx).toBeCloseTo(40);
    expect(frame.dy).toBeCloseTo(10);
  });

  it("scale 在 1/4 周期达到最大缩放", () => {
    const anim = makeAnim({
      type: "scale",
      params: { minScale: 0.9, maxScale: 1.2, scaleFrequency: 1 },
    });
    const frame = computeAnimationFrame(anim, 0.25, runtime);
    expect(frame.scaleX).toBeCloseTo(1.2);
    expect(frame.scaleY).toBeCloseTo(1.2);
  });

  it("colorShift 在色相范围内摆动", () => {
    const anim = makeAnim({
      type: "colorShift",
      params: { hueRange: 120, hueSpeed: 90 },
    });
    const frame = computeAnimationFrame(anim, 1, runtime);
    // sin(90°)=1 → 偏移 +60°
    expect(frame.hueRotate).toBeCloseTo(60);
  });

  it("strength 缩放振幅/区间，0 时动画静止", () => {
    const anim = makeAnim({
      type: "move",
      params: { amplitudeX: 40, amplitudeY: 0, moveFrequency: 1, phase: 0 },
    });
    const strong = { ...runtime, strengthMul: 0.5 };
    expect(computeAnimationFrame(anim, 0.25, strong).dx).toBeCloseTo(20);
    expect(
      computeAnimationFrame(anim, 0.25, { ...runtime, strengthMul: 0 }).dx
    ).toBe(0);
  });
});

describe("resolveAnimationControl", () => {
  const values = new Map<string, { value: number | boolean }>([
    ["speed", { value: 50 }],
    ["off", { value: 0 }],
    ["on", { value: 1 }],
  ]);
  const getValue = (id: string) => values.get(id);

  it("未绑定变量时按固定参数循环（基础 speed 生效）", () => {
    const anim = makeAnim({ bind: null, speed: 2 });
    expect(resolveAnimationControl(anim, getValue)).toEqual({
      enabled: true,
      speedMul: 2,
      strengthMul: 1,
    });
  });

  it("speed 控制经范围映射后乘以基础速度", () => {
    const anim = makeAnim({
      speed: 2,
      bind: {
        variableId: "speed",
        control: "speed",
        mapping: { type: "range", from: [0, 100], to: [0, 2] },
      },
    });
    expect(resolveAnimationControl(anim, getValue).speedMul).toBeCloseTo(2);
  });

  it("strength 控制输出 0..10 的强度倍率", () => {
    const anim = makeAnim({
      bind: {
        variableId: "speed",
        control: "strength",
        mapping: { type: "range", from: [0, 100], to: [0, 2] },
      },
    });
    expect(resolveAnimationControl(anim, getValue).strengthMul).toBeCloseTo(1);
  });

  it("enabled 控制：0 停、1 播", () => {
    const base = {
      variableId: "",
      control: "enabled" as const,
      mapping: { type: "direct" as const },
    };
    expect(
      resolveAnimationControl(
        makeAnim({ bind: { ...base, variableId: "off" } }),
        getValue
      ).enabled
    ).toBe(false);
    expect(
      resolveAnimationControl(
        makeAnim({ bind: { ...base, variableId: "on" } }),
        getValue
      ).enabled
    ).toBe(true);
  });

  it("变量缺失时回退为固定参数", () => {
    const anim = makeAnim({
      bind: {
        variableId: "missing",
        control: "enabled",
        mapping: { type: "direct" },
      },
    });
    expect(resolveAnimationControl(anim, getValue).enabled).toBe(true);
  });
});

describe("mergeAnimationFrames", () => {
  it("叠加多个动画的旋转/位移并相乘透明度", () => {
    const merged = mergeAnimationFrames(
      { rotation: 30, opacity: 0.8, scaleX: 1.1, scaleY: 1.1 },
      { rotation: 10, opacity: 0.5, dx: 5, dy: -3, hueRotate: 20 }
    );
    expect(merged).toEqual({
      rotation: 40,
      opacity: 0.4,
      dx: 5,
      dy: -3,
      scaleX: 1.1,
      scaleY: 1.1,
      hueRotate: 20,
    });
  });
});
