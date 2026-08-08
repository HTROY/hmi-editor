export interface ResolutionPreset {
  label: string;
  width: number;
  height: number;
}

export const MIN_PAGE_SIZE = 64;
export const MAX_PAGE_SIZE = 8192;

export const RESOLUTION_PRESETS: ResolutionPreset[] = [
  { label: "1920×1080 (1080p)", width: 1920, height: 1080 },
  { label: "3840×2160 (4K)", width: 3840, height: 2160 },
  { label: "1366×768", width: 1366, height: 768 },
  { label: "1280×720 (720p)", width: 1280, height: 720 },
  { label: "1024×768 (XGA)", width: 1024, height: 768 },
];

/** 精确匹配预设；自定义分辨率返回 null */
export function findResolutionPreset(
  width: number,
  height: number
): ResolutionPreset | null {
  return (
    RESOLUTION_PRESETS.find((p) => p.width === width && p.height === height) ??
    null
  );
}

/** 校验并规范化自定义分辨率：取整并限制在合理范围 */
export function sanitizeResolution(
  width: number,
  height: number
): { width: number; height: number } {
  const w = Math.round(width) || MIN_PAGE_SIZE;
  const h = Math.round(height) || MIN_PAGE_SIZE;
  return {
    width: Math.min(MAX_PAGE_SIZE, Math.max(MIN_PAGE_SIZE, w)),
    height: Math.min(MAX_PAGE_SIZE, Math.max(MIN_PAGE_SIZE, h)),
  };
}
