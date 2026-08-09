import { describe, expect, it } from "vitest";
import { SceneGraph } from "../scene";
import { GroupShape, createShape } from "../shapes";
import { VariableManager } from "../variables";
import { AnimationEngine } from "./AnimationEngine";

describe("AnimationEngine 组内子图元", () => {
  it("嵌套组内子图元动画生成帧状态", () => {
    const scene = new SceneGraph();
    const variables = new VariableManager();
    const engine = new AnimationEngine(scene, variables);
    const inner = new GroupShape({
      id: "inner",
      children: [
        {
          id: "c",
          type: "rect",
          animations: [
            {
              id: "a1",
              type: "blink",
              enabled: true,
              speed: 1,
              params: { frequency: 1, minOpacity: 0.2 },
              bind: null,
            },
          ],
        },
      ].map((c) => createShape(c.type as any, c as any).toJSON()),
    });
    const outer = new GroupShape({
      id: "outer",
      children: [inner.toJSON()],
    });
    scene.add(outer);

    engine.update(500);
    const state = engine.getState().get("c");
    expect(state?.opacity).toBeCloseTo(0.2, 5);
  });
});
