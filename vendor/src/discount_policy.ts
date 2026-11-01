// Discount policy: concede only on a *verified* proof that a lower offer
// exists elsewhere. No valid proof -> no concession. Never below the floor.

export interface PolicyDecision {
  action: "concede" | "reject" | "floor";
  newPrice: number;
  reason: string;
}

// Hidden floor. Never exposed via the API or any message.
export const FLOOR = Number(process.env.VENDOR_FLOOR ?? 60);
// How far below the attested price we jump when conceding.
const UNDERCUT = Number(process.env.VENDOR_UNDERCUT ?? 3);

export const round2 = (n: number): number => Math.round(n * 100) / 100;

// --- Proof-anchored mirror pricing ---------------------------------------
// Ask and bottom line derive from the first attested online price for the
// product, per this vendor's own policy. Env is read per call so each
// deployed instance (and each test) carries its own knobs:
//   VENDOR_MARKUP_PCT    ask = anchor * (1 + markup%)   (default 5)
//   VENDOR_FLOOR_PCT     floor = anchor * (1 - floor%)  (default 8)
//   VENDOR_UNDERCUT_MODE penny (beat by $0.01) | percent (beat by PCT%)
//   VENDOR_UNDERCUT_PCT  percent-mode step              (default 5)
export function anchoredAsk(anchor: number): number {
  const markup = Number(process.env.VENDOR_MARKUP_PCT ?? 5);
  return round2(anchor * (1 + markup / 100));
}

export function anchoredFloor(anchor: number): number {
  const pct = Number(process.env.VENDOR_FLOOR_PCT ?? 8);
  return Math.max(0.01, round2(anchor * (1 - pct / 100)));
}

// Beat a verified rival price the way this vendor negotiates: just under
// it, never below its floor. At the floor it holds — lowest floor wins.
export function beat(
  currentPrice: number,
  attestedLowest: number | null,
  floor: number,
): PolicyDecision {
  if (attestedLowest === null) {
    return { action: "reject", newPrice: currentPrice, reason: "no verified lower offer" };
  }
  if (attestedLowest >= currentPrice) {
    return { action: "reject", newPrice: currentPrice, reason: "attested offer is not lower" };
  }
  const mode = process.env.VENDOR_UNDERCUT_MODE ?? "penny";
  const pct = Number(process.env.VENDOR_UNDERCUT_PCT ?? 5);
  const step = mode === "percent" ? Math.max(0.01, round2((attestedLowest * pct) / 100)) : 0.01;
  const target = round2(attestedLowest - step);
  if (target <= floor) {
    if (floor >= currentPrice) {
      return { action: "reject", newPrice: currentPrice, reason: "attested offer is not lower" };
    }
    return { action: "floor", newPrice: floor, reason: "best possible price reached" };
  }
  return { action: "concede", newPrice: target, reason: "verified lower offer" };
}

export function decide(currentPrice: number, attestedLowest: number | null): PolicyDecision {
  if (attestedLowest === null) {
    return { action: "reject", newPrice: currentPrice, reason: "no verified lower offer" };
  }
  if (attestedLowest >= currentPrice) {
    return { action: "reject", newPrice: currentPrice, reason: "attested offer is not lower" };
  }
  const target = attestedLowest - UNDERCUT;
  if (target <= FLOOR) {
    return { action: "floor", newPrice: FLOOR, reason: "best possible price reached" };
  }
  return { action: "concede", newPrice: target, reason: "verified lower offer" };
}
