import { UTxO } from "@lucid-evolution/lucid";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils";
import { sha3_256 } from "@noble/hashes/sha3";
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
};

/**
 * Generates a unique asset name based on an input UTxO using SHA3-256.
 * 
 * This ensures that assets minted in different transactions have unique names
 * even if they use the same minting policy.
 * 
 * @param utxo - The UTxO being spent to seed the uniqueness.
 * @param prefixHex - The CIP-68 label prefix (hex).
 * @returns Effect yielding a 32-byte hex string asset name.
 */
export const generateUniqueAssetName = (utxo: UTxO, prefixHex: string): Effect.Effect<string> => 
    Effect.sync(() => {
        const txIdHash = sha3_256(hexToBytes(utxo.txHash));
        const indexByte = new Uint8Array([utxo.outputIndex]);
        const concatIndex = concatBytes(indexByte, txIdHash);
        const concatPrefix = concatBytes(hexToBytes(prefixHex), concatIndex);
        return bytesToHex(concatPrefix.slice(0, 32));
    });

/**
 * Creates a standard pair of CIP-68 token names from a seed UTxO.
 * 
 * Generates both the Reference (100) and User (222) token names.
 * 
 * @param utxo - The seed UTxO.
 * @returns Effect yielding both token names.
 */
export const createCip68TokenNames = (utxo: UTxO): Effect.Effect<{ refTokenName: string, userTokenName: string }> => 
    Effect.gen(function* () {
        const refTokenName = yield* generateUniqueAssetName(utxo, assetNameLabels.prefix100);
        const userTokenName = yield* generateUniqueAssetName(utxo, assetNameLabels.prefix222);
        return { refTokenName, userTokenName };
    });

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
    tokenName: string
): Effect.Effect<UTxO, UtxoNotFoundError> => {
    const assetId = policyId + tokenName;
    const found = utxos.find((utxo) => utxo.assets[assetId] && utxo.assets[assetId] >= 1n);
    return found ? Effect.succeed(found) : Effect.fail(new UtxoNotFoundError({ tokenName, address: "UTxO Set" }));
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
    policyId: string
): Effect.Effect<Cip68TokenPair, UtxoNotFoundError> => 
    Effect.gen(function* () {
        let userTokenName = "";
        const userUtxo = utxos.find(u => 
            Object.entries(u.assets).find(([k, v]) => {
                if (v === 1n && k.startsWith(policyId)) {
                    const tn = k.slice(policyId.length);
                    if (tn.startsWith(assetNameLabels.prefix222)) {
                        userTokenName = tn;
                        return true;
                    }
                }
                return false;
            })
        );

        if (!userUtxo) {
            return yield* Effect.fail(new UtxoNotFoundError({ tokenName: "CIP-68 User Token", address: "UTxO Set" }));
        }

        const suffix = userTokenName.slice(assetNameLabels.prefix222.length);
        const refTokenName = assetNameLabels.prefix100 + suffix;

        const refUtxo = utxos.find(u => 
            Object.keys(u.assets).includes(policyId + refTokenName)
        );

        if (!refUtxo) {
             return yield* Effect.fail(new UtxoNotFoundError({ tokenName: "CIP-68 Reference Token", address: "UTxO Set" }));
        }

        return { userUtxo, userTokenName, refUtxo, refTokenName };
    });

