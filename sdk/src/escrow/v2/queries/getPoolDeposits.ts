import { Data, LucidEvolution, UTxO } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { DcuError, LucidError } from "../../../core/errors.js";
import { makeReturn, patchInlineDatum } from "../../../core/utils/index.js";
import { fromOnchainAddress, VaultDatum } from "../types.js";
import { poolVaultAddress, resolvePool } from "../utils.js";

/**
 * Lists a pool's LIVE (unallocated) deposits — the contributions ledger the
 * quorum allocates from and the cap table any off-chain return distribution
 * settles against. Read-only address scan; an indexer keyed by pool id is the
 * faster equivalent at scale.
 *
 * @param lucid - Lucid instance (no wallet needed).
 * @param config - GetPoolDepositsConfig.
 * @returns Effect yielding one row per deposit UTxO.
 */
export type GetPoolDepositsConfig = {
  /** The pool's permanent identity (returned by createPool). */
  poolTokenName: string;
};

export type PoolDepositRow = {
  txHash: string;
  outputIndex: number;
  contributorAddress: string;
  /** Amount in the pool's asset. */
  amount: bigint;
  lockedUntil: bigint | null;
};

export const getPoolDepositsProgram = (
  lucid: LucidEvolution,
  config: GetPoolDepositsConfig,
): Effect.Effect<PoolDepositRow[], DcuError, never> =>
  Effect.gen(function* () {
    const network = lucid.config().network ?? "Preprod";
    const { pool } = yield* resolvePool(lucid, config.poolTokenName);
    const assetUnit =
      pool.asset_policy === ""
        ? "lovelace"
        : pool.asset_policy + pool.asset_name;
    const utxos: UTxO[] = yield* Effect.tryPromise({
      try: () => lucid.utxosAt(poolVaultAddress(network)),
      catch: (e) =>
        new LucidError({ message: `utxosAt(poolVault) failed: ${String(e)}` }),
    });
    const rows: PoolDepositRow[] = [];
    for (const raw of utxos) {
      const utxo = patchInlineDatum(raw);
      if (!utxo.datum) continue;
      let parsed: VaultDatum;
      try {
        parsed = Data.from(utxo.datum, VaultDatum);
      } catch {
        continue;
      }
      if (typeof parsed === "string" || !("PoolDeposit" in parsed)) continue;
      const d = parsed.PoolDeposit;
      if (d.pool_id !== config.poolTokenName) continue;
      const contributorAddress = yield* fromOnchainAddress(
        network,
        d.contributor,
      );
      rows.push({
        txHash: utxo.txHash,
        outputIndex: utxo.outputIndex,
        contributorAddress,
        amount: utxo.assets[assetUnit] ?? 0n,
        lockedUntil: d.locked_until,
      });
    }
    return rows;
  });

export const getPoolDeposits = (
  lucid: LucidEvolution,
  config: GetPoolDepositsConfig,
) => makeReturn(getPoolDepositsProgram(lucid, config));
