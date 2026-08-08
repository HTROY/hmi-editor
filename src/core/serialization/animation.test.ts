import { describe, expect, it } from "vitest";
import { Serializer } from "./Serializer";
import { SceneGraph } from "../scene";
import { createShape } from "../shapes";

describe("动画与绑定随工程保存恢复", () => {
  it("导出/导入保留五类动画参数与变量控制", () => {
    const scene = new SceneGraph();
    const rect = createShape("rect", {
      id: "r1",
      animations: [
        {
          id: "a1",
          type: "blink",
          enabled: true,
          speed: 1,
          params: { frequency: 2, minOpacity: 0.1 },
          bind: {
            variableId: "STA1_FAN_1_STATUS",
            control: "enabled",
            mapping: { type: "direct" },
          },
        },
        {
          id: "a2",
          type: "move",
          enabled: true,
          speed: 1.5,
          params: {
            amplitudeX: 30,
            amplitudeY: 5,
            moveFrequency: 0.5,
            phase: 1,
          },
          bind: null,
        },
      ],
      bindings: [
        {
          variableId: "STA1_FAN_1_SPEED",
          variableType: "AI",
          targetProp: "rotation",
          mapping: { type: "range", from: [0, 3000], to: [0, 360] },
          smooth: true,
          smoothMs: 500,
        },
      ],
    });
    scene.add(rect);

    const page = Serializer.exportPage(scene, { id: "pg1", title: "动画页" });
    const restored = Serializer.importPage(page);
    const r = restored.get("r1")!;

    expect(r.animations).toHaveLength(2);
    expect(r.animations[0]).toEqual(rect.animations[0]);
    expect(r.animations[1]).toEqual(rect.animations[1]);
    expect(r.bindings).toEqual(rect.bindings);
  });

  it("旧工程动画缺少 id/params 时导入自动补默认值", () => {
    const page = {
      id: "old",
      title: "旧画面",
      width: 800,
      height: 600,
      background: "#FFFFFF",
      shapes: [
        {
          id: "r1",
          type: "rect",
          animations: [
            { type: "blink", enabled: true, speed: 1 },
            { type: "rotate", bindVariable: "STA1_FAN_1_STATUS" },
          ],
        },
      ],
    } as never;

    const scene = Serializer.importPage(page);
    const anims = scene.get("r1")!.animations;
    expect(anims[0].id).toBeTruthy();
    expect(anims[0].params).toEqual({ frequency: 1, minOpacity: 0.2 });
    expect(anims[1].bind?.variableId).toBe("STA1_FAN_1_STATUS");
    expect(anims[1].params).toEqual({ angleSpeed: 60, direction: 1 });
  });
});
