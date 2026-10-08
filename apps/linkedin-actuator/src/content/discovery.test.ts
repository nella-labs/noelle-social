// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { harvestVisiblePosts, locateDiscoveryCopyLink, locateDiscoveryPostMenu, readDiscoveryMenuShareUrn } from "./discovery.js";
import { isSponsored } from "./selectors.js";

const archived = readFileSync(resolve(process.cwd(), "tests/fixtures/feed-2026-obfuscated.html"), "utf8");
const outsideMenuFixture = readFileSync(resolve(process.cwd(), "tests/fixtures/feed-outside-post-menu-2026.html"), "utf8");
const mount = (html: string) => {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
};

function startOutsideMenuRead(expandedAttribute: string | null = "false") {
  const root = mount(outsideMenuFixture);
  root.querySelector("#interop-outlet")!.attachShadow({ mode: "open" }).innerHTML =
    `<section>${Array.from({ length: 8 }, () => "<button>Other</button>").join("")}</section>`;
  const button = root.querySelector<HTMLButtonElement>("#qualified-card button[aria-label^='Open control menu']")!;
  if (expandedAttribute === null) button.removeAttribute("aria-expanded");
  else button.setAttribute("aria-expanded", expandedAttribute);
  button.getBoundingClientRect = () => DOMRect.fromRect({ x: 20, y: 30, width: 40, height: 20 });
  const candidate = harvestVisiblePosts(root).find((post) => post.authorHandle === "ada")!;
  expect(locateDiscoveryPostMenu(root, candidate.fingerprint).ok).toBe(true);
  return { root, button };
}

describe("visible LinkedIn post extraction", () => {
  it("reads a current URN-less feed card's full expanded body and engagement without opening its menu", () => {
    const root = mount(`<main><div role="list">
      <div role="listitem" componentkey="update-card-focusOpaqueFeedType_MAIN_FEED_RELEVANCE">
        <button aria-label="Open control menu for post by Andreas Horn"></button>
        <a href="/in/andreashorn1/"><span>Andreas Horn</span></a>
        <p><span>12h •</span></p>
        <p><span data-testid="expandable-text-box">First line<br>Second line with
          <a href="https://example.com">a link</a><br>Final line</span></p>
        <span>252 reactions</span><span aria-hidden="true">252 reactions</span>
        <span>50 comments</span><span aria-hidden="true">50 comments</span>
        <button aria-label="Reaction button state: no reaction"></button>
      </div>
    </div></main>`);
    const first = harvestVisiblePosts(root, new Date("2026-09-19T12:00:00Z"));
    const second = harvestVisiblePosts(root, new Date("2026-09-19T12:05:00Z"));
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      authorName: "Andreas Horn",
      authorHandle: "andreashorn1",
      text: "First line\nSecond line with a link\nFinal line",
      reactionCount: 252,
      commentCount: 50,
      postedAt: "2026-09-19T00:00:00.000Z",
    });
    expect(first[0]?.fingerprint).toMatch(/^v1-[0-9a-f]{16}$/);
    expect(first[0]?.fingerprint).toBe(second[0]?.fingerprint);
    expect(first[0]?.urn).toBeUndefined();
    expect(first[0]?.url).toBeUndefined();
  });

  it("reads the full DOM text from a card with a More button and keeps its identity after expansion", () => {
    const root = mount(`<main><div role="listitem" componentkey="update-card-focusOpaqueFeedType_MAIN_FEED_RELEVANCE">
      <button aria-label="Open control menu for post by Ada Lovelace"></button>
      <a href="/in/ada/">Ada Lovelace</a>
      <p><span data-testid="expandable-text-box">A promising excerpt<br>and the rest of the post
        <button data-testid="expandable-text-button" aria-hidden="true">… more</button>
      </span></p>
      <span>252 reactions</span><span>50 comments</span>
      <button aria-label="Reaction button state: no reaction"></button>
    </div></main>`);
    const collapsed = harvestVisiblePosts(root)[0];
    expect(collapsed).toMatchObject({
      text: "A promising excerpt\nand the rest of the post",
      reactionCount: 252,
      commentCount: 50,
    });
    root.querySelector("[data-testid='expandable-text-button']")?.remove();
    expect(harvestVisiblePosts(root)[0]?.fingerprint).toBe(collapsed?.fingerprint);
  });

  it("counts named reactions in the current feed markup without counting the hidden duplicate", () => {
    const root = mount(`<main><div role="listitem">
      <button aria-label="Open control menu for post by Ada Lovelace"></button>
      <a href="/in/ada/">Ada Lovelace</a>
      <span data-testid="expandable-text-box">A concrete engineering lesson.</span>
      <a href="/feed/"><p><span>
        <span>Grace Hopper and 46 others reacted</span>
        <span aria-hidden="true">Grace Hopper and 46 others</span>
      </span></p></a>
      <button><span>22 comments</span><span aria-hidden="true">22 comments</span></button>
      <button aria-label="Reaction button state: no reaction"></button>
    </div></main>`);
    expect(harvestVisiblePosts(root)[0]).toMatchObject({ reactionCount: 47, commentCount: 22 });
  });

  it("ignores malformed engagement labels rather than storing an invalid count", () => {
    const root = mount(`<div role="listitem">
      <button aria-label="Open control menu for post by Ada Lovelace"></button>
      <a href="/in/ada/">Ada Lovelace</a>
      <span data-testid="expandable-text-box">A concrete lesson.</span>
      <span>... reactions</span><span>... comments</span>
      <button aria-label="Reaction button state: no reaction"></button>
    </div>`);
    expect(harvestVisiblePosts(root)[0]).toMatchObject({ reactionCount: 0, commentCount: 0 });
  });

  it("keeps older visible posts eligible, defaults absent engagement to zero, and deduplicates identical cards", () => {
    const card = `<div role="listitem" componentkey="update-card-focusOpaqueFeedType_MAIN_FEED_RELEVANCE">
      <button aria-label="Open control menu for post by Ada Lovelace"></button>
      <a href="/in/ada/">Ada Lovelace</a><p><span>2h •</span></p>
      <p><span data-testid="expandable-text-box">A complete idea worth discussing.</span></p>
      <button aria-label="Reaction button state: no reaction"></button></div>`;
    const posts = harvestVisiblePosts(mount(`<main>${card}${card}</main>`), new Date("2026-09-19T12:00:00Z"));
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ reactionCount: 0, commentCount: 0, postedAt: "2026-09-19T10:00:00.000Z" });
  });

  it("locates only the qualified visible card's post menu by its fingerprint", () => {
    const root = mount(`<main><div role="listitem">
      <button aria-label="Open control menu for post by Ada Lovelace"></button>
      <a href="/in/ada/">Ada</a><span data-testid="expandable-text-box">First idea</span>
      <button aria-label="Reaction button state: no reaction"></button>
      </div><div role="listitem">
      <button aria-label="Open control menu for post by Grace Hopper"></button>
      <a href="/in/grace/">Grace</a><span data-testid="expandable-text-box">Second idea</span>
      <button aria-label="Reaction button state: no reaction"></button>
    </div></main>`);
    const second = root.querySelectorAll<HTMLButtonElement>("button[aria-label^='Open control menu']")[1]!;
    second.getBoundingClientRect = () => DOMRect.fromRect({ x: 20, y: 30, width: 40, height: 20 });
    const posts = harvestVisiblePosts(root);
    expect(posts).toHaveLength(2);
    expect(locateDiscoveryPostMenu(root, posts[1]!.fingerprint)).toMatchObject({
      ok: true, x: 40, y: 40, rect: { x: 20, y: 30, width: 40, height: 20 },
    });
    expect(locateDiscoveryPostMenu(root, "v1-not-on-page")).toMatchObject({
      ok: false, skipReason: "qualified-post-not-visible",
    });
  });

  it("reads a canonical share URN from the opened menu without opening the embed modal", () => {
    const root = mount(`<main><div id="interop-outlet"></div></main>`);
    root.querySelector("#interop-outlet")!.attachShadow({ mode: "open" }).innerHTML = `
      <a role="menuitem" href="https://evil.example/preload/embed-modal/?targetUrn=urn%3Ali%3Ashare%3A1111111111111111111">Embed this post</a>
      <a role="menuitem" href="https://www.linkedin.com/preload/embed-modal/?targetUrn=urn%3Ali%3Ashare%3A7506985844398911488">Embed this post</a>`;
    expect(readDiscoveryMenuShareUrn(root)).toEqual({ ok: true, urn: "urn:li:share:7506985844398911488" });
  });

  it("reads one direct activity permalink from the visible opened post menu", () => {
    const root = mount(`<main><div id="interop-outlet"></div></main>`);
    root.querySelector("#interop-outlet")!.attachShadow({ mode: "open" }).innerHTML = `
      <div role="menu">
        <a role="menuitem" href="/feed/update/urn:li:activity:7506985844398911488/">View post</a>
        <a role="menuitem" href="https://www.linkedin.com/posts/ada_story-activity-7506985844398911488-XyZ?utm_source=feed">Copy link</a>
      </div>`;
    expect(readDiscoveryMenuShareUrn(root)).toEqual({ ok: true, urn: "urn:li:activity:7506985844398911488" });
  });

  it("reads a direct permalink from a wrapperless open shadow menu", () => {
    const root = mount(`<main><div role="listitem">
      <a href="/feed/update/urn:li:activity:1111111111111111111/">Cited post</a>
    </div><div id="interop-outlet"></div></main>`);
    root.querySelector("#interop-outlet")!.attachShadow({ mode: "open" }).innerHTML = `
      <a role="menuitem" href="/feed/update/urn:li:activity:7506985844398911488/">View post</a>`;
    expect(readDiscoveryMenuShareUrn(root)).toEqual({ ok: true, urn: "urn:li:activity:7506985844398911488" });
  });

  it("uses a roleless open shadow menu instead of unrelated page menus", () => {
    const root = mount(`<main>
      <div role="menu"><a href="/feed/update/urn:li:activity:1111111111111111111/">Navigation</a></div>
      <div role="menu"><a href="/feed/update/urn:li:activity:2222222222222222222/">Other navigation</a></div>
      <div role="listitem"><a href="/feed/update/urn:li:activity:3333333333333333333/">Cited post</a></div>
      <div id="interop-outlet"></div>
    </main>`);
    root.querySelector("#interop-outlet")!.attachShadow({ mode: "open" }).innerHTML = `
      <section><button>Save</button><button>Hide</button>
        <div data-clipboard-text="https://www.linkedin.com/feed/update/urn:li:activity:7506985844398911488/">
          <button>Copy</button>
        </div>
      </section>`;
    expect(readDiscoveryMenuShareUrn(root)).toEqual({ ok: true, urn: "urn:li:activity:7506985844398911488" });
  });

  it("keeps embed and activity identities inside the opened overlay", () => {
    const root = mount(`<main>
      <a role="menuitem" href="https://www.linkedin.com/preload/embed-modal/?targetUrn=urn%3Ali%3Ashare%3A1111111111111111111">Cited embed</a>
      <div id="interop-outlet"></div>
    </main>`);
    root.querySelector("#interop-outlet")!.attachShadow({ mode: "open" }).innerHTML = `
      <button data-url="/feed/update/urn:li:activity:7506985844398911488/">Copy</button>`;
    expect(readDiscoveryMenuShareUrn(root)).toEqual({ ok: true, urn: "urn:li:activity:7506985844398911488" });
  });

  it("rejects conflicting or foreign roleless menu data links", () => {
    const root = mount(`<main><div id="interop-outlet"></div></main>`);
    const shadow = root.querySelector("#interop-outlet")!.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <button data-url="https://evil.example/feed/update/urn:li:activity:1111111111111111111/">Foreign</button>
      <button data-url="/feed/update/urn:li:activity:7506985844398911488/">Copy</button>
      <button data-clipboard-text="https://www.linkedin.com/posts/other-activity-4444444444444444444-aBcD">View</button>`;
    expect(readDiscoveryMenuShareUrn(root)).toMatchObject({ ok: false, skipReason: "ambiguous-menu-activity" });
    shadow.lastElementChild!.setAttribute("hidden", "");
