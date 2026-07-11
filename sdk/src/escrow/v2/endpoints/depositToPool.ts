import { Assets, Data, LucidEvolution, TxSignBuilder } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import {
  ConfigurationError,
  DcuError,
  TransactionBuildError,
} from "../../../core/errors.js";
import { getWalletAddress, makeReturn } from "../../../core/utils/index.js";
import { toOnchainAddress, VaultDatum } from "../types.js";
import { MIN_ADA_BUFFER, resolvePool } from "../utils.js";

/**
 * Creates an unsigned transaction committing funds to a pool: a plain payment
 * to the vault address carrying YOUR deposit datum. The deposit stays yours —
 * exitable any time (past the optional commitment window) until the quorum
 * allocates it into a milestone escrow.
 *
 * @param lucid - Lucid instance with the contributor's wallet selected.
 * @param config - DepositToPoolConfig.
 * @returns Effect yielding TxSignBuilder.
 */
export type DepositToPoolConfig = {
  /** The pool's permanent identity (returned by createPool). */
  poolTokenName: string;
  /** Amount of the pool's asset to commit (> 0). */
  amount: bigint;
  /** Optional commitment window: no exit before this (POSIX ms). */
  lockedUntil?: bigint;
  /** Refund identity. Defaults to the wallet address. */
  contributorAddress?: string;
};

export const unsignedDepositToPoolTxProgram = (
  lucid: LucidEvolution,
  config: DepositToPoolConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { utxo: poolUtxo, pool } = yield* resolvePool(
      lucid,
      config.poolTokenName,
    );
    if (pool.status !== 0n) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "poolTokenName",
          message: "the pool is closed to new commitments",
        }),
      );
    }
    if (config.amount <= 0n) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "amount",
          message: "the deposit must be > 0",
        }),
      );
    }
    const walletAddress = yield* getWalletAddress(lucid);
    const contributor = yield* toOnchainAddress(
      config.contributorAddress ?? walletAddress,
    );
    const datum: VaultDatum = {
      PoolDeposit: {
        pool_id: config.poolTokenName,
        contributor,
        locked_until: config.lockedUntil ?? null,
      },
    };
    const isAda = pool.asset_policy === "";
    const assets: Assets = isAda
      ? { lovelace: config.amount }
      : {
          lovelace: MIN_ADA_BUFFER,
          [pool.asset_policy + pool.asset_name]: config.amount,
        };

    return yield* lucid
      .newTx()
      .pay.ToContract(
        poolUtxo.address,
        { kind: "inline", value: Data.to(datum, VaultDatum) },
        assets,
      )
      .completeProgram()
      .pipe(
        Effect.mapError(
          (e) =>
            new TransactionBuildError({
              operation: "depositToPool",
              error: String(e),
            }),
        ),
      );
  });

export const depositToPool = (
  lucid: LucidEvolution,
  config: DepositToPoolConfig,
) => makeReturn(unsignedDepositToPoolTxProgram(lucid, config));
