import {
  Data,
  LucidEvolution,
  RedeemerBuilder,
  TxBuilder,
  TxSignBuilder,
  UTxO,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { DcuError, TransactionBuildError } from "../../core/errors.js";
import {
  makeReturn,
  resolveUtxoByUnit,
  attachTxMessage,
  type TxMessage,
} from "../../core/utils/index.js";
import { GateRedeemer, GovMintRedeemer } from "../types.js";
import { GovernanceInstance } from "../validators.js";
import { decisionTokenName, GovScriptRefs } from "../utils.js";

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
  /**
   * The redeemer the target input is spent with. The gate binds a decision to
   * ONE action by requiring these exact bytes: a `Generic` action's payload is
   * this redeemer's CBOR, and a typed action must BE this redeemer. Omit only
   * when the target needs no redeemer, which the gate then rejects — a decision
   * cannot authorize a transaction that performs no action.
   */
  targetRedeemer?: string;
  /**
   * Optional human-readable note attached to this transaction as CIP-20
   * metadata (label 674). Transaction-scoped: no validator reads it, it costs
   * no min-ADA, and it can never be edited. Public and permanent — never PII.
   */
  message?: TxMessage;
};

export type GateWitnessConfig = {
  instance: GovernanceInstance;
  /** The proposal whose decision authorizes the action. */
  proposalId: string;
  /** The vault input the decision is bound to — the UTxO carrying the state NFT
   *  named the decision's `target_id`. It is indexed, never collected here. */
  targetUtxo: UTxO;
  /** Reference-script UTxOs — pass the dispatcher ref to keep the burn policy
   *  off the transaction body (its one hash serves mint and spend). */
  scriptRefs?: GovScriptRefs;
};

/**
 * The gate half of a governed action, as an EXTENSION of the target action's
 * own transaction: it spends the decision UTxO at the gate with the binding
 * redeemer and burns the one-shot decision token.
 *
 * Apply it to the builder the governed primitive is already assembling —
 * savings takes it as `quorumWitness.extend` — to satisfy a vault whose
 * `quorum` is `Script(instance.gateHash)`: the on-chain rule is "some spent
 * input sits at that script's credential", and the decision UTxO is that input.
 *
 * Two things it deliberately does NOT do:
 * - it never collects `targetUtxo`; the primitive's endpoint spends that input
 *   with its own redeemer, and this only *indexes* it so `target_input_index`
 *   resolves against the combined transaction;
 * - it is not a standalone builder to `compose` in afterwards. `compose` merges
 *   a fragment's minted assets but runs its `collectFrom` too late for coin
 *   selection, so the decision burn would have no input to balance against.
 *
 * `authorizeAction` below stays exactly as it was — a standalone demonstration
 * of the gate mechanics — so existing callers are unaffected. The small overlap
 * between the two is deliberate.
 *
 * @param lucid - Lucid instance with the acting wallet selected.
 * @param config - GateWitnessConfig.
 * @returns Effect yielding a `TxBuilder => TxBuilder` extension.
 */
export const gateWitnessProgram = (
  lucid: LucidEvolution,
  config: GateWitnessConfig,
): Effect.Effect<(_tx: TxBuilder) => TxBuilder, DcuError, never> =>
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

    return (tx: TxBuilder) => {
      const gated = tx
        .collectFrom([decisionUtxo], spendRedeemer)
        .attach.SpendingValidator(instance.gateValidator)
        .mintAssets({ [decisionUnit]: -1n }, burnRedeemer);
      // One dispatcher ref serves both its mint and spend purposes (same hash).
      return config.scriptRefs?.dispatcher
        ? gated.readFrom([config.scriptRefs.dispatcher])
        : gated.attach.MintingPolicy(instance.dispatcherValidator.mint);
    };
  });

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

    const tx = yield* (yield* attachTxMessage(lucid.newTx(), config.message))
      .collectFrom([decisionUtxo], spendRedeemer)
      .attach.SpendingValidator(instance.gateValidator)
      .collectFrom(
        [config.targetUtxo],
        ...(config.targetRedeemer ? [config.targetRedeemer] : []),
      )
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
