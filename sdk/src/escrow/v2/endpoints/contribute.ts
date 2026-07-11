import {
  Assets,
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
} from "../../../core/errors.js";
import { makeReturn } from "../../../core/utils/index.js";
import { EscrowDatumV2, EscrowV2SpendRedeemer } from "../types.js";
import { escrowV2Validator } from "../validators.js";
import {
  applyPartyWitness,
  escrowV2AssetUnit,
  PartyWitness,
  resolveEscrowV2,
} from "../utils.js";

/**
 * Creates an unsigned transaction topping up a PerMilestone escrow with more
 * of the escrowed asset. Funder-authorized; the datum is unchanged and the
 * balance strictly grows. Upfront escrows are already fully funded and reject
 * contributions.
 *
 * @param lucid - Lucid instance with the funder's wallet selected.
 * @param config - ContributeConfig.
 * @returns Effect yielding TxSignBuilder.
 */
export type ContributeConfig = {
  /** The escrow's permanent identity (returned by createEscrow). */
  stateTokenName: string;
  /** Amount of the escrowed asset to add (smallest unit; > 0). */
  amount: bigint;
  /** Required when the funder credential is a script hash. */
  funderWitness?: PartyWitness;
};

export const unsignedContributeTxProgram = (
  lucid: LucidEvolution,
  config: ContributeConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { utxo: escrowUtxo, datum } = yield* resolveEscrowV2(
      lucid,
      config.stateTokenName,
    );
    if (datum.funding_mode !== "PerMilestone") {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "stateTokenName",
          message:
            "Upfront escrows are fully funded at create — nothing to contribute",
        }),
      );
    }
    if (config.amount <= 0n) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "amount",
          message: "the contribution must be > 0",
        }),
      );
    }

    const assetUnit = escrowV2AssetUnit(datum);
    const continuationAssets: Assets = { ...escrowUtxo.assets };
    continuationAssets[assetUnit] =
      (continuationAssets[assetUnit] ?? 0n) + config.amount;

    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            Contribute: {
              escrow_input_index: inputIndices[0],
              continuation_index: 0n,
            },
          },
          EscrowV2SpendRedeemer,
        ),
      inputs: [escrowUtxo],
    };

    const baseTx = lucid
      .newTx()
      .collectFrom([escrowUtxo], redeemer)
      .attach.SpendingValidator(escrowV2Validator.spendEscrow)
      .pay.ToContract(
        escrowUtxo.address,
        { kind: "inline", value: Data.to(datum, EscrowDatumV2) },
        continuationAssets,
      );

    const withWitness = yield* applyPartyWitness(
      lucid,
      baseTx,
      datum.funder.payment_credential,
      config.funderWitness,
      "funder",
    );

    return yield* withWitness.completeProgram().pipe(
      Effect.mapError(
        (e) =>
          new TransactionBuildError({
            operation: "contribute",
            error: String(e),
          }),
      ),
    );
  });

export const contribute = (lucid: LucidEvolution, config: ContributeConfig) =>
  makeReturn(unsignedContributeTxProgram(lucid, config));
