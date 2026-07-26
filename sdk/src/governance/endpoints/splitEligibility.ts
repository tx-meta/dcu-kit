import { LucidEvolution, TxSignBuilder } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { DcuError, TransactionBuildError } from "../../core/errors.js";
import { getWalletAddress, makeReturn } from "../../core/utils/index.js";

export type SplitEligibilityConfig = {
  /** Token units to isolate — each lands in its own output. */
  tokenUnits: string[];
};

/**
 * Pays each supplied token to the wallet in its own output, so every resulting
 * UTxO holds exactly one token name under its policy.
 *
 * The on-chain member-id derivation expects exactly one token name under
 * member_policy in the voter input. Ordinary change handling merges tokens back
 * together, so this is a prerequisite transaction — it cannot be folded into
 * register or vote, whose input must already be clean.
 *
 * @param lucid - Lucid instance with the token-holding wallet selected.
 * @param config - SplitEligibilityConfig.
 */
export const unsignedSplitEligibilityTxProgram = (
  lucid: LucidEvolution,
  config: SplitEligibilityConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const address = yield* getWalletAddress(lucid);
    let tx = lucid.newTx();
    for (const unit of config.tokenUnits) {
      tx = tx.pay.ToAddress(address, { [unit]: 1n });
    }
    return yield* tx.completeProgram().pipe(
      Effect.mapError(
        (e) =>
          new TransactionBuildError({
            operation: "splitEligibility",
            error: String(e),
          }),
      ),
    );
  });

export const splitEligibility = (
  lucid: LucidEvolution,
  config: SplitEligibilityConfig,
) => makeReturn(unsignedSplitEligibilityTxProgram(lucid, config));
