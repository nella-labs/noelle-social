// KILL SWITCH for the notifications actor ("Auto notifications").
//
// Turned OFF at the operator's instruction, with re-enabling deliberately
// requiring a CODE change — not a dashboard toggle, not a DB column, not an env
// var. The feature reached a state where it could navigate to a post and fail
// to reply, and the operator wanted it inert until that is finished rather than
// half-working behind a flag someone could flip by accident.
//
// TO RE-ENABLE: set this to `true`, rebuild, redeploy. That is the whole
// procedure, and it is intentionally the only one.
//
// While false:
//   - the panel does not render the "Auto notifications" button
//   - startNotifications refuses if it is somehow invoked
//   - notificationSweepDue never returns true, so no sweep can run
//
// The sweep is read-only, but it is the thing that FILES conversation leads —
// so off here means no new notification lead is created, which is the real
// stop. Existing leads already in the pipeline are unaffected; drain or skip
// them from the dashboard.
export const NOTIFICATIONS_ACTOR_ENABLED = false;
