import type { ApifyResultCoverage, ApifyRunReceipt } from "./apifyRunReceipts.js";
import { readSourceCount } from "./sourceValues.js";

export interface ApifyReceiptClient {
  drainLastRunUsd?(): number | null;
  drainRunReceipts?(): ApifyRunReceipt[];
}
export interface RotatingTokenCandidate { credentialId: string | null; token: string; wasExhausted: boolean }
export interface ApifyRotationDeps<C extends ApifyReceiptClient> {
  candidates: RotatingTokenCandidate[];
  /** Build a fresh client so simultaneous operations never share its receipt store. */
  buildClient(token: string): C;
  onTokenFatal?: (credentialId: string, status: number, token: string) => void;
  onRecovered?: (credentialId: string) => void;
  totalCount?: number;
  log?: { warn(obj: Record<string, unknown>, message: string): void };
}
interface Policy {
  fatalStatus(error: unknown): number | null;
  exhaustedError(count: number, detail: string): Error;
  limitError(): Error;
  retryActor?: (error: unknown) => boolean;
  maxActorRetries?: number;
  acceptLegacyFailedUsage?: boolean;
}
export const MAX_APIFY_TOKEN_ATTEMPTS = 64;
export function isApifyTokenFatalStatus(status: number): boolean { return status === 401 || status === 402 || status === 403; }
export function apifyExhaustedMessage(count: number, detail: string): string {
  return `no usable Apify token — all ${count} are exhausted or invalid. Add/fix a token in Connections. Last error: ${detail}`;
}
export function legacyApifyCoverage(value: unknown): ApifyResultCoverage {
  const data = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
  const raw = readSourceCount(data.resultCount);
  return { resultCount: raw ?? (Array.isArray(value) ? value.length : 0),
    resultCountComplete: raw !== null && data.resultCountComplete !== false,
    fetchedResultCount: readSourceCount(data.fetchedResultCount) ?? raw ?? (Array.isArray(value) ? value.length : 0) };
}

/** Fork shares token policy; charge, credential and base-client state stay local. */
export function createApifyRotation<C extends ApifyReceiptClient>(deps: ApifyRotationDeps<C>, policy: Policy) {
  const dead = new Set<number>();
  function scope() {
    let lastCredentialId = deps.candidates[0]?.credentialId ?? null;
    let receipts: ApifyRunReceipt[] = [];
    let usdDrained = false;
    let bridgeUsd = 0; let bridgeKnown = true; let bridgeRows = 0;
    function retain(rows: ApifyRunReceipt[], bridge = true) {
      receipts.push(...rows);
      if (!bridge) return;
      bridgeRows += rows.length;
      for (const row of rows) {
        if (row.actualUsd === null) bridgeKnown = false;
        else bridgeUsd += row.actualUsd;
      }
    }
    async function run<T>(call: (client: C) => Promise<T>, actor: string): Promise<T> {
      receipts = []; usdDrained = false;
      bridgeUsd = 0; bridgeKnown = true; bridgeRows = 0;
      let attempts = 0; let actorRetries = 0;
      let lastMessage = deps.candidates.length === 0 ? "all tokens cooling down (awaiting billing reset)" : "unknown";
      for (let index = 0; index < deps.candidates.length; index++) {
        if (dead.has(index)) continue;
        if (attempts >= MAX_APIFY_TOKEN_ATTEMPTS) throw policy.limitError();
        attempts++;
        const candidate = deps.candidates[index]!;
        const client = deps.buildClient(candidate.token);
        let result: T | undefined; let succeeded = false;
        try {
          result = await call(client); succeeded = true; lastCredentialId = candidate.credentialId;
          if (candidate.wasExhausted && candidate.credentialId) deps.onRecovered?.(candidate.credentialId);
          return result;
        } catch (error) {
          const status = policy.fatalStatus(error);
          if (status !== null) {
            dead.add(index); lastMessage = error instanceof Error ? error.message : "token failed";
            if (candidate.credentialId) deps.onTokenFatal?.(candidate.credentialId, status, candidate.token);
            deps.log?.warn({ credentialId: candidate.credentialId, status }, status === 401
              ? "apify token invalid (401); rotating to next" : "apify token exhausted; rotating to next");
          } else if (policy.retryActor?.(error) && actorRetries < (policy.maxActorRetries ?? 0)) {
            actorRetries++; lastMessage = error instanceof Error ? error.message : "actor failed";
            deps.log?.warn({ credentialId: candidate.credentialId, attempt: actorRetries }, "apify actor run failed; retrying same call on next token");
          } else { throw error; }
        } finally {
          const legacyUsd = client.drainLastRunUsd?.() ?? null;
          const received = client.drainRunReceipts?.();
          if (received?.length) retain(received.map(receipt => ({ ...receipt, credentialId: candidate.credentialId })));
          else if (!received || !succeeded) {
            const actualUsd = succeeded || policy.acceptLegacyFailedUsage ? legacyUsd : null;
            // Failed legacy clients have no authoritative receipt. Keep that unknown
            // attempt visible without changing their success-only amount bridge.
            retain([{ runId: null, actor, status: succeeded ? "SUCCEEDED" : "UNKNOWN", terminal: succeeded,
              ...legacyApifyCoverage(result), actualUsd, credentialId: candidate.credentialId }],
              succeeded || !!received || !!policy.acceptLegacyFailedUsage);
          }
        }
      }
      throw policy.exhaustedError(deps.totalCount ?? deps.candidates.length, lastMessage);
    }
    return {
      run, fork: scope, currentCredentialId: () => lastCredentialId,
      drainRunReceipts() { const received = receipts; receipts = []; usdDrained = true; return received; },
      drainLastRunUsd(): number | null {
        if (usdDrained || bridgeRows === 0) return null;
        usdDrained = true;
        return bridgeKnown && Number.isFinite(bridgeUsd) ? bridgeUsd : null;
      },
    };
  }
  return scope();
}
