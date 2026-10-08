/** Provider account totals and local run records have different coverage. Never add them together. */
export interface UsageSnapshot {
  credentialId: string;
  label: string;
  active: boolean;
  accountId: string;
  cycleStartAt: string;
  cycleEndAt: string;
  usageUsd: number;
  fetchedAt: string;
  dailyUsage: { date: string; usageUsd: number }[];
}
export interface ApifyLedgerDay {
  credentialId: string | null;
  label: string;
  active: boolean;
  day: string;
  cents: number;
}
export interface ApifyTokenSpend {
  credentialId: string | null;
  label: string;
  active: boolean;
  cents: number;
  source: "provider" | "unverified";
  accountId?: string;
  fetchedAt?: string;
  cycleStartAt?: string;
  cycleEndAt?: string;
}

function accountCycles(snapshots: UsageSnapshot[]): UsageSnapshot[] {
  const latest = new Map<string, UsageSnapshot>();
  for (const s of snapshots) {
    const key = `${s.accountId}:${new Date(s.cycleStartAt).toISOString()}`;
    const prev = latest.get(key);
    if (!prev || Date.parse(s.fetchedAt) > Date.parse(prev.fetchedAt)) latest.set(key, s);
  }
  return [...latest.values()];
}

/** A saved reading covers only completed UTC days in its billing cycle. */
function uncoveredLedger(snapshots: UsageSnapshot[], ledger: ApifyLedgerDay[]): ApifyLedgerDay[] {
  const coverage = snapshots.map(s => ({
    credentialId: s.credentialId,
    startDay: s.cycleStartAt.slice(0, 10),
    endDay: s.cycleEndAt.slice(0, 10),
    fetchedDay: new Date(s.fetchedAt).toISOString().slice(0, 10),
  }));
  // The ledger aggregates a whole day, so the fetch day can include later runs.
  return ledger.filter(l => !coverage.some(s => s.credentialId === l.credentialId &&
    l.day >= s.startDay && l.day <= s.endDay && l.day < s.fetchedDay));
}

export function apifyTokenSpend(snapshots: UsageSnapshot[], ledger: ApifyLedgerDay[]): ApifyTokenSpend[] {
  const cycles = accountCycles(snapshots);
  const latestByAccount = new Map<string, UsageSnapshot>();
  for (const s of cycles) {
    const prev = latestByAccount.get(s.accountId);
    if (!prev || Date.parse(s.cycleStartAt) > Date.parse(prev.cycleStartAt)) latestByAccount.set(s.accountId, s);
  }
  const tokens = new Map<string, ApifyTokenSpend>();
  for (const s of [...snapshots].sort((a, b) => Date.parse(a.fetchedAt) - Date.parse(b.fetchedAt))) {
    const latest = latestByAccount.get(s.accountId)!;
    tokens.set(s.credentialId, {
      credentialId: s.credentialId, label: s.label, active: s.active,
      cents: latest.usageUsd * 100, source: "provider", accountId: s.accountId,
      fetchedAt: latest.fetchedAt, cycleStartAt: latest.cycleStartAt, cycleEndAt: latest.cycleEndAt,
    });
  }
  // Unsynced historical charges stay visible, including records whose old FK was deleted.
  const unverified = new Map<string | null, ApifyTokenSpend>();
  for (const l of uncoveredLedger(snapshots, ledger)) {
    const previous = unverified.get(l.credentialId);
    unverified.set(l.credentialId, {
      credentialId: l.credentialId, label: l.label, active: l.active,
      cents: (previous?.cents ?? 0) + l.cents, source: "unverified",
    });
  }
  return [...tokens.values(), ...unverified.values()].filter(r => r.source === "provider" || r.cents > 0);
}

export function summarizeApifyProviderSpend(
  snapshots: UsageSnapshot[], ledger: ApifyLedgerDay[], startIso: string | null,
) {
  const startDay = startIso?.slice(0, 10) ?? "";
  const byDay = new Map<string, number>();
  const cycles = accountCycles(snapshots);
  for (const s of cycles) {
    for (const d of s.dailyUsage) {
      const day = d.date.slice(0, 10);
      if (day >= startDay) byDay.set(day, (byDay.get(day) ?? 0) + d.usageUsd * 100);
    }
  }
  return {
    cents: [...byDay.values()].reduce((a, b) => a + b, 0),
    unverifiedCents: uncoveredLedger(snapshots, ledger)
      .filter(l => l.day >= startDay).reduce((a, l) => a + l.cents, 0),
    fetchedAt: cycles.reduce<string | null>((latest, s) =>
      !latest || Date.parse(s.fetchedAt) > Date.parse(latest) ? s.fetchedAt : latest, null),
    byDay: [...byDay].sort(([a], [b]) => a.localeCompare(b)).map(([day, cents]) => ({ day, cents })),
  };
}
