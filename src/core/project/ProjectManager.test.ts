import { describe, expect, it } from "vitest";
import { ProjectManager } from "./ProjectManager";

describe("ProjectManager.setPageBackground", () => {
  it("updates the page background and marks the project dirty", () => {
    const pm = new ProjectManager();
    pm.newProject();
    const pageId = pm.activePageId;

    pm.setPageBackground(pageId, "#0c1520");

    expect(pm.getPageMeta(pageId)?.background).toBe("#0c1520");
    expect(pm.dirty).toBe(true);
  });

  it("keeps the existing background when the page does not exist", () => {
    const pm = new ProjectManager();
    pm.newProject();
    const before = pm.getPageMeta(pm.activePageId)?.background;

    pm.setPageBackground("missing_page", "#000000");

    expect(pm.getPageMeta(pm.activePageId)?.background).toBe(before);
    expect(pm.dirty).toBe(false);
  });
});
