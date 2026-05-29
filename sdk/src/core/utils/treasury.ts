import { UTxO } from "@lucid-evolution/lucid";
import { TreasuryDatum, GroupDatum } from "../types.js";

export type TreasuryState = {
  utxo: UTxO;
  datum: TreasuryDatum;
};

/**
 * Helper to calculate the current rotation slot based on time
 */
export function calculateCurrentSlot(
  currentTime: number, // Milliseconds
  groupDatum: GroupDatum,
): number {
  // (current - start) / interval % num_rounds
  if (currentTime < Number(groupDatum.start_time)) {
    return 0; // Not started
  }

  // Ensure we handle BigInt/Number conversion safely if types differ
  const start = Number(groupDatum.start_time);
  const interval = Number(groupDatum.interval_length);
  const numIntervals = Number(groupDatum.num_rounds);

  const elapsed = currentTime - start;
  const currentInterval = Math.floor(elapsed / interval);

  return currentInterval % numIntervals;
}
// Unused functions fetchTreasuryState and findMemberTreasury removed.
