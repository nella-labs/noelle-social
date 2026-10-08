import { mkdtemp, rm, writeFile, truncate } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTENT_MEDIA_MAX_BYTES, VideoTeardownSchema } from "@noelle/contracts";
import { BudgetExceededError, ModelNotDispatchedError, unlimitedBudget, type SpendRow } from "@noelle/runtime";
import { createVertexVideoAnalyzer } from "./teardown-analyze.js";
import { createVideoModelOperation } from "./video-gemini.js";

const credentials = vi.hoisted(() => ({ getAccessToken: vi.fn(async () => "owned-token") }));
vi.mock("@noelle/runtime/google-credentials", () => ({ defaultGoogleCredentialClient: () => credentials }));
const result = VideoTeardownSchema.parse({ hook: { text: "Saved hook", type: "question" },
  pacing: { cutsPerSec: 0.1, avgBeatSec: 1, wordsPerSec: 1 }, cta: { present: false }, sound: {}, whyItWorked: "Observed structure" });
const input = { caption: "Saved caption", transcript: "Saved transcript", keyframePaths: [] as string[], cutTimestamps: [1],
  metrics: { views: null, likes: 0, comments: null, shares: null, durationS: 2 } };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
let directory: string | undefined;
afterEach(async () => { vi.restoreAllMocks(); if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined; vi.clearAllMocks(); });
const generation = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(result) }] } }] }));

describe("Video analyzer transport compatibility", () => {
  it.each(["key", "adc"])("keeps %s frame casing, six-frame cap and analysis temperature", async mode => {
    directory = await mkdtemp(join(tmpdir(), "video-frame-test-"));
    const frame = join(directory, "frame.png"); await writeFile(frame, png);
    let request: RequestInit | undefined;
    const analyze = createVertexVideoAnalyzer({ project: "fixture", ...(mode === "key" ? { apiKey: "fixture" } : {}),
      fetchImpl: async (_url, init) => { request = init; return generation(); } });
    expect(await analyze.analyze({ ...input, keyframePaths: Array(7).fill(frame) })).toEqual(result);
    const body = JSON.parse(String(request?.body));
    expect(body.generationConfig).toEqual({ responseMimeType: "application/json", temperature: 0.2 });
    const parts = body.contents[0].parts; expect(parts).toHaveLength(7);
    expect(parts[0].text).toContain("views=unknown likes=0 comments=unknown shares=unknown");
    const encoded = png.toString("base64");
    expect(parts[1]).toEqual(mode === "key" ? { inline_data: { mime_type: "image/png", data: encoded } }
      : { inlineData: { mimeType: "image/png", data: encoded } });
    if (mode === "key") { expect(body.systemInstruction).toBeUndefined(); expect(credentials.getAccessToken).not.toHaveBeenCalled(); }
    else { expect(body.systemInstruction.parts[0].text).toContain("short-form video analyst"); expect(credentials.getAccessToken).toHaveBeenCalledWith(8000); }
  });
  it("keeps missing credentials and malformed teardown schemas as unknown", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"hook":42}' }] } }] })));
    expect(await createVertexVideoAnalyzer({ project: "", fetchImpl }).analyze(input)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await createVertexVideoAnalyzer({ project: "", apiKey: "fixture", fetchImpl }).analyze(input)).toBeNull();
  });
});

describe("Video keyframe input boundaries", () => {
  async function frame(name: string, bytes: Uint8Array) {
    directory = await mkdtemp(join(tmpdir(), "video-frame-boundary-"));
    const path = join(directory, name); await writeFile(path, bytes); return path;
  }
  function transport() {
    const images: Array<{ mime_type: string; data: string }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      for (const part of JSON.parse(String(init?.body)).contents[0].parts) {
        if (part.inline_data) images.push(part.inline_data);
      }
      return generation();
    });
    return { images, fetchImpl };
  }

  it("uses the frame bytes when a PNG has a JPEG suffix", async () => {
    const path = await frame("frame.jpg", png); const s = transport();
    expect(await createVertexVideoAnalyzer({ project: "", apiKey: "inert", fetchImpl: s.fetchImpl }).analyze({ ...input, keyframePaths: [path] })).toEqual(result);
    expect(s.images).toEqual([{ mime_type: "image/png", data: png.toString("base64") }]);
  });

  it.each([Buffer.from("<html>not a frame</html>"), Buffer.from("GIF89a", "ascii")])("skips non-image or Gemini-unsupported frame bytes %j", async bytes => {
    const path = await frame("frame.jpg", bytes); const s = transport();
    expect(await createVertexVideoAnalyzer({ project: "", apiKey: "inert", fetchImpl: s.fetchImpl }).analyze({ ...input, keyframePaths: [path] })).toEqual(result);
    expect(s.images).toEqual([]);
  });

  it("skips a real FIFO without waiting for its writer", async () => {
    directory = await mkdtemp(join(tmpdir(), "video-frame-fifo-"));
    const path = join(directory, "frame.jpg"); await promisify(execFile)("mkfifo", [path]);
    let settled = false;
    const s = transport();
    const operation = createVertexVideoAnalyzer({ project: "", apiKey: "inert", timeoutMs: 1000, fetchImpl: s.fetchImpl })
      .analyze({ ...input, keyframePaths: [path] }).finally(() => { settled = true; });
    try { await new Promise(resolve => setTimeout(resolve, 50)); expect(settled).toBe(true); }
    finally { if (!settled) await writeFile(path, png); await operation; }
    expect(s.images).toEqual([]);
  });

  it("skips a regular file above the existing media byte bound", async () => {
    const path = await frame("frame.png", png); await truncate(path, CONTENT_MEDIA_MAX_BYTES + 1);
    const s = transport();
    expect(await createVertexVideoAnalyzer({ project: "", apiKey: "inert", fetchImpl: s.fetchImpl }).analyze({ ...input, keyframePaths: [path] })).toEqual(result);
    expect(s.images).toEqual([]);
  });

  it.each([0, -1, 1.5, Infinity, NaN])("validates budget %s before accessing frame paths", async timeoutMs => {
    const readPaths = vi.fn(() => [] as string[]); const s = transport();
    const value = { ...input, get keyframePaths() { return readPaths(); } };
    expect(await createVertexVideoAnalyzer({ project: "", apiKey: "inert", timeoutMs, fetchImpl: s.fetchImpl }).analyze(value)).toBeNull();
    expect(readPaths).not.toHaveBeenCalled(); expect(s.fetchImpl).not.toHaveBeenCalled();
  });

  it("does not begin HTTP after preparation consumes the original deadline", async () => {
    const path = await frame("frame.png", png); const s = transport();
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(20);
    expect(await createVertexVideoAnalyzer({ project: "", apiKey: "inert", timeoutMs: 10, fetchImpl: s.fetchImpl }).analyze({ ...input, keyframePaths: [path] })).toBeNull();
    expect(s.fetchImpl).not.toHaveBeenCalled();
  });
});

describe("Video analyzer scoped monetary context", () => {
  function scope(rows: SpendRow[], id = "instance") {
    return { engine: "vertex" as const, context: { orgId: `org-${id}`, instanceId: id, agentRole: "video_intern" as const, worker: "teardown", bucket: "drafter" },
      budget: { ...unlimitedBudget, adapters: { ...unlimitedBudget.adapters, reserveAttempt: vi.fn(async () => ({ attemptId: id })) } },
      recorder: { record: async (row: SpendRow) => { rows.push(row); } } };
  }
  it("forwards an acknowledged refusal separately from frame and prompt input", async () => {
    const rows: SpendRow[] = []; const marker = vi.fn(async () => "not_dispatched" as const);
    const operation = createVideoModelOperation(marker); const fetchImpl = vi.fn<typeof fetch>(async () => generation());
    await expect(createVertexVideoAnalyzer({ project: "", apiKey: "inert", fetchImpl, metering: scope(rows) })
      .analyze({ ...input, operation })).rejects.toBeInstanceOf(ModelNotDispatchedError);
    expect(marker).toHaveBeenCalledOnce(); expect(fetchImpl).not.toHaveBeenCalled();
    expect(operation).toMatchObject({ acknowledgement: "not_dispatched", markerAttempted: true });
    expect(rows[0]).toMatchObject({ status: "error", costBasis: "not_dispatched", cents: 0 });
  });
  it("checks the original preparation deadline after admission before attempting the marker", async () => {
    let clock = 0; vi.spyOn(performance, "now").mockImplementation(() => clock);
    const rows: SpendRow[] = []; const metering = scope(rows);
    metering.budget.adapters.reserveAttempt.mockImplementation(async () => { clock = 11; return { attemptId: "instance" }; });
    const marker = vi.fn(async () => "dispatch" as const); const operation = createVideoModelOperation(marker);
    const fetchImpl = vi.fn<typeof fetch>(async () => generation());
    await expect(createVertexVideoAnalyzer({ project: "", apiKey: "inert", fetchImpl, timeoutMs: 10, metering })
      .analyze({ ...input, operation })).rejects.toBeInstanceOf(ModelNotDispatchedError);
    expect(marker).not.toHaveBeenCalled(); expect(fetchImpl).not.toHaveBeenCalled();
    expect(operation).toMatchObject({ acknowledgement: "not_dispatched", markerAttempted: false });
    expect(rows[0]).toMatchObject({ costBasis: "not_dispatched", latencyMs: null });
  });
  it("retains an unknown receipt when the marker throws a nominal refusal", async () => {
    const rows: SpendRow[] = []; const operation = createVideoModelOperation(async () => { throw new ModelNotDispatchedError(); });
    const fetchImpl = vi.fn<typeof fetch>(async () => generation());
    await expect(createVertexVideoAnalyzer({ project: "", apiKey: "inert", fetchImpl, metering: scope(rows) })
      .analyze({ ...input, operation })).rejects.toBeInstanceOf(ModelNotDispatchedError);
    expect(fetchImpl).not.toHaveBeenCalled(); expect(operation.acknowledgement).toBe("unknown");
    expect(rows[0]).toMatchObject({ costBasis: "unknown", cents: 0 });
  });
  it("denies admission before a paid analysis request", async () => {
    const rows: SpendRow[] = []; const metering = scope(rows);
    metering.budget.adapters.reserveAttempt.mockRejectedValue(new BudgetExceededError({ layer: "instance", spent_cents: 0, cap_cents: 0, estimated_cents: 1 }));
    const fetchImpl = vi.fn<typeof fetch>(async () => generation());
    const opts = { project: "", apiKey: "inert", fetchImpl, metering };
    await expect(createVertexVideoAnalyzer(opts).analyze(input)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(fetchImpl).not.toHaveBeenCalled(); expect(rows[0]).toMatchObject({ worker: "teardown", status: "budget_exceeded" });
  });
  it("keeps overlapping instance context and received usage local to each analysis", async () => {
    const rows: SpendRow[] = []; let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const a = createVertexVideoAnalyzer({ project: "", apiKey: "inert", metering: scope(rows, "a"), fetchImpl: async () => {
      await blocked; return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(result) }] } }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 } }));
    } });
    const b = createVertexVideoAnalyzer({ project: "", apiKey: "inert", metering: scope(rows, "b"), fetchImpl: async () => generation() });
    const pending = a.analyze(input);
    try { expect(await b.analyze(input)).toEqual(result); } finally { release(); await pending; }
    expect(rows.map(row => [row.instanceId, row.orgId, row.attemptId, row.costBasis])).toEqual([
      ["b", "org-b", "b", "unknown"], ["a", "org-a", "a", "token_estimate"],
    ]);
  });
});
