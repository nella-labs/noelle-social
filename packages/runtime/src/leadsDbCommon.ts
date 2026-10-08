// RESERVED PLACEHOLDER — no runtime code here yet.
//
// Lane INT-DB-0 reserved this module and its `@noelle/runtime/leads-db-common`
// subpath export up front so the later intern data-layer lanes can land file
// contents without every one of them editing packages/runtime/package.json and
// colliding in it.
//
// What lands here: the platform-agnostic half of the leads DB layer (claim /
// status transitions / caps over noelle.leads), today duplicated three ways as
// apps/{x,linkedin,reddit}-intern/src/lib/leads-db.ts. Only the genuinely common
// parts move; each intern keeps its platform-shaped queries.
//
// Owned by the later lane that performs that extraction. Until then this file is
// deliberately empty: `export {}` only, so it is a module and compiles clean.

export {};
