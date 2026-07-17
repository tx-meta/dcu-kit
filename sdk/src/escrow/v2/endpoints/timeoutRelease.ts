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
import { EscrowV2SpendRedeemer } from "../types.js";
import { escrowV2Validator } from "../validators.js";
import { cureBoundary, resolveEscrowV2 } from "../utils.js";
import { applyTrancheOutputs, stateUnitOf } from "./tranche.js";

/**
 * Creates an unsigned transaction auto-releasing an OVERDUE milestone tranche
 * to the beneficiary — "silence approves". Only for escrows created with
 * `timeoutPolicy: "ReleaseToBeneficiary"`; valid strictly after the milestone's
 * cure boundary; requires NO party signature (the payout destination is fixed
 * by the datum, so anyone may crank — typically the beneficiary).
 *
 * @param lucid - Lucid instance with the crank wallet selected (pays the fee).
 * @param config - TimeoutReleaseConfig.
 * @returns Effect yielding TxSignBuilder.
 */
export type TimeoutReleaseConfig = {
  /** The escrow's permanent identity (returned by createEscrow). */
  stateTokenName: string;
  /** Clock override (POSIX ms) — pass `emulator.now()` in emulator tests. */
  currentTime?: bigint;
};

export const unsignedTimeoutReleaseTxProgram = (
  lucid: LucidEvolution,
  config: TimeoutReleaseConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { utxo: escrowUtxo, datum } = yield* resolveEscrowV2(
      lucid,
      config.stateTokenName,
    );
    const stateUnit = stateUnitOf(config.stateTokenName);
    if (datum.timeout_policy !== "ReleaseToBeneficiary") {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "stateTokenName",
          message:
            "this escrow refunds the funder on timeout — auto-release is not enabled",
        }),
      );
    }
    const now = config.currentTime ?? BigInt(Date.now());
    const cure = cureBoundary(datum);
    if (now <= cure) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "stateTokenName",
          message: `the cure window is still open until ${cure} — the verifier decides for now`,
        }),
      );
    }
    const disputeGate =
      datum.dispute !== null && datum.dispute.milestone === datum.released_count
        ? datum.dispute.until
        : 0n;

    const redeemer = (indices: {
      continuation_index: bigint;
      payout_index: bigint;
      funder_index: bigint;
    }): RedeemerBuilder => ({
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            TimeoutReleaseV2: {
              escrow_input_index: inputIndices[0],
              ...indices,
            },
          },
          EscrowV2SpendRedeemer,
        ),
      inputs: [escrowUtxo],
    });

    const network = lucid.config().network ?? "Preprod";
    // Timeout requires a pinned lower bound strictly past the cure boundary
    // (and past any dispute freeze).
    const validFrom = Number(
      (cure > disputeGate ? cure : disputeGate) + 1_000n,
    );

    const plan = yield* applyTrancheOutputs(
      network,
      lucid
        .newTx()
        .attach.SpendingValidator(escrowV2Validator.spendEscrow)
        .validFrom(validFrom),
      escrowUtxo,
      datum,
      stateUnit,
    );
    const collected = plan.tx.collectFrom([escrowUtxo], redeemer(plan.indices));

    return yield* collected.completeProgram().pipe(
      Effect.mapError(
        (e) =>
          new TransactionBuildError({
            operation: "timeoutRelease",
            error: String(e),
          }),
      ),
    );
  });

export const timeoutRelease = (
  lucid: LucidEvolution,
  config: TimeoutReleaseConfig,
) => makeReturn(unsignedTimeoutReleaseTxProgram(lucid, config));
