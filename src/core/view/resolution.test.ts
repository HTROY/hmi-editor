import { describe, expect, it } from "vitest";
import {
  RESOLUTION_PRESETS,
  findResolutionPreset,
  sanitizeResolution,
  MIN_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "./resolution";

describe("page resolution presets", () => {
  it("exposes presets for common control-room resolutions", () => {
    expect(RESOLUTION_PRESETS.length).toBeGreaterThanOrEqual(4);
    expect(
      RESOLUTION_PRESETS.some((p) => p.width === 1920 && p.height === 1080)
    ).toBe(true);
    expect(
      RESOLUTION_PRESETS.some((p) => p.width === 3840 && p.height === 2160)
    ).toBe(true);
  });

  it("finds the matching preset for an exact resolution", () => {
    const preset = RESOLUTION_PRESETS.find(
      (p) => p.width === 1280 && p.height === 720
    )!;
    expect(findResolutionPreset(1280, 720)).toEqual(preset);
  });

  it("returns null for custom resolutions", () => {
    expect(findResolutionPreset(1440, 900)).toBeNull();
  });

  it("clamps custom sizes to a sane range and rounds to integers", () => {
    expect(sanitizeResolution(50, 5000)).toEqual({
      width: MIN_PAGE_SIZE,
      height: 5000,
    });
    expect(sanitizeResolution(100000, 1080.6)).toEqual({
      width: MAX_PAGE_SIZE,
      height: 1081,
    });
    expect(sanitizeResolution(123.4, 567.8)).toEqual({
      width: 123,
      height: 568,
    });
  });
});
