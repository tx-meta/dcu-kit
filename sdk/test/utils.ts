/**
 * Test Datum Factories
 * 
 * Factory functions for creating test datums with sensible defaults.
 * Eliminates boilerplate and ensures consistency across tests.
 */

import { fromText } from "@lucid-evolution/lucid";
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
  contribution_fee_policyid: "00",
  contribution_fee_assetname: "00",
  contribution_fee: 100n,
  joining_fee_policyid: "00",
  joining_fee_assetname: "00",
  joining_fee: 100n,
  penalty_fee_policyid: "00",
  penalty_fee_assetname: "00",
  penalty_fee: 100n,
  interval_length: 3600000n, // 1 hour
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
