import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectManager } from "../project/ProjectManager";
import { createShape } from "../shapes";
import { AutosaveController, AUTOSAVE_DELAY_MS } from "./AutosaveController";
import { createMemoryAutosaveStore } from "./AutosaveStore";
import {
  applyAutosaveSnapshot,
  buildAutosaveSnapshot,
  isAutosaveSnapshot,
} from "./snapshot";

describe("自动保存 → 新会话恢复", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("新会话从本地存储恢复上次工程的页面、图元、绑定与每页视图", async () => {
    const store = createMemoryAutosaveStore();

    // 第一次会话：编辑两个页面后停止编辑，防抖自动保存
    const first = new ProjectManager();
    first.newProject();
    const pageA = first.getPages()[0];
    first.getPageScene(pageA.id)!.add(
      createShape("rect", {
        id: "r1",
        bindings: [
          {
            variableId: "STA1_211_IA",
            variableType: "AI",
            targetProp: "fill",
            mapping: { type: "direct" },
          },
        ],
        animations: [{ type: "blink", enabled: true, speed: 2 }],
      })
    );
    vi.advanceTimersByTime(1);
    const { meta: pageB } = first.createPage("配电画面");
    first.activePageId = pageB.id;
    const views = {
      [pageA.id]: { zoom: 2, panX: -50, panY: 30 },
      [pageB.id]: { zoom: 1, panX: 0, panY: 0 },
    };

    const controller = new AutosaveController(store);
    controller.schedule(() =>
      buildAutosaveSnapshot(first, views, first.activePageId)
    );
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS);
    await vi.advanceTimersByTimeAsync(0);

    // 第二次会话：加载快照并恢复
    const second = new ProjectManager();
    const loaded = await controller.load();
    expect(loaded).not.toBeNull();
    expect(isAutosaveSnapshot(loaded)).toBe(true);
    const restoredViews = applyAutosaveSnapshot(second, loaded!);

    expect(second.getPages().map((p) => p.title)).toEqual([
      "主画面",
      "配电画面",
    ]);
    expect(second.activePageId).toBe(pageB.id);
    expect(
      second.getPageScene(pageA.id)!.get("r1")!.bindings[0].variableId
    ).toBe("STA1_211_IA");
    expect(
      second.getPageScene(pageA.id)!.get("r1")!.animations[0].enabled
    ).toBe(true);
    expect(restoredViews[pageA.id]).toEqual({
      zoom: 2,
      panX: -50,
      panY: 30,
    });
    expect(second.getPageScene(pageB.id)!.getAll()).toHaveLength(0);
  });
});
