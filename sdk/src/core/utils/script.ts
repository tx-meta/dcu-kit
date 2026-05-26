import {
  LucidEvolution,
  Script,
  validatorToAddress,
  validatorToScriptHash,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { DcuError, TransactionBuildError } from "../errors.js";

/**
 * Utility for Cardano scripts and hex conversions.
 */

export const fromHex = (hex: string): Uint8Array => Buffer.from(hex, "hex");
export const toHex = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("hex");

/**
 * Derives the Bech32 address for a script (Validator or Minting Policy).
 *
 * Automatically resolves the network context from the Lucid instance.
 *
 * @param lucid - The active Lucid instance.
 * @param script - The Plutus script object.
 * @returns Effect yielding the Bech32 address string.
 */
export const getScriptAddress = (
  lucid: LucidEvolution,
  script: Script,
): Effect.Effect<string, DcuError> => {
  return Effect.try({
    try: () => {
      const network = lucid.config().network || "Custom";
      return validatorToAddress(network, script);
    },
    catch: (error) =>
      new TransactionBuildError({
        operation: "getScriptAddress",
        error: String(error),
      }),
  });
};

/**
 * Derives the blake2b-224 hash (Script Hash) of a script.
 *
 * @param _lucid - The active Lucid instance (unused but kept for consistency).
 * @param script - The Plutus script object.
 * @returns The hex-encoded script hash.
 */
export const getScriptHash = (
  _lucid: LucidEvolution,
  script: Script,
): string => {
  return validatorToScriptHash(script);
};
