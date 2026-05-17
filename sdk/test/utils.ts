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
export function extractTokenSuffix(utxo: UTxO, policyId: string, prefix: string): string {
    const key = Object.keys(utxo.assets).find(
        k => k.startsWith(policyId) && k.slice(policyId.length).startsWith(prefix)
    );
    if (!key) throw new Error(`No token with prefix ${prefix} found in UTxO ${utxo.txHash}#${utxo.outputIndex}`);
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
  overrides?: Partial<GroupDatum>
): GroupDatum => ({
  // ADA is represented as empty bytes "" — NOT "00" (which is a 1-byte non-ADA token).
  // The Aiken validator uses assets.quantity_of(value, policyid, assetname) for fee checks;
  // quantity_of(value, "", "") returns lovelace. Using "00" would look up a non-existent
  // token and return 0, causing fees_locked? to fail with "exited prematurely".
  contribution_fee_policyid: "",
  contribution_fee_assetname: "",
  contribution_fee: 2_000_000n,  // 2 ADA — must be > 0 per Aiken CreateGroup check
  joining_fee_policyid: "",
  joining_fee_assetname: "",
  joining_fee: 0n,
  penalty_fee_policyid: "",
  penalty_fee_assetname: "",
  penalty_fee: 2_000_000n,      // 2 ADA — must be >= 0
  interval_length: 3_600_000n,  // 1 hour in milliseconds
  num_intervals: 10n,
  max_members: 30n,
  member_count: 0n,
  is_active: true,
  start_time: BigInt(Date.now()),
  // Fixed 28-byte test placeholder for admin_payment_credential.
  // With joining_fee: 0n this field is unused by the treasury validator,
  // but validate_create_group requires exactly 28 bytes (56 hex chars).
  admin_payment_credential: "a0a1a2a3a4a5a6a7a8a9b0b1b2b3b4b5b6b7b8b9c0c1c2c3c4c5c6c7",
  ...overrides,
});

