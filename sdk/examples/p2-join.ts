/**
 * B11 (P2 matrix): join a group with an EXPLICIT account suffix.
 *
 * The stock join-group.ts auto-discovers the first account (222) token in the
 * wallet; a wallet holding several accounts (fresh + tangled) can pick the wrong
 * one. This driver takes GROUP_SUFFIX + ACCOUNT_SUFFIX explicitly and signs with
 * ACTIVE_WALLET. Pre-supplies wallet UTxOs for coin selection.
 */
import { JoinGroupConfig } from "@tx-meta/dcu-kit";
import { loadSdk } from "./sdk.js";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  selectEnvWallet,
  loadScriptRefs,
} from "./context.js";

async function main() {
  const { lucid, isEmulator } = await makeLucid();
  if (isEmulator) {
    console.log("Run on Preprod.");
    process.exit(0);
  }
  const activeWallet = await selectEnvWallet(lucid, "ADMIN");

  const groupTokenSuffix = process.env.GROUP_SUFFIX;
  const accountTokenSuffix = process.env.ACCOUNT_SUFFIX;
  if (!groupTokenSuffix || !accountTokenSuffix)
    throw new Error("GROUP_SUFFIX and ACCOUNT_SUFFIX are required.");

  const sdk = loadSdk();
  // Pick a single richest spendable UTxO (pure-ADA preferred), excluding
  // reference-script UTxOs and the account (222) token UTxO the endpoint spends
  // internally — passing that again double-spends and crashes serialization.
  const walletUtxos = await lucid.wallet().getUtxos();
  const fundingUtxo = walletUtxos
    .filter((u) => !u.scriptRef)
    .filter(
      (u) => !Object.keys(u.assets).some((k) => k.endsWith(accountTokenSuffix)),
    )
    .sort((a, b) => {
      const aPure = Object.keys(a.assets).every((k) => k === "lovelace");
      const bPure = Object.keys(b.assets).every((k) => k === "lovelace");
      if (aPure !== bPure) return aPure ? -1 : 1;
      return Number(b.assets.lovelace - a.assets.lovelace);
    })[0];
  const config: JoinGroupConfig = {
    groupTokenSuffix,
    accountTokenSuffix,
    fundingUtxos: fundingUtxo ? [fundingUtxo] : undefined,
    overrideDepositLovelace: process.env.TREASURY_DEPOSIT_OVERRIDE
      ? BigInt(process.env.TREASURY_DEPOSIT_OVERRIDE)
      : undefined,
    scriptRefs: await loadScriptRefs(lucid),
  };

  console.log(
    `${activeWallet} joining group ${groupTokenSuffix.slice(0, 8)}... with account ${accountTokenSuffix.slice(0, 8)}...`,
  );
  const tx = await sdk.joinGroup(lucid, config).unsafeRun();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));
  await lucid.awaitTx(txHash);
  console.log("Joined.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
