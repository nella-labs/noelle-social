import type { ActuatorConfig } from "../lib/types.js";
import { renderActorOptionsPage } from "@noelle/actuator-cdp";

renderActorOptionsPage(document.body, "LinkedIn");

const $ = (id: string) => document.getElementById(id) as HTMLInputElement;

async function load() {
  const r = await chrome.storage.local.get("actuator.config");
  const c = r["actuator.config"] as ActuatorConfig | undefined;
  if (!c) return;
  $("apiBaseUrl").value = c.apiBaseUrl; $("token").value = c.token; $("instanceId").value = c.instanceId;
  $("capLikes").value = String(c.caps.likes); $("capComments").value = String(c.caps.comments); $("capDms").value = String(c.caps.dms);
  $("preferWatchlistRatio").value = String(c.preferWatchlistRatio); $("deepNightTaper").checked = c.deepNightTaper;
  $("ambientReadActions").checked = c.ambientReadActions ?? true;
  $("autonomous").checked = c.autonomous ?? false;
  $("autoDrain").checked = c.autoDrain ?? false;
  $("autoStartHour").value = String(c.autoStartHour ?? 9); $("autoEndHour").value = String(c.autoEndHour ?? 21); $("autoWindowHours").value = String(c.autoWindowHours ?? 8);
  $("autoTargetComments").value = String(c.autoTargetComments ?? 20); $("autoTargetLikes").value = String(c.autoTargetLikes ?? 40);
  $("challengeCooldownDays").value = String(c.challengeCooldownDays ?? 3); $("healthGate").checked = c.healthGate ?? true;
  $("autoChallengeBackoffDays").value = String(c.autoChallengeBackoffDays ?? 0);
}

document.getElementById("f")!.addEventListener("submit", async (e) => {
  e.preventDefault();
  const config: ActuatorConfig = {
    apiBaseUrl: $("apiBaseUrl").value.trim().replace(/\/$/, ""),
    token: $("token").value.trim(),
    instanceId: $("instanceId").value.trim(),
    caps: { likes: Number($("capLikes").value), comments: Number($("capComments").value), dms: Number($("capDms").value) },
    preferWatchlistRatio: Number($("preferWatchlistRatio").value),
    deepNightTaper: $("deepNightTaper").checked,
    ambientReadActions: $("ambientReadActions").checked,
    autonomous: $("autonomous").checked,
    autoDrain: $("autoDrain").checked,
    autoStartHour: Number($("autoStartHour").value),
    autoEndHour: Number($("autoEndHour").value),
    autoWindowHours: Number($("autoWindowHours").value),
    autoTargetComments: Number($("autoTargetComments").value),
    autoTargetLikes: Number($("autoTargetLikes").value),
    challengeCooldownDays: Number($("challengeCooldownDays").value),
    healthGate: $("healthGate").checked,
    autoChallengeBackoffDays: Number($("autoChallengeBackoffDays").value),
  };
  await chrome.storage.local.set({ "actuator.config": config });
  document.getElementById("msg")!.textContent = "saved ✓";
});

void load();
