/**
 * Purge DCU (222) User Tokens
 *
 * Sweeps CIP-68 (222) user tokens from the wallet to a permanent graveyard
 * address and consolidates all remaining UTxOs into a single change output.
 *
 * Two modes:
 *
 *   Default (stale-only):
 *     Sweeps (222) tokens under the CURRENT accountPolicyId / groupPolicyId
 *     whose suffix does NOT match the active suffix in state.json.
 *     Use this to clean up tokens from previous test runs of the same validator.
 *
 *   SWEEP_ALL=true:
 *     Sweeps EVERY CIP-68 (222) token in the wallet — any policy ID, any suffix.
 *     Use this when the wallet has tokens from multiple past deployments
 *     (different validator hashes) and you just want a clean slate.
 *     The paired (100) reference tokens are already permanently orphaned at
 *     dead script addresses and cannot be recovered regardless.
 *
 * Usage:
 *   ACTIVE_WALLET=ADMIN pnpm run purge-nfts               — stale-only, ADMIN
 *   ACTIVE_WALLET=ADMIN SWEEP_ALL=true pnpm run purge-nfts — sweep everything
 *   ACTIVE_WALLET=USER2 SWEEP_ALL=true pnpm run purge-nfts
 *
 * Cost: 2 ADA per token (min-UTxO locked in graveyard permanently).
 * Graveyard: key-hash "DCU_GRAVEYARD_V1" padded to 28 bytes — no known
 * private key; tokens sent there are permanently unspendable.
 */

import { credentialToAddress } from "@lucid-evolution/lucid";
import { accountPolicyId, assetNameLabels } from "@tx-meta/dcu-sdk";
import { loadSdk } from "./sdk.js";
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

// 2 ADA per token — safely exceeds the min-UTxO for any single native token.
const GRAVEYARD_MIN_ADA = 2_000_000n;

// CIP-68 (222) prefix — any token whose asset name starts with this is a
// CIP-68 user token. DCU mints all its user-facing tokens with this prefix.
const PREFIX_222 = assetNameLabels.prefix222; // "000de140"

async function main() {
  const { lucid, isEmulator } = await makeLucid();

  if (isEmulator) {
    console.log(
      "purge-nfts targets live networks only — stale tokens don't accumulate in the emulator.",
    );
    process.exit(0);
  }

  // Settings are optional for this diagnostic tool — without them we can still sweep
  // account tokens and (with SWEEP_ALL) every 222 token; group-policy classification
  // is simply skipped.
  let groupPolicyId: string | undefined;
  try {
    groupPolicyId = loadSdk().protocol.groupPolicyId;
  } catch {
    groupPolicyId = undefined;
  }

  const sweepAll = process.env.SWEEP_ALL === "true";
  const activeWallet = (process.env.ACTIVE_WALLET ?? "USER1").toUpperCase();
  const walletSeed =
    process.env[`${activeWallet}_SEED`] ?? process.env.USER1_SEED;
  if (!walletSeed) throw new Error(`${activeWallet}_SEED not found in .env`);
  lucid.selectWallet.fromSeed(walletSeed);
  await logWalletInfo(lucid, activeWallet);

  const network = lucid.config().network!;
  const graveyardAddress = credentialToAddress(network, {
    type: "Key",
    hash: GRAVEYARD_KEY_HASH,
  });

  if (sweepAll) {
    console.log("Mode: SWEEP_ALL — every CIP-68 (222) token will be swept.");
  } else {
    const state = loadState();
    const activeAccountSuffix = state[accountSuffixKey(activeWallet)];
    const activeGroupSuffix = state.groupTokenSuffix;
    console.log(
      `Mode: stale-only  (active account: ${activeAccountSuffix ?? "none"}, active group: ${activeGroupSuffix ?? "none"})`,
    );
  }
  console.log(`Graveyard: ${graveyardAddress}\n`);

  const allUtxos = (await lucid.wallet().getUtxos()).filter(
    (u) => !u.scriptRef,
  );
  if (allUtxos.length === 0) {
    console.log("Wallet is empty — nothing to do.");
    return;
  }

  const state = sweepAll ? null : loadState();
  const activeAccountSuffix = state
    ? state[accountSuffixKey(activeWallet)]
    : null;
  const activeGroupSuffix = state ? state.groupTokenSuffix : null;

  // Collect every (222) token that should be swept.
  const sweepUnits: string[] = [];
  for (const utxo of allUtxos) {
    for (const unit of Object.keys(utxo.assets)) {
      if (unit === "lovelace") continue;
      const policyId = unit.slice(0, 56);
      const assetName = unit.slice(56);
      const prefix = assetName.slice(0, 8);
      const suffix = assetName.slice(8);

      if (prefix !== PREFIX_222) continue;

      if (sweepAll) {
        // SWEEP_ALL: grab every (222) token regardless of policy or suffix
        sweepUnits.push(unit);
      } else {
        // Stale-only: only current DCU policies, non-active suffixes
        const isStaleAccount =
          policyId === accountPolicyId && suffix !== activeAccountSuffix;
        const isStaleGroup =
          groupPolicyId != null &&
          policyId === groupPolicyId &&
          suffix !== activeGroupSuffix;

        if (isStaleAccount || isStaleGroup) sweepUnits.push(unit);
      }
    }
  }

  if (sweepUnits.length === 0) {
    console.log("No tokens to sweep — wallet is already clean.");
    if (allUtxos.length > 1) {
      console.log(
        `(${allUtxos.length} UTxOs present — run with SWEEP_ALL=true to consolidate ADA anyway)`,
      );
    }
    return;
  }

  // Pretty-print what we're about to sweep
  console.log(`Sweeping ${sweepUnits.length} token(s):`);
  for (const unit of sweepUnits) {
    const policyId = unit.slice(0, 56);
    const suffix = unit.slice(64); // skip policy (56) + prefix (8)
    const knownPolicy =
      policyId === accountPolicyId
        ? "AccountUser(222)"
        : groupPolicyId && policyId === groupPolicyId
          ? "GroupCreator(222)"
          : `Unknown(222) policy:${policyId.slice(0, 8)}...`;
    console.log(`  • ${knownPolicy}  suffix: ${suffix.slice(0, 16)}...`);
  }

  const adaCost = BigInt(sweepUnits.length) * GRAVEYARD_MIN_ADA;
  console.log(
    `\nADA locked in graveyard: ${adaCost / 1_000_000n} ADA (${GRAVEYARD_MIN_ADA / 1_000_000n} ADA × ${sweepUnits.length})`,
  );
  console.log(
    `Collecting all ${allUtxos.length} UTxOs → consolidated ADA + change.\n`,
  );

  // Collect every wallet UTxO for consolidation, then send each swept token
  // to the graveyard. Remaining ADA returns as a single change output.
  let txBuilder = lucid.newTx().collectFrom(allUtxos);
  for (const unit of sweepUnits) {
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
    `Done! ${sweepUnits.length} token(s) swept, UTxOs consolidated into one.`,
  );
  console.log("Run 'pnpm run show-wallets' to verify.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
