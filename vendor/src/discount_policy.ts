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
