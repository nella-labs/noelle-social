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
    expect(readDiscoveryMenuShareUrn(root)).toEqual({ ok: true, urn: "urn:li:activity:7506985844398911488" });
  });

  it("accepts a single /posts/ permalink in an opened body menu", () => {
    const root = mount(`<div role="menu"><a role="menuitem"
      href="https://linkedin.com/posts/ada_story-activity-7506985844398911488-AbCd">Copy link</a></div>`);
    expect(readDiscoveryMenuShareUrn(root)).toEqual({ ok: true, urn: "urn:li:activity:7506985844398911488" });
  });

  it("ignores cited, hidden, and foreign links, then rejects conflicting menu identities", () => {
    const root = mount(`<main>
      <div role="listitem"><span data-testid="expandable-text-box">
        <a href="/posts/other_story-activity-1111111111111111111-AbCd">Cited post</a>
      </span></div>
      <div role="menu" hidden><a role="menuitem" href="/feed/update/urn:li:activity:2222222222222222222/">Hidden</a></div>
      <div id="interop-outlet"></div>
    </main>`);
    const shadow = root.querySelector("#interop-outlet")!.attachShadow({ mode: "open" });
    shadow.innerHTML = `<div role="menu">
      <a role="menuitem" href="https://www.linkedin.com.evil.example/feed/update/urn:li:activity:3333333333333333333/">Foreign</a>
      <a role="menuitem" href="/feed/update/urn:li:activity:7506985844398911488/">Current post</a>
    </div>`;
    expect(readDiscoveryMenuShareUrn(root)).toEqual({ ok: true, urn: "urn:li:activity:7506985844398911488" });
    shadow.querySelector("[role=menu]")!.insertAdjacentHTML("beforeend",
      `<a role="menuitem" href="/posts/other_story-activity-4444444444444444444-AbCd">Different post</a>`);
    expect(readDiscoveryMenuShareUrn(root)).toMatchObject({ ok: false, skipReason: "ambiguous-menu-activity" });
  });

  it("rejects a body citation or a permalink outside a visible open post menu", () => {
    const root = mount(`<main>
      <div role="listitem"><span data-testid="expandable-text-box">
        <a href="/feed/update/urn:li:activity:7506985844398911488/">Cited post</a>
      </span></div>
      <div role="menu" aria-hidden="true">
        <a role="menuitem" href="/feed/update/urn:li:activity:7506985844398911488/">Hidden menu</a>
      </div>
    </main>`);
    expect(readDiscoveryMenuShareUrn(root)).toMatchObject({ ok: false, skipReason: "embed-link-not-found" });
  });

  it("describes a missing embed link without leaking menu text, IDs, or URL values", () => {
    const root = mount(`<main><div id="interop-outlet"></div></main>`);
    root.querySelector("#interop-outlet")!.attachShadow({ mode: "open" }).innerHTML = `
      <div role="menu">
        <a role="menuitem" aria-label="Copy link for Jane Doe"
          href="https://www.linkedin.com/sharing/share-offsite/?targetUrn=secret-value&privateKey=abc123">Copy link to Jane Doe's post</a>
        <button role="menuitem" aria-label="Embed this post by Jane Doe">Embed this post</button>
        <button role="menuitem">Share with Jane Doe</button>
      </div>`;
    const result = readDiscoveryMenuShareUrn(root);
    expect(result).toMatchObject({ ok: false, skipReason: "embed-link-not-found" });
    expect(result.diagnostic).toContain("shadow=open");
    expect(result.diagnostic).toContain("copy-link");
    expect(result.diagnostic).toContain("embed");
    expect(result.diagnostic).toContain("share");
    expect(result.diagnostic).toContain("targetUrn");
    expect(result.diagnostic?.length).toBeLessThanOrEqual(600);
    for (const privateValue of ["Jane", "Doe", "7506985844398911488", "secret-value", "privateKey", "abc123", "https://"]) {
      expect(result.diagnostic).not.toContain(privateValue);
    }
  });

  it("reads a link held beyond the first four wrapperless controls", () => {
    const root = mount(`<main><div id="interop-outlet"></div></main>`);
    root.querySelector("#interop-outlet")!.attachShadow({ mode: "open" }).innerHTML = `
      <section><button>Save</button><button>Follow</button><button>Hide</button><button>Report</button>
        <div data-clipboard-text="https://www.linkedin.com/feed/update/urn:li:activity:7506985844398911488/">
          <button aria-label="Copy link to Jane Doe's post">Copy link</button>
        </div>
      </section>`;
    expect(readDiscoveryMenuShareUrn(root)).toEqual({ ok: true, urn: "urn:li:activity:7506985844398911488" });
  });

  it("detects a nonsemantic copy control without recording its URL", () => {
    const root = mount(`<main><div id="interop-outlet"></div></main>`);
    root.querySelector("#interop-outlet")!.attachShadow({ mode: "open" }).innerHTML = `
      <section><button>Save</button><button>Follow</button><button>Hide</button><button>Report</button>
        <div data-url="https://evil.example/feed/update/urn:li:activity:7506985844398911488/">
          <span>Copy link</span>
        </div>
      </section>`;
    const diagnostic = readDiscoveryMenuShareUrn(root).diagnostic;
    expect(diagnostic).toContain("h=span/copy-link[pdu]");
    expect(diagnostic).not.toContain("7506985844398911488");
  });

  it("reports all eight roleless overlay controls and card anchor shapes without values", () => {
    const root = mount(`<main><div role="listitem">
      <button aria-label="Open control menu for post by Jane Doe"></button>
      <a href="/in/jane-doe/">Jane Doe</a>
      <span data-testid="expandable-text-box">A private post body
        <a href="/posts/other-activity-1111111111111111111-XyZ">Cited post</a>
      </span>
    </div><div id="interop-outlet"></div></main>`);
    root.querySelector("#interop-outlet")!.attachShadow({ mode: "open" }).innerHTML = `
      <section>
        <button data-testid="secret-test-value" aria-label="Save Jane Doe">Save</button>
        <button data-control-name="secret-control-value">Hide</button>
        <button data-tracking-control-name="secret-tracking-value">Follow</button>
        <button data-action="secret-action-value">Report</button>
        <button title="Jane Doe's post">Mute</button>
        <button data-url="https://evil.example/private/secret-value">Copy</button>
        <button aria-label="Jane Doe private menu option">Other</button>
        <button>Last</button>
      </section>`;
    const result = readDiscoveryMenuShareUrn(root);
    expect(result).toMatchObject({ ok: false, skipReason: "embed-link-not-found" });
    const diagnostic = result.diagnostic!;
    expect(diagnostic).toContain("items=0:");
    expect(diagnostic).toContain("|1:");
    expect(diagnostic).toContain("|2:");
    expect(diagnostic).toContain("|3:");
    expect(diagnostic).toContain("|4:");
    expect(diagnostic).toContain("|5:");
    expect(diagnostic).toContain("|6:");
    expect(diagnostic).toContain("|7:");
    expect(diagnostic).toContain("dt");
    expect(diagnostic).toContain("cn");
    expect(diagnostic).toContain("tn");
    expect(diagnostic).toContain("da");
    expect(diagnostic).toContain("cards=1");
    expect(diagnostic).toContain("body:posts");
    expect(diagnostic.length).toBeLessThanOrEqual(600);
    for (const privateValue of ["Jane", "Doe", "jane-doe", "1111111111111111111", "secret", "https://", "A private post body"]) {
      expect(diagnostic).not.toContain(privateValue);
    }
  });

  it("keeps the card summary when eight controls exhaust the diagnostic budget", () => {
    const root = mount(`<main><div role="listitem">
      <button aria-label="Open control menu for post by Jane Doe"></button>
      <a href="/in/jane-doe/">Jane Doe</a>
    </div><div id="interop-outlet"></div></main>`);
    root.querySelector("#interop-outlet")!.attachShadow({ mode: "open" }).innerHTML = `
      <section>${Array.from({ length: 8 }, () => `
        <div data-url="opaque" data-clipboard-text="opaque">
          <a role="menuitem" aria-label="Copy link for Jane Doe" title="Jane Doe"
            data-url="opaque" data-clipboard-text="opaque" data-testid="private-value"
            data-control-name="private-value" data-tracking-control-name="private-value" data-action="private-value"
            href="https://www.linkedin.com/posts/opaque?targetUrn=private-value&url=private-value&private=private-value">Copy link</a>
        </div>`).join("")}</section>`;
    const diagnostic = readDiscoveryMenuShareUrn(root).diagnostic!;
    expect(diagnostic.length).toBeLessThanOrEqual(600);
    expect(diagnostic).toContain("cards=1;anchors=header:other");
    expect(diagnostic).not.toContain("Jane");
    expect(diagnostic).not.toContain("private-value");
  });

  it("categorizes roleless overlay actions and reports visible menu candidates outside the outlet", () => {
    const root = mount(`<main>
      <div id="interop-outlet"></div>
      <div role="dialog" aria-label="Private Jane Doe menu">
        <button aria-label="Follow Jane Doe">Follow</button>
        <a href="https://example.com/private/secret?name=Jane">Other</a>
      </div>
    </main>`);
    root.querySelector("#interop-outlet")!.attachShadow({ mode: "open" }).innerHTML = `
      <button aria-label="Copy link to Jane Doe's post">Copy link</button>
      <button>Embed this post</button><button>Share</button><button>Save</button>
      <button>Hide this post</button><button>Report Jane Doe</button>
      <button>Follow Jane Doe</button><button>View post</button>`;
    const diagnostic = readDiscoveryMenuShareUrn(root).diagnostic!;
    for (const action of ["copy-link", "embed", "share", "save", "hide", "report", "follow", "view-post"]) {
      expect(diagnostic).toContain(action);
    }
    expect(diagnostic).toContain("outside=1:div/dialog");
    expect(diagnostic).toContain("button/follow/none");
    expect(diagnostic).toContain("a/other/external:other");
    expect(diagnostic.length).toBeLessThanOrEqual(600);
    for (const privateValue of ["Jane", "Doe", "secret", "example.com", "https://"]) {
      expect(diagnostic).not.toContain(privateValue);
    }
  });

  it("diagnoses the clicked card and later outside menus when the shadow outlet has no post link", () => {
    const root = mount(`<main>
      <div role="listitem">
        <button aria-label="Open control menu for post by Jane Doe" aria-expanded="true"
          aria-haspopup="menu" aria-controls="private-post-actions"></button>
        <a href="/in/jane-doe/">Jane Doe</a>
        <a href="/feed/update/urn:li:activity:7506985844398911488/">Post time</a>
        <span data-testid="expandable-text-box">A private post body
          <a href="/posts/other-activity-1111111111111111111-XyZ">Cited post</a>
        </span>
      </div>
      <div id="interop-outlet"></div>
      <div role="menu"><a href="/in/other/">Navigation 1</a></div>
      <div role="menu"><a href="/in/another/">Navigation 2</a></div>
      <div role="menu"><button>Save</button></div>
      <div role="menu" id="private-post-actions">
        <button>Save</button>
        <a href="/feed/update/urn:li:activity:7506985844398911488/">Copy link</a>
      </div>
    </main>`);
    root.querySelector("#interop-outlet")!.attachShadow({ mode: "open" }).innerHTML =
      `<section>${Array.from({ length: 8 }, () => "<button>Other</button>").join("")}</section>`;
    const button = root.querySelector<HTMLButtonElement>("button[aria-label^='Open control menu']")!;
    button.getBoundingClientRect = () => DOMRect.fromRect({ x: 20, y: 30, width: 40, height: 20 });
    const item = harvestVisiblePosts(root)[0]!;
    expect(locateDiscoveryPostMenu(root, item.fingerprint).ok).toBe(true);

    const result = readDiscoveryMenuShareUrn(root);
    expect(result).toMatchObject({ ok: false, skipReason: "embed-link-not-found" });
    expect(result.diagnostic).toContain("target=expanded:true/popup:menu/controls:menu");
    expect(result.diagnostic).toContain("targetAnchors=header:feed|body:posts");
    expect(result.diagnostic).toContain("|3:div/menu:a/copy-link/li:feed/update/*");
    for (const privateValue of ["Jane", "Doe", "7506985844398911488", "1111111111111111111", "https://"]) {
      expect(result.diagnostic).not.toContain(privateValue);
    }
  });

  it("uses only the newly opened outside post menu despite cited and pre-existing links", () => {
    const { root, button } = startOutsideMenuRead();
    button.setAttribute("aria-expanded", "true");
    root.insertAdjacentHTML("beforeend", `<div role="menu"><div role="button">Save</div>
      <a href="https://www.linkedin.com/feed/update/urn:li:activity:7506985844398911488/">Copy link</a>
    </div>`);
    expect(readDiscoveryMenuShareUrn(root)).toEqual({ ok: true, urn: "urn:li:activity:7506985844398911488" });
  });

  it("keeps a clicked Copy link menu unresolved without a canonical URL", () => {
    const { root, button } = startOutsideMenuRead();
    button.setAttribute("aria-expanded", "true");
    root.insertAdjacentHTML("beforeend", `<div role="menu"><div role="button">Save</div>
      <div data-clipboard-text="private-opaque-value"><span>Copy link</span></div>
      <a href="https://evil.example/feed/update/urn:li:activity:7506985844398911488/">Foreign link</a>
    </div>`);
    const result = readDiscoveryMenuShareUrn(root);
    expect(result).toMatchObject({ ok: false, skipReason: "embed-link-not-found" });
    expect(result.diagnostic).toContain("newOutside=1:save|copy-link/link:none/attrs:href|dc");
    for (const privateValue of ["Ada", "7506985844398911488", "1111111111111111111", "https://"]) {
      expect(result.diagnostic).not.toContain(privateValue);
    }
  });

  it("reports a Copy-only outside menu without treating the control as a post URL", () => {
    const { root, button } = startOutsideMenuRead();
    button.setAttribute("aria-expanded", "true");
    root.insertAdjacentHTML("beforeend", `<div role="menu"><span>Copy link</span></div>`);
    const result = readDiscoveryMenuShareUrn(root);
    expect(result).toMatchObject({ ok: false, skipReason: "embed-link-not-found" });
    expect(result.diagnostic).toContain("newOutside=1:copy-link/link:none/attrs:none");
  });

  it("locates only the Copy link control in the matched card's newly opened menu", () => {
    const { root, button } = startOutsideMenuRead();
    button.setAttribute("aria-expanded", "true");
    root.insertAdjacentHTML("beforeend", `<div role="menu"><div>Save</div><div id="copy"><span>Copy link</span></div></div>`);
    const target = root.querySelector<HTMLElement>("#copy span")!;
    target.getBoundingClientRect = () => DOMRect.fromRect({ x: 50, y: 80, width: 70, height: 24 });
    expect(locateDiscoveryCopyLink(root)).toMatchObject({ ok: true, rect: { x: 50, y: 80, width: 70, height: 24 } });
  });

  it("locates a newly mounted Copy link in the roleless interop shadow overlay", () => {
    const { root } = startOutsideMenuRead();
    const shadow = root.querySelector("#interop-outlet")!.shadowRoot!;
    shadow.innerHTML = `<section><div>Save</div><div id="shadow-copy"><span>Copy link</span></div></section>`;
    const target = shadow.querySelector<HTMLElement>("#shadow-copy span")!;
    target.getBoundingClientRect = () => DOMRect.fromRect({ x: 60, y: 90, width: 80, height: 20 });
    expect(locateDiscoveryCopyLink(root)).toMatchObject({ ok: true, rect: { x: 60, y: 90, width: 80, height: 20 } });
  });

  it("locates the live Copy link to post paragraph when a persistent menu updates after the matched click", () => {
    const { root, button } = startOutsideMenuRead();
    const menu = root.querySelectorAll("[role='menu']")[2]!;
    button.setAttribute("aria-expanded", "true");
    menu.innerHTML = `<div role="menuitem"><div><div><p>Save</p></div></div></div>
      <div role="menuitem" id="live-copy"><div><div><p>Copy link to post</p></div></div></div>`;
    // The live feed can also mount an unrelated role menu during this click.
    root.insertAdjacentHTML("beforeend", `<div role="menu"><a href="/feed/">Other</a></div>`);
    const target = root.querySelector<HTMLElement>("#live-copy")!;
    target.getBoundingClientRect = () => DOMRect.fromRect({ x: 70, y: 90, width: 90, height: 24 });
    expect(locateDiscoveryCopyLink(root)).toMatchObject({ ok: true, rect: { x: 70, y: 90, width: 90, height: 24 } });
  });

  it("does not use an unchanged Copy link in an unrelated persistent menu", () => {
    const { root, button } = startOutsideMenuRead();
    const menu = root.querySelectorAll("[role='menu']")[2]!;
    menu.innerHTML = `<div role="menuitem"><div><div><p>Save</p></div></div></div>
      <div role="menuitem"><div><div><p>Copy link to post</p></div></div></div>`;
    // This menu existed at selection time in the real browser. Re-select to
    // snapshot its actions before the matched button expands.
    const candidate = harvestVisiblePosts(root).find((post) => post.authorHandle === "ada")!;
    expect(locateDiscoveryPostMenu(root, candidate.fingerprint).ok).toBe(true);
    button.setAttribute("aria-expanded", "true");
    root.insertAdjacentHTML("beforeend", `<div role="menu"><a href="/feed/">Other</a></div>`);
    expect(locateDiscoveryCopyLink(root)).toMatchObject({ ok: false });
  });

  it("does not use a changed persistent menu when the matched button did not expand", () => {
    const { root } = startOutsideMenuRead();
    const menu = root.querySelectorAll("[role='menu']")[2]!;
    menu.innerHTML = `<div role="menuitem"><div><div><p>Save</p></div></div></div>
      <div role="menuitem"><div><div><p>Copy link to post</p></div></div></div>`;
    expect(locateDiscoveryCopyLink(root)).toMatchObject({ ok: false });
  });

  it("does not treat a hidden Save action as proof of the opened post menu", () => {
    const { root, button } = startOutsideMenuRead();
    button.setAttribute("aria-expanded", "true");
    const menu = root.querySelectorAll("[role='menu']")[2]!;
    menu.innerHTML = `<div hidden role="menuitem"><p>Save</p></div>
      <div role="menuitem" id="unrelated-copy"><p>Copy link to post</p></div>`;
    root.querySelector<HTMLElement>("#unrelated-copy")!.getBoundingClientRect = () =>
      DOMRect.fromRect({ x: 70, y: 90, width: 90, height: 24 });
    expect(locateDiscoveryCopyLink(root)).toMatchObject({ ok: false });
  });

  it("rejects two persistent menus updated with Copy link controls during one click", () => {
    const { root, button } = startOutsideMenuRead();
    button.setAttribute("aria-expanded", "true");
    for (const menu of Array.from(root.querySelectorAll("[role='menu']")).slice(1)) {
      menu.innerHTML = `<div role="menuitem"><div><div><p>Save</p></div></div></div>
        <div role="menuitem"><div><div><p>Copy link to post</p></div></div></div>`;
    }
    expect(locateDiscoveryCopyLink(root)).toMatchObject({ ok: false, skipReason: "ambiguous-open-menu" });
  });

  it("refuses a pre-existing or ambiguous Copy link menu", () => {
    const { root, button } = startOutsideMenuRead();
    expect(locateDiscoveryCopyLink(root)).toMatchObject({ ok: false });
    button.setAttribute("aria-expanded", "true");
    root.insertAdjacentHTML("beforeend", `<div role="menu"><div>Save</div><div>Copy link</div></div>
      <div role="menu"><div>Save</div><div>Copy link</div></div>`);
    expect(locateDiscoveryCopyLink(root)).toMatchObject({ ok: false, skipReason: "ambiguous-open-menu" });
  });

  it("reports only bounded action counts and roles when Copy link location fails", () => {
    const { root, button } = startOutsideMenuRead();
    button.setAttribute("aria-expanded", "true");
    root.insertAdjacentHTML("beforeend", `<div role="menu"><a href="/in/private-author/">Private author</a></div>
      <div role="menu" hidden><a href="/in/hidden-author/">Hidden author</a></div>`);
    const result = locateDiscoveryCopyLink(root) as { ok: boolean; skipReason?: string; diagnostic?: string };
    expect(result).toMatchObject({ ok: false, skipReason: "not-post-menu" });
    expect(result.diagnostic).toMatch(/^expanded=true;totalMenus=5;menus=4;opened=1;updated=0;save=1;copy=0;menuitems=0;pageSave=1;pageCopy=0;pageMenuitems=0;outlet=open;outletControls=8$/);
    expect(result.diagnostic).not.toContain("private");
  });

  it("rejects conflicting activity links in the newly opened post menu", () => {
    const { root, button } = startOutsideMenuRead();
    button.setAttribute("aria-expanded", "true");
    root.insertAdjacentHTML("beforeend", `<div role="menu"><button>Save</button>
      <a href="/feed/update/urn:li:activity:7506985844398911488/">One</a>
      <a href="/posts/other-activity-4444444444444444444-AbCd">Another</a>
    </div>`);
    expect(readDiscoveryMenuShareUrn(root)).toMatchObject({ ok: false, skipReason: "ambiguous-menu-activity" });
  });

  it("rejects two newly opened Save menus or a button that never opened", () => {
    const { root, button } = startOutsideMenuRead();
    expect(readDiscoveryMenuShareUrn(root)).toMatchObject({ ok: false, skipReason: "embed-link-not-found" });
    button.setAttribute("aria-expanded", "true");
    root.insertAdjacentHTML("beforeend", `<div role="menu"><button>Save</button>
      <a href="/feed/update/urn:li:activity:7506985844398911488/">Copy link</a>
    </div>`);
    root.insertAdjacentHTML("beforeend", `<div role="menu"><button>Save</button>
      <a href="/feed/update/urn:li:activity:5555555555555555555/">Copy link</a>
    </div>`);
    expect(readDiscoveryMenuShareUrn(root)).toMatchObject({ ok: false, skipReason: "ambiguous-open-menu" });
  });

  it("uses a newly mounted menu even when aria-expanded is absent or unchanged", () => {
    for (const prior of [null, "false"] as const) {
      const { root } = startOutsideMenuRead(prior);
      root.insertAdjacentHTML("beforeend", `<div role="menu"><button>Save</button>
        <a href="/feed/update/urn:li:activity:7506985844398911488/">Copy link</a>
      </div>`);
      expect(readDiscoveryMenuShareUrn(root)).toEqual({ ok: true, urn: "urn:li:activity:7506985844398911488" });
    }
  });

  it("uses a newly mounted shadow menu when aria-expanded does not toggle", () => {
    const { root } = startOutsideMenuRead("false");
    root.querySelector("#interop-outlet")!.shadowRoot!.querySelector("section")!
      .insertAdjacentHTML("beforeend", `<div role="menu"><button>Save</button>
        <a href="/feed/update/urn:li:activity:7506985844398911488/">Copy link</a>
      </div>`);
    expect(readDiscoveryMenuShareUrn(root)).toEqual({ ok: true, urn: "urn:li:activity:7506985844398911488" });
  });

  it("includes actions inside a nested open shadow menu", () => {
    const root = mount(`<main><div id="interop-outlet"></div></main>`);
    const outer = root.querySelector("#interop-outlet")!.attachShadow({ mode: "open" });
    outer.innerHTML = `<section><div id="nested-menu"></div></section>`;
    outer.querySelector("#nested-menu")!.attachShadow({ mode: "open" }).innerHTML =
      `<button aria-label="Save Jane Doe's post">Private</button><button>Report this post</button>`;
    const diagnostic = readDiscoveryMenuShareUrn(root).diagnostic!;
    expect(diagnostic).toContain("button/other/save/none");
    expect(diagnostic).toContain("button/other/report/none");
    expect(diagnostic).not.toContain("Jane");
  });

  it("excludes hidden and offscreen outside menu candidates", () => {
    const root = mount(`<main>
      <div id="interop-outlet"></div>
      <div role="menu" style="display:none"><button>Share</button></div>
      <div role="dialog" id="offscreen"><button>Report</button></div>
      <div role="menu"><button>Save</button></div>
    </main>`);
    const offscreen = root.querySelector<HTMLElement>("#offscreen")!;
    offscreen.getClientRects = () => [DOMRect.fromRect({ y: window.innerHeight + 100, width: 10, height: 10 })] as unknown as DOMRectList;
    offscreen.getBoundingClientRect = () => DOMRect.fromRect({ y: window.innerHeight + 100, width: 10, height: 10 });
    root.querySelector("#interop-outlet")!.attachShadow({ mode: "open" }).innerHTML = `<button>Other</button>`;
    const diagnostic = readDiscoveryMenuShareUrn(root).diagnostic!;
    expect(diagnostic).toContain("outside=1:div/menu:button/save/none");
    expect(diagnostic).not.toContain("button/report/none");
    expect(diagnostic).not.toContain("button/share/none");
  });

  it("finds outside menu candidates inside a different open shadow root", () => {
    const root = mount(`<main><div id="interop-outlet"></div><div id="other-overlay"></div></main>`);
    root.querySelector("#interop-outlet")!.attachShadow({ mode: "open" }).innerHTML =
      `<div role="menu"><button>Other</button></div>`;
    root.querySelector("#other-overlay")!.attachShadow({ mode: "open" }).innerHTML =
      `<div role="menu"><button aria-label="Save Jane Doe's private post">Save</button></div>`;
    const diagnostic = readDiscoveryMenuShareUrn(root).diagnostic!;
    expect(diagnostic).toContain("outside=1:div/menu:button/save/none");
    expect(diagnostic).not.toContain("outside=2");
    expect(diagnostic).not.toContain("Jane");
    expect(diagnostic).not.toContain("Doe");
  });

  it("excludes hidden and offscreen cards from candidate anchor shapes", () => {
    const root = mount(`<main>
      <div role="listitem"><button aria-label="Open control menu for post by Visible"></button>
        <a href="/in/visible/">Visible</a></div>
      <section style="display:none"><div role="listitem"><button aria-label="Open control menu for post by Hidden"></button>
        <a href="/feed/update/urn:li:activity:1111111111111111111/">Hidden</a></div></section>
      <div role="listitem" id="offscreen"><button aria-label="Open control menu for post by Offscreen"></button>
        <a href="https://example.com/private/">Offscreen</a></div>
      <div id="interop-outlet"></div>
    </main>`);
    const offscreen = root.querySelector<HTMLElement>("#offscreen")!;
    offscreen.getClientRects = () => [DOMRect.fromRect({ y: window.innerHeight + 100, width: 10, height: 10 })] as unknown as DOMRectList;
    offscreen.getBoundingClientRect = () => DOMRect.fromRect({ y: window.innerHeight + 100, width: 10, height: 10 });
    root.querySelector("#interop-outlet")!.attachShadow({ mode: "open" }).innerHTML = `<button>Save</button>`;
    const diagnostic = readDiscoveryMenuShareUrn(root).diagnostic!;
    expect(diagnostic).toContain("cards=1;anchors=header:other");
    expect(diagnostic).not.toContain("header:feed");
    expect(diagnostic).not.toContain("header:external");
  });

  it("does not treat a link cited in a current post's body as that post's activity URN", () => {
    const root = mount(`<main><div role="listitem">
      <button aria-label="Open control menu for post by Ada Lovelace"></button>
      <a href="/in/ada/">Ada</a>
      <span data-testid="expandable-text-box">This reminds me of
        <a href="/posts/grace_story-activity-7506985845665681408-abcd">Grace's post</a>.
      </span>
      <button aria-label="Reaction button state: no reaction"></button>
    </div></main>`);
    expect(harvestVisiblePosts(root)[0]).toMatchObject({ authorHandle: "ada" });
    expect(harvestVisiblePosts(root)[0]?.urn).toBeUndefined();
  });

  it("reads singular engagement and rejects promoted cards in current markup", () => {
    const root = mount(`<main><div role="listitem">
      <button aria-label="Open control menu for post by Ada Lovelace"></button>
      <a href="/in/ada/">Ada</a>
      <span data-testid="expandable-text-box">One clear idea.</span>
      <span>1 reaction</span><span>1 comment</span>
      <button aria-label="Reaction button state: no reaction"></button>
      </div><div role="listitem">
      <button aria-label="Open control menu for post by Acme"></button>
      <span>Promoted</span><a href="/in/acme/">Acme</a>
      <span data-testid="expandable-text-box">Buy this product.</span>
      <button aria-label="Reaction button state: no reaction"></button>
    </div></main>`);
    const posts = harvestVisiblePosts(root);
    expect(isSponsored(root.querySelectorAll("[role=listitem]")[1]!)).toBe(true);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ reactionCount: 1, commentCount: 1, authorHandle: "ada" });
  });

  it("reads the September 2026 feed-header URN without including follower or comment text", () => {
    const root = mount(`<main><div role="list">
      <div role="listitem" id="expanded-obfuscated-card">
        <p>Followed by Garima Kalra</p>
        <span data-sdui-anchor-id="feed-header-urn:li:activity:7506818500620115968-0"></span>
        <button aria-label="Open control menu for post by Dave Slutzkin"></button>
        <a href="/in/daveslutzkin/">Dave Slutzkin</a>
        <p>CEO at a software company</p><p>12h •</p>
        <p componentkey="obfuscated">Your weekend task: remove stale symlinks.</p>
        <button aria-label="Reaction button state: no reaction"></button>
        <div><p>1h</p><p>A long comment that must not replace the post body text.</p>
          <button aria-label="Reaction button state: no reaction 2 reactions"></button></div>
      </div>
    </div></main>`);
    const posts = harvestVisiblePosts(root, new Date("2026-09-19T12:00:00Z"));
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      urn: "urn:li:activity:7506818500620115968",
      url: "https://www.linkedin.com/feed/update/urn:li:activity:7506818500620115968/",
      authorName: "Dave Slutzkin",
      authorHandle: "daveslutzkin",
      text: "Your weekend task: remove stale symlinks.",
      postedAt: "2026-09-19T00:00:00.000Z",
    });
  });

  it("reads an obfuscated feed card with a permalink and time", () => {
    const html = archived.replace(
      "A normal, likeable post about reusable rockets.",
      `A normal, likeable post about reusable rockets.
       <a href="/posts/ronwiener_rockets-activity-7481524546924343296-abcd">View post</a>
       <time datetime="2026-09-19T10:00:00Z">2h</time>`,
    );
    const posts = harvestVisiblePosts(mount(html), new Date("2026-09-19T12:00:00Z"));
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      urn: "urn:li:activity:7481524546924343296",
      authorName: "Ron Wiener",
      authorHandle: "ronwiener",
      postedAt: "2026-09-19T10:00:00.000Z",
    });
    expect(posts[0]!.text).toContain("A normal, likeable post");
  });

  it("keeps an unknown time and rejects sponsored cards or cards without an activity ID", () => {
    const root = mount(`<main>
      <div data-urn="urn:li:activity:7481524546924343298"><a href="/in/ada/">Ada</a><p data-testid="expandable-text-box">Useful design details</p></div>
      <div data-urn="urn:li:activity:7481524546924343299">Promoted <p data-testid="expandable-text-box">Sales pitch</p></div>
      <div><p data-testid="expandable-text-box">No ID</p></div>
    </main>`);
    const posts = harvestVisiblePosts(root, new Date("2026-09-19T12:00:00Z"));
    expect(posts).toHaveLength(1);
    expect(posts[0]?.postedAt).toBeUndefined();
  });
});
