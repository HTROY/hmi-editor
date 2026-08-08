import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectManager } from "../project/ProjectManager";
import { createShape } from "../shapes";
import {
  applyAutosaveSnapshot,
  buildAutosaveSnapshot,
  defaultPageViews,
  isAutosaveSnapshot,
  normalizePageView,
} from "./snapshot";
import { DEFAULT_PAGE_VIEW } from "./types";

function makeProject(): ProjectManager {
  const pm = new ProjectManager();
  pm.newProject();
  const pageA = pm.getPages()[0];
  const sceneA = pm.getPageScene(pageA.id)!;
  sceneA.add(
    createShape("rect", {
      id: "r1",
      x: 10,
      y: 20,
      width: 120,
      height: 80,
      bindings: [
        {
          variableId: "STA1_211_IA",
          variableType: "AI",
          targetProp: "fill",
          mapping: { type: "range", from: [0, 2000], to: [0, 255] },
        },
      ],
      animations: [{ type: "blink", enabled: true, speed: 2 }],
    })
  );
  // createPage 用毫秒时间戳生成 id，需推进时钟避免同毫秒碰撞
  vi.advanceTimersByTime(1);
  const { meta: pageB } = pm.createPage("配电画面");
  const sceneB = pm.getPageScene(pageB.id)!;
  sceneB.add(createShape("path", { id: "p1", d: "M0 0 H100 V80 Z" }));
  pm.activePageId = pageB.id;
  return pm;
}

describe("autosave snapshot", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("round-trips project data, active page and per-page views", () => {
    const pm = makeProject();
    const pages = pm.getPages();
    const views = {
      [pages[0].id]: { zoom: 1.5, panX: -120, panY: 80 },
      [pages[1].id]: { ...DEFAULT_PAGE_VIEW },
    };

    const snapshot = buildAutosaveSnapshot(pm, views, pages[1].id);
    const restored = new ProjectManager();
    const restoredViews = applyAutosaveSnapshot(restored, snapshot);

    expect(snapshot.schemaVersion).toBe(1);
    expect(restored.getPages().map((p) => p.title)).toEqual([
      "主画面",
      "配电画面",
    ]);
    expect(restored.activePageId).toBe(pages[1].id);
    expect(restored.activePage?.meta.width).toBe(1920);
    expect(restored.activePage?.scene.getAll().map((s) => s.id)).toEqual([
      "p1",
    ]);

    const r1 = restored.getPageScene(pages[0].id)!.get("r1")!;
    expect(r1.bindings).toEqual([
      {
        variableId: "STA1_211_IA",
        variableType: "AI",
        targetProp: "fill",
        mapping: { type: "range", from: [0, 2000], to: [0, 255] },
      },
    ]);
    expect(r1.animations).toEqual([{ type: "blink", enabled: true, speed: 2 }]);

    expect(restoredViews[pages[0].id]).toEqual({
      zoom: 1.5,
      panX: -120,
      panY: 80,
    });
    expect(restoredViews[pages[1].id]).toEqual(DEFAULT_PAGE_VIEW);
  });

  it("normalizes invalid view entries to defaults", () => {
    expect(normalizePageView({ zoom: -2, panX: Number.NaN, panY: 5 })).toEqual({
      zoom: 1,
      panX: 0,
      panY: 5,
    });
    expect(normalizePageView({ zoom: 20, panX: 0, panY: 0 })).toEqual(
      DEFAULT_PAGE_VIEW
    );
    expect(normalizePageView(null)).toEqual(DEFAULT_PAGE_VIEW);
    expect(normalizePageView(undefined)).toEqual(DEFAULT_PAGE_VIEW);
  });

  it("drops views for unknown pages and fills defaults for every restored page", () => {
    const pm = makeProject();
    const pages = pm.getPages();
    const snapshot = buildAutosaveSnapshot(
      pm,
      {
        ghost: { zoom: 2, panX: 10, panY: 10 },
      },
      pm.activePageId
    );

    const restored = new ProjectManager();
    const restoredViews = applyAutosaveSnapshot(restored, snapshot);

    expect(Object.keys(restoredViews)).toEqual(pages.map((p) => p.id));
    expect(restoredViews.ghost).toBeUndefined();
    for (const view of Object.values(restoredViews)) {
      expect(view).toEqual(DEFAULT_PAGE_VIEW);
    }
  });

  it("keeps recent files untouched when restoring", () => {
    const pm = makeProject();
    const snapshot = buildAutosaveSnapshot(pm, {}, pm.activePageId);
    const recent = [
      {
        path: "C:/old/工程.hmi.json",
        name: "旧工程",
        openedAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    const restored = new ProjectManager();
    restored.recentFiles = [...recent];
    applyAutosaveSnapshot(restored, snapshot);

    expect(restored.recentFiles).toEqual(recent);
  });

  it("rejects malformed snapshots", () => {
    expect(isAutosaveSnapshot(null)).toBe(false);
    expect(isAutosaveSnapshot("oops")).toBe(false);
    expect(
      isAutosaveSnapshot({
        schemaVersion: 99,
        project: {},
        activePageId: "p1",
        views: {},
      })
    ).toBe(false);
    expect(
      isAutosaveSnapshot({
        schemaVersion: 1,
        savedAt: "2026-01-01T00:00:00.000Z",
        project: { meta: {}, pages: "oops" },
        activePageId: "p1",
        views: {},
      })
    ).toBe(false);
  });

  it("defaultPageViews returns a default view for every page", () => {
    const pm = makeProject();
    const views = defaultPageViews(pm);
    expect(Object.keys(views)).toEqual(pm.getPages().map((p) => p.id));
    expect(views[pm.activePageId]).toEqual(DEFAULT_PAGE_VIEW);
  });
});
