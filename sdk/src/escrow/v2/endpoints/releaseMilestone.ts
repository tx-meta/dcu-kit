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
import {
  applyPartyWitness,
  cureBoundary,
  disputeFrozen,
  PartyWitness,
  resolveEscrowV2,
} from "../utils.js";
import { applyTrancheOutputs, stateUnitOf } from "./tranche.js";

/**
 * Creates an unsigned transaction releasing the next milestone tranche to the
 * beneficiary. Verifier-authorized; valid until the milestone's cure boundary
 * (deadline + grace, extended by the dispute window if this milestone was
 * disputed); refused while a dispute freeze is active.
 *
 * Final tranche: burns the state token and returns the remainder (the min-ADA
 * buffer) to the funder — enforced on-chain in v2.
 *
 * @param lucid - Lucid instance with the crank wallet selected (pays the fee).
 * @param config - ReleaseMilestoneV2Config.
 * @returns Effect yielding TxSignBuilder.
 */
export type ReleaseMilestoneV2Config = {
  /** The escrow's permanent identity (returned by createEscrow). */
  stateTokenName: string;
  /** Required when the verifier credential is a script hash. */
  verifierWitness?: PartyWitness;
  /** Clock override (POSIX ms) — pass `emulator.now()` in emulator tests. */
  currentTime?: bigint;
};

export const unsignedReleaseMilestoneV2TxProgram = (
  lucid: LucidEvolution,
  config: ReleaseMilestoneV2Config,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { utxo: escrowUtxo, datum } = yield* resolveEscrowV2(
      lucid,
      config.stateTokenName,
    );
    const stateUnit = stateUnitOf(config.stateTokenName);
    const now = config.currentTime ?? BigInt(Date.now());
    const cure = cureBoundary(datum);
    if (now > cure) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "stateTokenName",
          message:
            "the current milestone's cure window has passed — releases are closed",
        }),
      );
    }
    if (disputeFrozen(datum, now)) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "stateTokenName",
          message: `a dispute freezes this escrow until ${datum.dispute!.until} — resolve it or wait`,
        }),
      );
    }

    const redeemer = (indices: {
      continuation_index: bigint;
      payout_index: bigint;
      funder_index: bigint;
    }): RedeemerBuilder => ({
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            ReleaseV2: { escrow_input_index: inputIndices[0], ...indices },
          },
          EscrowV2SpendRedeemer,
        ),
      inputs: [escrowUtxo],
    });

    const network = lucid.config().network ?? "Preprod";
    const validTo = Number(now + 1_200_000n < cure ? now + 1_200_000n : cure);

    // A lapsed dispute on this milestone requires proving the freeze passed.
    const lapsedDispute =
      datum.dispute !== null &&
      datum.dispute.milestone === datum.released_count &&
      now > datum.dispute.until;

    const plan = yield* applyTrancheOutputs(
      network,
      lucid
        .newTx()
        .attach.SpendingValidator(escrowV2Validator.spendEscrow)
        .validTo(validTo),
      escrowUtxo,
      datum,
      stateUnit,
    );
    const collected = plan.tx.collectFrom([escrowUtxo], redeemer(plan.indices));
    const timed = lapsedDispute
      ? collected.validFrom(Number(datum.dispute!.until + 1_000n))
      : collected;

    const withWitness = yield* applyPartyWitness(
      lucid,
      timed,
      datum.verifier,
      config.verifierWitness,
      "verifier",
    );

    return yield* withWitness.completeProgram().pipe(
      Effect.mapError(
        (e) =>
          new TransactionBuildError({
            operation: "releaseMilestoneV2",
            error: String(e),
          }),
      ),
    );
  });

export const releaseMilestone = (
  lucid: LucidEvolution,
  config: ReleaseMilestoneV2Config,
) => makeReturn(unsignedReleaseMilestoneV2TxProgram(lucid, config));
