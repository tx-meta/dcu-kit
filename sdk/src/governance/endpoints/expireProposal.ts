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
import { GovMintRedeemer, GovSpendRedeemer, VotingAction } from "../types.js";
import { GovernanceInstance } from "../validators.js";
import {
  GovScriptRefs,
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
  /** Override the wall clock (emulator tests pass emulator.now()). */
  currentTime?: bigint;
  /** Reference-script UTxOs — required in practice: dispatcher + voting no
   *  longer fit inline together under the 16,384-byte tx limit. */
  scriptRefs?: GovScriptRefs;
};

export const unsignedExpireProposalTxProgram = (
  lucid: LucidEvolution,
  config: ExpireProposalConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { instance } = config;
    const network = lucid.config().network ?? "Preprod";

    const { utxo: anchorUtxo } = yield* resolveAnchor(lucid, instance);
    const { utxo: proposalUtxo, proposal } = yield* resolveProposal(
      lucid,
      instance,
      config.proposalId,
    );
    const proposalUnit = instance.govPolicy + config.proposalId;

    // Temporal gate mirrors the validator: an Open proposal expires only after
    // its deadline, a Passed one only after its exec_deadline (None = never),
    // Executed/Rejected any time.
    const now = config.currentTime ?? BigInt(Date.now());
    const drift = network === "Custom" ? 0n : 60_000n;
    const notBefore =
      proposal.status === "Open"
        ? proposal.deadline + 1n
        : proposal.status === "Passed"
          ? proposal.exec_deadline !== null
            ? proposal.exec_deadline + 1n
            : null
          : 0n;
    if (notBefore === null) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "proposalId",
          message:
            "a Passed proposal with no exec_deadline is not expirable — execute it instead",
        }),
      );
    }
    // Slot-align the bound UP: ledger validity is in whole-second slots, so a
    // ms bound like deadline+1 floors back to/below the deadline and fails the
    // validator's entirely-after check.
    const notBeforeSlot = ((notBefore + 999n) / 1000n) * 1000n;
    const validFrom = now - drift > notBeforeSlot ? now - drift : notBeforeSlot;
    const validTo = now + 900_000n;
    if (validTo <= validFrom) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "proposalId",
          message: "the proposal is still live — it cannot be expired yet",
        }),
      );
    }

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

    // NOTE: no .compose() here — under lucid 0.4.31, composing after a burn
    // mintAssets duplicates the burn during balancing. Attach conditionally
    // on the single chain instead.
    let builder = lucid
      .newTx()
      .collectFrom([proposalUtxo], spendRedeemer)
      .readFrom(
        config.scriptRefs?.dispatcher && config.scriptRefs?.voting
          ? [anchorUtxo, config.scriptRefs.dispatcher, config.scriptRefs.voting]
          : [anchorUtxo],
      )
      .mintAssets({ [proposalUnit]: -1n }, burnRedeemer)
      .withdraw(votingRewardAddress(network, instance), 0n, votingRedeemer);
    if (!config.scriptRefs?.dispatcher) {
      builder = builder.attach
        .SpendingValidator(instance.dispatcherValidator.spend)
        .attach.MintingPolicy(instance.dispatcherValidator.mint);
    }
    if (!config.scriptRefs?.voting) {
      builder = builder.attach.WithdrawalValidator(instance.votingValidator);
    }
    const tx = yield* builder
      .validFrom(Number(validFrom))
      .validTo(Number(validTo))
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
