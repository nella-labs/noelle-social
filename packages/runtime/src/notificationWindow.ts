// The notification recency window — ONE number, in one place.
//
// the operator's rule: a reply is worth answering only if it is recent. Answering a
// two-day-old comment is necro-engagement — the thread has moved on and the
// answer reads as a bot working through a backlog.
//
// This file exists because the number drifted the first day it shipped. Two
// sessions set it independently: the browser actuators enforced one value while
// the server's claim RPC enforced another, and the server silently won. The
// client's window is a politeness filter; the SERVER's is the real gate, since
// it decides what may be drafted and sent regardless of what any client
// harvested. When they disagree, the operator gets the stricter one and no
// error — the worst kind of bug, because everything looks like it works.
//
// Anything server-side (api-vm, the interns, the SQL functions) must derive its
// bound from here. Two places necessarily hold a COPY rather than an import:
//
//   - the Chrome extensions (apps/x-actuator, apps/linkedin-actuator) — a
//     content script cannot import a workspace package, so each declares its own
//     MAX_AGE_MINUTES. A test in each of them reads THIS file and fails if the
//     numbers diverge.
//   - the SQL in infra/cloudsql/schema/ — a migration is a frozen artifact and
//     cannot import anything. Changing this constant means writing a migration
//     that redefines the claim functions to match.
//
// See docs/notifications-actor.md § the recency window.

/** How old a reply may be and still be worth answering. */
export const NOTIFICATION_MAX_AGE_HOURS = 12;

/** The same bound in minutes, for the clients that measure that way. */
export const NOTIFICATION_MAX_AGE_MINUTES = NOTIFICATION_MAX_AGE_HOURS * 60;

/**
 * The bound as a Postgres interval literal, e.g. `12 hours`.
 *
 * Callers interpolate this into `interval '...'` / `make_interval` inside a
 * tagged SQL template. It is derived from an integer constant and never from
 * user input, so it cannot carry an injection.
 */
export const NOTIFICATION_MAX_AGE_SQL_INTERVAL = `${NOTIFICATION_MAX_AGE_HOURS} hours`;
