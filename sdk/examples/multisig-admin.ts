/**
 * Script-held admin helpers shared by the admin-op examples.
 *
 * After assign-admin moves the group admin (222) token to a multisig script
 * address, admin-gated endpoints need two extra pieces:
 *   1. AdminAuthConfig — the native script witness (adminScript) plus the key
 *      hashes of the co-signers (adminSignerKeyHashes) so the builder can
 *      declare and budget the required signatures.
 *   2. Co-signatures — the sign builder captures the wallet at BUILD time, so
 *      re-selecting wallets before signing does nothing. Each co-signer key is
 *      chained with sign.withPrivateKey (same pattern as propose-recovery's
 *      APPROVER_WALLETS).
 *
 * resolveAdminAuth() detects where the admin token currently sits. On a plain
 * VK address it returns the empty config and the caller's flow is unchanged.
 * On a script address it requires the multisig recorded by create-multisig in
 * state.json to match the address's payment credential.
 *
 * Env:
 *   SIGNER_WALLETS=ADMIN,USER1  which wallets co-sign (default: the first M of
 *                               the recorded multisigSignerWallets)
 */

import {
  getAddressDetails,
  walletFromSeed,
  LucidEvolution,
  TxSignBuilder,
} from "@lucid-evolution/lucid";
import type { AdminAuthConfig } from "@tx-meta/dcu-kit/multisig";
import { loadState } from "./state.js";

export type AdminAuthResolution = {
  scriptHeld: boolean;
  /** Spread into the endpoint config ({} on the VK path). */
  adminAuth: AdminAuthConfig;
  signers: { wallet: string; keyHash: string; paymentKey: string }[];
};

const exampleNetwork = () =>
  process.env.NETWORK === "Mainnet" ? ("Mainnet" as const) : ("Preprod" as const);

/**
 * Resolves the admin (222) unit's current UTxO and returns the AdminAuthConfig
 * and co-signer set the calling example needs. Throws when the token is
 * script-held but state.json has no matching multisig — proceeding would build
 * an unspendable transaction.
 */
export async function resolveAdminAuth(
  lucid: LucidEvolution,
  adminUnit: string,
): Promise<AdminAuthResolution> {
  const adminUtxo = await lucid.utxoByUnit(adminUnit);
  if (!adminUtxo)
    throw new Error(`Admin (222) token not found on-chain: ${adminUnit}`);
  const payCred = getAddressDetails(adminUtxo.address).paymentCredential;
  if (payCred?.type !== "Script")
    return { scriptHeld: false, adminAuth: {}, signers: [] };

  const state = loadState();
  if (!state.multisigScript || state.multisigHash !== payCred.hash)
    throw new Error(
      `Admin token is held at script address ${adminUtxo.address}\n` +
        "but state.json has no matching multisig (multisigScript / multisigHash).\n" +
        "Run create-multisig with the same signers first.",
    );

  const required = state.multisigRequired ?? 2;
  const recorded = state.multisigSignerWallets ?? ["ADMIN", "USER1", "USER2"];
  const signerWallets = (
    process.env.SIGNER_WALLETS ?? recorded.slice(0, required).join(",")
  )
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (signerWallets.length < required)
    throw new Error(
      `SIGNER_WALLETS provides ${signerWallets.length} signer(s); the multisig requires ${required}.`,
    );

  const network = exampleNetwork();
  const signers = signerWallets.map((wallet) => {
    const seed = process.env[`${wallet}_SEED`];
    if (!seed) throw new Error(`${wallet}_SEED not found in .env`);
    const { address, paymentKey } = walletFromSeed(seed, { network });
    const cred = getAddressDetails(address).paymentCredential;
    if (!cred || cred.type !== "Key")
      throw new Error(`${wallet}: could not derive a payment key hash`);
    return { wallet, keyHash: cred.hash, paymentKey };
  });

  console.log(
    `Admin token is script-held (${required}-of-${recorded.length} multisig) — co-signing with: ${signerWallets.join(", ")}`,
  );

  return {
    scriptHeld: true,
    adminAuth: {
      adminScript: { type: "Native", script: state.multisigScript },
      adminSignerKeyHashes: signers.map((s) => s.keyHash),
    },
    signers,
  };
}

/**
 * Signs with the active wallet, then chains sign.withPrivateKey for each
 * co-signer whose key the wallet signature does not already provide.
 */
export async function signWithAdminAuth(
  lucid: LucidEvolution,
  tx: TxSignBuilder,
  auth: AdminAuthResolution,
) {
  let signing = tx.sign.withWallet();
  if (auth.scriptHeld) {
    const activeHash = getAddressDetails(await lucid.wallet().address())
      .paymentCredential?.hash;
    for (const s of auth.signers) {
      if (s.keyHash === activeHash) continue;
      signing = signing.sign.withPrivateKey(s.paymentKey);
    }
  }
  return signing.complete();
}
