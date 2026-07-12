import {
  Data,
  LucidEvolution,
  RedeemerBuilder,
  TxSignBuilder,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { DcuError, TransactionBuildError } from "../../core/errors.js";
import { makeReturn } from "../../core/utils/index.js";
import { GovMintRedeemer, GovSpendRedeemer, VotingAction } from "../types.js";
import { GovernanceInstance } from "../validators.js";
import {
  resolveAnchor,
  resolveProposal,
  votingRewardAddress,
} from "../utils.js";

/**
 * Creates an unsigned transaction expiring a terminal proposal: an `Open`
 * proposal past its deadline that never met quorum/threshold, or a stale passed
 * proposal past its `exec_deadline`. Permissionless; burns the Proposal State
 * NFT and reclaims its min-ADA. Couples to the voting ExpireAction.
 *
 * @param lucid - Lucid instance with any wallet selected (cranker).
 * @param config - ExpireProposalConfig.
 */
export type ExpireProposalConfig = {
  instance: GovernanceInstance;
  proposalId: string;
};

export const unsignedExpireProposalTxProgram = (
  lucid: LucidEvolution,
  config: ExpireProposalConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { instance } = config;
    const network = lucid.config().network ?? "Preprod";

    const { utxo: anchorUtxo } = yield* resolveAnchor(lucid, instance);
    const { utxo: proposalUtxo } = yield* resolveProposal(
      lucid,
      instance,
      config.proposalId,
    );
    const proposalUnit = instance.govPolicy + config.proposalId;

    const spendRedeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (idx: bigint[]) =>
        Data.to(
          { Expire: { proposal_input_index: idx[0], withdrawal_index: 0n } },
          GovSpendRedeemer,
        ),
      inputs: [proposalUtxo],
    };

    const burnRedeemer = Data.to(
      { BurnProposal: { withdrawal_index: 0n } },
      GovMintRedeemer,
    );

    const votingRedeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (idx: bigint[]) =>
        Data.to(
          { ExpireAction: { proposal_input_index: idx[0] } },
          VotingAction,
        ),
      inputs: [proposalUtxo],
    };

    const tx = yield* lucid
      .newTx()
      .collectFrom([proposalUtxo], spendRedeemer)
      .attach.SpendingValidator(instance.dispatcherValidator.spend)
      .readFrom([anchorUtxo])
      .mintAssets({ [proposalUnit]: -1n }, burnRedeemer)
      .attach.MintingPolicy(instance.dispatcherValidator.mint)
      .withdraw(votingRewardAddress(network, instance), 0n, votingRedeemer)
      .attach.WithdrawalValidator(instance.votingValidator)
      .completeProgram()
      .pipe(
        Effect.mapError(
          (e) =>
            new TransactionBuildError({
              operation: "expireProposal",
              error: String(e),
            }),
        ),
      );

    return tx;
  });

export const expireProposal = (
  lucid: LucidEvolution,
  config: ExpireProposalConfig,
) => makeReturn(unsignedExpireProposalTxProgram(lucid, config));
