import {
  Data,
  fromText,
  LucidEvolution,
  RedeemerBuilder,
  TxSignBuilder,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import {
  ConfigurationError,
  DcuError,
  TransactionBuildError,
} from "../../../core/errors.js";
import { makeReturn } from "../../../core/utils/index.js";
import {
  PartyRef,
  partyToCredential,
  PoolSpendRedeemer,
  VaultDatum,
} from "../types.js";
import { poolVaultValidator } from "../validators.js";
import { applyPartyWitness, PartyWitness, resolvePool } from "../utils.js";

/**
 * Creates an unsigned transaction updating a pool anchor: charter (title /
 * content hash), status, and quorum rotation — the governance handoff,
 * including a future upgrade to a vote-script quorum. Quorum-authorized; the
 * pool's asset and escrow target are immutable identity.
 *
 * @param lucid - Lucid instance (the quorum must sign).
 * @param config - UpdatePoolConfig.
 * @returns Effect yielding TxSignBuilder.
 */
export type UpdatePoolConfig = {
  /** The pool's permanent identity (returned by createPool). */
  poolTokenName: string;
  title?: string;
  contentHash?: string | null;
  status?: "Active" | "Closed";
  /** Rotate the ratification authority. */
  newQuorum?: PartyRef;
  /** Required when the quorum credential is a script hash. */
  quorumWitness?: PartyWitness;
};

export const unsignedUpdatePoolTxProgram = (
  lucid: LucidEvolution,
  config: UpdatePoolConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { utxo: poolUtxo, pool } = yield* resolvePool(
      lucid,
      config.poolTokenName,
    );
    const titleHex =
      config.title === undefined ? pool.title : fromText(config.title);
    if (titleHex.length > 128) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "title",
          message: "title must be at most 64 UTF-8 bytes",
        }),
      );
    }
    const quorum = config.newQuorum
      ? yield* partyToCredential(config.newQuorum, "newQuorum")
      : pool.quorum;

    const updated: VaultDatum = {
      PoolAnchor: {
        pool: {
          ...pool,
          title: titleHex,
          content_hash:
            config.contentHash === undefined
              ? pool.content_hash
              : config.contentHash,
          status:
            config.status === undefined
              ? pool.status
              : config.status === "Active"
                ? 0n
                : 1n,
          quorum,
        },
      },
    };

    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            UpdatePool: {
              pool_input_index: inputIndices[0],
              continuation_index: 0n,
            },
          },
          PoolSpendRedeemer,
        ),
      inputs: [poolUtxo],
    };

    const baseTx = lucid
      .newTx()
      .collectFrom([poolUtxo], redeemer)
      .attach.SpendingValidator(poolVaultValidator.spendPool)
      .pay.ToContract(
        poolUtxo.address,
        { kind: "inline", value: Data.to(updated, VaultDatum) },
        poolUtxo.assets,
      );

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
            operation: "updatePool",
            error: String(e),
          }),
      ),
    );
  });

export const updatePool = (lucid: LucidEvolution, config: UpdatePoolConfig) =>
  makeReturn(unsignedUpdatePoolTxProgram(lucid, config));
