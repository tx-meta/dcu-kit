import {
  Data,
  LucidEvolution,
  RedeemerBuilder,
  TxSignBuilder,
  UTxO,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import {
  ConfigurationError,
  DcuError,
  TransactionBuildError,
} from "../../core/errors.js";
import {
  assetNameLabels,
  getWalletUtxos,
  makeReturn,
  attachTxMessage,
  parseSafeDatum,
  resolveUtxoByUnit,
  type TxMessage,
} from "../../core/utils/index.js";
import { SavingsDatumSchema } from "../../savings/types.js";
import { GovernanceDatum, GovSpendRedeemer, VotingAction } from "../types.js";
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
  /**
   * Optional human-readable note attached to this transaction as CIP-20
   * metadata (label 674). Transaction-scoped: no validator reads it, it costs
   * no min-ADA, and it can never be edited. Public and permanent — never PII.
   */
  message?: TxMessage;
};

export const unsignedCastVoteTxProgram = (
  lucid: LucidEvolution,
  config: CastVoteConfig,
): Effect.Effect<{ tx: TxSignBuilder; recordName: string }, DcuError, never> =>
  Effect.gen(function* () {
    const { instance } = config;
    const network = lucid.config().network ?? "Preprod";

    const { utxo: anchorUtxo, anchor } = yield* resolveAnchor(lucid, instance);
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
    // member_id_of expects EXACTLY one token name under member_policy in this
    // input; a UTxO carrying two crashes the validator rather than failing
    // cleanly, so select a clean one here.
    const memberPolicy = config.voterTokenUnit.slice(0, 56);
    const voterUtxo = (yield* getWalletUtxos(lucid)).find(
      (u) =>
        (u.assets[config.voterTokenUnit] ?? 0n) > 0n &&
        Object.keys(u.assets).filter((k) => k.startsWith(memberPolicy))
          .length === 1,
    );
    if (!voterUtxo) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "voterTokenUnit",
          message:
            "no wallet UTxO holds the eligibility token with exactly one token name " +
            "under member_policy — split it into its own output first (see splitEligibility)",
        }),
      );
    }

    const recordName = voterRecordTokenName(memberId);

    // The voter's member account is needed when eligibility is granted by the
    // same policy that identifies the governed vault (it names their fund), and
    // under ShareWeighted (it carries their share units). The validator finds it
    // among the reference inputs by the (100) twin it holds, so only its
    // presence matters here, not its position.
    const shareWeighted =
      typeof anchor.voting_mode !== "string" &&
      "ShareWeighted" in anchor.voting_mode;
    const fundBound = proposal.target_policy === memberPolicy;
    const accountRefs: UTxO[] = [];
    let weight = 1n;
    if (fundBound || shareWeighted) {
      const twin =
        memberPolicy +
        assetNameLabels.prefix100 +
        memberId.slice(assetNameLabels.prefix222.length);
      const accountUtxo = yield* resolveUtxoByUnit(lucid, twin);
      accountRefs.push(accountUtxo);
      if (shareWeighted) {
        const account = yield* parseSafeDatum(
          accountUtxo.datum,
          SavingsDatumSchema,
        );
        if (!("MemberAccount" in account)) {
          return yield* Effect.fail(
            new ConfigurationError({
              configKey: "voterTokenUnit",
              message: `the member account UTxO for ${memberId} is not a MemberAccount datum`,
            }),
          );
        }
        weight = account.MemberAccount.share_units;
        if (weight <= 0n) {
          return yield* Effect.fail(
            new ConfigurationError({
              configKey: "voterTokenUnit",
              message:
                "share-weighted voting needs a positive share balance; this member holds none",
            }),
          );
        }
      }
    }

    // Tracked spending inputs: proposal (0), voter token (1), record (2).
    const votingInputs = [proposalUtxo, voterUtxo, recordUtxo];

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
              approve: config.approve,
            },
          },
          VotingAction,
        ),
      inputs: votingInputs,
    };

    const tx = yield* (yield* attachTxMessage(lucid.newTx(), config.message))
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
      .readFrom([anchorUtxo, ...accountRefs])
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
