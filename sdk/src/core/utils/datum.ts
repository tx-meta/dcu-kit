import { Constr, Data } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { GroupDatum } from "../types.js";
import { InvalidDatumError } from "../errors.js";

/**
 * Safely parses a UTxO inline datum string into a typed value.
 * Returns an Effect that succeeds with the parsed datum or fails with
 * InvalidDatumError — keeping datum decoding consistent with the rest
 * of the SDK's Effect-based error model.
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

export type GroupCip68Parts = {
  metadata: Data;
  version: bigint;
  groupDatum: GroupDatum;
};

/**
 * Parses a GroupCip68Datum from an inline datum hex string.
 *
 * The on-chain structure is Constr(0, [metadata_map, version, GroupDatum]).
 * Rather than nesting Data.Object schemas (which Lucid Evolution does not
 * recursively deserialise), this function extracts the three fields positionally
 * and re-parses the GroupDatum independently.
 */
export const parseGroupCip68Datum = (
  datum: string | null | undefined,
): Effect.Effect<GroupCip68Parts, InvalidDatumError> =>
  Effect.try({
    try: () => {
      if (!datum) throw new Error("missing datum");
      const outer = Data.from(datum) as Constr<Data>;
      const groupDatumHex = Data.to(outer.fields[2]);
      return {
        metadata: outer.fields[0],
        version: outer.fields[1] as bigint,
        groupDatum: Data.from(groupDatumHex, GroupDatum),
      };
    },
    catch: (error) =>
      new InvalidDatumError({
        field: "datum",
        reason: `invalid GroupCip68Datum: ${error}`,
      }),
  });

/**
 * Builds a GroupCip68Datum hex string from its component parts.
 *
 * Reconstructs Constr(0, [metadata, version, GroupDatum]), preserving the
 * original metadata and version from the input UTxO through all state transitions.
 */
export const buildGroupCip68Datum = (
  metadata: Data,
  version: bigint,
  groupDatum: GroupDatum,
): string => {
  const groupDatumHex = Data.to(groupDatum, GroupDatum);
  const groupDatumData = Data.from(groupDatumHex);
  return Data.to(new Constr(0, [metadata, version, groupDatumData]));
};
