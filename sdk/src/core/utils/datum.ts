import { Data } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { InvalidDatumError } from "../errors.js";

/**
 * General-purpose utility functions for the DCU SDK.
 */

/**
 * Safely parses a UTxO inline datum string into a typed value.
 *
 * Returns an Effect that succeeds with the parsed datum or fails with
 * InvalidDatumError — keeping datum decoding consistent with the rest
 * of the SDK's Effect-based error model.
 *
 * @param datum - The raw inline datum string (or null/undefined if absent).
 * @param datumType - The Lucid/Data schema to decode against.
 * @returns Effect yielding the parsed datum or InvalidDatumError.
 *
 * @example
 * ```typescript
 * const datum = yield* parseSafeDatum(utxo.datum, TreasuryDatum);
 * ```
 */
export const parseSafeDatum = <T>(
  datum: string | null | undefined,
  datumType: T,
): Effect.Effect<T, InvalidDatumError> => {
  if (!datum) {
    return Effect.fail(
      new InvalidDatumError({ field: "datum", reason: "missing datum" }),
    );
  }
  return Effect.try({
    try: () => Data.from(datum, datumType),
    catch: (error) =>
      new InvalidDatumError({
        field: "datum",
        reason: `invalid datum: ${error}`,
      }),
  });
};
