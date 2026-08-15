import { useCallback } from "react";

/** 客户端生成并下载文件（JSON 字符串 / Blob），返回成功与否。 */
export function useDownload() {
  return useCallback(
    (content: string | Blob, filename: string, mime?: string): boolean => {
      try {
        const blob =
          typeof content === "string"
            ? new Blob([content], { type: mime ?? "application/json" })
            : content;
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
        return true;
      } catch {
        return false;
      }
    },
    []
  );
}
