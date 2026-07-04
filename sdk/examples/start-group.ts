/**
 * Start Group Example
 *
 * Seals membership and anchors the rotation schedule. Must be called by the
 * group admin (holder of the group 222 token) after all members have joined.
 *
 * What StartGroup does on-chain:
 *   - Sets is_started = true (one-way latch; prevents further joins)
 *   - Sets num_rounds = member_count (fixes the rotation length)
 *   - Sets start_time = tx validity lower bound (anchors round timing)
 *   - Requires member_count >= 2 (enforced by the validator)
 *
 * After this call:
 *   - groupStartTime, groupNumRounds are saved to state.json
 *   - distribute-payout can now be called once the first interval elapses
 *
 * Wallet selection:
 *   Default (ADMIN): uses ADMIN_SEED from .env
 *
 * Live network: requires BLOCKFROST_KEY or MAESTRO_API_KEY in .env
 */

import {
  StartGroupConfig,
  assetNameLabels,
  GroupCip68Datum,
} from "@tx-meta/dcu-kit";
import { Data } from "@lucid-evolution/lucid";
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
  checkValidatorStaleness,
} from "./state.js";

async function main() {
  const { lucid, isEmulator } = await makeLucid();

  if (isEmulator) {
    console.log(
      "This example requires an existing on-chain group with joined members.",
    );
    console.log(
      "These example scripts require existing on-chain state. Run on Preprod.",
    );
    process.exit(0);
  }

  // StartGroup must be called by the admin (holder of the group 222 token).
  const activeWallet = (process.env.ACTIVE_WALLET ?? "ADMIN").toUpperCase();
  const adminSeed =
    process.env[`${activeWallet}_SEED`] ?? process.env.ADMIN_SEED;
  if (!adminSeed) throw new Error(`${activeWallet}_SEED not found in .env`);
  lucid.selectWallet.fromSeed(adminSeed);
  await logWalletInfo(lucid, activeWallet);

  const sdk = loadSdk();
  const { groupPolicyId } = sdk.protocol;

  checkValidatorStaleness({ groupPolicyId });

  const state = loadState();
  const { groupTokenSuffix } = state;
  if (!groupTokenSuffix)
    throw new Error(
      "groupTokenSuffix not found in state.json. Run create-group.ts first.",
    );

  // Verify the group is not already started.
  const groupUnit =
    groupPolicyId! + assetNameLabels.prefix100 + groupTokenSuffix;
  const groupUtxo = await lucid.utxoByUnit(groupUnit);
  if (!groupUtxo)
    throw new Error(
      "Group UTxO not found on-chain. Is groupTokenSuffix correct?",
    );
  const groupDatum = Data.from(groupUtxo.datum!, GroupCip68Datum).extra;

  if (groupDatum.is_started) {
    console.error("\nERROR: Group is already started.");
    console.error(
      `  is_started = true, num_rounds = ${groupDatum.num_rounds}, start_time = ${groupDatum.start_time}`,
    );
    process.exit(1);
  }

  if (groupDatum.member_count < 2n) {
    console.error(
      `\nERROR: Group only has ${groupDatum.member_count} member(s). StartGroup requires at least 2.`,
    );
    console.error(
      "  Join more members first with: ACTIVE_WALLET=USER1 pnpm run join-group",
    );
    process.exit(1);
  }

  console.log(`Starting group with ${groupDatum.member_count} members...`);
  console.log(
    `  After start: num_rounds = ${groupDatum.member_count}, rotation begins immediately.`,
  );

  const config: StartGroupConfig = {
    groupTokenSuffix,
  };

  console.log("Building start-group transaction...");
  const tx = await sdk.startGroup(lucid, config).unsafeRun();

  console.log("Signing and submitting...");
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("Waiting for confirmation...");
  await lucid.awaitTx(txHash);

  // Fetch the updated group UTxO to read the on-chain start_time.
  // The validator sets start_time = get_lower_bound(tx), which is the
  // validFrom value used when building the tx — not Date.now().
  const [updatedUtxo] = await lucid.utxosByOutRef([{ txHash, outputIndex: 0 }]);
  if (!updatedUtxo)
    throw new Error("Could not fetch updated group UTxO after start-group.");
  const updatedDatum = Data.from(updatedUtxo.datum!, GroupCip68Datum).extra;

  const groupStartTime = Number(updatedDatum.start_time);
  const groupNumRounds = Number(updatedDatum.num_rounds);
  const groupIntervalLength =
    state.groupIntervalLength ?? Number(updatedDatum.interval_length);

  saveState({ groupStartTime, groupNumRounds, groupIntervalLength });

  printSlotSchedule(
    { groupStartTime, groupNumRounds, groupIntervalLength },
    Array.from({ length: groupNumRounds }, (_, i) => i),
  );

  console.log("Group started successfully!");
  console.log(`  num_rounds : ${groupNumRounds}`);
  console.log(`  start_time    : ${new Date(groupStartTime).toISOString()}`);
  console.log(`  interval_length: ${groupIntervalLength / 60_000} minutes`);
  console.log("\nNext steps:");
  console.log("  Wait for the first interval to elapse, then run:");
  console.log("  pnpm run distribute-payout     — pays the slot 0 borrower");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
