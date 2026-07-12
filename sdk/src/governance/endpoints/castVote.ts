import {
  Data,
  getAddressDetails,
  LucidEvolution,
  RedeemerBuilder,
  TxSignBuilder,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { DcuError, TransactionBuildError } from "../../core/errors.js";
import { getWalletAddress, makeReturn } from "../../core/utils/index.js";
import {
  GovernanceDatum,
  GovMintRedeemer,
  GovSpendRedeemer,
  NO_SHARE_REF,
  VotingAction,
} from "../types.js";
import { GovernanceInstance } from "../validators.js";
import {
  dispatcherAddress,
  resolveAnchor,
  resolveProposal,
  sortedRefIndexOf,
  voteReceiptTokenName,
  votingRewardAddress,
} from "../utils.js";

/**
 * Creates an unsigned transaction casting one weighted vote: spends the
 * proposal UTxO to update its cached tally, mints the voter's one-per-proposal
 * receipt (a re-vote reproduces an existing token name and fails), and couples
 * to the voting validator's CastAction via a 0-ADA withdrawal.
 *
 * Under one-member-one-vote the weight is 1. Under share-weighted the voter's
 * savings account is read as a reference input for its share_units.
 *
 * @param lucid - Lucid instance with the voter's wallet selected.
 * @param config - CastVoteConfig.
 */
export type CastVoteConfig = {
  instance: GovernanceInstance;
  /** The proposal to vote on (its state-token name). */
  proposalId: string;
  /** true = for, false = against. */
  approve: boolean;
  /** The voter's eligibility-token name (the receipt binds to it). Defaults to
   *  the wallet's payment key hash. */
  voterRef?: string;
  /** The vote weight to apply (share-weighted callers pass share_units).
   *  Defaults to 1 (one-member-one-vote). */
  weight?: bigint;
};

export const unsignedCastVoteTxProgram = (
  lucid: LucidEvolution,
  config: CastVoteConfig,
): Effect.Effect<{ tx: TxSignBuilder; receiptName: string }, DcuError, never> =>
  Effect.gen(function* () {
    const { instance } = config;
    const network = lucid.config().network ?? "Preprod";
    const walletAddress = yield* getWalletAddress(lucid);

    const { utxo: anchorUtxo } = yield* resolveAnchor(lucid, instance);
    const { utxo: proposalUtxo, proposal } = yield* resolveProposal(
      lucid,
      instance,
      config.proposalId,
    );

    const voterRef =
      config.voterRef ??
      getAddressDetails(walletAddress).paymentCredential!.hash;
    const weight = config.weight ?? 1n;
    const receiptName = voteReceiptTokenName(config.proposalId, voterRef);
    const receiptUnit = instance.govPolicy + receiptName;

    // Continuation: increment the cached tally by weight; count one more voter.
    const updated: GovernanceDatum = {
      Proposal: {
        ...proposal,
        tally_yes: config.approve
          ? proposal.tally_yes + weight
          : proposal.tally_yes,
        tally_no: config.approve
          ? proposal.tally_no
          : proposal.tally_no + weight,
        votes_cast: proposal.votes_cast + 1n,
      },
    };

    const anchorRefIndex = sortedRefIndexOf(anchorUtxo, [anchorUtxo]);

    // The proposal is the tracked spending input; all three redeemers resolve
    // its index consistently. Outputs: proposal continuation (0), receipt (1).
    const spendRedeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (idx: bigint[]) =>
        Data.to(
          {
            Vote: {
              anchor_ref_index: anchorRefIndex,
              proposal_input_index: idx[0],
              proposal_output_index: 0n,
              voter_index: idx[0],
              share_ref_index: NO_SHARE_REF,
              approve: config.approve,
              withdrawal_index: 0n,
            },
          },
          GovSpendRedeemer,
        ),
      inputs: [proposalUtxo],
    };

    const mintRedeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (idx: bigint[]) =>
        Data.to(
          {
            CastVote: {
              proposal_input_index: idx[0],
              receipt_output_index: 1n,
              voter_index: idx[0],
              withdrawal_index: 0n,
            },
          },
          GovMintRedeemer,
        ),
      inputs: [proposalUtxo],
    };

    const votingRedeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (idx: bigint[]) =>
        Data.to(
          {
            CastAction: {
              proposal_input_index: idx[0],
              proposal_output_index: 0n,
              voter_index: idx[0],
              share_ref_index: NO_SHARE_REF,
              approve: config.approve,
            },
          },
          VotingAction,
        ),
      inputs: [proposalUtxo],
    };

    const tx = yield* lucid
      .newTx()
      .collectFrom([proposalUtxo], spendRedeemer)
      .attach.SpendingValidator(instance.dispatcherValidator.spend)
      .readFrom([anchorUtxo])
      .mintAssets({ [receiptUnit]: 1n }, mintRedeemer)
      .attach.MintingPolicy(instance.dispatcherValidator.mint)
      .withdraw(votingRewardAddress(network, instance), 0n, votingRedeemer)
      .attach.WithdrawalValidator(instance.votingValidator)
      .pay.ToContract(
        dispatcherAddress(network, instance),
        { kind: "inline", value: Data.to(updated, GovernanceDatum) },
        proposalUtxo.assets,
      )
      .pay.ToAddress(walletAddress, { [receiptUnit]: 1n })
      .completeProgram()
      .pipe(
        Effect.mapError(
          (e) =>
            new TransactionBuildError({
              operation: "castVote",
              error: String(e),
            }),
        ),
      );

    return { tx, receiptName };
  });

export const castVote = (lucid: LucidEvolution, config: CastVoteConfig) =>
  makeReturn(unsignedCastVoteTxProgram(lucid, config));
