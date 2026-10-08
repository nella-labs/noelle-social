import { decodeHttpJson, fetchBoundedHttpResponse, HttpBodyError, MAX_HTTP_TIMEOUT_MS } from "./boundedHttp.js";
import { createRunReceiptStore, TERMINAL_APIFY_RUN_STATES, type ApifyResultCoverage } from "./apifyRunReceipts.js";

interface Options {
  token: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  errorFactory(message: string, status: number): Error;
}
interface RunRequest { actorId: string; actor: string; input: unknown; itemLimit: number }
interface Run { id?: string; status?: string; defaultDatasetId?: string; usageTotalUsd?: unknown }
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export const MAX_APIFY_ITEM_LIMIT = 5000;

/** Validate paid input and retrieval bounds before an adapter starts other work. */
export function assertApifyItemLimit(itemLimit: number, errorFactory: Options["errorFactory"]): void {
  if (!Number.isSafeInteger(itemLimit) || itemLimit < 0 || itemLimit > MAX_APIFY_ITEM_LIMIT) {
    throw errorFactory(`apify item limit must be an integer between 0 and ${MAX_APIFY_ITEM_LIMIT}`, 400);
  }
}

/** Shared actor lifecycle; platform adapters retain their own error constructors. */
export function createApifyTransport(options: Options) {
  const receipts = createRunReceiptStore();
  const baseUrl = options.baseUrl ?? "https://api.apify.com";
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_HTTP_TIMEOUT_MS) {
    throw options.errorFactory(`apify timeout must be between 1 and ${MAX_HTTP_TIMEOUT_MS} ms`, 400);
  }
  const token = encodeURIComponent(options.token);

  async function runActor({ actorId, actor, input, itemLimit }: RunRequest): Promise<{ items: unknown[] } & ApifyResultCoverage> {
    assertApifyItemLimit(itemLimit, options.errorFactory);
    if (itemLimit === 0) return { items: [], resultCount: 0, resultCountComplete: true, fetchedResultCount: 0 };
    let receipt: ReturnType<ReturnType<typeof createRunReceiptStore>["beginRun"]>;
    try { receipt = receipts.beginRun(actor); }
    catch { throw options.errorFactory("apify operation run limit reached", 400); }
    const deadline = Date.now() + timeoutMs;
    const remaining = () => Math.max(1, deadline - Date.now());
    const waitSecs = () => Math.min(60, Math.max(1, Math.ceil(remaining() / 1000)));

    async function request(path: string, context: string, init: RequestInit = {}): Promise<{ response: Response; value: unknown }> {
      if (Date.now() >= deadline) throw options.errorFactory(`apify ${context} timed out`, 0);
      let fetched: Awaited<ReturnType<typeof fetchBoundedHttpResponse>>;
      try {
        fetched = await fetchBoundedHttpResponse(`${baseUrl}${path}`, init, {
          timeoutMs: remaining(), ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        });
      } catch (error) {
        const bodyStatus = error instanceof HttpBodyError ? error.status : undefined;
        const httpFailure = bodyStatus !== undefined && bodyStatus >= 400;
        const status = httpFailure ? bodyStatus : error instanceof HttpBodyError && error.code === "body_too_large" ? 502 : 0;
        const detail = error instanceof HttpBodyError && error.code === "body_too_large"
          ? "exceeds the 4 MiB response limit" : error instanceof HttpBodyError && error.code === "timeout" ? "timed out" : "failed";
        throw options.errorFactory(`apify ${context} ${detail}`, status);
      }
      if (!fetched.response.ok) throw options.errorFactory(`apify ${context} -> ${fetched.response.status}`, fetched.response.status);
      try { return { response: fetched.response, value: decodeHttpJson(fetched.bytes) }; }
      catch { throw options.errorFactory(`apify ${context} returned invalid JSON`, 502); }
    }
    function runFrom(value: unknown): Run | undefined {
      if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
      const data = (value as { data?: unknown }).data;
      if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
      const raw = data as Record<string, unknown>;
      const id = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9_~-]{1,128}$/.test(value) ? value : undefined;
      const status = typeof raw.status === "string" &&
        ["READY", "RUNNING", "TIMING-OUT", "ABORTING", ...TERMINAL_APIFY_RUN_STATES].includes(raw.status)
        ? raw.status : "UNKNOWN";
      return { ...(id(raw.id) ? { id: id(raw.id)! } : {}), status,
        ...(id(raw.defaultDatasetId) ? { defaultDatasetId: id(raw.defaultDatasetId)! } : {}), usageTotalUsd: raw.usageTotalUsd };
    }
    const started = await request(`/v2/acts/${encodeURIComponent(actorId)}/runs?token=${token}&waitForFinish=${waitSecs()}`, "actor metadata", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
    });
    let run = runFrom(started.value);
    if (run) receipt.observe(run);
    while (run && !TERMINAL_APIFY_RUN_STATES.has(run.status ?? "") && Date.now() < deadline) {
      if (typeof run.id !== "string" || !run.id || run.status === "UNKNOWN") break;
      await sleep(Math.min(1000, remaining()));
      if (Date.now() >= deadline) break;
      const expectedRunId = run.id;
      const polled = runFrom((await request(`/v2/actor-runs/${encodeURIComponent(expectedRunId)}?token=${token}&waitForFinish=${waitSecs()}`, "run poll metadata", {
        method: "GET", headers: { accept: "application/json" },
      })).value);
      if (!polled || polled.id !== expectedRunId) throw options.errorFactory("apify run poll identity mismatch", 502);
      run = polled;
      receipt.observe(run);
    }
    if (!run || run.status !== "SUCCEEDED") {
      throw options.errorFactory(`apify actor ${actorId} run ${run?.status ?? "unknown"} (not SUCCEEDED)`, run ? 502 : 504);
    }
    if (typeof run.defaultDatasetId !== "string" || !run.defaultDatasetId) {
      return { items: [], resultCount: 0, fetchedResultCount: 0, resultCountComplete: false };
    }
    const dataset = await request(`/v2/datasets/${encodeURIComponent(run.defaultDatasetId)}/items?token=${token}&format=json&limit=${itemLimit}`, "dataset", {
      method: "GET", headers: { accept: "application/json" },
    });
    if (!Array.isArray(dataset.value)) throw options.errorFactory("apify dataset returned invalid items", 502);
    const rawTotal = dataset.response.headers.get("X-Apify-Pagination-Total");
    const total = rawTotal !== null && /^[0-9]+$/.test(rawTotal) ? Number(rawTotal) : null;
    const complete = total !== null && Number.isSafeInteger(total) && total >= dataset.value.length;
    const coverage = { resultCount: complete ? total : dataset.value.length,
      fetchedResultCount: dataset.value.length, resultCountComplete: complete };
    receipt.setCoverage(coverage);
    return { items: dataset.value.slice(0, itemLimit), ...coverage };
  }

  return {
    beginOperation: () => receipts.clear(), runActor,
    drainRunReceipts: () => receipts.drain(), drainLastRunUsd: () => receipts.drainLastRunUsd(),
  };
}
