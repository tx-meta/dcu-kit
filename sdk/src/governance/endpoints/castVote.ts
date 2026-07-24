import {
  Data,
  LucidEvolution,
  RedeemerBuilder,
  TxSignBuilder,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import {
  ConfigurationError,
  DcuError,
  TransactionBuildError,
} from "../../core/errors.js";
import { getWalletUtxos, makeReturn } from "../../core/utils/index.js";
import {
  GovernanceDatum,
  GovSpendRedeemer,
  NO_SHARE_REF,
  VotingAction,
} from "../types.js";
import { GovernanceInstance } from "../validators.js";
import {
  dispatcherAddress,
  GovScriptRefs,
  resolveAnchor,
  resolveProposal,
  resolveVoterRecord,
  sortedRefIndexOf,
  voterRecordTokenName,
  votingRewardAddress,
} from "../utils.js";

/**
 * Creates an unsigned transaction casting one weighted vote: spends the
 * proposal UTxO to update its cached tally AND the member's voter record UTxO
 * to append this proposal to its `voted` list. The record spend is the
 * double-vote nullifier — the ledger's own double-spend prevention plus the
 * appended list make a second vote structurally impossible. Couples to the
 * voting validator's CastAction via a 0-ADA withdrawal.
 *
 * The member must have registered once (`registerVoter`) before their first
 * vote. Votes land strictly before the proposal's deadline.
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
  /** The voter's eligibility token unit (a token of the charter's
   *  member_policy). Its wallet UTxO is spent to prove eligibility, and its
   *  token name is the member id the voter record is bound to. */
  voterTokenUnit: string;
  /** Override the wall clock (emulator tests pass emulator.now()). */
  currentTime?: bigint;
  /** Reference-script UTxOs — required in practice: dispatcher + voting no
   *  longer fit inline together under the 16,384-byte tx limit. */
  scriptRefs?: GovScriptRefs;
};

export const unsignedCastVoteTxProgram = (
  lucid: LucidEvolution,
  config: CastVoteConfig,
): Effect.Effect<{ tx: TxSignBuilder; recordName: string }, DcuError, never> =>
  Effect.gen(function* () {
    const { instance } = config;
    const network = lucid.config().network ?? "Preprod";

    const { utxo: anchorUtxo } = yield* resolveAnchor(lucid, instance);
    const { utxo: proposalUtxo, proposal } = yield* resolveProposal(
      lucid,
      instance,
      config.proposalId,
    );

    // The member id is the eligibility token's name (unit = policy + name).
    const memberId = config.voterTokenUnit.slice(56);
    const { utxo: recordUtxo, record } = yield* resolveVoterRecord(
      lucid,
      instance,
      memberId,
    );
    if (record.voted.includes(config.proposalId)) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "proposalId",
          message: "this member has already voted on this proposal",
        }),
      );
    }

    // Temporal window: the vote must land ENTIRELY before the deadline.
    const now = config.currentTime ?? BigInt(Date.now());
    const validFrom = now - (network === "Custom" ? 0n : 60_000n);
    const validTo =
      proposal.deadline - 1n < now + 900_000n
        ? proposal.deadline - 1n
        : now + 900_000n;
    if (validTo <= validFrom) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "proposalId",
          message: "the proposal's voting deadline has passed",
        }),
      );
    }

    // The voter spends their eligibility-token UTxO to prove eligibility; its
    // index resolves to voter_index. The token returns to the wallet as change.
    const voterUtxo = (yield* getWalletUtxos(lucid)).find(
      (u) => (u.assets[config.voterTokenUnit] ?? 0n) > 0n,
    );
    if (!voterUtxo) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "voterTokenUnit",
          message: "the wallet holds no UTxO with the eligibility token",
        }),
      );
    }

    const recordName = voterRecordTokenName(memberId);

    // Tracked spending inputs: proposal (0), voter token (1), record (2).
    const votingInputs = [proposalUtxo, voterUtxo, recordUtxo];
    const weight = 1n; // one-member-one-vote (share-weighted is deferred)

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

    // Record continuation: this proposal is appended to the nullifier set.
    const updatedRecord: GovernanceDatum = {
      VoterRecord: {
        member_id: record.member_id,
        voted: [config.proposalId, ...record.voted],
      },
    };

    const anchorRefIndex = sortedRefIndexOf(anchorUtxo, [anchorUtxo]);

    // Outputs: proposal continuation (0), record continuation (1).
    const spendRedeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (idx: bigint[]) =>
        Data.to(
          {
            Vote: {
              anchor_ref_index: anchorRefIndex,
              proposal_input_index: idx[0],
              proposal_output_index: 0n,
              voter_index: idx[1],
              record_input_index: idx[2],
              record_output_index: 1n,
              share_ref_index: NO_SHARE_REF,
              approve: config.approve,
              withdrawal_index: 0n,
            },
          },
          GovSpendRedeemer,
        ),
      inputs: votingInputs,
    };

    // The record input runs the dispatcher spend validator too — its thin
    // redeemer just asserts the coupling to this CastAction.
    const recordRedeemer = Data.to(
      { VoteRecordSpend: { withdrawal_index: 0n } },
      GovSpendRedeemer,
    );

    const votingRedeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (idx: bigint[]) =>
        Data.to(
          {
            CastAction: {
              proposal_input_index: idx[0],
              proposal_output_index: 0n,
              voter_index: idx[1],
              record_input_index: idx[2],
              record_output_index: 1n,
              share_ref_index: NO_SHARE_REF,
              approve: config.approve,
            },
          },
          VotingAction,
        ),
      inputs: votingInputs,
    };

    const tx = yield* lucid
      .newTx()
      .collectFrom([proposalUtxo], spendRedeemer)
      .collectFrom([recordUtxo], recordRedeemer)
      .compose(
        config.scriptRefs?.dispatcher
          ? lucid.newTx().readFrom([config.scriptRefs.dispatcher])
          : lucid
              .newTx()
              .attach.SpendingValidator(instance.dispatcherValidator.spend),
      )
      .collectFrom([voterUtxo])
      .readFrom([anchorUtxo])
      .withdraw(votingRewardAddress(network, instance), 0n, votingRedeemer)
      .compose(
        config.scriptRefs?.voting
          ? lucid.newTx().readFrom([config.scriptRefs.voting])
          : lucid.newTx().attach.WithdrawalValidator(instance.votingValidator),
      )
      .pay.ToContract(
        dispatcherAddress(network, instance),
        { kind: "inline", value: Data.to(updated, GovernanceDatum) },
        proposalUtxo.assets,
      )
      .pay.ToContract(
        dispatcherAddress(network, instance),
        { kind: "inline", value: Data.to(updatedRecord, GovernanceDatum) },
        recordUtxo.assets,
      )
      .validFrom(Number(validFrom))
      .validTo(Number(validTo))
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

    return { tx, recordName };
  });

export const castVote = (lucid: LucidEvolution, config: CastVoteConfig) =>
  makeReturn(unsignedCastVoteTxProgram(lucid, config));
