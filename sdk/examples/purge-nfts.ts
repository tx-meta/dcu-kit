/**
 * Purge Stale DCU Tokens
 *
 * Sweeps accumulated DCU (222) user tokens from past test sessions to a
 * permanent graveyard address, and consolidates all remaining wallet UTxOs
 * (ADA + any active tokens) into a single change output.
 *
 * "Stale" = any AccountUser(222) or GroupAdmin(222) token whose suffix does
 * NOT match the active suffix stored in state.json for this wallet.
 * The (100) reference tokens live at script addresses and are handled by
 * delete-account / delete-group.
 *
 * Usage:
 *   ACTIVE_WALLET=ADMIN pnpm run purge-nfts
 *   pnpm run purge-nfts                       — USER1 (default)
 *   ACTIVE_WALLET=USER2 pnpm run purge-nfts
 *
 * Cost: 2 ADA per stale token (min-UTxO locked in graveyard permanently).
 * Graveyard: key-hash "DCU_GRAVEYARD_V1" padded to 28 bytes — no known
 * private key; tokens sent there are permanently unspendable.
 */

import { credentialToAddress } from "@lucid-evolution/lucid";
import {
  accountPolicyId,
  groupPolicyId,
  assetNameLabels,
} from "@tx-meta/dcu-sdk";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  logWalletInfo,
} from "./context.js";
import { loadState, accountSuffixKey } from "./state.js";

// 28-byte payment key hash derived from ASCII("DCU_GRAVEYARD_V1") + 12 zero bytes.
// No private key corresponds to this value — tokens sent here are unrecoverable.
const GRAVEYARD_KEY_HASH =
  "4443555f4752415645594152445f5631000000000000000000000000";

// 2 ADA per stale token — safely exceeds the min-UTxO for any single native token.
const GRAVEYARD_MIN_ADA = 2_000_000n;

async function main() {
  const { lucid, isEmulator } = await makeLucid();

  if (isEmulator) {
    console.log(
      "purge-nfts targets live networks only — stale tokens don't accumulate in the emulator.",
    );
    process.exit(0);
  }

  const activeWallet = (process.env.ACTIVE_WALLET ?? "USER1").toUpperCase();
  const walletSeed =
    process.env[`${activeWallet}_SEED`] ?? process.env.USER1_SEED;
  if (!walletSeed) throw new Error(`${activeWallet}_SEED not found in .env`);
  lucid.selectWallet.fromSeed(walletSeed);
  await logWalletInfo(lucid, activeWallet);

  const state = loadState();
  const activeAccountSuffix = state[accountSuffixKey(activeWallet)];
  const activeGroupSuffix = state.groupTokenSuffix;

  console.log(
    `Active account suffix : ${activeAccountSuffix ?? "(none in state.json)"}`,
  );
  console.log(
    `Active group suffix   : ${activeGroupSuffix ?? "(none in state.json)"}`,
  );

  const network = lucid.config().network!;
  const graveyardAddress = credentialToAddress(network, {
    type: "Key",
    hash: GRAVEYARD_KEY_HASH,
  });
  console.log(`Graveyard address    : ${graveyardAddress}\n`);

  const allUtxos = (await lucid.wallet().getUtxos()).filter(
    (u) => !u.scriptRef,
  );
  if (allUtxos.length === 0) {
    console.log("Wallet is empty — nothing to do.");
    return;
  }

  // Identify stale DCU (222) tokens across all wallet UTxOs.
  const staleUnits: string[] = [];
  for (const utxo of allUtxos) {
    for (const unit of Object.keys(utxo.assets)) {
      if (unit === "lovelace") continue;
      const policyId = unit.slice(0, 56);
      const assetName = unit.slice(56);
      const prefix = assetName.slice(0, 8);
      const suffix = assetName.slice(8);

      if (prefix !== assetNameLabels.prefix222) continue;

      const isStaleAccount =
        policyId === accountPolicyId && suffix !== activeAccountSuffix;
      const isStaleGroup =
        groupPolicyId != null &&
        policyId === groupPolicyId &&
        suffix !== activeGroupSuffix;

      if (isStaleAccount || isStaleGroup) {
        staleUnits.push(unit);
      }
    }
  }

  if (staleUnits.length === 0) {
    console.log("No stale DCU tokens found — wallet is already clean.");
    if (allUtxos.length > 1) {
      console.log(
        `(${allUtxos.length} UTxOs present — run with CONSOLIDATE=true to consolidate ADA anyway)`,
      );
    }
    return;
  }

  console.log(`Found ${staleUnits.length} stale token(s):`);
  for (const unit of staleUnits) {
    const policyId = unit.slice(0, 56);
    const assetName = unit.slice(56);
    const suffix = assetName.slice(8);
    const kind =
      policyId === accountPolicyId ? "AccountUser(222)" : "GroupAdmin(222)";
    console.log(`  • ${kind}  suffix: ${suffix.slice(0, 16)}...`);
  }

  const adaCost = BigInt(staleUnits.length) * GRAVEYARD_MIN_ADA;
  console.log(
    `\nADA locked in graveyard: ${adaCost / 1_000_000n} ADA (${GRAVEYARD_MIN_ADA / 1_000_000n} ADA × ${staleUnits.length})`,
  );
  console.log(
    `Collecting all ${allUtxos.length} wallet UTxOs → consolidated ADA + active tokens return as change.\n`,
  );

  // Collect every wallet UTxO for consolidation, then route each stale token
  // to the graveyard. Active tokens and remaining ADA return as a single change output.
  let txBuilder = lucid.newTx().collectFrom(allUtxos);
  for (const unit of staleUnits) {
    txBuilder = txBuilder.pay.ToAddress(graveyardAddress, {
      [unit]: 1n,
      lovelace: GRAVEYARD_MIN_ADA,
    });
  }

  console.log("Building sweep transaction...");
  const built = await txBuilder.complete();

  console.log("Signing and submitting...");
  const signed = await built.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("\nWaiting for confirmation...");
  await lucid.awaitTx(txHash);
  console.log(
    `Done! ${staleUnits.length} stale token(s) swept. Wallet UTxOs consolidated.`,
  );
  console.log("Run 'pnpm run show-wallets' to verify.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
