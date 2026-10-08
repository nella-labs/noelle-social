// X error taxonomy — shared by the cookie/bird path (index.ts) and the official
// API write path (apiClient.ts). Kept in its own module so both can import the
// classes without an index <-> apiClient evaluation cycle.

export class XError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export class XAuthError extends XError {
  constructor(message = "x auth failed", status = 401) {
    super(message, status);
  }
}

export class XRateLimitError extends XError {
  /** Cooldown hint (ms) parsed from x-rate-limit-reset / retry-after on the official API path. */
  retryAfterMs?: number;
  constructor(message = "x rate limited", status = 429) {
    super(message, status);
  }
}

/** Preparation failed before a post request; any unknown budget reservation stays charged. */
export class XWritePreparationError extends XError {
  constructor(message = "x write preparation failed before dispatch") {
    super(message, 503);
    this.name = "XWritePreparationError";
  }
}

/** A write was dispatched but its outcome cannot be confirmed. Never auto-retry. */
export class XWriteUncertainError extends XError {
  readonly receipt?: { id: string; url: string };
  constructor(message = "x write outcome requires reconciliation", receipt?: { id: string; url: string }) {
    super(message, 502);
    this.name = "XWriteUncertainError";
    if (receipt) this.receipt = receipt;
  }
}

/**
 * The account is LOCKED or X flagged the action as automated (Error 226
 * "looks like it might be automated", error 326 temporary lock, a
 * "temporarily limited" / /account/access interstitial, or persistent
 * 403-CSRF). This is NOT a per-request failure to retry — it is an
 * account-level stop signal. Retrying on a locked account is the documented
 * fastest path to permanent suspension, so callers MUST hard-stop + alert a
 * human, never advance the batch or flip the row to 'errored'.
 */
export class XLockError extends XError {
  constructor(message = "x account locked / flagged automated", status = 403) {
    super(message, status);
  }
}

/**
 * X is demanding an interactive human challenge (Arkose / CAPTCHA / verify).
 * A headless cookie session cannot satisfy it — same hard-stop + alert
 * handling as XLockError.
 */
export class XChallengeError extends XError {
  constructor(message = "x human challenge required", status = 403) {
    super(message, status);
  }
}

/** Only a definite rejection permits refunding a dispatched write reservation. */
export function isDefiniteXWriteRejection(error: unknown): error is XError {
  return error instanceof XError && !(error instanceof XWriteUncertainError)
    && !(error instanceof XWritePreparationError) && error.status >= 400 && error.status < 500 && error.status !== 408;
}
