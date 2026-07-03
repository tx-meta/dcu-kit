import { LucidEvolution, toUnit } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import {
  TreasuryDatum,
  TreasuryDatumSchema,
} from "../core/types.js";
import { Protocol } from "../core/validators/constants.js";
import {
  parseGroupCip68Datum,
  parseSafeDatum,
  patchInlineDatum,
  assetNameLabels,
  resolveUtxoByUnit,
  reserveTokenName,
  MIN_ADA_RESERVE,
} from "../core/utils/index.js";
import { DcuError, InvalidDatumError } from "../core/errors.js";

/**
 * A snapshot of a group's mutual reserve.
 *
 * `balance` is the *contributable* amount in the group's contribution asset
 * (min-ADA excluded for ADA-denominated groups) — what the pot can actually
 * pay out in stand-in draws and wind-down refunds.
 */
export type ReserveState = {
  /** Contributable balance in the contribution asset. */
  balance: bigint;
  /** Remaining stand-in fee-units owed to future rounds (0n when idle). */
  standinRounds: bigint;
  /** One-time join levy configured on the group (0n = off). */
  joinLevy: bigint;
  /** Per-member per-round levy configured on the group (0n = off). */
  roundLevy: bigint;
};

/**
 * Reads the current state of a group's mutual reserve.
 *
 * Resolves the ReserveState UTxO by its deterministic token
 * (`"RSVE" + group suffix` under the treasury policy) and pairs it with the
 * group's levy configuration.
 *
 * @param protocol - Deployment protocol context.
 * @param lucid - Lucid instance (any wallet).
 * @param groupTokenSuffix - The group's permanent CIP-68 suffix.
 * @returns Effect yielding the {@link ReserveState} snapshot.
 */
export const getReserveStateProgram = (
  protocol: Protocol,
  lucid: LucidEvolution,
  groupTokenSuffix: string,
): Effect.Effect<ReserveState, DcuError, never> =>
  Effect.gen(function* () {
    const { treasuryPolicyId, groupPolicyId } = protocol;

    const groupRefName = assetNameLabels.prefix100 + groupTokenSuffix;
    const groupUtxoRaw = yield* resolveUtxoByUnit(
      lucid,
      groupPolicyId + groupRefName,
    );
    const groupUtxo = patchInlineDatum(groupUtxoRaw);
    const groupCip68 = yield* parseGroupCip68Datum(groupUtxo.datum);
    const groupDatum = groupCip68.groupDatum;

    const reserveUnit = treasuryPolicyId + reserveTokenName(groupRefName);
    const reserveUtxoRaw = yield* resolveUtxoByUnit(lucid, reserveUnit);
    const reserveUtxo = patchInlineDatum(reserveUtxoRaw);
    const reserveDatum = (yield* parseSafeDatum(
      reserveUtxo.datum,
      TreasuryDatumSchema,
    )) as unknown as TreasuryDatum;
    if (!("ReserveState" in reserveDatum)) {
      return yield* Effect.fail(
        new InvalidDatumError({
          field: "reserveDatum",
          reason: "Expected ReserveState on the reserve UTxO",
        }),
      );
    }

    const isAdaFee = groupDatum.contribution_fee_policyid === "";
    const raw = isAdaFee
      ? reserveUtxo.assets.lovelace ?? 0n
      : reserveUtxo.assets[
          toUnit(
            groupDatum.contribution_fee_policyid,
            groupDatum.contribution_fee_assetname,
          )
        ] ?? 0n;
    const balance = isAdaFee ? raw - MIN_ADA_RESERVE : raw;

    return {
      balance,
      standinRounds: reserveDatum.ReserveState.standin_rounds,
      joinLevy: groupDatum.reserve_join_levy,
      roundLevy: groupDatum.reserve_round_levy,
    };
  });
