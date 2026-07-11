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
import {
  applyPartyWitness,
  cureBoundary,
  PartyWitness,
  resolveEscrowV2,
} from "../utils.js";
import { stateUnitOf } from "./tranche.js";

/**
 * Creates an unsigned transaction reclaiming an overdue escrow's remaining
 * balance to the funder. Only for escrows with `timeoutPolicy:
 * "RefundToFunder"`; valid strictly after the current milestone's cure
 * boundary (dispute-extended). Burns the state token.
 *
 * @param lucid - Lucid instance (pays the fee; the funder must sign).
 * @param config - ReclaimEscrowV2Config.
 * @returns Effect yielding TxSignBuilder.
 */
export type ReclaimEscrowV2Config = {
  /** The escrow's permanent identity (returned by createEscrow). */
  stateTokenName: string;
  /** Required when the funder credential is a script hash. */
  funderWitness?: PartyWitness;
  /** Clock override (POSIX ms) — pass `emulator.now()` in emulator tests. */
  currentTime?: bigint;
};

export const unsignedReclaimEscrowV2TxProgram = (
  lucid: LucidEvolution,
  config: ReclaimEscrowV2Config,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { utxo: escrowUtxo, datum } = yield* resolveEscrowV2(
      lucid,
      config.stateTokenName,
    );
    const stateUnit = stateUnitOf(config.stateTokenName);
    if (datum.timeout_policy !== "RefundToFunder") {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "stateTokenName",
          message:
            "this escrow auto-releases to the beneficiary on timeout — the funder's exits are abort or the arbiter",
        }),
      );
    }
    const now = config.currentTime ?? BigInt(Date.now());
    const cure = cureBoundary(datum);
    if (now <= cure) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "stateTokenName",
          message: `the cure window is still open until ${cure} — reclaim opens strictly after`,
        }),
      );
    }
    const disputeGate =
      datum.dispute !== null && datum.dispute.milestone === datum.released_count
        ? datum.dispute.until
        : 0n;

    const network = lucid.config().network ?? "Preprod";
    const funderAddress = yield* fromOnchainAddress(network, datum.funder);

    const refundAssets: Assets = { ...escrowUtxo.assets };
    delete refundAssets[stateUnit];

    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            ReclaimV2: {
              escrow_input_index: inputIndices[0],
              refund_index: 0n,
            },
          },
          EscrowV2SpendRedeemer,
        ),
      inputs: [escrowUtxo],
    };

    const validFrom = Number(
      (cure > disputeGate ? cure : disputeGate) + 1_000n,
    );

    const baseTx = lucid
      .newTx()
      .collectFrom([escrowUtxo], redeemer)
      .attach.SpendingValidator(escrowV2Validator.spendEscrow)
      .mintAssets(
        { [stateUnit]: -1n },
        Data.to("BurnEscrowV2", EscrowV2MintRedeemer),
      )
      .attach.MintingPolicy(escrowV2Validator.mintEscrow)
      .pay.ToAddress(funderAddress, refundAssets)
      .validFrom(validFrom);

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
            operation: "reclaimEscrowV2",
            error: String(e),
          }),
      ),
    );
  });

export const reclaimEscrow = (
  lucid: LucidEvolution,
  config: ReclaimEscrowV2Config,
) => makeReturn(unsignedReclaimEscrowV2TxProgram(lucid, config));
