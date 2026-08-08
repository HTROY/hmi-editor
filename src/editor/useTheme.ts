import { useCallback, useState } from "react";

export type ThemeMode = "dark" | "light";

const STORAGE_KEY = "hmi-editor-theme";

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
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // 隐私模式等场景下忽略持久化失败
      }
      return next;
    });
  }, []);

  return { theme, toggleTheme };
}
