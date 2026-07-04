import {
  Assets,
  Data,
  LucidEvolution,
  RedeemerBuilder,
  TxSignBuilder,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { DcuError, TransactionBuildError } from "../../core/errors.js";
import { makeReturn } from "../../core/utils/index.js";
import { EscrowMintRedeemer, EscrowSpendRedeemer } from "../types.js";
import { escrowPolicyId, escrowValidator } from "../validators.js";
import { applyPartyWitness, PartyWitness, resolveEscrow } from "../utils.js";

/**
 * Creates an unsigned transaction dissolving an escrow by mutual consent.
 * Funder AND beneficiary must both authorize; the distribution is whatever the
 * two parties agreed (`payouts`).
 *
 * **Functionality:**
 * - Burns the state token and pays the escrow balance out per `payouts`.
 * - Both parties' authorizations are added (signer keys for VK credentials,
 *   dust-UTxO proofs for script credentials). Collect both signatures with
 *   `partialSign` before submitting.
 *
 * @param lucid - Lucid instance (either party, or a coordinator, pays the fee).
 * @param config - AbortEscrowConfig.
 * @returns Effect yielding TxSignBuilder (needs both parties' signatures).
 */
export type AbortEscrowConfig = {
  /** The escrow's permanent identity (returned by createEscrow). */
  stateTokenName: string;
  /** The agreed distribution of the escrow balance (fees come from the wallet). */
  payouts: { address: string; assets: Assets }[];
  /** Required when the funder credential is a script hash. */
  funderWitness?: PartyWitness;
  /** Required when the beneficiary credential is a script hash. */
  beneficiaryWitness?: PartyWitness;
};

export const unsignedAbortEscrowTxProgram = (
  lucid: LucidEvolution,
  config: AbortEscrowConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { utxo: escrowUtxo, datum } = yield* resolveEscrow(
      lucid,
      config.stateTokenName,
    );
    const stateUnit = escrowPolicyId + config.stateTokenName;

    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          { Abort: { escrow_input_index: inputIndices[0] } },
          EscrowSpendRedeemer,
        ),
      inputs: [escrowUtxo],
    };

    const baseTx = lucid
      .newTx()
      .collectFrom([escrowUtxo], redeemer)
      .attach.SpendingValidator(escrowValidator.spendEscrow)
      .mintAssets(
        { [stateUnit]: -1n },
        Data.to("BurnEscrow", EscrowMintRedeemer),
      )
      .attach.MintingPolicy(escrowValidator.mintEscrow);

    const withPayouts = config.payouts.reduce(
      (t, p) => t.pay.ToAddress(p.address, p.assets),
      baseTx,
    );

    const withFunder = yield* applyPartyWitness(
      lucid,
      withPayouts,
      datum.funder.payment_credential,
      config.funderWitness,
      "funder",
    );
    const withBoth = yield* applyPartyWitness(
      lucid,
      withFunder,
      datum.beneficiary.payment_credential,
      config.beneficiaryWitness,
      "beneficiary",
    );

    const tx = yield* withBoth.completeProgram().pipe(
      Effect.mapError(
        (e) =>
          new TransactionBuildError({
            operation: "abortEscrow",
            error: String(e),
          }),
      ),
    );

    return tx;
  });

export const abortEscrow = (lucid: LucidEvolution, config: AbortEscrowConfig) =>
  makeReturn(unsignedAbortEscrowTxProgram(lucid, config));
