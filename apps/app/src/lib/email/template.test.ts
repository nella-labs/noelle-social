// @vitest-environment jsdom

import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildEmailHtml } from "./template.mjs";

describe("Noelle email identity", () => {
  it.each([true, false])("renders one accessible raster lockup for transactional=%s", (transactional) => {
    const email = document.createElement("div");
    email.innerHTML = buildEmailHtml({
      body: '<p data-message="true">Your message stays here.</p>',
      transactional,
    });
    const logo = email.querySelector<HTMLImageElement>('img[alt="Noelle"]');
    expect(logo).not.toBeNull();
    const url = new URL(logo!.src);
    expect(url.protocol).toBe("https:");
    expect(url.pathname).toBe("/brand/noelle-lockup-white.png");
    expect(url.searchParams.get("v")).toBe("geometric-1");
    expect(existsSync(path.resolve("public", url.pathname.slice(1)))).toBe(true);
    expect(logo!.parentElement?.textContent).not.toMatch(/\bNoelle\b/);
    expect(email.querySelector("[data-message]")?.textContent).toBe("Your message stays here.");
  });
});
