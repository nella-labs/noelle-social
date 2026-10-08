import type { NextConfig } from "next";

const sdkPackages = ["@noelle/runtime", "@noelle/secrets"];

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@noelle/agents", "@noelle/contracts", "@noelle/types", "@noelle/ui"],
  serverExternalPackages: ["@supabase/ssr", ...sdkPackages],
  outputFileTracingIncludes: { "/*": ["src/lib/supabase/api-session-worker.mjs"] },
  // ⚠️ Build/dev run with `--webpack` (see package.json scripts). Next 16 defaults
  // to Turbopack, but ~71 source files import with explicit `.js` extensions that
  // this extensionAlias resolves to `.ts`/`.tsx`; Turbopack would change that
  // resolution. Keep Webpack until those imports are migrated. A `webpack` key
  // here also makes `next build` (Turbopack) fail fast, which is the intent.
  webpack: (cfg, { isServer, nextRuntime }) => {
    if (isServer && nextRuntime === "nodejs") {
      // Workspace symlinks resolve outside node_modules; keep SDK workers in their ESM package.
      const externalSdkPackages = (
        { request }: { request?: string },
        callback: (error?: Error | null, result?: string) => void,
      ) => {
        if (sdkPackages.some((name) => request === name || request?.startsWith(`${name}/`))) {
          callback(null, `module ${request}`);
        } else callback();
      };
      const externals = cfg.externals ?? [];
      cfg.externals = [
        externalSdkPackages,
        ...(Array.isArray(externals) ? externals : [externals]),
      ];
    }
    cfg.resolve = cfg.resolve ?? {};
    (cfg.resolve as { extensionAlias?: Record<string, string[]> }).extensionAlias = {
      ".js": [".ts", ".tsx", ".js", ".jsx"],
      ".mjs": [".mts", ".mjs"],
    };
    return cfg;
  },
};

export default config;
