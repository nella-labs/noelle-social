export type ThemeMode = "light" | "dark";
export interface Tweaks { theme: ThemeMode }

export const STORAGE_KEY = "noelle:tweaks";
export const DEFAULTS: Tweaks = { theme: "light" };

/** One resolver keeps persisted mode and the first paint consistent. */
export function resolveTweaks(raw: string | null, defaults: Tweaks): Tweaks {
  try {
    const saved: unknown = raw ? JSON.parse(raw) : null;
    if (saved && typeof saved === "object" && "theme" in saved
        && (saved.theme === "light" || saved.theme === "dark")) return { theme: saved.theme };
  } catch { /* Invalid or unavailable preferences use the default mode. */ }
  return { ...defaults };
}

export function applyTweaks(root: HTMLElement, tweaks: Tweaks) {
  root.setAttribute("data-theme", tweaks.theme);
  root.setAttribute("data-type", "grotesk");
  root.setAttribute("data-density", "regular");
  for (const property of ["--grain", "--scan", "--glow", "--accent"]) root.style.removeProperty(property);
}

function bootstrapTheme(defaults: Tweaks, key: string, resolve: typeof resolveTweaks, apply: typeof applyTweaks) {
  let raw: string | null = null;
  try { raw = localStorage.getItem(key); } catch { /* Storage can be unavailable. */ }
  apply(document.documentElement, resolve(raw, defaults));
}

export const THEME_BOOTSTRAP = `(${bootstrapTheme.toString()})(${JSON.stringify(DEFAULTS)},${JSON.stringify(STORAGE_KEY)},${resolveTweaks.toString()},${applyTweaks.toString()});`;
