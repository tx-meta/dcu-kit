import { LucidEvolution, UTxO } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { DcuError } from "../../core/errors.js";
import { makeReturn } from "../../core/utils/index.js";
import { EscrowDatum } from "../types.js";
import { escrowAssetUnit, resolveEscrow } from "../utils.js";

/**
 * Reads a live escrow's full state by its state-token name.
 *
 * @param lucid - Lucid instance (read-only).
 * @param config - `{ stateTokenName }` — the escrow's permanent identity.
 * @returns Effect yielding the parsed state summary.
 */
export type GetEscrowStateConfig = {
  stateTokenName: string;
};

export type EscrowState = {
  utxo: UTxO;
  datum: EscrowDatum;
  /** Tranches released so far. */
  releasedCount: number;
  totalMilestones: number;
  /** The next tranche amount, or null when the schedule is complete. */
  nextTranche: bigint | null;
  /** Balance of the escrowed asset currently locked. */
  remainingBalance: bigint;
  /** POSIX ms after which the funder can reclaim. */
  expiry: bigint;
  expired: boolean;
};

export const getEscrowStateProgram = (
  lucid: LucidEvolution,
  config: GetEscrowStateConfig,
): Effect.Effect<EscrowState, DcuError, never> =>
  Effect.gen(function* () {
    const { utxo, datum } = yield* resolveEscrow(lucid, config.stateTokenName);
    const releasedCount = Number(datum.released_count);
    const assetUnit = escrowAssetUnit(datum);
    return {
      utxo,
      datum,
      releasedCount,
      totalMilestones: datum.milestones.length,
      nextTranche: datum.milestones[releasedCount] ?? null,
      remainingBalance: utxo.assets[assetUnit] ?? 0n,
      expiry: datum.expiry,
      expired: BigInt(Date.now()) > datum.expiry,
    };
  });

export const getEscrowState = (
  lucid: LucidEvolution,
  config: GetEscrowStateConfig,
) => makeReturn(getEscrowStateProgram(lucid, config));
