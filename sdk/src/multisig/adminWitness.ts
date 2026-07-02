import type { Script, TxBuilder, UTxO } from "@lucid-evolution/lucid";

/** Admin authority custody config shared by every admin-gated endpoint. */
export type AdminAuthConfig = {
  /** Native-script witness when the admin 222 token sits at a multisig address. */
  adminScript?: Script;
  /** Key hashes of the co-signers that will sign (declared via addSignerKey). */
  adminSignerKeyHashes?: string[];
  /** Destination for the admin 222 token after a script-admin spend.
   *  Defaults to the admin UTxO's own address, preserving multisig custody. */
  adminReturnAddress?: string;
};

/** Destination and value for returning the admin token after collecting adminUtxo.
 *  Script custody returns the FULL admin UTxO value to the script address so sibling
 *  assets never leak into the builder's change. VK custody returns just the admin
 *  unit; wallet change handles the rest. */
export const adminTokenReturn = (
  cfg: AdminAuthConfig,
  adminUtxo: UTxO,
  adminUnit: string,
  builderAddress: string,
): { address: string; assets: Record<string, bigint> } =>
  cfg.adminScript
    ? {
        address: cfg.adminReturnAddress ?? adminUtxo.address,
        assets: adminUtxo.assets,
      }
    : { address: builderAddress, assets: { [adminUnit]: 1n } };

/** Attaches the admin native-script witness and declares co-signer key hashes. */
export const applyAdminWitness = (
  tx: TxBuilder,
  cfg: AdminAuthConfig,
): TxBuilder => {
  const withScript = cfg.adminScript
    ? tx.attach.SpendingValidator(cfg.adminScript)
    : tx;
  return (cfg.adminSignerKeyHashes ?? []).reduce(
    (t, kh) => t.addSignerKey(kh),
    withScript,
  );
};
