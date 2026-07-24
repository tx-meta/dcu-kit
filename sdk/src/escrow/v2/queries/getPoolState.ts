import { LucidEvolution, toText } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { DcuError } from "../../../core/errors.js";
import { makeReturn } from "../../../core/utils/index.js";
import { resolvePool } from "../utils.js";

/**
 * Reads a live pool anchor's state. Read-only.
 *
 * @param lucid - Lucid instance (no wallet needed).
 * @param config - GetPoolStateConfig.
 * @returns Effect yielding PoolState.
 */
export type GetPoolStateConfig = {
  /** The pool's permanent identity (returned by createPool). */
  poolTokenName: string;
};

export type PoolState = {
  title: string;
  contentHash: string | null;
  status: "Active" | "Closed";
  quorum: { type: "Key" | "Script"; hash: string };
  escrowTarget: string;
  assetUnit: string;
  fundingDeadline: bigint | null;
};

export const getPoolStateProgram = (
  lucid: LucidEvolution,
  config: GetPoolStateConfig,
): Effect.Effect<PoolState, DcuError, never> =>
  Effect.gen(function* () {
    const { pool } = yield* resolvePool(lucid, config.poolTokenName);
    return {
      title: toText(pool.title),
      contentHash: pool.content_hash,
      status: pool.status === 0n ? ("Active" as const) : ("Closed" as const),
      quorum:
        "VerificationKey" in pool.quorum
          ? { type: "Key" as const, hash: pool.quorum.VerificationKey[0] }
          : { type: "Script" as const, hash: pool.quorum.Script[0] },
      escrowTarget: pool.escrow_target,
      assetUnit:
        pool.asset_policy === ""
          ? "lovelace"
          : pool.asset_policy + pool.asset_name,
      fundingDeadline: pool.funding_deadline,
    };
  });

export const getPoolState = (
  lucid: LucidEvolution,
  config: GetPoolStateConfig,
) => makeReturn(getPoolStateProgram(lucid, config));
