import {
  Data,
  LucidEvolution,
  RedeemerBuilder,
  TxSignBuilder,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { DcuError, TransactionBuildError } from "../../../core/errors.js";
import { makeReturn } from "../../../core/utils/index.js";
import { PoolMintRedeemer, PoolSpendRedeemer } from "../types.js";
import { poolPolicyId, poolVaultValidator } from "../validators.js";
import { applyPartyWitness, PartyWitness, resolvePool } from "../utils.js";

/**
 * Creates an unsigned transaction burning a pool anchor (quorum-authorized).
 * Deposits are unaffected — individually owned and exitable forever; only new
 * allocations die with the anchor. Prefer `updatePool` with status "Closed"
 * to keep the record visible.
 *
 * @param lucid - Lucid instance (the quorum must sign).
 * @param config - ClosePoolConfig.
 * @returns Effect yielding TxSignBuilder.
 */
export type ClosePoolConfig = {
  /** The pool's permanent identity (returned by createPool). */
  poolTokenName: string;
  /** Required when the quorum credential is a script hash. */
  quorumWitness?: PartyWitness;
};

export const unsignedClosePoolTxProgram = (
  lucid: LucidEvolution,
  config: ClosePoolConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { utxo: poolUtxo, pool } = yield* resolvePool(
      lucid,
      config.poolTokenName,
    );
    const poolUnit = poolPolicyId + config.poolTokenName;

    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          { ClosePool: { pool_input_index: inputIndices[0] } },
          PoolSpendRedeemer,
        ),
      inputs: [poolUtxo],
    };

    const baseTx = lucid
      .newTx()
      .collectFrom([poolUtxo], redeemer)
      .attach.SpendingValidator(poolVaultValidator.spendPool)
      .mintAssets(
        { [poolUnit]: -1n },
        Data.to("BurnPool", PoolMintRedeemer),
      )
      .attach.MintingPolicy(poolVaultValidator.mintPool);

    const withWitness = yield* applyPartyWitness(
      lucid,
      baseTx,
      pool.quorum,
      config.quorumWitness,
      "quorum",
    );

    return yield* withWitness.completeProgram().pipe(
      Effect.mapError(
        (e) =>
          new TransactionBuildError({
            operation: "closePool",
            error: String(e),
          }),
      ),
    );
  });

export const closePool = (lucid: LucidEvolution, config: ClosePoolConfig) =>
  makeReturn(unsignedClosePoolTxProgram(lucid, config));
