/**
 * Test Datum Factories
 *
 * Factory functions for creating test datums with sensible defaults.
 * Eliminates boilerplate and ensures consistency across tests.
 */

import { UTxO } from "@lucid-evolution/lucid";
import { GroupDatum } from "../src/core/types.js";

/**
 * Extracts the shared 28-byte suffix from a CIP-68 token in a UTxO.
 * Works for both prefix100 and prefix222 — strips the policyId and the 4-byte prefix.
 */
export function extractTokenSuffix(
  utxo: UTxO,
  policyId: string,
  prefix: string,
): string {
  const key = Object.keys(utxo.assets).find(
    (k) =>
      k.startsWith(policyId) && k.slice(policyId.length).startsWith(prefix),
  );
  if (!key)
    throw new Error(
      `No token with prefix ${prefix} found in UTxO ${utxo.txHash}#${utxo.outputIndex}`,
    );
  return key.slice(policyId.length + prefix.length);
}

/**
 * Creates a default GroupDatum for testing.
 *
 * All fields use safe defaults that will pass validator checks.
 * Override any field by passing a partial object.
 *
 * @param overrides - Fields to override
 * @returns Complete GroupDatum
 *
 * @example
 * ```typescript
 * // Default datum
 * const datum = createDefaultGroupDatum();
 *
 * // Custom member count
 * const datum = createDefaultGroupDatum({ member_count: 5n });
 * ```
 */
export const createDefaultGroupDatum = (
  overrides?: Partial<GroupDatum>,
): GroupDatum => ({
  // contribution_fee_policyid: ADA is empty bytes "" — NOT "00" (which is a 1-byte non-ADA token).
  // The Aiken validator uses assets.quantity_of(value, policyid, assetname) for fee checks;
  // quantity_of(value, "", "") returns lovelace. Using "00" would look up a non-existent
  // token and return 0, causing fees_locked? to fail with "exited prematurely".
  contribution_fee_policyid: "",
  contribution_fee_assetname: "",
  contribution_fee: 2_000_000n, // 2 ADA — must be > 0 per Aiken CreateGroup check
  joining_fee_policyid: "",
  joining_fee_assetname: "",
  joining_fee: 0n,
  penalty_fee_policyid: "",
  penalty_fee_assetname: "",
  penalty_fee: 2_000_000n, // 2 ADA — must be >= 0
  grace_period_length: 0n,
  creator_bond: 0n, // 0 for test groups (no bond required)
  interval_length: 3_600_000n, // 1 hour in milliseconds
  // num_rounds is 0 at creation — assigned to member_count at startGroup.
  // Required by validate_create_group (num_rounds == 0 check).
  num_rounds: 0n,
  // Within the protocol ceiling (max_group_members = 20). Was 30 before the scale cap.
  max_members: 20n,
  member_count: 0n,
  // 0 at creation; startGroup sets it to member_count. Active-cycle tests override explicitly.
  active_member_count: 0n,
  is_active: true,
  is_started: false,
  last_distributed_round: -1n,
  // start_time MUST be 0 at creation — validate_create_group enforces (start_time == 0).
  // startGroup sets it to get_lower_bound(tx) when sealing membership.
  start_time: 0n,
  // Fixed 28-byte test placeholder for creator_payment_credential (VK kind).
  // With joining_fee: 0n this field is unused by the treasury validator,
  // but validate_create_group requires a 28-byte hash (56 hex chars).
  creator_payment_credential: {
    VerificationKey: [
      "a0a1a2a3a4a5a6a7a8a9b0b1b2b3b4b5b6b7b8b9c0c1c2c3c4c5c6c7",
    ] as [string],
  },
  member_token_names: [],
  // 1 = PerRound (traditional ROSCA, default). Set to max_members for FullUpfront,
  // or any k in [1, max_members] for partial collateral.
  collateral_rounds: 1n,
  // Push = current direct-wallet-payout behaviour (default). Pull groups override this.
  payout_mode: "Push",
  // 2 = the envelope floor (min_recovery_threshold) — one member can never
  // satisfy a recovery quorum alone.
  recovery_threshold: 2n,
  // 259_200_000 ms = 3 days veto window before a recovery can execute.
  recovery_timelock: 259_200_000n,
  member_slots: [],
  era_start_round: 0n,
  recommit_window: 259_200_000n,
  reserve_join_levy: 0n,
  reserve_round_levy: 0n,
  ...overrides,
});
