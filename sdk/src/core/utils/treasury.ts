import { UTxO } from "@lucid-evolution/lucid";
import { TreasuryDatum, GroupDatum } from "../types.js";

export type TreasuryState = {
  utxo: UTxO;
  datum: TreasuryDatum;
};

/**
 * Lovelace permanently retained in any live treasury/penalty UTxO to satisfy the ledger
 * min-ADA requirement of the membership token it carries. Mirrors the Aiken
 * `min_ada_reserve` constant (dcu/treasury_utils): the validator excludes this reserve
 * from the *contributable* balance for ADA-denominated assets, so on the final round a
 * member's contributable balance reaches 0 while the reserve still carries the token.
 * Keep the two values in lockstep.
 */
export const MIN_ADA_RESERVE = 2_000_000n;

/**
 * The spendable amount of a contribution/penalty asset given its raw on-UTxO balance.
 * For an ADA-denominated asset the min-ADA reserve is excluded (mirrors the validator's
 * `contributable_in`); for native tokens the full balance is contributable because the
 * token is independent of the UTxO's lovelace.
 */
export function contributableBalance(
  rawBalance: bigint,
  isAdaAsset: boolean,
): bigint {
  return isAdaAsset ? rawBalance - MIN_ADA_RESERVE : rawBalance;
}

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
