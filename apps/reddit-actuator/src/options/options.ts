import type { ActuatorConfig } from "../lib/types.js";

const $ = (id: string) => document.getElementById(id) as HTMLInputElement;

async function load() {
  const r = await chrome.storage.local.get("actuator.config");
  const c = r["actuator.config"] as ActuatorConfig | undefined;
  if (!c) return;
  $("apiBaseUrl").value = c.apiBaseUrl; $("token").value = c.token; $("instanceId").value = c.instanceId;
  $("capComments").value = String(c.caps.comments);
  $("preferOldReddit").checked = c.preferOldReddit ?? false;
  // deepNightTaper is an inert stub (scheduler densityWeight hardcoded to full
  // density, operator directive e660bccd) — no UI control; nothing to hydrate.
  $("ambientReadActions").checked = c.ambientReadActions ?? true;
  $("upvotesEnabled").checked = c.upvotesEnabled ?? true; // operator opted in (default ON)
  $("upvotesPer15Min").value = String(c.upvotesPer15Min ?? 10);
  $("autonomous").checked = c.autonomous ?? false;
  $("autoDrain").checked = c.autoDrain ?? false; // default OFF (requires autonomous + dashboard auto_send_enabled)
  $("autoStartHour").value = String(c.autoStartHour ?? 9); $("autoEndHour").value = String(c.autoEndHour ?? 21); $("autoWindowHours").value = String(c.autoWindowHours ?? 8);
  $("autoTargetComments").value = String(c.autoTargetComments ?? 8);
  $("challengeCooldownDays").value = String(c.challengeCooldownDays ?? 3); $("healthGate").checked = c.healthGate ?? true;
  $("autoChallengeBackoffDays").value = String(c.autoChallengeBackoffDays ?? 0);
}

document.getElementById("f")!.addEventListener("submit", async (e) => {
  e.preventDefault();
  const config: ActuatorConfig = {
    apiBaseUrl: $("apiBaseUrl").value.trim().replace(/\/$/, ""),
    token: $("token").value.trim(),
    instanceId: $("instanceId").value.trim(),
    // Reddit is reply-only and never votes: likes + dms are hard-zeroed here and
    // again in the background (belt-and-suspenders — no vote/DM action can run).
    caps: { likes: 0, comments: Number($("capComments").value), dms: 0 },
    maxWritesPerHour: 3, // Reddit-safe hourly reply ceiling (REDDIT_DEFAULTS)
    preferWatchlistRatio: 0, // inert on Reddit (there is no like-watchlist bias)
    preferOldReddit: $("preferOldReddit").checked,
    externalLinks: false,
    // Inert stub — kept in the config shape for the scheduler's opts, but the
    // taper never fires (densityWeight hardcoded to 1, operator directive
    // e660bccd: post any hour). No UI control; always false.
    deepNightTaper: false,
    ambientReadActions: $("ambientReadActions").checked,
    // UPVOTE-ONLY, operator opt-in (default ON). Never downvotes. The cap is the
    // hard ≤N/rolling-15-min ceiling enforced in the background.
    upvotesEnabled: $("upvotesEnabled").checked,
    upvotesPer15Min: Number($("upvotesPer15Min").value),
    autonomous: $("autonomous").checked,
    autoDrain: $("autoDrain").checked,
    autoStartHour: Number($("autoStartHour").value),
    autoEndHour: Number($("autoEndHour").value),
    autoWindowHours: Number($("autoWindowHours").value),
    autoTargetComments: Number($("autoTargetComments").value),
    autoTargetLikes: 0, // inert on Reddit (no voting)
    challengeCooldownDays: Number($("challengeCooldownDays").value),
    healthGate: $("healthGate").checked,
    autoChallengeBackoffDays: Number($("autoChallengeBackoffDays").value),
  };
  await chrome.storage.local.set({ "actuator.config": config });
  document.getElementById("msg")!.textContent = "saved ✓";
});

void load();
