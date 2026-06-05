import { Constr, Data, fromText, toText } from "@lucid-evolution/lucid";
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
 * Decodes the CIP-68 display metadata of a group into plain text fields.
 *
 * The metadata is an on-chain `Pairs<ByteArray, ByteArray>` (UTF-8 key → UTF-8 value),
 * which Lucid deserialises to a `Map` of hex→hex. This reads the standard `name` and
 * optional `description` keys back as UTF-8 strings. Unknown keys are ignored.
 */
export const decodeGroupMetadata = (
  metadata: Data,
): { name?: string; description?: string } => {
  const result: { name?: string; description?: string } = {};
  if (!(metadata instanceof Map)) return result;
  const read = (key: string): string | undefined => {
    const value = (metadata as Map<unknown, unknown>).get(fromText(key));
    return typeof value === "string" ? toText(value) : undefined;
  };
  const name = read("name");
  const description = read("description");
  if (name !== undefined) result.name = name;
  if (description !== undefined) result.description = description;
  return result;
};

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
