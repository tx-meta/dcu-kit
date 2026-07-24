import {
  Data,
  LucidEvolution,
  RedeemerBuilder,
  slotToUnixTime,
  TxSignBuilder,
  unixTimeToSlot,
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
 * Creates an unsigned transaction raising a dispute on the CURRENT milestone.
 * Funder- or beneficiary-authorized; requires the escrow to have an arbiter.
 * Freezes release / timeout / reclaim until `tx upper bound + dispute_window`,
 * and extends the milestone's cure window by the same length so raising at the
 * last moment cannot steal the counterparty's window. One dispute per
 * milestone, maximum.
 *
 * @param lucid - Lucid instance with the raising party's wallet selected.
 * @param config - RaiseDisputeConfig.
 * @returns Effect yielding TxSignBuilder.
 */
export type RaiseDisputeConfig = {
  /** The escrow's permanent identity (returned by createEscrow). */
  stateTokenName: string;
  /** Which economic party raises the dispute. */
  raisedBy: "funder" | "beneficiary";
  /** Required when the raising party's credential is a script hash. */
  partyWitness?: PartyWitness;
  /** Clock override (POSIX ms) — pass `emulator.now()` in emulator tests. */
  currentTime?: bigint;
};

export const unsignedRaiseDisputeTxProgram = (
  lucid: LucidEvolution,
  config: RaiseDisputeConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { utxo: escrowUtxo, datum } = yield* resolveEscrowV2(
      lucid,
      config.stateTokenName,
    );
    if (datum.arbiter === null) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "stateTokenName",
          message: "this escrow has no arbiter — there is no dispute path",
        }),
      );
    }
    if (
      datum.dispute !== null &&
      datum.dispute.milestone === datum.released_count
    ) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "stateTokenName",
          message: "the current milestone was already disputed once",
        }),
      );
    }
    if (Number(datum.released_count) >= datum.milestones.length) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "stateTokenName",
          message: "all milestones are released — nothing to dispute",
        }),
      );
    }

    const now = config.currentTime ?? BigInt(Date.now());
    const network = lucid.config().network ?? "Preprod";
    // The datum's `until` must equal the ON-CHAIN upper bound + window, so run
    // the same ms→slot→ms conversion the ledger will.
    const slot = unixTimeToSlot(network, Number(now + 1_200_000n));
    const upperOnchain = BigInt(slotToUnixTime(network, slot));
    const until = upperOnchain + datum.dispute_window;

    const updatedDatum: EscrowDatumV2 = {
      ...datum,
      dispute: { milestone: datum.released_count, until },
    };

    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            RaiseDispute: {
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
        { kind: "inline", value: Data.to(updatedDatum, EscrowDatumV2) },
        escrowUtxo.assets,
      )
      .validTo(Number(upperOnchain));

    const raiser =
      config.raisedBy === "funder"
        ? datum.funder.payment_credential
        : datum.beneficiary.payment_credential;
    const withWitness = yield* applyPartyWitness(
      lucid,
      baseTx,
      raiser,
      config.partyWitness,
      config.raisedBy,
    );

    return yield* withWitness.completeProgram().pipe(
      Effect.mapError(
        (e) =>
          new TransactionBuildError({
            operation: "raiseDispute",
            error: String(e),
          }),
      ),
    );
  });

export const raiseDispute = (
  lucid: LucidEvolution,
  config: RaiseDisputeConfig,
) => makeReturn(unsignedRaiseDisputeTxProgram(lucid, config));
