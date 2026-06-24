import { LucidEvolution, TxSignBuilder } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { DcuError, TransactionBuildError } from "../core/errors.js";
import { assetNameLabels, resolveUtxoByUnit } from "../core/utils/index.js";
import { Protocol } from "../core/validators/constants.js";

/**
 * Configuration for transferring the group admin token to a new destination.
 *
 * @property groupTokenSuffix    - Permanent 28-byte (56 hex-char) CIP-68 suffix identifying the group.
 * @property destinationAddress  - Bech32 address to receive the admin `222` token. May be a VK
 *                                 delegate address or a native multisig script address produced
 *                                 by {@link buildMultisig}.
 */
export type AssignAdminConfig = {
  groupTokenSuffix: string;
  destinationAddress: string;
};

/**
 * Creates an unsigned transaction that transfers the group `222` admin token from
 * the current wallet to `destinationAddress`.
 *
 * This is a plain bearer-token transfer — no group validator is invoked. The admin
 * authority follows the token, so after this tx the `destinationAddress` (or its
 * co-signers, for a multisig) controls all admin operations on the group.
 *
 * **Typical flow:**
 * 1. Creator holds the `222` admin token in their VK wallet after `createGroup`.
 * 2. Call `buildMultisig` to derive a native multisig address.
 * 3. Call `assignAdmin` with that address to delegate admin authority to the multisig.
 *
 * @param protocol - Deployment protocol context (validators / policy IDs).
 * @param lucid    - Lucid instance with the admin wallet selected.
 * @param config   - {@link AssignAdminConfig}.
 * @returns Effect yielding a TxSignBuilder ready for signing and submission.
 */
export const unsignedAssignAdminTxProgram = (
  protocol: Protocol,
  lucid: LucidEvolution,
  config: AssignAdminConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { groupPolicyId } = protocol;
    const { groupTokenSuffix, destinationAddress } = config;

    const adminUnit =
      groupPolicyId + assetNameLabels.prefix222 + groupTokenSuffix;

    const adminUtxo = yield* resolveUtxoByUnit(lucid, adminUnit);

    const tx = yield* lucid
      .newTx()
      .collectFrom([adminUtxo])
      .pay.ToAddress(destinationAddress, { [adminUnit]: 1n })
      .completeProgram()
      .pipe(
        Effect.mapError(
          (e) =>
            new TransactionBuildError({
              operation: "assignAdmin",
              error: String(e),
            }),
        ),
      );

    return tx;
  });
