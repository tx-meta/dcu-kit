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
import {
  EscrowV2MintRedeemer,
  EscrowV2SpendRedeemer,
  fromOnchainAddress,
} from "../types.js";
import { escrowV2Validator } from "../validators.js";
import { applyPartyWitness, PartyWitness, resolveEscrowV2 } from "../utils.js";
import { stateUnitOf } from "./tranche.js";

/**
 * Creates an unsigned transaction resolving an active (or lapsed but
 * unresolved) dispute: the arbiter signs a TERMINAL split of the whole
 * remainder between funder and beneficiary — never to itself or a third
 * party (validator-enforced). Burns the state token.
 *
 * @param lucid - Lucid instance with the arbiter's wallet selected.
 * @param config - ResolveDisputeConfig.
 * @returns Effect yielding TxSignBuilder.
 */
export type ResolveDisputeConfig = {
  /** The escrow's permanent identity (returned by createEscrow). */
  stateTokenName: string;
  /** Lovelace (or escrow-asset units for token escrows) paid to the funder. */
  funderAmount: bigint;
  /** The rest of the escrowed asset goes to the beneficiary. */
  beneficiaryAmount: bigint;
  /** Required when the arbiter credential is a script hash. */
  arbiterWitness?: PartyWitness;
};

export const unsignedResolveDisputeTxProgram = (
  lucid: LucidEvolution,
  config: ResolveDisputeConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { utxo: escrowUtxo, datum } = yield* resolveEscrowV2(
      lucid,
      config.stateTokenName,
    );
    const stateUnit = stateUnitOf(config.stateTokenName);
    if (datum.arbiter === null) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "stateTokenName",
          message: "this escrow has no arbiter",
        }),
      );
    }
    if (
      datum.dispute === null ||
      datum.dispute.milestone !== datum.released_count
    ) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "stateTokenName",
          message: "no dispute on the current milestone to resolve",
        }),
      );
    }

    const remainder: Assets = { ...escrowUtxo.assets };
    delete remainder[stateUnit];
    const isAda = datum.asset_policy === "";
    const assetUnit = isAda
      ? "lovelace"
      : datum.asset_policy + datum.asset_name;
    const pot = remainder[assetUnit] ?? 0n;
    if (config.funderAmount + config.beneficiaryAmount !== pot) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "funderAmount",
          message: `the split must distribute the whole remainder (${pot} of ${assetUnit})`,
        }),
      );
    }

    const network = lucid.config().network ?? "Preprod";
    const funderAddress = yield* fromOnchainAddress(network, datum.funder);
    const beneficiaryAddress = yield* fromOnchainAddress(
      network,
      datum.beneficiary,
    );
    // Native-token escrows: split the tokens; the lovelace buffer follows the
    // funder (mirrors reclaim), and the beneficiary's token output carries
    // min-ADA from the crank.
    const bufferLovelace = isAda ? 0n : (remainder.lovelace ?? 0n);
    const funderAssets: Assets = {};
    if (isAda) {
      if (config.funderAmount > 0n) funderAssets.lovelace = config.funderAmount;
    } else {
      funderAssets.lovelace = bufferLovelace;
      if (config.funderAmount > 0n)
        funderAssets[assetUnit] = config.funderAmount;
    }
    const beneficiaryAssets: Assets = isAda
      ? { lovelace: config.beneficiaryAmount }
      : { lovelace: 2_000_000n, [assetUnit]: config.beneficiaryAmount };

    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          { ResolveDispute: { escrow_input_index: inputIndices[0] } },
          EscrowV2SpendRedeemer,
        ),
      inputs: [escrowUtxo],
    };

    let tx = lucid
      .newTx()
      .collectFrom([escrowUtxo], redeemer)
      .attach.SpendingValidator(escrowV2Validator.spendEscrow)
      .mintAssets(
        { [stateUnit]: -1n },
        Data.to("BurnEscrowV2", EscrowV2MintRedeemer),
      )
      .attach.MintingPolicy(escrowV2Validator.mintEscrow);

    if (Object.keys(funderAssets).length > 0) {
      tx = tx.pay.ToAddress(funderAddress, funderAssets);
    }
    if (config.beneficiaryAmount > 0n) {
      tx = tx.pay.ToAddress(beneficiaryAddress, beneficiaryAssets);
    }

    const withWitness = yield* applyPartyWitness(
      lucid,
      tx,
      datum.arbiter,
      config.arbiterWitness,
      "arbiter",
    );

    return yield* withWitness.completeProgram().pipe(
      Effect.mapError(
        (e) =>
          new TransactionBuildError({
            operation: "resolveDispute",
            error: String(e),
          }),
      ),
    );
  });

export const resolveDispute = (
  lucid: LucidEvolution,
  config: ResolveDisputeConfig,
) => makeReturn(unsignedResolveDisputeTxProgram(lucid, config));
