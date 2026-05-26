/**
 * Exit Group Example
 *
 * Exits a member from a ROSCA group.
 *   - Early exit (before maturity): moves treasury to PenaltyState (locked for admin).
 *   - Mature exit (after all intervals): burns membership token and refunds balance.
 *
 * Reads groupTokenSuffix and accountTokenSuffix from state.json.
 * Run create-group.ts, create-account.ts, and join-group.ts first.
 */

import {
  exitGroup,
  ExitGroupConfig,
  accountPolicyId,
  groupPolicyId,
  assetNameLabels,
} from "@tx-meta/dcu-sdk";
import { UTxO } from "@lucid-evolution/lucid";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  logWalletInfo,
} from "./context.js";
import { loadState, checkValidatorStaleness } from "./state.js";

async function main() {
  const { lucid, isEmulator } = await makeLucid();

  if (isEmulator) {
    console.log("This example requires an active group membership.");
    console.log(
      "These example scripts require existing on-chain state. Run on Preprod.",
    );
    process.exit(0);
  }

  const activeWallet = (process.env.ACTIVE_WALLET ?? "USER1").toUpperCase();
  const walletSeed =
    process.env[`${activeWallet}_SEED`] ?? process.env.USER1_SEED;
  if (!walletSeed) throw new Error(`${activeWallet}_SEED not found in .env`);
  lucid.selectWallet.fromSeed(walletSeed);
  await logWalletInfo(lucid, activeWallet);

  checkValidatorStaleness({ accountPolicyId, groupPolicyId: groupPolicyId! });

  const state = loadState();
  const { groupTokenSuffix } = state;
  if (!groupTokenSuffix)
    throw new Error(
      "groupTokenSuffix not found in state.json. Run create-group.ts first.",
    );

  // Verify the wallet has at least one account (222) token — the endpoint will
  // auto-detect which one was used to join this group by cross-matching all wallet
  // account tokens against treasury UTxO datums. This handles wallets that hold
  // multiple account tokens from different sessions.
  const walletUtxos = await lucid.wallet().getUtxos();
  const hasAccountToken = walletUtxos.some((u) =>
    Object.keys(u.assets).some(
      (k) =>
        k.startsWith(accountPolicyId!) &&
        k.slice(accountPolicyId!.length).startsWith(assetNameLabels.prefix222),
    ),
  );
  if (!hasAccountToken)
    throw new Error(
      `No account (222) token found in ${activeWallet} wallet.\n` +
        `Run join-group as ${activeWallet} first (or create-account if no account exists).`,
    );
  console.log(
    `Account (222) token(s) found in ${activeWallet} wallet — endpoint will auto-detect the correct one.`,
  );

  // Load reference script UTxOs to keep exit tx under 16KB.
  let scriptRefs: ExitGroupConfig["scriptRefs"];
  if (state.scriptRefTreasury && state.scriptRefGroup) {
    const [tUtxo, gUtxo] = await lucid.utxosByOutRef([
      {
        txHash: state.scriptRefTreasury.txHash,
        outputIndex: state.scriptRefTreasury.outputIndex,
      },
      {
        txHash: state.scriptRefGroup.txHash,
        outputIndex: state.scriptRefGroup.outputIndex,
      },
    ]);
    if (tUtxo?.scriptRef && gUtxo?.scriptRef) {
      scriptRefs = { treasury: tUtxo as UTxO, group: gUtxo as UTxO };
      console.log("Using reference scripts.");
    }
  }

  const config: ExitGroupConfig = {
    groupTokenSuffix,
    scriptRefs,
    // accountTokenSuffix omitted — endpoint auto-detects by scanning treasury
  };

  console.log(`Building exit transaction for ${activeWallet}...`);
  const tx = await exitGroup(lucid, config).unsafeRun();

  console.log("Signing and submitting...");
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("Waiting for confirmation...");
  await lucid.awaitTx(txHash);
  console.log("Exited group successfully!");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
