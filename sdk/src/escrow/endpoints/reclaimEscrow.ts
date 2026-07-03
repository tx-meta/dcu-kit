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
} from "../../core/errors.js";
import { makeReturn } from "../../core/utils/index.js";
import {
  EscrowMintRedeemer,
  EscrowSpendRedeemer,
  fromOnchainAddress,
} from "../types.js";
import { escrowPolicyId, escrowValidator } from "../validators.js";
import { applyPartyWitness, PartyWitness, resolveEscrow } from "../utils.js";

/**
 * Creates an unsigned transaction reclaiming an expired escrow's remaining
 * balance to the funder. Only valid strictly after `expiry`.
 *
 * **Functionality:**
 * - Pays the full remaining balance (all remaining assets except the state token)
 *   to the funder's full address from the datum.
 * - Burns the state token; the escrow ends.
 * - VK funder: the endpoint adds the required signer. Script funder (multisig):
 *   pass `funderWitness` (dust-UTxO authorization, as in releaseMilestone).
 *
 * @param lucid - Lucid instance (pays the fee; the funder must sign).
 * @param config - ReclaimEscrowConfig.
 * @returns Effect yielding TxSignBuilder.
 */
export type ReclaimEscrowConfig = {
  /** The escrow's permanent identity (returned by createEscrow). */
  stateTokenName: string;
  /** Required when the funder credential is a script hash. */
  funderWitness?: PartyWitness;
  /** Clock override (POSIX ms) — pass `emulator.now()` in emulator tests. */
  currentTime?: bigint;
};

export const unsignedReclaimEscrowTxProgram = (
  lucid: LucidEvolution,
  config: ReclaimEscrowConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { utxo: escrowUtxo, datum } = yield* resolveEscrow(
      lucid,
      config.stateTokenName,
    );
    const stateUnit = escrowPolicyId + config.stateTokenName;

    const now = config.currentTime ?? BigInt(Date.now());
    if (now <= datum.expiry) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "expiry",
          message: `escrow expires at ${datum.expiry}; reclaim opens strictly after`,
        }),
      );
    }

    const network = lucid.config().network ?? "Preprod";
    const funderAddress = yield* fromOnchainAddress(network, datum.funder);

    const refundAssets: Assets = { ...escrowUtxo.assets };
    delete refundAssets[stateUnit];

    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            Reclaim: {
              escrow_input_index: inputIndices[0],
              refund_index: 0n,
            },
          },
          EscrowSpendRedeemer,
        ),
      inputs: [escrowUtxo],
    };

    // Reclaim requires a pinned lower bound strictly above expiry. One full slot
    // past it — ms-to-slot conversion floors, and a bound that floors back to
    // exactly expiry fails the strict on-chain check.
    const validFrom = Number(datum.expiry + 1_000n);

    const baseTx = lucid
      .newTx()
      .collectFrom([escrowUtxo], redeemer)
      .attach.SpendingValidator(escrowValidator.spendEscrow)
      .mintAssets({ [stateUnit]: -1n }, Data.to("BurnEscrow", EscrowMintRedeemer))
      .attach.MintingPolicy(escrowValidator.mintEscrow)
      .pay.ToAddress(funderAddress, refundAssets)
      .validFrom(validFrom);

    const withWitness = yield* applyPartyWitness(
      lucid,
      baseTx,
      datum.funder.payment_credential,
      config.funderWitness,
      "funder",
    );

    const tx = yield* withWitness.completeProgram().pipe(
      Effect.mapError(
        (e) =>
          new TransactionBuildError({
            operation: "reclaimEscrow",
            error: String(e),
          }),
      ),
    );

    return tx;
  });

export const reclaimEscrow = (
  lucid: LucidEvolution,
  config: ReclaimEscrowConfig,
) => makeReturn(unsignedReclaimEscrowTxProgram(lucid, config));
