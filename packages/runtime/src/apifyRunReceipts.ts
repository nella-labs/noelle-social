export interface ApifyResultCoverage {
  /** Raw provider total; a lower bound when complete coverage is false. */
  resultCount: number;
  resultCountComplete?: boolean;
  fetchedResultCount?: number;
}

export interface ApifyRunReceipt extends ApifyResultCoverage {
  runId: string | null;
  actor: string;
  status: string;
  terminal: boolean;
  /** Final provider-reported charge, or null when unconfirmed. */
  actualUsd: number | null;
  credentialId?: string | null;
}

export const TERMINAL_APIFY_RUN_STATES: ReadonlySet<string> = new Set(["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"]);
type Run = { id?: unknown; status?: unknown; usageTotalUsd?: unknown };

/** Reserve before starting a paid run; polling updates its one retained receipt. */
export function createRunReceiptStore(maxRuns = 64) {
  if (!Number.isSafeInteger(maxRuns) || maxRuns < 1 || maxRuns > 256) throw new RangeError("Invalid Apify run limit");
  let receipts: ApifyRunReceipt[] = [];
  let usdDrained = false;
  return {
    clear() { receipts = []; usdDrained = false; },
    beginRun(actor: string) {
      if (receipts.length >= maxRuns) throw new RangeError("Apify operation run limit reached");
      const receipt: ApifyRunReceipt = {
        runId: null, actor: actor.slice(0, 128), status: "UNKNOWN", terminal: false, actualUsd: null,
        resultCount: 0, resultCountComplete: false, fetchedResultCount: 0,
      };
      receipts.push(receipt);
      return {
        observe(run: Run) {
          const terminal = typeof run.status === "string" && TERMINAL_APIFY_RUN_STATES.has(run.status);
          receipt.runId = typeof run.id === "string" ? run.id.slice(0, 128) : null;
          receipt.status = typeof run.status === "string" ? run.status.slice(0, 32) : "UNKNOWN";
          receipt.terminal = terminal;
          const usage = run.usageTotalUsd;
          receipt.actualUsd = terminal && typeof usage === "number" && Number.isFinite(usage) && usage >= 0 ? usage : null;
        },
        setCoverage(coverage: ApifyResultCoverage) { Object.assign(receipt, coverage); },
      };
    },
    drainLastRunUsd(): number | null {
      if (usdDrained || receipts.length === 0) return null;
      usdDrained = true;
      if (receipts.some(receipt => receipt.actualUsd === null)) return null;
      const total = receipts.reduce((sum, receipt) => sum + receipt.actualUsd!, 0);
      return Number.isFinite(total) ? total : null;
    },
    drain(): ApifyRunReceipt[] {
      const out = receipts.map(receipt => ({ ...receipt }));
      receipts = []; usdDrained = true;
      return out;
    },
  };
}
