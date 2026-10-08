// Playbook persistence now lives in @noelle/runtime (playbooksDb.ts), shared
// with the X intern — noelle.watchlist_playbooks has no platform column, so both
// interns write the same table. This shim re-exports it so existing
// "../lib/playbooks-db.js" imports keep resolving.
export * from "@noelle/runtime/playbooks-db";
