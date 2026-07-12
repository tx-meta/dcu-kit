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

    const decisionName = decisionTokenName(config.proposalId);
    const decisionUnit = instance.govPolicy + decisionName;

    const decisionDatum: GateDatum = {
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
      .attach.SpendingValidator(instance.dispatcherValidator.spend)
      .readFrom([anchorUtxo])
      .mintAssets({ [decisionUnit]: 1n }, mintRedeemer)
      .attach.MintingPolicy(instance.dispatcherValidator.mint)
      .withdraw(votingRewardAddress(network, instance), 0n, votingRedeemer)
      .attach.WithdrawalValidator(instance.votingValidator)
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
