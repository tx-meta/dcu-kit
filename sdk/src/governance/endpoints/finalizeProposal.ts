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
import { makeReturn } from "../../core/utils/index.js";
import { GovernanceDatum, GovSpendRedeemer, VotingAction } from "../types.js";
import { GovernanceInstance } from "../validators.js";
import {
  dispatcherAddress,
  GovScriptRefs,
  resolveAnchor,
  resolveProposal,
  sortedRefIndexOf,
  votingRewardAddress,
} from "../utils.js";

/**
 * Creates an unsigned transaction finalizing a proposal after its deadline:
 * compares the frozen quorum and threshold to the cast tally and transitions
 * `Open → Passed | Rejected`. Permissionless. No value moves; on pass, sets
 * `timelock_until = now + charter.timelock`. Couples to the voting
 * FinalizeAction via a 0-ADA withdrawal.
 *
 * @param lucid - Lucid instance with any wallet selected (cranker).
 * @param config - FinalizeProposalConfig.
 */
export type FinalizeProposalConfig = {
  instance: GovernanceInstance;
  proposalId: string;
  /** Override the wall clock (emulator tests pass emulator.now()). */
  currentTime?: bigint;
  /** Reference-script UTxOs — required in practice: dispatcher + voting no
   *  longer fit inline together under the 16,384-byte tx limit. */
  scriptRefs?: GovScriptRefs;
};

export const unsignedFinalizeProposalTxProgram = (
  lucid: LucidEvolution,
  config: FinalizeProposalConfig,
): Effect.Effect<{ tx: TxSignBuilder; passed: boolean }, DcuError, never> =>
  Effect.gen(function* () {
    const { instance } = config;
    const network = lucid.config().network ?? "Preprod";

    const { utxo: anchorUtxo, anchor } = yield* resolveAnchor(lucid, instance);
    const { utxo: proposalUtxo, proposal } = yield* resolveProposal(
      lucid,
      instance,
      config.proposalId,
    );

    const cast = proposal.tally_yes + proposal.tally_no;
    const passed =
      cast >= proposal.quorum &&
      proposal.tally_yes * 10000n >= proposal.threshold * cast;

    // Temporal window: finalize lands ENTIRELY after the voting deadline; on
    // pass, timelock_until is pinned to the validity lower bound + charter
    // timelock (the validator enforces both bounds).
    const now = config.currentTime ?? BigInt(Date.now());
    const drift = network === "Custom" ? 0n : 60_000n;
    // Slot-align the bound UP: ledger validity is in whole-second slots, so a
    // ms bound like deadline+1 floors back to/below the deadline and fails the
    // validator's entirely-after check.
    const afterDeadline = ((proposal.deadline + 1000n) / 1000n) * 1000n;
    const validFrom = now - drift > afterDeadline ? now - drift : afterDeadline;
    const validTo = now + 900_000n;
    if (validTo <= validFrom) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "proposalId",
          message: "voting is still open — finalize after the deadline",
        }),
      );
    }

    const updated: GovernanceDatum = {
      Proposal: {
        ...proposal,
        status: passed ? "Passed" : "Rejected",
        timelock_until: passed ? validFrom + anchor.timelock : null,
      },
    };

    const anchorRefIndex = sortedRefIndexOf(anchorUtxo, [anchorUtxo]);

    const spendRedeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (idx: bigint[]) =>
        Data.to(
          {
            Finalize: {
              anchor_ref_index: anchorRefIndex,
              proposal_input_index: idx[0],
              proposal_output_index: 0n,
              withdrawal_index: 0n,
            },
          },
          GovSpendRedeemer,
        ),
      inputs: [proposalUtxo],
    };

    const votingRedeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (idx: bigint[]) =>
        Data.to(
          {
            FinalizeAction: {
              proposal_input_index: idx[0],
              proposal_output_index: 0n,
            },
          },
          VotingAction,
        ),
      inputs: [proposalUtxo],
    };

    const tx = yield* lucid
      .newTx()
      .collectFrom([proposalUtxo], spendRedeemer)
      .compose(
        config.scriptRefs?.dispatcher
          ? lucid.newTx().readFrom([config.scriptRefs.dispatcher])
          : lucid
              .newTx()
              .attach.SpendingValidator(instance.dispatcherValidator.spend),
      )
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
      .validFrom(Number(validFrom))
      .validTo(Number(validTo))
      .completeProgram()
      .pipe(
        Effect.mapError(
          (e) =>
            new TransactionBuildError({
              operation: "finalizeProposal",
              error: String(e),
            }),
        ),
      );

    return { tx, passed };
  });

export const finalizeProposal = (
  lucid: LucidEvolution,
  config: FinalizeProposalConfig,
) => makeReturn(unsignedFinalizeProposalTxProgram(lucid, config));
