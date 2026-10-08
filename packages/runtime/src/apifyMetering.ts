import { apifySpendRow } from "./apifyPrices.js";
import { batchMap } from "./batchMap.js";
import type { SpendRow } from "./spendRecorder.js";
import { legacyApifyCoverage, type ApifyReceiptClient } from "./apifyRotation.js";

type SpendArgs = Parameters<typeof apifySpendRow>[0] & {
  recorder?: { record(row: SpendRow): Promise<unknown> } | null | undefined;
  log: { warn(obj: Record<string, unknown>, message: string): void };
  resultCountComplete?: boolean | undefined;
  fetchedResultCount?: number | undefined;
};
type OperationArgs<C extends ApifyReceiptClient> = Omit<SpendArgs, "resultCount" | "resultCountComplete" | "fetchedResultCount" | "actualUsd"> & {
  client: C;
};

/** Meter reported charges; estimate only a known raw total, never normalized length. */
export async function meterApifyRun(args: SpendArgs): Promise<void> {
  const { recorder, log, resultCountComplete, fetchedResultCount, ...spend } = args;
  const hasActual = typeof spend.actualUsd === "number" && Number.isFinite(spend.actualUsd) && spend.actualUsd >= 0;
  if (!hasActual && (resultCountComplete === false || spend.resultCount <= 0)) {
    log.warn({ worker: spend.worker, actor: spend.actor, fetchedResultCount: fetchedResultCount ?? null },
      "Apify spend unknown: run usage and complete result total are unavailable");
    return;
  }
  if (!recorder) return;
  try { await recorder.record(apifySpendRow(spend)); }
  catch { log.warn({ worker: spend.worker, actor: spend.actor }, "Apify spend could not be recorded"); }
}

/** Isolate and drain each logical operation, including failures and empty results. */
export async function withMeteredApifyCall<C extends ApifyReceiptClient, T>(
  args: OperationArgs<C>, call: (client: C) => Promise<T>,
): Promise<T> {
  const { client, ...spend } = args;
  const operation = (client as C & { isolateOperation?: () => C }).isolateOperation?.() ?? client;
  let result: T | undefined; let succeeded = false;
  try { result = await call(operation); succeeded = true; return result; }
  finally {
    const actualUsd = operation.drainLastRunUsd?.() ?? null;
    const receipts = operation.drainRunReceipts?.();
    const latencyMs = Date.now() - spend.startedAt.getTime();
    if (receipts) {
      await batchMap(receipts, receipt => meterApifyRun({ ...spend, ...receipt, latencyMs,
        credentialId: receipt.credentialId === undefined ? spend.credentialId ?? null : receipt.credentialId }),
        { concurrency: 4 });
    } else if (succeeded || actualUsd !== null) {
      await meterApifyRun({ ...spend, ...legacyApifyCoverage(result), actualUsd, latencyMs });
    }
    if (!succeeded && (!receipts || receipts.length === 0) && actualUsd === null) {
      spend.log.warn({ worker: spend.worker, actor: spend.actor },
        "Apify spend unknown: operation failed before run usage could be confirmed");
    }
  }
}
