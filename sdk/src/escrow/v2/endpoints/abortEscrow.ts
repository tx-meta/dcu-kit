import {
  Assets,
  Data,
  LucidEvolution,
  RedeemerBuilder,
  TxSignBuilder,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { DcuError, TransactionBuildError } from "../../../core/errors.js";
import {
  makeReturn,
  attachTxMessage,
  type TxMessage,
} from "../../../core/utils/index.js";
import { EscrowV2MintRedeemer, EscrowV2SpendRedeemer } from "../types.js";
import {
  effectiveEscrowV2ScriptRefs,
  EscrowV2ScriptRefs,
  verifyEscrowV2ScriptRefs,
  witnessEscrowV2Script,
} from "../scriptRefs.js";
import { applyPartyWitness, PartyWitness, resolveEscrowV2 } from "../utils.js";
import { stateUnitOf } from "./tranche.js";

/**
 * Creates an unsigned transaction aborting a v2 escrow by mutual consent:
 * funder AND beneficiary co-sign an explicit payout split. Burns the state
 * token. Consent works at any time — even during a dispute freeze.
 *
 * @param lucid - Lucid instance (either party's wallet; both must sign).
 * @param config - AbortEscrowV2Config.
 * @returns Effect yielding TxSignBuilder (needs both signatures).
 */
export type AbortEscrowV2Config = {
  /**
   * Reference-script UTxOs for the escrow v2 validators. Supplying the
   * escrow ref keeps its 11.4 KB out of the transaction body. Falls back
   * to the session default set by `configureEscrowV2ReferenceScripts`,
   * then to inlining the script.
   */
  scriptRefs?: EscrowV2ScriptRefs;
  /** The escrow's permanent identity (returned by createEscrow). */
  stateTokenName: string;
  /** Explicit distribution both parties agreed on. */
  payouts: { address: string; assets: Assets }[];
  /** Required when the funder credential is a script hash. */
  funderWitness?: PartyWitness;
  /** Required when the beneficiary credential is a script hash. */
  beneficiaryWitness?: PartyWitness;
  /**
   * Optional human-readable note attached to this transaction as CIP-20
   * metadata (label 674). Transaction-scoped: no validator reads it, it costs
   * no min-ADA, and it can never be edited. Public and permanent — never PII.
   */
  message?: TxMessage;
};

export const unsignedAbortEscrowV2TxProgram = (
  lucid: LucidEvolution,
  config: AbortEscrowV2Config,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const scriptRefs = effectiveEscrowV2ScriptRefs(config.scriptRefs);
    yield* verifyEscrowV2ScriptRefs(scriptRefs);
    const { utxo: escrowUtxo, datum } = yield* resolveEscrowV2(
      lucid,
      config.stateTokenName,
    );
    const stateUnit = stateUnitOf(config.stateTokenName);

    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          { AbortV2: { escrow_input_index: inputIndices[0] } },
          EscrowV2SpendRedeemer,
        ),
      inputs: [escrowUtxo],
    };

    const baseTx = witnessEscrowV2Script(
      yield* attachTxMessage(lucid.newTx(), config.message),
      "escrow",
      scriptRefs,
      ["spend", "mint"],
    )
      .collectFrom([escrowUtxo], redeemer)
      .mintAssets(
        { [stateUnit]: -1n },
        Data.to("BurnEscrowV2", EscrowV2MintRedeemer),
      );

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

    return yield* withBoth.completeProgram().pipe(
      Effect.mapError(
        (e) =>
          new TransactionBuildError({
            operation: "abortEscrowV2",
            error: String(e),
          }),
      ),
    );
  });

export const abortEscrow = (
  lucid: LucidEvolution,
  config: AbortEscrowV2Config,
) => makeReturn(unsignedAbortEscrowV2TxProgram(lucid, config));
