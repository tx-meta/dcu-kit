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
import {
  EscrowDatumV2,
  EscrowV2SpendRedeemer,
  PartyRef,
  partyToCredential,
  toOnchainAddress,
} from "../types.js";
import { escrowV2Validator } from "../validators.js";
import { applyPartyWitness, PartyWitness, resolveEscrowV2 } from "../utils.js";

/**
 * Creates an unsigned transaction rotating ONE party of a v2 escrow to a new
 * credential — wallet migration, verifier handoff, or assigning the receivable
 * (beneficiary rotation). Authorized by the CURRENT credential of the rotated
 * party only; no party can replace another.
 *
 * Funder/beneficiary take a full address (payout destinations); verifier and
 * arbiter take an address or `{ type, hash }`.
 *
 * @param lucid - Lucid instance with the rotating party's wallet selected.
 * @param config - RotatePartyConfig.
 * @returns Effect yielding TxSignBuilder.
 */
export type RotatePartyConfig = {
  /** The escrow's permanent identity (returned by createEscrow). */
  stateTokenName: string;
  party: "funder" | "beneficiary" | "verifier" | "arbiter";
  /** The replacement: an address (funder/beneficiary/verifier/arbiter) or a credential. */
  newParty: PartyRef;
  /** Required when the CURRENT credential of the party is a script hash. */
  partyWitness?: PartyWitness;
};

const partyTag = {
  funder: "FunderParty",
  beneficiary: "BeneficiaryParty",
  verifier: "VerifierParty",
  arbiter: "ArbiterParty",
} as const;

export const unsignedRotatePartyTxProgram = (
  lucid: LucidEvolution,
  config: RotatePartyConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { utxo: escrowUtxo, datum } = yield* resolveEscrowV2(
      lucid,
      config.stateTokenName,
    );

    const credKey = (c: EscrowDatumV2["verifier"]) =>
      "VerificationKey" in c ? `K${c.VerificationKey[0]}` : `S${c.Script[0]}`;

    let updatedDatum: EscrowDatumV2;
    let currentCredential: EscrowDatumV2["verifier"];
    switch (config.party) {
      case "funder": {
        if (typeof config.newParty !== "string") {
          return yield* Effect.fail(
            new ConfigurationError({
              configKey: "newParty",
              message: "funder rotation takes a full address (refund destination)",
            }),
          );
        }
        const funder = yield* toOnchainAddress(config.newParty);
        updatedDatum = { ...datum, funder };
        currentCredential = datum.funder.payment_credential;
        break;
      }
      case "beneficiary": {
        if (typeof config.newParty !== "string") {
          return yield* Effect.fail(
            new ConfigurationError({
              configKey: "newParty",
              message:
                "beneficiary rotation takes a full address (payout destination)",
            }),
          );
        }
        const beneficiary = yield* toOnchainAddress(config.newParty);
        updatedDatum = { ...datum, beneficiary };
        currentCredential = datum.beneficiary.payment_credential;
        break;
      }
      case "verifier": {
        const verifier = yield* partyToCredential(config.newParty, "newParty");
        updatedDatum = { ...datum, verifier };
        currentCredential = datum.verifier;
        break;
      }
      case "arbiter": {
        if (datum.arbiter === null) {
          return yield* Effect.fail(
            new ConfigurationError({
              configKey: "party",
              message:
                "this escrow has no arbiter — one cannot be added after create",
            }),
          );
        }
        const arbiter = yield* partyToCredential(config.newParty, "newParty");
        updatedDatum = { ...datum, arbiter };
        currentCredential = datum.arbiter;
        break;
      }
    }

    // Mirror the on-chain guardrails so failures are typed before submission.
    if (
      credKey(updatedDatum.verifier) ===
      credKey(updatedDatum.beneficiary.payment_credential)
    ) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "newParty",
          message: "the rotation would make the verifier the beneficiary",
        }),
      );
    }
    if (
      updatedDatum.arbiter !== null &&
      [
        credKey(updatedDatum.funder.payment_credential),
        credKey(updatedDatum.beneficiary.payment_credential),
        credKey(updatedDatum.verifier),
      ].includes(credKey(updatedDatum.arbiter))
    ) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "newParty",
          message:
            "the rotation would collapse the arbiter into another party",
        }),
      );
    }

    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            RotateParty: {
              escrow_input_index: inputIndices[0],
              continuation_index: 0n,
              party: partyTag[config.party],
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
      currentCredential,
      config.partyWitness,
      config.party,
    );

    return yield* withWitness.completeProgram().pipe(
      Effect.mapError(
        (e) =>
          new TransactionBuildError({
            operation: "rotateParty",
            error: String(e),
          }),
      ),
    );
  });

export const rotateParty = (lucid: LucidEvolution, config: RotatePartyConfig) =>
  makeReturn(unsignedRotatePartyTxProgram(lucid, config));
