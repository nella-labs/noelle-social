// Pure resolver: given the two per-lever env flags, the master auto-enable
// flag, and whether the instance is in autosend, decide whether voice-variety
// and the reply-diversity gate are ON for this tick. Deterministic, no I/O,
// no Date.now — safe to unit test.
//
// The two levers (voice-variety + reply-diversity gate) are the human-likeness
// levers that most reduce templated / near-duplicate reply signals. The master
// flag lets an operator turn them ON for the unattended (auto_send_enabled) path
// in one switch, without having to remember both per-lever flags. Default OFF ⇒
// behavior is exactly today's (each lever governed only by its own flag).
export interface AutosendQualityInput {
  varietyFlag: boolean; // env.NOELLE_DRAFTER_VARIETY
  diversityGateFlag: boolean; // env.NOELLE_REPLY_DIVERSITY_GATE
  autoEnable: boolean; // env.NOELLE_AUTOSEND_QUALITY_AUTOENABLE (master, default OFF)
  autoSendEnabled: boolean | undefined; // instance.auto_send_enabled
}

export interface AutosendQualityResult {
  variety: boolean;
  diversityGate: boolean;
}

export function resolveAutosendQuality(
  i: AutosendQualityInput,
): AutosendQualityResult {
  const auto = i.autoEnable === true && i.autoSendEnabled === true;
  return {
    variety: i.varietyFlag || auto,
    diversityGate: i.diversityGateFlag || auto,
  };
}
