import { describe, expect, it } from "vitest";
import { renderLauncher, renderPlist } from "./autostart.js";

describe("renderLauncher", () => {
  it("prepends the given dirs (+ system path) and execs autostart-run", () => {
    const script = renderLauncher({
      nodeBin: "/usr/local/bin/node",
      cliEntry: "/Users/operator/Projects/noelle/apps/cli/dist/index.js",
      pathDirs: ["/opt/homebrew/bin"],
      vm: "default",
    });
    expect(script).toContain(`export PATH='/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin':"$PATH"`);
    expect(script).toContain(
      "exec '/usr/local/bin/node' '/Users/operator/Projects/noelle/apps/cli/dist/index.js' 'autostart-run' '--vm' 'default'",
    );
    expect(script.startsWith("#!/bin/bash")).toBe(true);
  });
});

describe("renderPlist", () => {
  it("is a RunAtLoad agent that bash-runs the launcher and logs to one file", () => {
    const plist = renderPlist({
      label: "com.noelle.autostart",
      launcher: "/Users/operator/.noelle/host/autostart.sh",
      log: "/Users/operator/.noelle/host/autostart.log",
    });
    expect(plist).toContain("<string>com.noelle.autostart</string>");
    expect(plist).toContain("<string>/bin/bash</string>");
    expect(plist).toContain("<string>/Users/operator/.noelle/host/autostart.sh</string>");
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    // stdout + stderr both point at the same log file
    expect((plist.match(/host\/autostart\.log/g) ?? []).length).toBe(2);
  });

  it("runs Interactive, never Background (the QoS clamp inherits into pm2 + the whole runtime)", () => {
    const plist = renderPlist({
      label: "com.noelle.autostart",
      launcher: "/l.sh",
      log: "/l.log",
    });
    expect(plist).toMatch(/<key>ProcessType<\/key>\s*<string>Interactive<\/string>/);
    expect(plist).not.toContain("<string>Background</string>");
  });
});
