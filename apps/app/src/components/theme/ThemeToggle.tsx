"use client";

import { useTweaks } from "./ThemeProvider";
import { Moon, Sun } from "lucide-react";

export function ThemeToggle() {
  const { t, setTweak } = useTweaks();
  const next = t.theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className="btn btn-sm theme-toggle"
      onClick={() => setTweak("theme", next)}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
    >
      {t.theme === "dark" ? <Sun size={15} aria-hidden="true" /> : <Moon size={15} aria-hidden="true" />}
      <span>{t.theme === "dark" ? "Light" : "Dark"}</span>
    </button>
  );
}
