"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { applyTweaks, DEFAULTS, resolveTweaks, STORAGE_KEY, type Tweaks } from "./theme-preferences";
export type { ThemeMode, Tweaks } from "./theme-preferences";

type Ctx = {
  t: Tweaks;
  setTweak: <K extends keyof Tweaks>(key: K, value: Tweaks[K]) => void;
  reset: () => void;
};

const TweaksCtx = createContext<Ctx | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [t, setT] = useState<Tweaks>(DEFAULTS);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      setT(resolveTweaks(raw, DEFAULTS));
    } catch {
      // ignore parse errors — fall back to defaults
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    applyTweaks(document.documentElement, t);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...t, version: 3 }));
    } catch {
      // localStorage may be disabled (private browsing); non-fatal
    }
  }, [t, hydrated]);

  const setTweak = useCallback<Ctx["setTweak"]>((key, value) => {
    setT((prev) => ({ ...prev, [key]: value }));
  }, []);

  const reset = useCallback(() => setT(DEFAULTS), []);

  const value = useMemo<Ctx>(() => ({ t, setTweak, reset }), [t, setTweak, reset]);

  return <TweaksCtx.Provider value={value}>{children}</TweaksCtx.Provider>;
}

export function useTweaks(): Ctx {
  const ctx = useContext(TweaksCtx);
  if (!ctx) throw new Error("useTweaks must be used inside <ThemeProvider>");
  return ctx;
}
