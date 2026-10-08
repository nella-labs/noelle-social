/**
 * Three-layer budget cap check (D27).
 *
 * All three caps must pass before any LLM call. Any failure throws
 * BudgetExceededError synchronously (well, after the async fetches resolve),
 * before the model is invoked.
 */

/** Thrown when any cap layer is exceeded. */
export class BudgetExceededError extends Error {
  readonly layer: "bucket" | "org" | "instance";
  readonly spentCents: number;
  readonly capCents: number;
  readonly estimatedCents: number;

  constructor(args: {
    layer: "bucket" | "org" | "instance";
    spent_cents: number;
    cap_cents: number;
    estimated_cents: number;
  }) {
    super(
      `Budget exceeded on layer "${args.layer}": spent=${args.spent_cents} + estimated=${args.estimated_cents} > cap=${args.cap_cents}`,
    );
    this.name = "BudgetExceededError";
    this.layer = args.layer;
    this.spentCents = args.spent_cents;
    this.capCents = args.cap_cents;
    this.estimatedCents = args.estimated_cents;
  }
}

export type CapsSnapshot = {
  bucket: number;
  org: number;
  instance: number;
};

export type SpendSnapshot = {
  bucket: number;
  org: number;
  instance: number;
};

export type CapAdapters = {
  /** Durable admission for production adapters; snapshot-only adapters remain useful for pure callers. */
  reserveAttempt?: (args: BudgetAttempt) => Promise<{ attemptId: string }>;
  /** Returns current month-to-date spend in cents for each layer. */
  fetchSpend: (args: {
    bucket: string;
    orgId: string;
    instanceId: string;
  }) => Promise<SpendSnapshot>;
  /** Returns the cap in cents for each layer. */
  fetchCaps: (args: {
    bucket: string;
    orgId: string;
    instanceId: string;
  }) => Promise<CapsSnapshot>;
  /**
   * Spend for ONE engine in the current period, in cents.
   *
   * The main layers deliberately exclude codex-cli: it draws on a separate
   * ChatGPT subscription, and counting it against the Claude cap would make the
   * budget failover refuse the very call meant to route around that cap. But
   * "exempt from the Claude cap" was left meaning "unbounded", which is not a
   * thing a budget system should have. This gives the second pot a ceiling of
   * its own without entangling the two.
   *
   * Optional so existing adapters (and every test stub) keep working; absent ⇒
   * the caller treats the engine as uncapped, i.e. today's behaviour.
   */
  fetchEngineSpend?: (args: { engine: string; orgId: string }) => Promise<number>;
};

export type BudgetAttempt = {
  bucket: string;
  orgId: string;
  instanceId: string;
  agentRole: string;
  worker: string;
  engine: string;
  model: string;
  estimatedCents: number;
  /** A separate pot for engines exempt from the common layers. */
  engineCapCents?: number;
};

/**
 * Asserts the estimated call cost fits within all three cap layers.
 *
 * Fetches spend and caps in parallel, then checks bucket → org → instance in
 * that order. Throws BudgetExceededError at the first failing layer.
 */
export async function assertWithinCap(
  args: {
    bucket: string;
    orgId: string;
    instanceId: string;
    estimatedCents: number;
  },
  adapters: CapAdapters,
): Promise<void> {
  const [spend, caps] = await Promise.all([
    adapters.fetchSpend({
      bucket: args.bucket,
      orgId: args.orgId,
      instanceId: args.instanceId,
    }),
    adapters.fetchCaps({
      bucket: args.bucket,
      orgId: args.orgId,
      instanceId: args.instanceId,
    }),
  ]);

  const layers: Array<{
    layer: "bucket" | "org" | "instance";
    spent: number;
    cap: number;
  }> = [
    { layer: "bucket", spent: spend.bucket, cap: caps.bucket },
    { layer: "org", spent: spend.org, cap: caps.org },
    { layer: "instance", spent: spend.instance, cap: caps.instance },
  ];

  for (const check of layers) {
    if (check.spent + args.estimatedCents > check.cap) {
      throw new BudgetExceededError({
        layer: check.layer,
        spent_cents: check.spent,
        cap_cents: check.cap,
        estimated_cents: args.estimatedCents,
      });
    }
  }
}
