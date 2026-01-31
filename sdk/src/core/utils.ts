import { 
    LucidEvolution, 
    Script, 
    validatorToAddress, 
    validatorToScriptHash, 
    UTxO,
    TxSignBuilder,
    Data,
    Constr,
    fromText
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { DcuValidators } from "./validators/context.js";
import { LucidError, DcuError, TransactionBuildError } from "./errors.js";

// Simple hex conversion helpers (Lucid v0.10 style compatibility or general usage)
export const fromHex = (hex: string): Uint8Array => Buffer.from(hex, "hex");
export const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

// --- General Utilities ---

export const getScriptAddress = (lucid: LucidEvolution, script: Script): Effect.Effect<string, DcuError> => {
    return Effect.try({
        try: () => {
             const network = lucid.config().network || "Custom";
             return validatorToAddress(network, script);
        },
        catch: (error) => new TransactionBuildError({ operation: "getScriptAddress", error: String(error) })
    });
};

export const getScriptHash = (lucid: LucidEvolution, script: Script): string => {
    return validatorToScriptHash(script);
}

export const findUtxoWithToken = (
    utxos: UTxO[],
    policyId: string,
    tokenName: string
): UTxO | undefined => {
    const assetId = policyId + tokenName;
    return utxos.find((utxo) => utxo.assets[assetId] && utxo.assets[assetId] >= 1n);
};

export const sortUtxos = (utxos: UTxO[]): UTxO[] => {
    return [...utxos].sort((a, b) => {
        if (a.txHash < b.txHash) return -1;
        if (a.txHash > b.txHash) return 1;
        return a.outputIndex - b.outputIndex;
    });
};

// --- Wallet Utilities ---

export const getWalletUtxos = (
  lucid: LucidEvolution
): Effect.Effect<UTxO[], LucidError, never> =>
  Effect.tryPromise({
    try: () => lucid.wallet().getUtxos(),
    catch: (error) => new LucidError({ message: "Failed to get wallet UTxOs", cause: error })
  });

export const getWalletAddress = (
  lucid: LucidEvolution
): Effect.Effect<string, LucidError, never> =>
  Effect.tryPromise({
    try: () => lucid.wallet().address(),
    catch: (error) => new LucidError({ message: "Failed to get wallet address", cause: error })
  });

export const selectWalletFromSeed = (
  lucid: LucidEvolution,
  seedPhrase: string
): void => {
  lucid.selectWallet.fromSeed(seedPhrase);
};

export const getUtxosAt = (
  lucid: LucidEvolution,
  address: string
): Effect.Effect<UTxO[], LucidError, never> =>
  Effect.tryPromise({
    try: () => lucid.utxosAt(address),
    catch: (error) => new LucidError({ message: `Failed to get UTxOs at ${address}`, cause: error })
  });

// --- Transaction Utilities ---

export const signAndSubmit = (
  tx: TxSignBuilder
): Effect.Effect<string, LucidError, never> =>
  Effect.gen(function* () {
    const signed = yield* Effect.tryPromise({
      try: () => tx.sign.withWallet().complete(),
      catch: (error) => new LucidError({ message: "Failed to sign transaction", cause: error })
    });
    const txHash = yield* Effect.tryPromise({
      try: () => signed.submit(),
      catch: (error) => new LucidError({ message: "Failed to submit transaction", cause: error })
    });
    return txHash;
  });

export const tryBuildTx = (
  operation: string,
  f: () => Promise<TxSignBuilder>
): Effect.Effect<TxSignBuilder, TransactionBuildError> =>
  Effect.tryPromise({
    try: f,
    catch: (error) => new TransactionBuildError({ operation, error: String(error) }),
  });

// --- Redeemer Utilities ---

export const buildGroupMintRedeemer = {
  createGroup: (): string => {
    return Data.to(new Constr(0, []));
  },
};

export const buildGroupSpendRedeemer = {
  updateGroup: (
    tokenName: string,
    adminInputIndex: bigint,
    groupInputIndex: bigint,
    groupOutputIndex: bigint
  ): string => {
    return Data.to(
      new Constr(1, [
        fromText(tokenName),
        adminInputIndex,
        groupInputIndex,
        groupOutputIndex,
      ])
    );
  },

  removeGroup: (
    tokenName: string,
    adminInputIndex: bigint,
    groupInputIndex: bigint,
    groupOutputIndex: bigint
  ): string => {
    return Data.to(
      new Constr(2, [
        fromText(tokenName),
        adminInputIndex,
        groupInputIndex,
        groupOutputIndex,
      ])
    );
  },
};

export const buildAccountSpendRedeemer = {
  updateAccount: (
    tokenName: string,
    userInputIndex: bigint,
    accountInputIndex: bigint,
    accountOutputIndex: bigint
  ): string => {
    return Data.to(
      new Constr(0, [
        fromText(tokenName),
        userInputIndex,
        accountInputIndex,
        accountOutputIndex,
      ])
    );
  },

  deleteAccount: (
    tokenName: string,
    userInputIndex: bigint,
    accountInputIndex: bigint
  ): string => {
    return Data.to(
      new Constr(1, [fromText(tokenName), userInputIndex, accountInputIndex])
    );
  },
};

// --- Lookup Utilities ---

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

export const findUserTokenUtxo = (
    lucid: LucidEvolution,
    policyId: string,
    tokenNameHex?: string // If null, assume policy prefix check
): Effect.Effect<UTxO | undefined, LucidError, never> => 
    Effect.tryPromise({
        try: async () => {
            const utxos = await lucid.wallet().getUtxos();
            return utxos.find(u => Object.keys(u.assets).some(k => {
                if (tokenNameHex) return k === policyId + tokenNameHex;
                return k.startsWith(policyId);
            }));
        },
        catch: (error) => new LucidError({ message: "Failed to find User Token UTxO", cause: error })
    });
