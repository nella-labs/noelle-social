import { describe, expect, it } from "vitest";
import {
  deriveAutopilotStatus,
  nextSendTargetAt,
  quietUntilMs,
} from "./autopilot-status";

describe("deriveAutopilotStatus", () => {
  it("both off => 'off' / muted", () => {
    const s = deriveAutopilotStatus({ replySendEnabled: false, autoSendEnabled: false });
    expect(s.state).toBe("off");
    expect(s.tone).toBe("muted");
  });

  it("master on, autopilot off => 'drafting-only' / accent", () => {
    const s = deriveAutopilotStatus({ replySendEnabled: true, autoSendEnabled: false });
    expect(s.state).toBe("drafting-only");
    expect(s.tone).toBe("accent");
  });

  it("CRITICAL: autopilot armed but master off => 'queued-master-off' / warn", () => {
    const s = deriveAutopilotStatus({ replySendEnabled: false, autoSendEnabled: true });
    expect(s.state).toBe("queued-master-off");
    expect(s.tone).toBe("warn");
    expect(s.label).toMatch(/master off/i);
  });

  it("both on => 'live' / ok", () => {
    const s = deriveAutopilotStatus({ replySendEnabled: true, autoSendEnabled: true });
    expect(s.state).toBe("live");
    expect(s.tone).toBe("ok");
  });
});

describe("nextSendTargetAt", () => {
  it("returns null for an empty queue", () => {
    expect(nextSendTargetAt([])).toBeNull();
  });

  it("returns the earliest ISO from unordered rows", () => {
    const rows = [
      { targetAt: "2026-05-30T18:30:00.000Z" },
      { targetAt: "2026-05-30T18:05:00.000Z" },
      { targetAt: "2026-05-30T19:00:00.000Z" },
    ];
    expect(nextSendTargetAt(rows)).toBe("2026-05-30T18:05:00.000Z");
  });

  it("skips rows with an unparseable targetAt", () => {
    const rows = [
      { targetAt: "not-a-date" },
      { targetAt: "2026-05-30T18:20:00.000Z" },
      { targetAt: "also bad" },
    ];
    expect(nextSendTargetAt(rows)).toBe("2026-05-30T18:20:00.000Z");
  });

  it("returns null when every row is unparseable", () => {
    expect(nextSendTargetAt([{ targetAt: "x" }, { targetAt: "y" }])).toBeNull();
  });
});

describe("quietUntilMs (shared quiet-window helper)", () => {
  it("returns the next window-end epoch when inside the window", () => {
    const now = Date.UTC(2026, 5, 8, 6, 0, 0);
    expect(quietUntilMs(now, { startHourUtc: 4, endHourUtc: 12 })).toBe(
      Date.UTC(2026, 5, 8, 12, 0, 0),
    );
  });

  it("handles a wrapping window", () => {
    const now = Date.UTC(2026, 5, 8, 23, 0, 0);
    expect(quietUntilMs(now, { startHourUtc: 22, endHourUtc: 6 })).toBe(
      Date.UTC(2026, 5, 9, 6, 0, 0),
    );
  });

  it("returns null outside the window", () => {
    const now = Date.UTC(2026, 5, 8, 14, 0, 0);
    expect(quietUntilMs(now, { startHourUtc: 4, endHourUtc: 12 })).toBeNull();
  });

  it("returns null when start === end (disabled)", () => {
    const now = Date.UTC(2026, 5, 8, 6, 0, 0);
    expect(quietUntilMs(now, { startHourUtc: 6, endHourUtc: 6 })).toBeNull();
  });
});
