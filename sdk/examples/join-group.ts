/**
 * Join Group Example
 *
 * Joins a member to an existing ROSCA group.
 *
 * Wallet selection:
 *   Default (USER1):  uses USER1_SEED from .env
 *   ACTIVE_WALLET=USER2: uses USER2_SEED — joins as a second member
 *
 * Token suffix resolution:
 *   groupTokenSuffix:      state.json → auto-discover from wallet (222 prefix)
 *   accountTokenSuffix:    state.json (USER1 only) → auto-discover from wallet
 *
 * Live network: requires BLOCKFROST_KEY or MAESTRO_API_KEY in .env
 */

import {
  JoinGroupConfig,
  accountPolicyId,
  assetNameLabels,
  GroupCip68Datum,
} from "@tx-meta/dcu-sdk";
import { Data, UTxO } from "@lucid-evolution/lucid";
import { loadSdk } from "./sdk.js";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  logWalletInfo,
} from "./context.js";
import {
  loadState,
  saveState,
  printSlotSchedule,
  accountSuffixKey,
  checkValidatorStaleness,
} from "./state.js";

async function main() {
  const { lucid, isEmulator } = await makeLucid();

  if (isEmulator) {
    console.log("This example requires existing on-chain group and account.");
    console.log(
      "These example scripts require existing on-chain state. Run on Preprod.",
    );
    process.exit(0);
  }

  // Support ACTIVE_WALLET=USER2 to join as a second member.
  const activeWallet = (process.env.ACTIVE_WALLET ?? "USER1").toUpperCase();
  const walletSeed =
    process.env[`${activeWallet}_SEED`] ?? process.env.USER1_SEED;
  if (!walletSeed) throw new Error(`${activeWallet}_SEED not found in .env`);
  lucid.selectWallet.fromSeed(walletSeed);
  await logWalletInfo(lucid, activeWallet);

  const sdk = loadSdk();
  const { groupPolicyId, treasuryPolicyId } = sdk.protocol;

  const suffixKey = accountSuffixKey(activeWallet);
  const state = loadState();

  // Print current slot so you know where you are before spending gas.
  printSlotSchedule(state, []);

  let { groupTokenSuffix } = state;
  let accountTokenSuffix = state[suffixKey];

  checkValidatorStaleness({ accountPolicyId, groupPolicyId });

  // Auto-discover groupTokenSuffix from the group admin (222) token in wallet
  if (!groupTokenSuffix) {
    console.log(
      "groupTokenSuffix not in state.json — scanning wallet for group admin token...",
    );
    const walletUtxos = await lucid.wallet().getUtxos();
    const adminUtxo = walletUtxos.find((u) =>
      Object.keys(u.assets).some(
        (k) =>
          k.startsWith(groupPolicyId!) &&
          k.slice(groupPolicyId!.length).startsWith(assetNameLabels.prefix222),
      ),
    );
    if (!adminUtxo)
      throw new Error(
        "No group admin token (222) found in wallet and no groupTokenSuffix in state.json.\n" +
          "Run create-group.ts first.",
      );
    const key = Object.keys(adminUtxo.assets).find(
      (k) =>
        k.startsWith(groupPolicyId!) &&
        k.slice(groupPolicyId!.length).startsWith(assetNameLabels.prefix222),
    )!;
    groupTokenSuffix = key.slice(
      groupPolicyId!.length + assetNameLabels.prefix222.length,
    );
    console.log("Found groupTokenSuffix:", groupTokenSuffix);
    saveState({ groupTokenSuffix });
  }

  // Always scan the current wallet for the account (222) token — never trust state.json
  // blindly. A stale suffix points to a token that may be at a different address (e.g.,
  // another participant's wallet), causing Lucid to attempt spending a UTxO it can't sign
  // for, which manifests as a cryptic "insufficient funds" error at tx build time.
  const walletUtxos = await lucid.wallet().getUtxos();
  const accountUtxoInWallet = walletUtxos.find((u) =>
    Object.keys(u.assets).some(
      (k) =>
        k.startsWith(accountPolicyId!) &&
        k.slice(accountPolicyId!.length).startsWith(assetNameLabels.prefix222),
    ),
  );

  if (!accountUtxoInWallet) {
    if (accountTokenSuffix) {
      console.error(
        `\nERROR: state.json has ${suffixKey}="${accountTokenSuffix}"`,
      );
      console.error(
        `       but the account (222) token is NOT in the ${activeWallet} wallet.`,
      );
      console.error(
        `       The suffix may be from a different wallet or session.\n`,
      );
    }
    throw new Error(
      `No account (222) token found in ${activeWallet} wallet.\n` +
        `Run: ACTIVE_WALLET=${activeWallet} pnpm run create-account`,
    );
  }

  // Derive suffix from the wallet UTxO — this is the authoritative source.
  const accountKey = Object.keys(accountUtxoInWallet.assets).find(
    (k) =>
      k.startsWith(accountPolicyId!) &&
      k.slice(accountPolicyId!.length).startsWith(assetNameLabels.prefix222),
  )!;
  const discoveredSuffix = accountKey.slice(
    accountPolicyId!.length + assetNameLabels.prefix222.length,
  );
  if (accountTokenSuffix && accountTokenSuffix !== discoveredSuffix) {
    console.warn(
      `state.json ${suffixKey} differs from wallet — updating to wallet value.`,
    );
  }
  accountTokenSuffix = discoveredSuffix;
  saveState({ [suffixKey]: accountTokenSuffix });
  console.log(
    `Account (222) confirmed in ${activeWallet} wallet  suffix: ${accountTokenSuffix.slice(0, 8)}...`,
  );

  // Fetch the group datum to compute the required contribution amount and current slot
  const groupUnit =
    groupPolicyId! + assetNameLabels.prefix100 + groupTokenSuffix;
  const groupUtxo = await lucid.utxoByUnit(groupUnit);
  if (!groupUtxo)
    throw new Error(
      "Group UTxO not found on-chain. Is groupTokenSuffix correct?",
    );
  const groupDatum = Data.from(groupUtxo.datum!, GroupCip68Datum).extra;
  // Contribution covers all future rounds: max_members * contribution_fee.
  // num_rounds is 0 at creation and only set by StartGroup — cannot use it here.
  const contributionAmount =
    groupDatum.max_members * groupDatum.contribution_fee;
  const assignedSlot = Number(groupDatum.member_count);
  console.log(
    `Contribution: ${contributionAmount / 1_000_000n} ADA  |  Will be assigned slot: ${assignedSlot}`,
  );

  // Guard: prevent double-joining. The treasury membership token name is derived
  // from the account token name — if a treasury UTxO already holds it, this wallet
  // already has an active membership. The on-chain validator does NOT enforce this;
  // without the guard the same account silently takes two consecutive slots.
  const memberRefTokenName = assetNameLabels.prefix222 + accountTokenSuffix;
  const treasuryMemberUnit = treasuryPolicyId + memberRefTokenName;
  const existingTreasuryUtxo = await lucid
    .utxoByUnit(treasuryMemberUnit)
    .catch(() => null);
  if (existingTreasuryUtxo) {
    console.error(
      `\nERROR: ${activeWallet} already has an active treasury membership.`,
    );
    console.error(
      `  Treasury UTxO: ${existingTreasuryUtxo.txHash}#${existingTreasuryUtxo.outputIndex}`,
    );
    console.error(`  Run exit-group first if you want to rejoin.\n`);
    process.exit(1);
  }

  // Pre-supply coin selection by passing the richest spendable wallet UTxO.
  // completeProgram() queries wallet UTxOs internally via Blockfrost; on live
  // network that query can return empty (rate limit / stale) leaving a ~22 ADA
  // deficit. Passing a UTxO explicitly ensures the tx is always funded.
  //
  // Prefer pure-ADA UTxOs (simpler change output) but fall back to token-bearing
  // UTxOs — after create-group + create-account, all wallet ADA may live in UTxOs
  // that also carry native assets (group admin token, account token).
  //
  // Exclude the account UTxO: joinGroup.ts already calls collectFrom([accountUtxo])
  // internally; passing it again here would be a double-spend and crash Lucid.
  const fundingCandidates = walletUtxos
    .filter((u) => !u.scriptRef)
    .filter(
      (u) =>
        !(
          u.txHash === accountUtxoInWallet.txHash &&
          u.outputIndex === accountUtxoInWallet.outputIndex
        ),
    )
    .sort((a, b) => {
      const aIsPure = Object.keys(a.assets).every((k) => k === "lovelace");
      const bIsPure = Object.keys(b.assets).every((k) => k === "lovelace");
      if (aIsPure !== bIsPure) return aIsPure ? -1 : 1;
      return Number(b.assets.lovelace - a.assets.lovelace);
    });
  const fundingUtxo = fundingCandidates[0];
  if (fundingUtxo) {
    const isPure = Object.keys(fundingUtxo.assets).every(
      (k) => k === "lovelace",
    );
    console.log(
      `Funding UTxO: ${fundingUtxo.txHash.slice(0, 8)}...  ${fundingUtxo.assets.lovelace / 1_000_000n} ADA${isPure ? "" : " (+ native assets)"}`,
    );
  } else {
    console.warn(
      "No spendable UTxOs found in wallet — coin selection may fail on live network.",
    );
  }

  // Load reference script UTxOs — reduce tx size from ~16.4KB to ~4.5KB.
  // Deploy once with: pnpm run deploy-scripts
  let scriptRefs: JoinGroupConfig["scriptRefs"];
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
      console.log("Using reference scripts — tx will be under 16KB.");
    } else {
      console.warn(
        "Reference script UTxOs not found on-chain — falling back to inline scripts.",
      );
      console.warn("Run 'pnpm run deploy-scripts' to deploy them.");
    }
  } else {
    console.warn(
      "No script refs in state.json — falling back to inline scripts (may exceed 16KB).",
    );
    console.warn("Run 'pnpm run deploy-scripts' first.");
  }

  // TREASURY_DEPOSIT_OVERRIDE lets you join with a non-standard deposit (lovelace).
  // Use this to engineer DefaultState for testing contribute and
  // extend-grace-window. Example: TREASURY_DEPOSIT_OVERRIDE=5000000 joins with 5 ADA
  // instead of max_members × contribution_fee, so ICS triggers after round 0.
  // Never use this in production — members with low deposits become insolvent early.
  const overrideDepositLovelace = process.env.TREASURY_DEPOSIT_OVERRIDE
    ? BigInt(process.env.TREASURY_DEPOSIT_OVERRIDE)
    : undefined;
  if (overrideDepositLovelace !== undefined)
    console.warn(
      `[TEST ONLY] Overriding treasury deposit to ${overrideDepositLovelace / 1_000_000n} ADA.`,
    );

  const config: JoinGroupConfig = {
    groupTokenSuffix,
    accountTokenSuffix,
    fundingUtxos: fundingUtxo ? [fundingUtxo] : [],
    scriptRefs,
    overrideDepositLovelace,
  };

  console.log("Building join transaction...");
  const tx = await sdk.joinGroup(lucid, config).unsafeRun();

  console.log("Signing and submitting...");
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("Waiting for confirmation...");
  await lucid.awaitTx(txHash);
  console.log(`Joined group successfully as slot ${assignedSlot}!`);
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
