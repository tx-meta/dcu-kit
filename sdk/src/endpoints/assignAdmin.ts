import {
  getAddressDetails,
  LucidEvolution,
  Script,
  TxSignBuilder,
  validatorToScriptHash,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import {
  ConfigurationError,
  DcuError,
  TransactionBuildError,
} from "../core/errors.js";
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
  /** Required when destinationAddress is a script address: the script whose hash
   *  must match the destination's payment credential. Proves the sender holds the
   *  spending preimage of where the authority token is going — a script address
   *  that nobody can spend from would lose admin authority permanently. */
  destinationScript?: Script;
  /** Skips destination verification. The transfer is a one-way door; only use
   *  this when the destination script is intentionally not at hand. */
  force?: boolean;
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

    if (!config.force) {
      const details = yield* Effect.try({
        try: () => getAddressDetails(destinationAddress),
        catch: () =>
          new ConfigurationError({
            configKey: "destinationAddress",
            message: `not a valid address: ${destinationAddress}`,
          }),
      });
      const payCred = details.paymentCredential;
      if (!payCred) {
        return yield* Effect.fail(
          new ConfigurationError({
            configKey: "destinationAddress",
            message: "address has no payment credential",
          }),
        );
      }
      if (payCred.type === "Script") {
        if (!config.destinationScript) {
          return yield* Effect.fail(
            new ConfigurationError({
              configKey: "destinationScript",
              message:
                "destination is a script address; pass destinationScript proving it is spendable, or force: true",
            }),
          );
        }
        if (validatorToScriptHash(config.destinationScript) !== payCred.hash) {
          return yield* Effect.fail(
            new ConfigurationError({
              configKey: "destinationScript",
              message:
                "destinationScript hash does not match the destination address payment credential",
            }),
          );
        }
      }
    }

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
