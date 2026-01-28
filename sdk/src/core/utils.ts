import { LucidEvolution, Script, validatorToAddress, validatorToScriptHash, UTxO } from "@lucid-evolution/lucid";

// Helper to resolve always succeeds address (or any script address)
// In a real app, this might cache the result or be passed in config.
export const getScriptAddress = async (lucid: LucidEvolution, script: Script): Promise<string> => {
    // In Lucid Evolution, validatorToAddress might need network param or be async?
    // Check signature. Reference uses: validatorToAddress(network, validator)
    // But lucid instance has config().network
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
