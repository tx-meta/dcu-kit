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
} from "../../../core/errors.js";
import { makeReturn } from "../../../core/utils/index.js";
import { EscrowDatumV2, EscrowV2SpendRedeemer } from "../types.js";
import { escrowV2Validator } from "../validators.js";
import { applyPartyWitness, PartyWitness, resolveEscrowV2 } from "../utils.js";

/**
 * Creates an unsigned transaction anchoring deliverable evidence for one
 * milestone: the beneficiary records a content hash (e.g. an IPFS CID's hash)
 * against an unreleased milestone. Overwritable until that milestone is
 * released; has NO effect on fund movement — an assertion can't authorize
 * funds, it only notifies and timestamps.
 *
 * @param lucid - Lucid instance with the beneficiary's wallet selected.
 * @param config - SubmitEvidenceConfig.
 * @returns Effect yielding TxSignBuilder.
 */
export type SubmitEvidenceConfig = {
  /** The escrow's permanent identity (returned by createEscrow). */
  stateTokenName: string;
  /** Index of the milestone the evidence is for (>= released_count). */
  milestoneIndex: number;
  /** Hex hash of the evidence document. */
  evidenceHash: string;
  /** Required when the beneficiary credential is a script hash. */
  beneficiaryWitness?: PartyWitness;
};

export const unsignedSubmitEvidenceTxProgram = (
  lucid: LucidEvolution,
  config: SubmitEvidenceConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { utxo: escrowUtxo, datum } = yield* resolveEscrowV2(
      lucid,
      config.stateTokenName,
    );
    const ix = config.milestoneIndex;
    if (ix < Number(datum.released_count) || ix >= datum.milestones.length) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "milestoneIndex",
          message: `evidence can only target an unreleased milestone (${datum.released_count}..${datum.milestones.length - 1})`,
        }),
      );
    }

    const updatedDatum: EscrowDatumV2 = {
      ...datum,
      evidence: datum.evidence.map((e, i) =>
        i === ix ? config.evidenceHash : e,
      ),
    };

    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            SubmitEvidence: {
              escrow_input_index: inputIndices[0],
              continuation_index: 0n,
              milestone_index: BigInt(ix),
              evidence_hash: config.evidenceHash,
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
        { kind: "inline", value: Data.to(updatedDatum, EscrowDatumV2) },
        escrowUtxo.assets,
      );

    const withWitness = yield* applyPartyWitness(
      lucid,
      baseTx,
      datum.beneficiary.payment_credential,
      config.beneficiaryWitness,
      "beneficiary",
    );

    return yield* withWitness.completeProgram().pipe(
      Effect.mapError(
        (e) =>
          new TransactionBuildError({
            operation: "submitEvidence",
            error: String(e),
          }),
      ),
    );
  });

export const submitEvidence = (
  lucid: LucidEvolution,
  config: SubmitEvidenceConfig,
) => makeReturn(unsignedSubmitEvidenceTxProgram(lucid, config));
