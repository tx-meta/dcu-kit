import {
  Data,
  LucidEvolution,
  RedeemerBuilder,
  TxSignBuilder,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { DcuError, TransactionBuildError } from "../../../core/errors.js";
import {
  makeReturn,
  attachTxMessage,
  type TxMessage,
} from "../../../core/utils/index.js";
import { PoolMintRedeemer, PoolSpendRedeemer } from "../types.js";
import { poolPolicyId } from "../validators.js";
import {
  effectiveEscrowV2ScriptRefs,
  EscrowV2ScriptRefs,
  verifyEscrowV2ScriptRefs,
  witnessEscrowV2Script,
} from "../scriptRefs.js";
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
  /**
   * Reference-script UTxOs for the escrow v2 validators. Supplying the
   * escrow ref keeps its 11.4 KB out of the transaction body. Falls back
   * to the session default set by `configureEscrowV2ReferenceScripts`,
   * then to inlining the script.
   */
  scriptRefs?: EscrowV2ScriptRefs;
  /** The pool's permanent identity (returned by createPool). */
  poolTokenName: string;
  /** Required when the quorum credential is a script hash. */
  quorumWitness?: PartyWitness;
  /**
   * Optional human-readable note attached to this transaction as CIP-20
   * metadata (label 674). Transaction-scoped: no validator reads it, it costs
   * no min-ADA, and it can never be edited. Public and permanent — never PII.
   */
  message?: TxMessage;
};

export const unsignedClosePoolTxProgram = (
  lucid: LucidEvolution,
  config: ClosePoolConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const scriptRefs = effectiveEscrowV2ScriptRefs(config.scriptRefs);
    yield* verifyEscrowV2ScriptRefs(scriptRefs);
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

    const baseTx = witnessEscrowV2Script(
      yield* attachTxMessage(lucid.newTx(), config.message),
      "pool",
      scriptRefs,
      ["spend", "mint"],
    )
      .collectFrom([poolUtxo], redeemer)
      .mintAssets({ [poolUnit]: -1n }, Data.to("BurnPool", PoolMintRedeemer));

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
