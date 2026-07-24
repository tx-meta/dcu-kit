import {
  Data,
  LucidEvolution,
  RedeemerBuilder,
  TxSignBuilder,
  UTxO,
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
  PartyD,
  PartyRef,
  partyToCredential,
  toOnchainAddress,
} from "../types.js";
import { escrowV2Validator } from "../validators.js";
import { applyPartyWitness, PartyWitness, resolveEscrowV2 } from "../utils.js";

/**
 * Creates an unsigned transaction rotating ONE party of a v2 escrow to a new
 * credential — wallet migration, verifier handoff, assigning the receivable
 * (beneficiary rotation), or a co-beneficiary moving its own payout address.
 * Authorized by the CURRENT credential of the rotated party only; no party can
 * replace another.
 *
 * @param lucid - Lucid instance with the rotating party's wallet selected.
 * @param config - RotatePartyConfig.
 * @returns Effect yielding TxSignBuilder.
 */
export type RotatePartyConfig = {
  /** The escrow's permanent identity (returned by createEscrow). */
  stateTokenName: string;
  /** Which party rotates; co-beneficiaries rotate by index. */
  party:
    | "funder"
    | "beneficiary"
    | "verifier"
    | "arbiter"
    | { coBeneficiary: number };
  /** The replacement: an address (payout parties) or a credential. */
  newParty: PartyRef;
  /** Required when the CURRENT credential of the party is a script hash. */
  partyWitness?: PartyWitness;
};

const credKey = (c: EscrowDatumV2["verifier"]) =>
  "VerificationKey" in c ? `K${c.VerificationKey[0]}` : `S${c.Script[0]}`;

const guardrailViolation = (datum: EscrowDatumV2): string | null => {
  const beneficiaries = [
    credKey(datum.beneficiary.payment_credential),
    ...datum.co_beneficiaries.map((c) => credKey(c.address.payment_credential)),
  ];
  if (beneficiaries.includes(credKey(datum.verifier))) {
    return "the rotation would make the verifier a beneficiary";
  }
  if (new Set(beneficiaries).size !== beneficiaries.length) {
    return "the rotation would duplicate a beneficiary";
  }
  if (
    datum.arbiter !== null &&
    [
      credKey(datum.funder.payment_credential),
      credKey(datum.verifier),
      ...beneficiaries,
    ].includes(credKey(datum.arbiter))
  ) {
    return "the rotation would collapse the arbiter into another party";
  }
  return null;
};

const buildRotation = (
  lucid: LucidEvolution,
  escrowUtxo: UTxO,
  updatedDatum: EscrowDatumV2,
  party: PartyD,
  currentCredential: EscrowDatumV2["verifier"],
  witness: PartyWitness | undefined,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    // Mirror the on-chain guardrails so failures are typed before submission.
    const violation = guardrailViolation(updatedDatum);
    if (violation !== null) {
      return yield* Effect.fail(
        new ConfigurationError({ configKey: "newParty", message: violation }),
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
              party,
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
      witness,
      "rotating party",
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

export const unsignedRotatePartyTxProgram = (
  lucid: LucidEvolution,
  config: RotatePartyConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { utxo: escrowUtxo, datum } = yield* resolveEscrowV2(
      lucid,
      config.stateTokenName,
    );

    if (typeof config.party === "object") {
      const ix = config.party.coBeneficiary;
      const current = datum.co_beneficiaries[ix];
      if (current === undefined) {
        return yield* Effect.fail(
          new ConfigurationError({
            configKey: "party",
            message: `no co-beneficiary at index ${ix}`,
          }),
        );
      }
      if (typeof config.newParty !== "string") {
        return yield* Effect.fail(
          new ConfigurationError({
            configKey: "newParty",
            message:
              "co-beneficiary rotation takes a full address (payout destination)",
          }),
        );
      }
      const address = yield* toOnchainAddress(config.newParty);
      const updatedDatum: EscrowDatumV2 = {
        ...datum,
        co_beneficiaries: datum.co_beneficiaries.map((c, i) =>
          i === ix ? { ...c, address } : c,
        ),
      };
      return yield* buildRotation(
        lucid,
        escrowUtxo,
        updatedDatum,
        { CoBeneficiaryParty: { index: BigInt(ix) } },
        current.address.payment_credential,
        config.partyWitness,
      );
    }

    switch (config.party) {
      case "funder": {
        if (typeof config.newParty !== "string") {
          return yield* Effect.fail(
            new ConfigurationError({
              configKey: "newParty",
              message:
                "funder rotation takes a full address (refund destination)",
            }),
          );
        }
        const funder = yield* toOnchainAddress(config.newParty);
        return yield* buildRotation(
          lucid,
          escrowUtxo,
          { ...datum, funder },
          "FunderParty",
          datum.funder.payment_credential,
          config.partyWitness,
        );
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
        return yield* buildRotation(
          lucid,
          escrowUtxo,
          { ...datum, beneficiary },
          "BeneficiaryParty",
          datum.beneficiary.payment_credential,
          config.partyWitness,
        );
      }
      case "verifier": {
        const verifier = yield* partyToCredential(config.newParty, "newParty");
        return yield* buildRotation(
          lucid,
          escrowUtxo,
          { ...datum, verifier },
          "VerifierParty",
          datum.verifier,
          config.partyWitness,
        );
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
        return yield* buildRotation(
          lucid,
          escrowUtxo,
          { ...datum, arbiter },
          "ArbiterParty",
          datum.arbiter,
          config.partyWitness,
        );
      }
    }
  });

export const rotateParty = (lucid: LucidEvolution, config: RotatePartyConfig) =>
  makeReturn(unsignedRotatePartyTxProgram(lucid, config));
