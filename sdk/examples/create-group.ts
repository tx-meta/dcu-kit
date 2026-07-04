import {
  CreateGroupConfig,
  GroupDatum,
  assetNameLabels,
} from "@tx-meta/dcu-kit";
import { getAddressDetails } from "@lucid-evolution/lucid";
import { loadSdk } from "./sdk.js";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  logWalletInfo,
  loadScriptRefs,
} from "./context.js";
import { saveState, checkValidatorStaleness } from "./state.js";

async function main() {
  const { lucid, isEmulator } = await makeLucid();

  // Groups should be created by the admin wallet (holds the GroupAdmin NFT).
  const activeWallet = (process.env.ACTIVE_WALLET ?? "ADMIN").toUpperCase();
  const adminSeed =
    process.env[`${activeWallet}_SEED`] ?? process.env.USER1_SEED;
  if (!adminSeed)
    throw new Error(`${activeWallet}_SEED or USER1_SEED is required.`);
  lucid.selectWallet.fromSeed(adminSeed);
  await logWalletInfo(lucid, activeWallet);

  const sdk = loadSdk();
  const { groupPolicyId } = sdk.protocol;

  checkValidatorStaleness({ groupPolicyId });

  const utxos = await lucid.wallet().getUtxos();
  if (utxos.length === 0)
    throw new Error("No UTxOs found. Please fund the wallet first.");

  // Derive the admin's 28-byte payment key hash so joining fees route to this wallet.
  const adminAddress = await lucid.wallet().address();
  const { paymentCredential } = getAddressDetails(adminAddress);
  if (!paymentCredential || paymentCredential.type !== "Key") {
    throw new Error(
      "Admin wallet must be a key-hash address (not a script address).",
    );
  }
  const adminPkh = paymentCredential.hash;

  // TEST_MODE: short intervals so distribute-payout is testable within minutes.
  // First joiner gets assigned_slot=0, currentSlot=0 at start_time, so they're
  // the borrower immediately. After one interval passes, their contributions
  // become claimable and distribute-payout can be called.
  // Flip to false for realistic mainnet/preprod configuration.
  const TEST_MODE = true;

  const INTERVAL_LENGTH = TEST_MODE ? 5n * 60_000n : 60n * 60_000n; // 5 min | 1 hour

  // --- Contribution asset ---
  // ADA: leave policyid and assetname as "" (empty bytes = lovelace).
  // Native token / stablecoin: set policyid to the 28-byte policy ID (hex) and
  // assetname to the asset name (hex). Amount is in the token's smallest unit.
  // Example (USDM on Mainnet):
  //   contribution_fee_policyid: "f43a62fdc3965df486de8a0d32fe800963589c41b38946602a0dc535",
  //   contribution_fee_assetname: "41474958",
  //   contribution_fee: 5_000_000n,   // 5 USDM (6 decimal places)
  const CONTRIBUTION_FEE = 5_000_000n; // lovelace (5 ADA)
  const JOINING_FEE = 2_000_000n; // lovelace (2 ADA one-time)

  // --- Penalty economics ---
  // The penalty_fee is the amount forfeited on early exit, locked in PenaltyState.
  // Set this based on your group's risk tolerance:
  //   Low  (e.g. 20%): 1_000_000n  — low friction, easy exit, weak deterrent
  //   High (e.g. 100%): CONTRIBUTION_FEE — full contribution forfeited, strong deterrent
  // Must use the same asset as the contribution fee (or ADA if fees are ADA).
  const PENALTY_FEE = 2_000_000n; // 2 ADA — adjust per your group's policy

  // --- Member cap ---
  // Max number of members allowed in the group. distributePayout consumes one
  // UTxO per member in a single tx; beyond ~30 members the tx may exceed the
  // Cardano size/execution limits. Set to match your expected group size.
  const MAX_MEMBERS = TEST_MODE ? 5n : 30n;

  const groupDatum: GroupDatum = {
    contribution_fee_policyid: "",
    contribution_fee_assetname: "",
    contribution_fee: CONTRIBUTION_FEE,

    joining_fee_policyid: "",
    joining_fee_assetname: "",
    joining_fee: JOINING_FEE,

    penalty_fee_policyid: "",
    penalty_fee_assetname: "",
    penalty_fee: PENALTY_FEE,

    // Locked in the group UTxO at creation. Returned to admin on deleteGroup
    // once all members have exited. Signals commitment and deters spam groups.
    // Recommend >= contribution_fee; set to 0n only for trusted/family groups.
    creator_bond: CONTRIBUTION_FEE,

    interval_length: INTERVAL_LENGTH,
    // num_rounds MUST be 0 at creation — the on-chain validator enforces this.
    // StartGroup sets it to member_count when sealing membership.
    num_rounds: 0n,
    max_members: MAX_MEMBERS,

    // Collateral the join floor requires, expressed in rounds of contribution_fee:
    //   1n            = PerRound (default) — members top up each round via Contribute
    //   MAX_MEMBERS   = FullUpfront — entire obligation locked at join
    //   k             = partial — k rounds locked up front
    collateral_rounds: 1n,

    // Push (default): the round's pot is paid straight to the borrower's wallet.
    // Pull: the pot is earmarked in the borrower's own treasury (claimable_balance)
    //       and withdrawn later via ClaimPayout — the lost-wallet-safe mode.
    // Set PAYOUT_MODE=Pull to create a Pull-mode group.
    payout_mode: process.env.PAYOUT_MODE === "Pull" ? "Pull" : "Push",
    // Minimum approvals required to authorize a lost-member recovery (absolute count).
    recovery_threshold: 1n,
    // Veto window before a recovery proposal can execute (POSIX ms). 3 days default.
    recovery_timelock: 259_200_000n,

    member_count: 0n,
    // Cached count of members in good standing — maintained by the validators;
    // MUST equal member_count at creation (both 0).
    active_member_count: 0n,
    // Slot ownership registry, parallel to member_token_names. Empty until
    // StartGroup seals membership and assigns slots.
    member_slots: [],
    // The round number the current era (rotation lap numbering) started at.
    era_start_round: 0n,
    // Minimum duration of a recommit window (POSIX ms) — the guaranteed free-exit
    // period between eras. 3 days default.
    recommit_window: 259_200_000n,
    // Mutual reserve levies, in the CONTRIBUTION asset. 0n = off. Frozen once a
    // member joins. RESERVE_JOIN_LEVY fires once per join; RESERVE_ROUND_LEVY per
    // contributing member per round (comes out of the pot, not on top).
    reserve_join_levy: BigInt(process.env.RESERVE_JOIN_LEVY ?? "0"),
    reserve_round_levy: BigInt(process.env.RESERVE_ROUND_LEVY ?? "0"),
    is_active: true,
    is_started: false,
    // start_time MUST be 0 at creation — set to tx lower bound by StartGroup.
    start_time: 0n,
    last_distributed_round: -1n,
    grace_period_length: 0n,
    // Joining fees route to this credential forever (frozen at first join).
    // A VerificationKey credential pays a wallet; a Script credential (e.g. a
    // native multisig) needs `creatorScript` in the config as spendability proof.
    creator_payment_credential: { VerificationKey: [adminPkh] },
    member_token_names: [],
  };

  const config: CreateGroupConfig = {
    // groupName goes into the CIP-68 metadata map (metadata["name"]) on the group
    // reference token. Wallets display this name when showing the group NFT.
    groupName: process.env.GROUP_NAME ?? "My DCU Group",
    // groupDescription is the chama's stated purpose — e.g. "Kiambu land-buying chama".
    // Stored on-chain in metadata["description"] and frozen once a member joins. Optional.
    groupDescription:
      process.env.GROUP_DESCRIPTION ?? "A rotating savings group (chama).",
    groupDatum,
    utxoToSpend: utxos[0],
    // Creating a group invokes BOTH minting policies (group + treasury reserve);
    // the two no longer fit inline — deploy refs first with `pnpm run deploy-scripts`.
    scriptRefs: await loadScriptRefs(lucid),
  };

  console.log("Building transaction...");
  const { tx } = await sdk.createGroup(lucid, config).unsafeRun();

  console.log("Signing and submitting...");
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  if (!isEmulator) console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("Waiting for confirmation...");
  await lucid.awaitTx(txHash);

  // Extract the permanent group token suffix from the minted script UTxO (output 0).
  const [scriptUtxo] = await lucid.utxosByOutRef([{ txHash, outputIndex: 0 }]);
  if (!scriptUtxo) throw new Error("Could not fetch minted group UTxO");
  const refKey = Object.keys(scriptUtxo.assets).find(
    (k) =>
      k.startsWith(groupPolicyId!) &&
      k.slice(groupPolicyId!.length).startsWith(assetNameLabels.prefix100),
  );
  if (!refKey) throw new Error("No group reference token found in output 0");
  const groupTokenSuffix = refKey.slice(
    groupPolicyId!.length + assetNameLabels.prefix100.length,
  );

  // Save interval_length now — it's fixed at creation.
  // groupStartTime and groupNumRounds are saved by start-group.ts after StartGroup is called.
  saveState({
    groupTokenSuffix,
    groupPolicyId: groupPolicyId!,
    groupIntervalLength: Number(INTERVAL_LENGTH),
  });

  console.log("Group created successfully!");
  console.log("\nNext steps:");
  console.log(
    "  pnpm run update-group                      — (optional) change fees while member_count=0",
  );
  console.log("");
  console.log(
    "  Create an account for each participant (establishes verifiable identity):",
  );
  console.log("  ACTIVE_WALLET=ADMIN pnpm run create-account");
  console.log("  ACTIVE_WALLET=USER1 pnpm run create-account");
  console.log("  ACTIVE_WALLET=USER2 pnpm run create-account");
  console.log("");
  console.log("  Then join the group (order determines slot assignment):");
  console.log(
    "  ACTIVE_WALLET=ADMIN pnpm run join-group    — ADMIN joins as slot 0",
  );
  console.log(
    "  ACTIVE_WALLET=USER1 pnpm run join-group    — USER1 joins as slot 1",
  );
  console.log(
    "  ACTIVE_WALLET=USER2 pnpm run join-group    — USER2 joins as slot 2",
  );
  console.log("");
  console.log(
    "  Once all members have joined, seal membership and anchor the schedule:",
  );
  console.log(
    "  pnpm run start-group                       — ADMIN seals group, sets start_time",
  );
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
