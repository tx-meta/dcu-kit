import { LucidEvolution, UTxO } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { TreasuryDatum, TreasuryDatumSchema, GroupDatum } from "../types.js";
import {
  AmbiguousUtxoError,
  LucidError,
  UtxoNotFoundError,
} from "../errors.js";
import { parseSafeDatum } from "./datum.js";
import { patchInlineDatum } from "./tx.js";

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
/**
 * The owning group's (100) reference token name for any treasury datum variant that
 * carries one. Every variant does today (TreasuryState, PenaltyState, DefaultState,
 * RecoveryRequest, ReserveState), so `null` means the datum did not decode as a
 * treasury datum at all.
 */
export function treasuryGroupRefName(datum: TreasuryDatum): string | null {
  if (typeof datum === "string") return null;
  if ("TreasuryState" in datum)
    return datum.TreasuryState.group_reference_tokenname;
  if ("PenaltyState" in datum)
    return datum.PenaltyState.group_reference_tokenname;
  if ("DefaultState" in datum)
    return datum.DefaultState.group_reference_tokenname;
  if ("RecoveryRequest" in datum)
    return datum.RecoveryRequest.group_reference_tokenname;
  if ("ReserveState" in datum)
    return datum.ReserveState.group_reference_tokenname;
  return null;
}

/**
 * Resolves the treasury UTxO holding `unit`, narrowed to the group named by
 * `groupRefName` (a (100) group reference token name).
 *
 * A member's treasury token name is their account (222) token name, which the
 * validator requires, so the unit alone does not identify a UTxO once that member
 * belongs to more than one group. `lucid.utxoByUnit` rejects outright in that case;
 * this reads every candidate with `utxosAtWithUnit` and picks by the datum's
 * `group_reference_tokenname`.
 *
 * `groupRefName` is optional so callers that never had it keep working for
 * single-group members. It is required to break a tie.
 */
export const resolveTreasuryUtxoForGroup = (
  lucid: LucidEvolution,
  treasuryAddress: string,
  unit: string,
  groupRefName?: string,
): Effect.Effect<
  UTxO,
  UtxoNotFoundError | AmbiguousUtxoError | LucidError,
  never
> =>
  Effect.gen(function* () {
    const candidates = yield* Effect.tryPromise({
      try: () => lucid.utxosAtWithUnit(treasuryAddress, unit),
      catch: (e) =>
        new LucidError({
          message: `utxosAtWithUnit failed for ${unit} at ${treasuryAddress}: ${String(e)}`,
          cause: e,
        }),
    });

    if (candidates.length === 0)
      return yield* Effect.fail(
        new UtxoNotFoundError({
          tokenName: unit,
          address: treasuryAddress,
          message: `no treasury UTxO at ${treasuryAddress} holds ${unit}`,
        }),
      );

    // Decode once; the group name is needed both to filter and to report.
    const decoded: { utxo: UTxO; group: string | null }[] = [];
    for (const raw of candidates) {
      const utxo = patchInlineDatum(raw);
      const datum = yield* parseSafeDatum(utxo.datum, TreasuryDatumSchema).pipe(
        Effect.map((d) => d as unknown as TreasuryDatum),
        Effect.orElse(() => Effect.succeed(null)),
      );
      decoded.push({ utxo, group: datum ? treasuryGroupRefName(datum) : null });
    }

    if (groupRefName === undefined) {
      if (decoded.length === 1) return decoded[0]!.utxo;
      return yield* Effect.fail(
        new AmbiguousUtxoError({
          unit,
          candidates: decoded.length,
          groups: decoded.map((d) => d.group ?? "<undecodable>"),
          message: `${unit} is live in ${decoded.length} groups; pass the owning group to disambiguate`,
        }),
      );
    }

    const matches = decoded.filter((d) => d.group === groupRefName);
    if (matches.length === 1) return matches[0]!.utxo;
    if (matches.length === 0)
      return yield* Effect.fail(
        new UtxoNotFoundError({
          tokenName: unit,
          address: treasuryAddress,
          message: `no treasury UTxO holding ${unit} belongs to group ${groupRefName}; live groups for this member: ${decoded
            .map((d) => d.group ?? "<undecodable>")
            .join(", ")}`,
        }),
      );
    return yield* Effect.fail(
      new AmbiguousUtxoError({
        unit,
        candidates: matches.length,
        groups: matches.map((d) => d.group ?? "<undecodable>"),
        message: `${matches.length} treasury UTxOs hold ${unit} in group ${groupRefName}; on-chain state is inconsistent`,
      }),
    );
  });

// Unused functions fetchTreasuryState and findMemberTreasury removed.
