/**
 * Test Datum Factories
 * 
 * Factory functions for creating test datums with sensible defaults.
 * Eliminates boilerplate and ensures consistency across tests.
 */

import { GroupDatum } from "../src/core/types.js";
import { AccountDatum } from "../src/core/types.js";

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
  member_count: 0n,
  is_active: true,
  start_time: BigInt(Date.now()),
  ...overrides,
});

/**
 * Creates a default AccountDatum for testing.
 * 
 * Uses placeholder hashes that will pass validator checks.
 * Override any field by passing a partial object.
 * 
 * @param overrides - Fields to override
 * @returns Complete AccountDatum
 * 
 * @example
 * ```typescript
 * // Default account
 * const datum = createDefaultAccountDatum();
 * 
 * // Custom email hash
 * const datum = createDefaultAccountDatum({ 
 *   email_hash: fromText("test@example.com") 
 * });
 * ```
 */
export const createDefaultAccountDatum = (
  overrides?: Partial<AccountDatum>
): AccountDatum => ({
  email_hash: "00".repeat(32),
  phone_hash: "00".repeat(32),
  ...overrides,
});
