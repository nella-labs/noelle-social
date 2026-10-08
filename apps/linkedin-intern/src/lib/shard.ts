// Apify sharding primitives now live in @noelle/runtime (shard.ts), shared with
// the X intern. The functions are pure and platform-agnostic (round-robin split,
// budget split, launch stagger, bounded-concurrency runner). This shim re-exports
// them so existing "../lib/shard.js" imports keep resolving.
// Tests live in packages/runtime/src/shard.test.ts.
export * from "@noelle/runtime/shard";
