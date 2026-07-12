import {
  Data,
  LucidEvolution,
  RedeemerBuilder,
  TxSignBuilder,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { DcuError, TransactionBuildError } from "../../core/errors.js";
import { makeReturn, resolveUtxoByUnit } from "../../core/utils/index.js";
import { GateRedeemer, GovMintRedeemer } from "../types.js";
import { GovernanceInstance } from "../validators.js";
import { decisionTokenName } from "../utils.js";

/**
 * Creates an unsigned transaction that consumes a decision at the gate: spends
 * the decision UTxO (satisfying a target vault's quorum credential = the gate)
 * and burns the one-shot decision token so it cannot be replayed.
 *
 * In production this is COMPOSED into the target vault's action transaction —
 * the vault spend and this decision spend share one tx, and `target_input_index`
 * points at the vault input the gate binds against. Called standalone it
 * demonstrates the gate mechanics (spend + burn) against the scaffold.
 *
 * @param lucid - Lucid instance with any wallet selected.
 * @param config - AuthorizeActionConfig.
 */
export type AuthorizeActionConfig = {
  instance: GovernanceInstance;
  /** The proposal whose decision authorizes the action. */
  proposalId: string;
  /** Index of the target vault input the gate binds to. Defaults to the
   *  decision input (standalone / scaffold use). */
  targetInputIndex?: bigint;
};

export const unsignedAuthorizeActionTxProgram = (
  lucid: LucidEvolution,
  config: AuthorizeActionConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { instance } = config;
    const decisionName = decisionTokenName(config.proposalId);
    const decisionUnit = instance.govPolicy + decisionName;
    const decisionUtxo = yield* resolveUtxoByUnit(lucid, decisionUnit);

    const spendRedeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (idx: bigint[]) =>
        Data.to(
          {
            decision_input_index: idx[0],
            target_input_index: config.targetInputIndex ?? idx[0],
          },
          GateRedeemer,
        ),
      inputs: [decisionUtxo],
    };

    const burnRedeemer = Data.to("BurnDecision", GovMintRedeemer);

    const tx = yield* lucid
      .newTx()
      .collectFrom([decisionUtxo], spendRedeemer)
      .attach.SpendingValidator(instance.gateValidator)
      .mintAssets({ [decisionUnit]: -1n }, burnRedeemer)
      .attach.MintingPolicy(instance.dispatcherValidator.mint)
      .completeProgram()
      .pipe(
        Effect.mapError(
          (e) =>
            new TransactionBuildError({
              operation: "authorizeAction",
              error: String(e),
            }),
        ),
      );

    return tx;
  });

export const authorizeAction = (
  lucid: LucidEvolution,
  config: AuthorizeActionConfig,
) => makeReturn(unsignedAuthorizeActionTxProgram(lucid, config));
