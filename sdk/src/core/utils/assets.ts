import { UTxO, Data, Constr } from "@lucid-evolution/lucid";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils";
import { blake2b } from "@noble/hashes/blake2";
import { Effect } from "effect";
import { UtxoNotFoundError } from "../errors.js";

/**
 * Utility for generating and discovering CIP-68 assets.
 *
 * CIP-68 uses standardized labels as prefixes to distinguish between
 * different types of assets (Reference NFT, User Auth, etc.) using the same base name.
 */
export const assetNameLabels = {
  prefix100: "000643b0", // Reference NFT (held by script)
  prefix222: "000de140", // User/Auth NFT (held by user)
  prefix333: "0014df10", // Royalty NFT
  prefix444: "001bc280", // Other NFT
  prefixRsv: "52535645", // ASCII "RSVE" — mutual reserve identity (treasury policy)
};

/**
 * Generates a unique CIP-68 asset name from a seed UTxO.
 *
 * Matches the Aiken on-chain algorithm (`dcu/cip68.unique_token_name`):
 *   1. CBOR-serialise OutputReference as Plutus data:
 *      Constr(0, [txHash_bytes, outputIndex_int])
 *      (TransactionId is a ByteArray alias in stdlib v3, not a wrapper Constr)
 *   2. blake2b_256 of the CBOR bytes → 32-byte hash
 *   3. Take the first 28 bytes  (CIP-68 prefix occupies the remaining 4)
 *   4. Prepend the 4-byte CIP-68 label prefix → 32-byte asset name
 *
 * @param utxo      - The UTxO being consumed to seed uniqueness.
 * @param prefixHex - The 4-byte CIP-68 label prefix in hex (e.g. "000643b0" for ref).
 * @returns Effect yielding a 32-byte hex string asset name.
 */
export const generateUniqueAssetName = (
  utxo: UTxO,
  prefixHex: string,
): Effect.Effect<string> =>
  Effect.sync(() => {
    // Matches Aiken's `cbor.serialise(OutputReference { transaction_id, output_index })`.
    // OutputReference serialises as Plutus data: Constr(0, [ByteArray(txHash), Int(outputIndex)]).
    // TransactionId is a ByteArray alias in stdlib v3 (not a nested Constr wrapper).
    // Data.to() produces the correct Plutus-data CBOR (tag 0xD879 + indefinite array).
    const outputRefCbor = Data.to(
      new Constr(0, [utxo.txHash, BigInt(utxo.outputIndex)]),
    );

    // blake2b_256 → 32-byte hash, take first 28 bytes.
    // JS .slice(0, 28) is exclusive-end = 28 bytes.
    // Matches Aiken: bytearray.slice(hash, 0, 27) which is inclusive-end = 28 bytes.
    const hash = blake2b(hexToBytes(outputRefCbor), { dkLen: 32 });
    const chopped = hash.slice(0, 28);
    return bytesToHex(concatBytes(hexToBytes(prefixHex), chopped));
  });

/**
 * Creates a standard pair of CIP-68 token names from a seed UTxO.
 *
 * Generates both the Reference (100) and User (222) token names.
 *
 * @param utxo - The seed UTxO.
 * @returns Effect yielding both token names.
 */
export const createCip68TokenNames = (
  utxo: UTxO,
): Effect.Effect<{ refTokenName: string; userTokenName: string }> =>
  Effect.gen(function* () {
    const refTokenName = yield* generateUniqueAssetName(
      utxo,
      assetNameLabels.prefix100,
    );
    const userTokenName = yield* generateUniqueAssetName(
      utxo,
      assetNameLabels.prefix222,
    );
    return { refTokenName, userTokenName };
  });

/**
 * Derives the group's mutual-reserve token name from its (100) ref token name.
 *
 * Matches the Aiken helper (`dcu/cip68.convert_ref_to_reserve_token`):
 * `"RSVE" (52535645) + the ref token's 28-byte unique part`. The reserve token
 * lives under the TREASURY policy (unlike the 100/222 pair) and is the permanent
 * identity of the group's ReserveState UTxO.
 *
 * @param groupRefTokenName - The group's (100) ref token name (64 hex chars).
 * @returns The 32-byte reserve token name (hex).
 */
export const reserveTokenName = (groupRefTokenName: string): string =>
  assetNameLabels.prefixRsv + groupRefTokenName.slice(8);

/**
 * Finds a UTxO containing at least one of the specified token.
 *
 * @param utxos - The set of UTxOs to search.
 * @param policyId - The minting policy ID.
 * @param tokenName - The asset name (hex).
 * @returns Effect yielding the found UTxO or UtxoNotFoundError.
 */
export const findUtxoWithToken = (
  utxos: UTxO[],
  policyId: string,
  tokenName: string,
): Effect.Effect<UTxO, UtxoNotFoundError> => {
  const assetId = policyId + tokenName;
  const found = utxos.find(
    (utxo) => utxo.assets[assetId] && utxo.assets[assetId] >= 1n,
  );
  return found
    ? Effect.succeed(found)
    : Effect.fail(new UtxoNotFoundError({ tokenName, address: "UTxO Set" }));
};

export type Cip68TokenPair = {
  userUtxo: UTxO;
  userTokenName: string;
  refUtxo: UTxO;
  refTokenName: string;
};

/**
 * Discovers a linked pair of CIP-68 Reference and User tokens in a UTxO set.
 *
 * It searches for a token with the (222) prefix first, and then looks for its
 * corresponding (100) partner based on the shared suffix.
 *
 * @param utxos - Combined set of wallet and script UTxOs.
 * @param policyId - The policy ID to search within.
 * @returns Effect yielding the discovered pair or UtxoNotFoundError.
 *
 * @example
 * ```typescript
 * const pair = yield* findCip68TokenPair(allUtxos, accountPolicyId);
 * console.log(pair.userTokenName, pair.refTokenName);
 * ```
 */
export const findCip68TokenPair = (
  utxos: UTxO[],
  policyId: string,
): Effect.Effect<Cip68TokenPair, UtxoNotFoundError> =>
  Effect.gen(function* () {
    let userTokenName = "";
    const userUtxo = utxos.find((u) =>
      Object.entries(u.assets).find(([k, v]) => {
        if (v === 1n && k.startsWith(policyId)) {
          const tn = k.slice(policyId.length);
          if (tn.startsWith(assetNameLabels.prefix222)) {
            userTokenName = tn;
            return true;
          }
        }
        return false;
      }),
    );

    if (!userUtxo) {
      return yield* Effect.fail(
        new UtxoNotFoundError({
          tokenName: "CIP-68 User Token",
          address: "UTxO Set",
        }),
      );
    }

    const suffix = userTokenName.slice(assetNameLabels.prefix222.length);
    const refTokenName = assetNameLabels.prefix100 + suffix;

    const refUtxo = utxos.find((u) =>
      Object.keys(u.assets).includes(policyId + refTokenName),
    );

    if (!refUtxo) {
      return yield* Effect.fail(
        new UtxoNotFoundError({
          tokenName: "CIP-68 Reference Token",
          address: "UTxO Set",
        }),
      );
    }

    return { userUtxo, userTokenName, refUtxo, refTokenName };
  });

/**
 * Removes a member's registry entry AND its same-index slot entry (parallel lists,
 * mirroring the on-chain `remove_paired`). The slot map may be empty (pre-start or
 * recommit window) — then only the name is removed and the map stays empty.
 */
export const removeRegistryEntry = (
  names: string[],
  slots: bigint[],
  target: string,
): { names: string[]; slots: bigint[] } => {
  const ix = names.indexOf(target);
  if (ix === -1) return { names, slots };
  return {
    names: names.filter((_, i) => i !== ix),
    slots: slots.length > 0 ? slots.filter((_, i) => i !== ix) : slots,
  };
};
