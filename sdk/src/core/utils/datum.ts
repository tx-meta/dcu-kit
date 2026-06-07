import { Constr, Data, toText } from "@lucid-evolution/lucid";
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
 * Decodes a raw CIP-68 metadata map (hex→hex) into a plain `Record<string, string>`.
 * Internal primitive shared by {@link getGroupMetadata} and {@link decodeGroupMetadata}.
 * Non-UTF-8 entries are skipped rather than throwing.
 */
const metadataToRecord = (metadata: Data): Record<string, string> => {
  const result: Record<string, string> = {};
  if (!(metadata instanceof Map)) return result;
  for (const [key, value] of metadata as Map<unknown, unknown>) {
    if (typeof key !== "string" || typeof value !== "string") continue;
    try {
      result[toText(key)] = toText(value);
    } catch {
      // skip entries that are not valid UTF-8 hex
    }
  }
  return result;
};

/**
 * Decodes a group's CIP-68 display metadata into a plain `Record<string, string>`.
 *
 * The on-chain metadata is a `Pairs<ByteArray, ByteArray>` (UTF-8 key → UTF-8 value)
 * that Lucid deserialises to a `Map` of hex→hex. This returns every entry decoded to
 * UTF-8 — no Plutus/Lucid types leak to the caller. Keys follow CIP-68 convention
 * (e.g. `"name"`, `"description"`). Malformed entries are skipped, never thrown.
 *
 * Accepts anything carrying a `metadata` field — both the typed {@link GroupCip68Datum}
 * and the {@link GroupCip68Parts} produced by {@link parseGroupCip68Datum}.
 *
 * @example
 * const meta = getGroupMetadata(parts); // { name: "Savings Club", description: "…" }
 */
export const getGroupMetadata = (source: {
  metadata: Data;
}): Record<string, string> => metadataToRecord(source.metadata);

/**
 * Reads a group's display name from its CIP-68 metadata (`metadata["name"]`).
 *
 * Centralises the CIP-68 key lookup and UTF-8 decode so consumers stop reimplementing
 * the `fromText("name")` / `toText()` plumbing. Returns `undefined` when the key is
 * absent (never throws).
 *
 * @example
 * const name = getGroupName(parts); // "Savings Club" | undefined
 */
export const getGroupName = (source: {
  metadata: Data;
}): string | undefined => getGroupMetadata(source)["name"];

/**
 * Decodes the CIP-68 display metadata of a group into the standard `name` and
 * optional `description` fields. Thin convenience over {@link getGroupMetadata}
 * preserved for existing callers; prefer `getGroupMetadata` for arbitrary keys.
 */
export const decodeGroupMetadata = (
  metadata: Data,
): { name?: string; description?: string } => {
  const all = metadataToRecord(metadata);
  const result: { name?: string; description?: string } = {};
  if (all.name !== undefined) result.name = all.name;
  if (all.description !== undefined) result.description = all.description;
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
