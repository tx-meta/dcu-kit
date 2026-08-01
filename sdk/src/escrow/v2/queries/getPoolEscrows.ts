import { Data, LucidEvolution, toText, UTxO } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { DcuError, LucidError } from "../../../core/errors.js";
import { makeReturn, patchInlineDatum } from "../../../core/utils/index.js";
import { EscrowDatumV2 } from "../types.js";
import { escrowV2PolicyId } from "../validators.js";
import { escrowV2Address, resolvePool } from "../utils.js";

export type GetPoolEscrowsConfig = {
  /** The pool's permanent identity (returned by createPool). */
  poolTokenName: string;
};

export type PoolEscrowSummary = {
  /**
   * The escrow's permanent identity. Feed straight to
   * `allocateToEscrow`'s `existingStateTokenName` to top this escrow up.
   */
  stateTokenName: string;
  title: string;
  releasedCount: number;
  totalMilestones: number;
  /** Escrow-asset balance currently locked. */
  lockedBalance: bigint;
  /** True while the escrow can still take a top-up (not fully released). */
  topUpEligible: boolean;
};

/**
 * Lists the LIVE escrows this pool has funded.
 *
 * Allocation is the one place a caller previously had to supply an escrow's
 * token name from memory: `allocateToEscrow` tops up an existing escrow by
 * `existingStateTokenName`, and nothing produced that name. This is the lookup,
 * so a fundraiser UI can offer a list instead of a text field.
 *
 * Pool-funded escrows are identified by their funder, which allocation sets to
 * the pool's quorum credential. That credential is the pool's spending
 * authority, so any escrow it funded is one this pool can top up.
 *
 * Scans the escrow script address; at scale an indexer keyed by funder
 * credential is the faster equivalent.
 *
 * @param lucid - Lucid instance (no wallet needed).
 * @param config - GetPoolEscrowsConfig.
 * @returns Effect yielding one summary per live escrow, newest first.
 */
export const getPoolEscrowsProgram = (
  lucid: LucidEvolution,
  config: GetPoolEscrowsConfig,
): Effect.Effect<PoolEscrowSummary[], DcuError, never> =>
  Effect.gen(function* () {
    const network = lucid.config().network ?? "Preprod";
    const { pool } = yield* resolvePool(lucid, config.poolTokenName);
    const quorumHash =
      "VerificationKey" in pool.quorum
        ? pool.quorum.VerificationKey[0]
        : pool.quorum.Script[0];

    const utxos: UTxO[] = yield* Effect.tryPromise({
      try: () => lucid.utxosAt(escrowV2Address(network)),
      catch: (e) =>
        new LucidError({
          message: `utxosAt(escrowV2Address) failed: ${String(e)}`,
        }),
    });

    const summaries: PoolEscrowSummary[] = [];
    for (const raw of utxos) {
      const utxo = patchInlineDatum(raw);
      if (!utxo.datum) continue;
      let datum: EscrowDatumV2;
      try {
        datum = Data.from(utxo.datum, EscrowDatumV2);
      } catch {
        continue; // foreign or malformed UTxO at the script address
      }

      const funderHash =
        "VerificationKey" in datum.funder.payment_credential
          ? datum.funder.payment_credential.VerificationKey[0]
          : datum.funder.payment_credential.Script[0];
      if (funderHash !== quorumHash) continue;

      const stateTokenName = Object.keys(utxo.assets)
        .find((unit) => unit.startsWith(escrowV2PolicyId))
        ?.slice(escrowV2PolicyId.length);
      if (!stateTokenName) continue;

      const assetUnit =
        datum.asset_policy === ""
          ? "lovelace"
          : datum.asset_policy + datum.asset_name;
      const releasedCount = Number(datum.released_count);
      summaries.push({
        stateTokenName,
        title: toText(datum.title),
        releasedCount,
        totalMilestones: datum.milestones.length,
        lockedBalance: utxo.assets[assetUnit] ?? 0n,
        topUpEligible: releasedCount < datum.milestones.length,
      });
    }
    return summaries;
  });

export const getPoolEscrows = (
  lucid: LucidEvolution,
  config: GetPoolEscrowsConfig,
) => makeReturn(getPoolEscrowsProgram(lucid, config));
