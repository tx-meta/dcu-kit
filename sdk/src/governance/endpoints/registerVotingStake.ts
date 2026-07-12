import { LucidEvolution, TxSignBuilder } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { DcuError, TransactionBuildError } from "../../core/errors.js";
import { getWalletAddress, makeReturn } from "../../core/utils/index.js";
import { GovernanceInstance } from "../validators.js";
import { votingRewardAddress } from "../utils.js";

/**
 * Registers the instance's voting stake credential — a one-time bootstrap.
 *
 * Every proposal transaction carries a 0-ADA reward withdrawal from the voting
 * validator (the withdraw-zero home of the heavy validation). The ledger rejects
 * a withdrawal from an unregistered stake credential, so this must run once per
 * instance before any propose/vote/finalize/execute/expire endpoint is used.
 *
 * The 2 ADA key deposit is paid by the connected wallet. A duplicate
 * registration is rejected by the ledger and never enters a block.
 *
 * @param lucid - Lucid instance with a funded wallet selected.
 * @param instance - The governance instance (from buildGovernance / initGovernance).
 */
export const unsignedRegisterVotingStakeTxProgram = (
  lucid: LucidEvolution,
  instance: GovernanceInstance,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const network = lucid.config().network ?? "Preprod";
    const address = yield* getWalletAddress(lucid);
    return yield* lucid
      .newTx()
      .register.Stake(votingRewardAddress(network, instance))
      .addSigner(address)
      .completeProgram()
      .pipe(
        Effect.mapError(
          (e) =>
            new TransactionBuildError({
              operation: "registerVotingStake",
              error: String(e),
            }),
        ),
      );
  });

export const registerVotingStake = (
  lucid: LucidEvolution,
  instance: GovernanceInstance,
) => makeReturn(unsignedRegisterVotingStakeTxProgram(lucid, instance));
