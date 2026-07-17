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
import {
  GateDatum,
  GovernanceDatum,
  GovMintRedeemer,
  GovSpendRedeemer,
  VotingAction,
} from "../types.js";
import { GovernanceInstance } from "../validators.js";
import {
  decisionTokenName,
  dispatcherAddress,
  gateAddress,
  GovScriptRefs,
  MIN_ADA_BUFFER,
  resolveAnchor,
  resolveProposal,
  sortedRefIndexOf,
  votingRewardAddress,
} from "../utils.js";

/**
 * Creates an unsigned transaction executing a passed proposal: mints the
 * one-shot Decision token (bound to the proposal's target and action) and locks
 * it at the gate address, then marks the proposal `Executed`. Permissionless,
 * after the timelock. This is the only step that creates authorization; the
 * decision is later spent (and burned) by the gated vault action.
 *
 * @param lucid - Lucid instance with any wallet selected (cranker).
 * @param config - ExecuteDecisionConfig.
 */
export type ExecuteDecisionConfig = {
  instance: GovernanceInstance;
  proposalId: string;
  /** Override the wall clock (emulator tests pass emulator.now()). */
  currentTime?: bigint;
  /** Reference-script UTxOs — required in practice: dispatcher + voting no
   *  longer fit inline together under the 16,384-byte tx limit. */
  scriptRefs?: GovScriptRefs;
};

export const unsignedExecuteDecisionTxProgram = (
  lucid: LucidEvolution,
  config: ExecuteDecisionConfig,
): Effect.Effect<
  { tx: TxSignBuilder; decisionName: string },
  DcuError,
  never
> =>
  Effect.gen(function* () {
    const { instance } = config;
    const network = lucid.config().network ?? "Preprod";

    const { utxo: anchorUtxo } = yield* resolveAnchor(lucid, instance);
    const { utxo: proposalUtxo, proposal } = yield* resolveProposal(
      lucid,
      instance,
      config.proposalId,
    );

    if (proposal.status !== "Passed") {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "proposalId",
          message: `proposal is ${proposal.status}, not Passed`,
        }),
      );
    }

    // Temporal window: execution lands ENTIRELY after timelock_until and,
    // when an exec_deadline is set, entirely before it.
    const now = config.currentTime ?? BigInt(Date.now());
    const drift = network === "Custom" ? 0n : 60_000n;
    const timelockUntil = proposal.timelock_until ?? 0n;
    // Slot-align the bound UP: ledger validity is in whole-second slots, so a
    // ms bound like timelock+1 floors back to/below the timelock and fails the
    // validator's entirely-after check.
    const afterTimelock = ((timelockUntil + 1000n) / 1000n) * 1000n;
    const validFrom = now - drift > afterTimelock ? now - drift : afterTimelock;
    const validTo =
      proposal.exec_deadline !== null &&
      proposal.exec_deadline - 1n < now + 900_000n
        ? proposal.exec_deadline - 1n
        : now + 900_000n;
    if (validTo <= validFrom) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "proposalId",
          message:
            "outside the execution window (timelock not elapsed, or exec deadline passed)",
        }),
      );
    }

    const decisionName = decisionTokenName(config.proposalId);
    const decisionUnit = instance.govPolicy + decisionName;

    const decisionDatum: GateDatum = {
      target_policy: proposal.target_policy,
      target_id: proposal.target_id,
      action: proposal.action,
      exec_deadline: proposal.exec_deadline,
    };

    const updated: GovernanceDatum = {
      Proposal: { ...proposal, status: "Executed" },
    };

    const anchorRefIndex = sortedRefIndexOf(anchorUtxo, [anchorUtxo]);

    // Outputs: proposal continuation (0), decision UTxO at the gate (1).
    const spendRedeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (idx: bigint[]) =>
        Data.to(
          {
            Execute: {
              anchor_ref_index: anchorRefIndex,
              proposal_input_index: idx[0],
              proposal_output_index: 0n,
              decision_output_index: 1n,
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
            ExecuteProposal: {
              proposal_input_index: idx[0],
              decision_output_index: 1n,
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
            ExecuteAction: {
              proposal_input_index: idx[0],
              proposal_output_index: 0n,
              decision_output_index: 1n,
            },
          },
          VotingAction,
        ),
      inputs: [proposalUtxo],
    };

    const tx = yield* lucid
      .newTx()
      .collectFrom([proposalUtxo], spendRedeemer)
      .readFrom([anchorUtxo])
      .mintAssets({ [decisionUnit]: 1n }, mintRedeemer)
      .compose(
        config.scriptRefs?.dispatcher
          ? lucid.newTx().readFrom([config.scriptRefs.dispatcher])
          : lucid
              .newTx()
              .attach.SpendingValidator(instance.dispatcherValidator.spend)
              .attach.MintingPolicy(instance.dispatcherValidator.mint),
      )
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
        gateAddress(network, instance),
        { kind: "inline", value: Data.to(decisionDatum, GateDatum) },
        { lovelace: MIN_ADA_BUFFER, [decisionUnit]: 1n },
      )
      .validFrom(Number(validFrom))
      .validTo(Number(validTo))
      .completeProgram()
      .pipe(
        Effect.mapError(
          (e) =>
            new TransactionBuildError({
              operation: "executeDecision",
              error: String(e),
            }),
        ),
      );

    return { tx, decisionName };
  });

export const executeDecision = (
  lucid: LucidEvolution,
  config: ExecuteDecisionConfig,
) => makeReturn(unsignedExecuteDecisionTxProgram(lucid, config));
