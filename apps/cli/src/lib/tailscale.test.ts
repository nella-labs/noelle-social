import { describe, expect, it } from "vitest";
import { buildUrl, parseDnsName, serveArgs } from "./tailscale.js";

describe("serveArgs", () => {
  it("https on 443 (shared root)", () => {
    expect(serveArgs(3001, "https", 443)).toEqual(["serve", "--bg", "--yes", "--https=443", "3001"]);
  });
  it("https on a dedicated port (off the shared root)", () => {
    expect(serveArgs(3001, "https", 8443)).toEqual(["serve", "--bg", "--yes", "--https=8443", "3001"]);
  });
  it("http publishes a plain listen port", () => {
    expect(serveArgs(3001, "http", 8080)).toEqual(["serve", "--bg", "--yes", "--http=8080", "3001"]);
  });
});

describe("parseDnsName", () => {
  it("extracts Self.DNSName and strips the trailing dot", () => {
    const json = JSON.stringify({ Self: { DNSName: "workstation.tail-example.ts.net." } });
    expect(parseDnsName(json)).toBe("workstation.tail-example.ts.net");
  });
  it("returns null when DNSName is missing or json is garbage", () => {
    expect(parseDnsName("{}")).toBeNull();
    expect(parseDnsName("not json")).toBeNull();
    expect(parseDnsName(JSON.stringify({ Self: {} }))).toBeNull();
  });
});

describe("buildUrl", () => {
  const dns = "workstation.tail-example.ts.net";
  it("https on 443 → cert URL with no port", () => {
    expect(buildUrl(dns, "https", 443)).toBe("https://workstation.tail-example.ts.net");
  });
  it("https on a dedicated port → URL carries the port", () => {
    expect(buildUrl(dns, "https", 8443)).toBe("https://workstation.tail-example.ts.net:8443");
  });
  it("http → plain URL with the listen port", () => {
    expect(buildUrl(dns, "http", 8080)).toBe("http://workstation.tail-example.ts.net:8080");
  });
});
