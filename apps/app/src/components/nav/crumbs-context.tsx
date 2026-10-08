"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

/**
 * Lets a deeply-nested page replace one breadcrumb segment with a friendlier
 * label (e.g. an agent UUID → "Vega"). The Provider sits in the org layout
 * so `OrgCrumbs` (above the page) and `SetCrumb` (rendered from the page)
 * share a single override map.
 */
type CrumbsCtx = {
  overrides: Record<string, string>;
  setOverride: (segment: string, label: string) => void;
  clearOverride: (segment: string) => void;
};

const Ctx = createContext<CrumbsCtx | null>(null);

export function CrumbsProvider({ children }: { children: React.ReactNode }) {
  const [overrides, setOverrides] = useState<Record<string, string>>({});

  const setOverride = useCallback((segment: string, label: string) => {
    setOverrides((prev) => (prev[segment] === label ? prev : { ...prev, [segment]: label }));
  }, []);

  const clearOverride = useCallback((segment: string) => {
    setOverrides((prev) => {
      if (!(segment in prev)) return prev;
      const { [segment]: _drop, ...rest } = prev;
      return rest;
    });
  }, []);

  return <Ctx.Provider value={{ overrides, setOverride, clearOverride }}>{children}</Ctx.Provider>;
}

export function useCrumbOverrides(): Record<string, string> {
  return useContext(Ctx)?.overrides ?? {};
}

export function useSetCrumb(segment: string, label: string | null | undefined) {
  const ctx = useContext(Ctx);
  const setOverride = ctx?.setOverride;
  const clearOverride = ctx?.clearOverride;
  useEffect(() => {
    if (!setOverride || !clearOverride || !label) return;
    setOverride(segment, label);
    return () => clearOverride(segment);
  }, [setOverride, clearOverride, segment, label]);
}
