import {
  LucidEvolution,
  Script,
  scriptFromNative,
  validatorToAddress,
  validatorToScriptHash,
  mintingPolicyToId,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { ConfigurationError, DcuError } from "../errors.js";

/**
 * Configuration for a native `atLeast M of N` multisig script.
 *
 * @property signers  - Payment key hashes (28-byte / 56 hex-char) of the co-signers.
 * @property required - Minimum number of signatures required (M). Must satisfy
 *                      1 <= required <= signers.length.
 */
export type MultisigConfig = {
  signers: string[];
  required: number;
};

/**
 * The result of building a native multisig script.
 *
 * @property script     - The Lucid `Script` (type "Native").
 * @property address    - Enterprise (stakeless) bech32 address derived from the script,
 *                        at the network of the supplied `LucidEvolution` instance.
 * @property policyHash - The 56 hex-char script hash. Useful as a minting-policy ID or
 *                        for recording the script identity off-chain.
 */
export type BuiltMultisig = {
  script: Script;
  address: string;
  policyHash: string;
};

/**
 * Constructs a validated native `atLeast M of N` multisig script and its enterprise address.
 *
 * Validates:
 * - `signers` must be non-empty.
 * - `required` must be >= 1.
 * - `required` must be <= `signers.length`.
 *
 * @param lucid - Active `LucidEvolution` instance; its network determines the address prefix.
 * @param cfg   - `MultisigConfig` containing `signers` and `required`.
 * @returns `Effect` yielding `BuiltMultisig`, failing with `ConfigurationError` on invalid input.
 */
export const buildMultisig = (
  lucid: LucidEvolution,
  cfg: MultisigConfig,
): Effect.Effect<BuiltMultisig, DcuError> => {
  const { signers, required } = cfg;

  if (signers.length === 0) {
    return Effect.fail(
      new ConfigurationError({
        configKey: "signers",
        message: "signers must not be empty",
      }),
    );
  }

  if (!Number.isInteger(required)) {
    return Effect.fail(
      new ConfigurationError({
        configKey: "required",
        message: `required must be an integer, got ${required}`,
      }),
    );
  }

  if (required < 1) {
    return Effect.fail(
      new ConfigurationError({
        configKey: "required",
        message: `required must be >= 1, got ${required}`,
      }),
    );
  }

  if (required > signers.length) {
    return Effect.fail(
      new ConfigurationError({
        configKey: "required",
        message: `required (${required}) must not exceed signers.length (${signers.length})`,
      }),
    );
  }

  return Effect.sync(() => {
    const network = lucid.config().network ?? "Custom";

    const script = scriptFromNative({
      type: "atLeast",
      required,
      scripts: signers.map((keyHash) => ({ type: "sig", keyHash })),
    });

    // validatorToAddress produces an enterprise address (no stake credential)
    const address = validatorToAddress(network, script);

    // mintingPolicyToId and validatorToScriptHash both return the 28-byte script hash;
    // use mintingPolicyToId as the canonical name for the "policy hash" role.
    const policyHash = mintingPolicyToId(script);

    return { script, address, policyHash };
  });
};
