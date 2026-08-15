import { useCallback, useState } from "react";
import { browserStorage } from "./platform/browserPorts";
import { createStorage } from "../core/platform/storage";

export type ThemeMode = "dark" | "light";

// 键保持 hmi-editor-theme 不变（F17：统一走 platform/storage）
const storage = createStorage("", browserStorage);
const THEME_KEY = "hmi-editor-theme";

function getInitialTheme(): ThemeMode {
  if (typeof document === "undefined") return "dark";
  const stored = document.documentElement.getAttribute("data-theme");
  return stored === "light" || stored === "dark" ? stored : "dark";
}

export function useTheme() {
  const [theme, setTheme] = useState<ThemeMode>(getInitialTheme);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next: ThemeMode = prev === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      // 隐私模式等场景下忽略持久化失败
      storage.set(THEME_KEY, next);
      return next;
    });
  }, []);

  return { theme, toggleTheme };
}
