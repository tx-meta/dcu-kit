import type { Script, TxBuilder, UTxO } from "@lucid-evolution/lucid";

/** Admin authority custody config shared by every admin-gated endpoint. */
export type AdminAuthConfig = {
  /** When the admin 222 token is held at a native-script (multisig) address, supply the
   *  Script here. The tx will attach the native-script witness so the UTxO is spendable.
   *  Omit (or pass undefined) to use the default VK-wallet path — behaviour is unchanged. */
  adminScript?: Script;
  /** Key hashes of the co-signers required by adminScript (for addSignerKey). Only used
   *  when adminScript is present. Callers should pass exactly the M hashes that will sign. */
  adminSignerKeyHashes?: string[];
  /** Optional destination for returning the admin 222 token after script-admin spend.
   *  Defaults to the current admin UTxO address, preserving multisig delegation. */
  adminReturnAddress?: string;
};

/** Script-custody return output: pays the FULL admin UTxO value back to the script
 *  address (or an explicit override) so sibling assets never leak into the builder's
 *  change. No-op on the VK path — there the wallet's own change returns the token. */
export const payAdminReturn = (
  tx: TxBuilder,
  cfg: AdminAuthConfig,
  adminUtxo: UTxO,
): TxBuilder =>
  cfg.adminScript
    ? tx.pay.ToAddress(
        cfg.adminReturnAddress ?? adminUtxo.address,
        adminUtxo.assets,
      )
    : tx;

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
