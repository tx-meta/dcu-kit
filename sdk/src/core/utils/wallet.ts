
import { LucidEvolution, UTxO, fromText } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { LucidError } from "../errors.js";
import { DcuValidators } from "../validators/context.js";

/**
 * Utility for wallet-related operations (UTxO management, address resolution, wallet selection).
 */

/**
 * Fetches all UTxOs for the currently selected wallet.
 * 
 * @param lucid - The active Lucid instance.
 * @returns Effect yielding an array of UTxOs.
 */
export const getWalletUtxos = (
  lucid: LucidEvolution
): Effect.Effect<UTxO[], LucidError, never> =>
  Effect.tryPromise({
    try: () => lucid.wallet().getUtxos(),
    catch: (error) => new LucidError({ message: "Failed to get wallet UTxOs", cause: error })
  });

/**
 * Resolves the primary address of the currently selected wallet.
 * 
 * @param lucid - The active Lucid instance.
 * @returns Effect yielding the address string.
 */
export const getWalletAddress = (
  lucid: LucidEvolution
): Effect.Effect<string, LucidError, never> =>
  Effect.tryPromise({
    try: () => lucid.wallet().address(),
    catch: (error) => new LucidError({ message: "Failed to get wallet address", cause: error })
  });

/**
 * Selects a wallet for the session from a BIP-39 seed phrase.
 * 
 * @param lucid - The active Lucid instance.
 * @param seedPhrase - The 12 or 24 word mnemonic.
 */
export const selectWalletFromSeed = (
  lucid: LucidEvolution,
  seedPhrase: string
): void => {
  lucid.selectWallet.fromSeed(seedPhrase);
};

/**
 * Fetches all UTxOs currently locked at a specific address (e.g. Validator or User).
 * 
 * @param lucid - The active Lucid instance.
 * @param address - The Cardano address to query.
 * @returns Effect yielding an array of UTxOs.
 */
export const getUtxosAt = (
  lucid: LucidEvolution,
  address: string
): Effect.Effect<UTxO[], LucidError, never> =>
  Effect.tryPromise({
    try: () => lucid.utxosAt(address),
    catch: (error) => new LucidError({ message: `Failed to get UTxOs at ${address}`, cause: error })
  });

/**
 * Deterministically sorts a set of UTxOs by Transaction Hash and Output Index.
 * 
 * Useful for ensuring consistent input ordering in transaction construction.
 * 
 * @param utxos - The set of UTxOs to sort.
 * @returns A new array of sorted UTxOs.
 */
export const sortUtxos = (utxos: UTxO[]): UTxO[] => {
    return [...utxos].sort((a, b) => {
        if (a.txHash < b.txHash) return -1;
        if (a.txHash > b.txHash) return 1;
        return a.outputIndex - b.outputIndex;
    });
};

/**
 * Discovers the active Group Reference UTxO residing in the Group Contract.
 * 
 * Identifies the UTxO that contains the "GroupReference" CIP-68 Reference NFT.
 * 
 * @param lucid - The active Lucid instance.
 * @param scripts - The validator context to resolve addresses and policy IDs.
 * @returns Effect yielding the Group UTxO, or undefined if not found.
 */
export const findGroupReferenceUtxo = (
    lucid: LucidEvolution,
    scripts: DcuValidators
): Effect.Effect<UTxO | undefined, LucidError, never> => 
    Effect.tryPromise({
        try: async () => {
            const groupScriptAddr = scripts.group.spend.address;
            const groupUtxos = await lucid.utxosAt(groupScriptAddr);
            const groupName = fromText("GroupReference");
            return groupUtxos.find(u => Object.keys(u.assets).some(k => k.includes(groupName)));
        },
        catch: (error) => new LucidError({ message: "Failed to find Group Reference UTxO", cause: error })
    });


