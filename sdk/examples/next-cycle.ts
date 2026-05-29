/**
 * Next Cycle Example
 *
 * Resets a mature ROSCA group for another rotation cycle. All rounds must be
 * distributed before this can run. Members keep their assigned slots and
 * membership tokens; the group datum is reset (is_started=false,
 * last_distributed_round=-1, num_rounds=0, start_time=0).
 *
 * After next-cycle:
 *   1. Members re-deposit via: pnpm run contribute
 *   2. Admin seals again via:  pnpm run start-group
 *   3. Distribute as normal
 *
 * Default wallet: ADMIN (must hold the group user (222) token).
 *
 * Reads groupTokenSuffix from state.json. Run deploy-scripts, create-group,
 * join-group, start-group, and all distribute-payout rounds first.
 */

import {
  nextCycle,
  NextCycleConfig,
  groupPolicyId,
  accountPolicyId,
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
    console.log(
      "This example requires an existing on-chain group in mature state.",
    );
    console.log(
      "Run on Preprod with distribute-payout completing all rounds first.",
    );
    process.exit(0);
  }

  const walletSeed = process.env.ADMIN_SEED;
  if (!walletSeed) throw new Error("ADMIN_SEED not found in .env");
  lucid.selectWallet.fromSeed(walletSeed);
  await logWalletInfo(lucid, "ADMIN");

  checkValidatorStaleness({ accountPolicyId, groupPolicyId: groupPolicyId! });

  const state = loadState();
  const { groupTokenSuffix } = state;
  if (!groupTokenSuffix)
    throw new Error(
      "groupTokenSuffix not found in state.json. Run create-group.ts first.",
    );

  // Load reference script UTxOs — keeps tx under 16KB.
  let scriptRefs: NextCycleConfig["scriptRefs"];
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
    }
  } else {
    console.warn(
      "No script refs in state.json — falling back to inline scripts (may exceed 16KB).",
    );
    console.warn("Run 'pnpm run deploy-scripts' first.");
  }

  const config: NextCycleConfig = { groupTokenSuffix, scriptRefs };

  console.log("Building next-cycle transaction...");
  const tx = await nextCycle(lucid, config).unsafeRun();

  console.log("Signing and submitting...");
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("Waiting for confirmation...");
  await lucid.awaitTx(txHash);
  console.log("Group reset for next cycle!");
  console.log("");
  console.log("Next steps:");
  console.log(
    "  1. Members re-deposit:  ACTIVE_WALLET=<wallet> TOP_UP_AMOUNT=<lovelace> pnpm run contribute",
  );
  console.log("  2. Seal new cycle:      pnpm run start-group");
  console.log("  3. Distribute as usual: pnpm run distribute-payout");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
