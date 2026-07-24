import {
  Data,
  LucidEvolution,
  RedeemerBuilder,
  TxSignBuilder,
  UTxO,
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
  /** The target vault UTxO the decision authorizes — it must carry a token named
   *  the decision's `target_id`. The gate binds the decision to it. In production
   *  this is the vault input of the composed action transaction. */
  targetUtxo: UTxO;
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

    // The gate binds the decision to the target vault: both are tracked inputs so
    // decision_input_index / target_input_index resolve at build time.
    const spendRedeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (idx: bigint[]) =>
        Data.to(
          { decision_input_index: idx[0], target_input_index: idx[1] },
          GateRedeemer,
        ),
      inputs: [decisionUtxo, config.targetUtxo],
    };

    const burnRedeemer = Data.to("BurnDecision", GovMintRedeemer);

    const tx = yield* lucid
      .newTx()
      .collectFrom([decisionUtxo], spendRedeemer)
      .attach.SpendingValidator(instance.gateValidator)
      .collectFrom([config.targetUtxo])
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
