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

// --- General Utilities ---

export const getScriptAddress = async (lucid: LucidEvolution, script: Script): Promise<string> => {
    const network = lucid.config().network || "Custom";
    return validatorToAddress(network, script);
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

// --- Wallet Utilities ---

export const getWalletUtxos = (
  lucid: LucidEvolution
): Effect.Effect<UTxO[], Error, never> =>
  Effect.promise(() => lucid.wallet().getUtxos());

export const getWalletAddress = (
  lucid: LucidEvolution
): Effect.Effect<string, Error, never> =>
  Effect.promise(() => lucid.wallet().address());

export const selectWalletFromSeed = (
  lucid: LucidEvolution,
  seedPhrase: string
): void => {
  lucid.selectWallet.fromSeed(seedPhrase);
};

export const getUtxosAt = (
  lucid: LucidEvolution,
  address: string
): Effect.Effect<UTxO[], Error, never> =>
  Effect.promise(() => lucid.utxosAt(address));

// --- Transaction Utilities ---

export const signAndSubmit = (
  tx: TxSignBuilder
): Effect.Effect<string, Error, never> =>
  Effect.gen(function* () {
    const signed = yield* Effect.promise(() =>
      tx.sign.withWallet().complete()
    );
    const txHash = yield* Effect.promise(() => signed.submit());
    return txHash;
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
