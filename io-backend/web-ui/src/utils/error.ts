/** 把任意异常归一化为可展示的文本（替代散落的 `catch (e: any)` + 手写拼接）。 */
export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e != null) return String(e);
  return "未知错误";
}
