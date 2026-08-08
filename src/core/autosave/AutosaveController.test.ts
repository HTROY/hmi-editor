import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutosaveController, AUTOSAVE_DELAY_MS } from "./AutosaveController";
import { createMemoryAutosaveStore } from "./AutosaveStore";
import type { AutosaveSnapshot } from "./types";

function snapshot(projectName: string): AutosaveSnapshot {
  return {
    schemaVersion: 1,
    savedAt: "2026-01-01T00:00:00.000Z",
    project: {
      meta: {
        name: projectName,
        version: "0.1.0",
        description: "",
        author: "",
        stationName: "",
        lineName: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      pages: [],
    },
    activePageId: "page_1",
    views: {},
  };
}

function countingStore() {
  const inner = createMemoryAutosaveStore();
  let saves = 0;
  return {
    store: {
      async save(s: AutosaveSnapshot) {
        saves++;
        await inner.save(s);
      },
      load: () => inner.load(),
      clear: () => inner.clear(),
    },
    saveCount: () => saves,
  };
}

describe("AutosaveController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("saves only after the debounce delay has passed", async () => {
    const { store } = countingStore();
    const controller = new AutosaveController(store);

    controller.schedule(() => snapshot("工程 A"));
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS - 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(await store.load()).toBeNull();

    vi.advanceTimersByTime(1);
    await vi.advanceTimersByTimeAsync(0);
    expect((await store.load())?.project.meta.name).toBe("工程 A");
  });

  it("resets the timer on repeated schedules and persists only the latest snapshot", async () => {
    const { store, saveCount } = countingStore();
    const controller = new AutosaveController(store);

    controller.schedule(() => snapshot("工程 A"));
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS / 2);
    controller.schedule(() => snapshot("工程 B"));
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS - 1);
    await vi.advanceTimersByTimeAsync(0);

    expect(saveCount()).toBe(0);
    expect(await store.load()).toBeNull();

    vi.advanceTimersByTime(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(saveCount()).toBe(1);
    expect((await store.load())?.project.meta.name).toBe("工程 B");
  });

  it("flush saves immediately and cancels a pending debounce", async () => {
    const { store, saveCount } = countingStore();
    const controller = new AutosaveController(store);

    controller.schedule(() => snapshot("工程 A"));
    controller.flush(() => snapshot("工程 B"));

    expect((await store.load())?.project.meta.name).toBe("工程 B");
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(saveCount()).toBe(1);
  });

  it("dispose cancels a pending save", async () => {
    const { store } = countingStore();
    const controller = new AutosaveController(store);

    controller.schedule(() => snapshot("工程 A"));
    controller.dispose();
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS);
    await vi.advanceTimersByTimeAsync(0);

    expect(await store.load()).toBeNull();
  });

  it("load returns null when no snapshot was stored", async () => {
    const { store } = countingStore();
    const controller = new AutosaveController(store);

    expect(await controller.load()).toBeNull();
  });
});
