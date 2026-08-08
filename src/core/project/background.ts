// ============================================================
// 页面背景色 — 默认值与输入规整
// ============================================================

export const DEFAULT_PAGE_BACKGROUND = "#FFFFFF";

/** 规整用户输入的页面背景色：去空白，空值回落默认色 */
export function sanitizePageBackground(value: string): string {
  const trimmed = value.trim();
  return trimmed === "" ? DEFAULT_PAGE_BACKGROUND : trimmed;
}
