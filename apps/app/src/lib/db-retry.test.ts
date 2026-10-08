import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DbTimeoutError,
  isRetryableConnError,
  isRetryableReadError,
  runWithRetry,
  withTimeout,
} from "./db-retry";

describe("isRetryableConnError", () => {
  it("retries the Cloud SQL expired-cert TLS handshake failure (the actual outage)", () => {
    expect(
      isRetryableConnError({
        code: "ERR_SSL_SSL/TLS_ALERT_BAD_CERTIFICATE",
        message:
          "C008...:error:0A000412:SSL routines:ssl3_read_bytes:ssl/tls alert bad certificate ... SSL alert number 42",
      }),
    ).toBe(true);
  });

  it("retries postgres.js connection-class errors", () => {
    for (const code of [
      "CONNECTION_DESTROYED",
      "CONNECTION_CLOSED",
      "CONNECTION_ENDED",
      "CONNECT_TIMEOUT",
      "ECONNRESET",
      "ETIMEDOUT",
    ]) {
      expect(isRetryableConnError({ code }), code).toBe(true);
    }
  });

  it("NEVER retries a server-side PostgresError — a write must not double-apply", () => {
    // PostgresError carries `.severity` + a 5-char SQLSTATE.
    expect(
      isRetryableConnError({
        severity: "ERROR",
        code: "23505",
        message: "duplicate key value violates unique constraint",
      }),
    ).toBe(false);
    expect(
      isRetryableConnError({ severity: "ERROR", code: "23503", message: "foreign key violation" }),
    ).toBe(false);
    // Even a server error whose message happens to contain "tls" must not retry.
    expect(
      isRetryableConnError({ severity: "FATAL", code: "57P01", message: "terminating ... tls" }),
    ).toBe(false);
  });

  it("ignores non-errors and unrelated application errors", () => {
    expect(isRetryableConnError(null)).toBe(false);
    expect(isRetryableConnError(undefined)).toBe(false);
    expect(isRetryableConnError("a string")).toBe(false);
    expect(isRetryableConnError({ message: "Cannot read properties of undefined" })).toBe(false);
  });

  it("retries a DbTimeoutError — a client-build HANG is healed like a dropped conn", () => {
    // This is the link that makes the whole fix work: the timeout we throw when
    // the connector/token build hangs must be classified retryable, or the
    // self-heal won't fire and the page stays frozen.
    expect(isRetryableConnError(new DbTimeoutError("cloud-sql client build", 9000))).toBe(true);
  });
});

describe("isRetryableReadError", () => {
  it("allows real server disconnects only for the enforced read-only path", () => {
    for (const code of ["08006", "57P01", "57P02", "57P03"]) {
      const error = { severity: "FATAL", code };
      expect(isRetryableConnError(error)).toBe(false);
      expect(isRetryableReadError(error)).toBe(true);
    }
  });
  it("does not retry read-only violations, statement cancellation, or unrelated SQL errors", () => {
    for (const code of ["25006", "57014", "23505", "42601"]) expect(isRetryableReadError({ severity: "ERROR", code })).toBe(false);
  });
});

describe("withTimeout", () => {
  afterEach(() => vi.useRealTimers());

  it("resolves with the value when the promise settles in time", async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, "x")).resolves.toBe(42);
  });

  it("propagates a rejection from the inner promise unchanged", async () => {
    const boom = new Error("boom");
    await expect(withTimeout(Promise.reject(boom), 1000, "x")).rejects.toBe(boom);
  });

  it("rejects with a retryable DbTimeoutError when the inner promise hangs", async () => {
    vi.useFakeTimers();
    const neverSettles = new Promise<number>(() => {});
    const p = withTimeout(neverSettles, 9000, "cloud-sql client build");
    const assertion = expect(p).rejects.toBeInstanceOf(DbTimeoutError);
    await vi.advanceTimersByTimeAsync(9000);
    await assertion;
    await expect(p.catch((e) => isRetryableConnError(e))).resolves.toBe(true);
  });
});

describe("runWithRetry", () => {
  afterEach(() => vi.useRealTimers());

  it("returns the value on first success without resetting", async () => {
    const reset = vi.fn();
    await expect(runWithRetry(async () => "ok", { reset })).resolves.toBe("ok");
    expect(reset).not.toHaveBeenCalled();
  });

  it("self-heals a transient connector hang: times out, resets, retries, recovers", async () => {
    vi.useFakeTimers();
    const reset = vi.fn(async () => {});
    let calls = 0;
    const attempt = vi.fn(() => {
      calls += 1;
      // First attempt models the frozen connector (hangs forever); after the
      // reset tears it down, the rebuilt client succeeds.
      return calls === 1
        ? new Promise<string>(() => {})
        : Promise.resolve("recovered");
    });

    const p = runWithRetry(attempt, { reset, timeoutMs: 12_000, backoffMs: [150, 500] });
    await vi.advanceTimersByTimeAsync(12_000); // attempt #1 hits the timeout
    await vi.advanceTimersByTimeAsync(250); // jittered backoff, then retry
    await expect(p).resolves.toBe("recovered");
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("gives up after exhausting retries when the hang never clears", async () => {
    vi.useFakeTimers();
    const reset = vi.fn(async () => {});
    const attempt = vi.fn(() => new Promise<string>(() => {})); // always hangs
    const p = runWithRetry(attempt, { reset, timeoutMs: 1000, backoffMs: [10, 10] });
    const assertion = expect(p).rejects.toBeInstanceOf(DbTimeoutError);
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(1000); // attempt times out
      await vi.advanceTimersByTimeAsync(60); // backoff (if any)
    }
    await assertion;
    expect(attempt).toHaveBeenCalledTimes(3); // initial + 2 retries
    expect(reset).toHaveBeenCalledTimes(2);
  });

  it("NEVER retries a server-side PostgresError — a write must not double-apply", async () => {
    const reset = vi.fn();
    const pgError = { severity: "ERROR", code: "23505", message: "duplicate key" };
    await expect(
      runWithRetry(async () => {
        throw pgError;
      }, { reset, timeoutMs: 1000 }),
    ).rejects.toBe(pgError);
    expect(reset).not.toHaveBeenCalled();
  });
});
