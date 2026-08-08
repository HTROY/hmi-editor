import { describe, expect, it } from "vitest";
import { DEFAULT_PAGE_BACKGROUND, sanitizePageBackground } from "./background";

describe("sanitizePageBackground", () => {
  it("keeps a valid hex color unchanged", () => {
    expect(sanitizePageBackground("#1A1A2E")).toBe("#1A1A2E");
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizePageBackground("  #0c1520  ")).toBe("#0c1520");
  });

  it("falls back to the default when empty", () => {
    expect(sanitizePageBackground("")).toBe(DEFAULT_PAGE_BACKGROUND);
    expect(sanitizePageBackground("   ")).toBe(DEFAULT_PAGE_BACKGROUND);
  });

  it("accepts other CSS color forms unchanged", () => {
    expect(sanitizePageBackground("rgb(7, 13, 20)")).toBe("rgb(7, 13, 20)");
  });
});
