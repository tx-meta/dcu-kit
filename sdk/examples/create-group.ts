import { createGroup, CreateGroupConfig, GroupDatum, joinGroup, JoinGroupConfig, groupPolicyId, assetNameLabels } from "@dcu/sdk";
import { getAddressDetails } from "@lucid-evolution/lucid";
import { makeLucid, cexplorerTxUrl, logError } from "./context.js";
import { saveState, loadState, printSlotSchedule, accountSuffixKey } from "./state.js";

async function main() {
    const { lucid, isEmulator } = await makeLucid();

    // Groups should be created by the admin wallet (holds the GroupAdmin NFT).
    const activeWallet = (process.env.ACTIVE_WALLET ?? "ADMIN").toUpperCase();
    const adminSeed = process.env[`${activeWallet}_SEED`] ?? process.env.USER1_SEED;
    if (!adminSeed) throw new Error(`${activeWallet}_SEED or USER1_SEED is required.`);
    lucid.selectWallet.fromSeed(adminSeed);

    const utxos = await lucid.wallet().getUtxos();
    if (utxos.length === 0) throw new Error("No UTxOs found. Please fund the wallet first.");

    // Derive the admin's 28-byte payment key hash so joining fees route to this wallet.
    const adminAddress = await lucid.wallet().address();
    const { paymentCredential } = getAddressDetails(adminAddress);
    if (!paymentCredential || paymentCredential.type !== "Key") {
        throw new Error("Admin wallet must be a key-hash address (not a script address).");
    }
    const adminPkh = paymentCredential.hash;

    // TEST_MODE: short intervals so distribute-payout is testable within minutes.
    // First joiner gets assigned_slot=0, currentSlot=0 at start_time, so they're
    // the borrower immediately. After one interval passes, their contributions
    // become claimable and distribute-payout can be called.
    // Flip to false for realistic mainnet/preprod configuration.
    const TEST_MODE = true;

    // JOIN_IMMEDIATELY: set to true to have the admin join as slot 0 immediately
    // after the group is created. This closes the slot-0 race condition window
    // (another wallet joining before the admin). Requires the admin's account
    // to be created first (pnpm run create-account as ADMIN).
    // Set to false if you want to test join-group.ts separately.
    const JOIN_IMMEDIATELY = true;

    const INTERVAL_LENGTH = TEST_MODE ? 5n * 60_000n : 60n * 60_000n; // 5 min | 1 hour
    const NUM_INTERVALS   = TEST_MODE ? 3n           : 12n; // 3 = ADMIN + USER1 + WALLET3

    // --- Contribution asset ---
    // ADA: leave policyid and assetname as "" (empty bytes = lovelace).
    // Native token / stablecoin: set policyid to the 28-byte policy ID (hex) and
    // assetname to the asset name (hex). Amount is in the token's smallest unit.
    // Example (USDM on Mainnet):
    //   contribution_fee_policyid: "f43a62fdc3965df486de8a0d32fe800963589c41b38946602a0dc535",
    //   contribution_fee_assetname: "41474958",
    //   contribution_fee: 5_000_000n,   // 5 USDM (6 decimal places)
    const CONTRIBUTION_FEE  = 5_000_000n;  // lovelace (5 ADA)
    const JOINING_FEE       = 2_000_000n;  // lovelace (2 ADA one-time)

    // --- Penalty economics ---
    // The penalty_fee is the amount forfeited on early exit, locked in PenaltyState.
    // Set this based on your group's risk tolerance:
    //   Low  (e.g. 20%): 1_000_000n  — low friction, easy exit, weak deterrent
    //   High (e.g. 100%): CONTRIBUTION_FEE — full contribution forfeited, strong deterrent
    // Must use the same asset as the contribution fee (or ADA if fees are ADA).
    const PENALTY_FEE = 2_000_000n;  // 2 ADA — adjust per your group's policy

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

        interval_length: INTERVAL_LENGTH,
        num_intervals: NUM_INTERVALS,
        max_members: MAX_MEMBERS,

        member_count: 0n,
        is_active: true,
        start_time: BigInt(Date.now()),
        admin_payment_credential: adminPkh,
    };

    const config: CreateGroupConfig = {
        groupDatum,
        utxoToSpend: utxos[0],
    };

    console.log("Building transaction...");
    const tx = await createGroup(lucid, config).unsafeRun();

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
    const refKey = Object.keys(scriptUtxo.assets).find(k =>
        k.startsWith(groupPolicyId!) &&
        k.slice(groupPolicyId!.length).startsWith(assetNameLabels.prefix100)
    );
    if (!refKey) throw new Error("No group reference token found in output 0");
    const groupTokenSuffix = refKey.slice(groupPolicyId!.length + assetNameLabels.prefix100.length);

    const timing = {
        groupStartTime:      Number(groupDatum.start_time),
        groupIntervalLength: Number(INTERVAL_LENGTH),
        groupNumIntervals:   Number(NUM_INTERVALS),
    };
    saveState({ groupTokenSuffix, ...timing });
    printSlotSchedule(timing, []);

    console.log("Group created successfully!");

    // --- Immediately join as slot 0 to close the race condition window ---
    if (JOIN_IMMEDIATELY) {
        const state = loadState();
        const suffixKey = accountSuffixKey(activeWallet);
        const accountTokenSuffix = state[suffixKey];

        if (!accountTokenSuffix) {
            console.warn(
                `\nWARNING: JOIN_IMMEDIATELY=true but no ${suffixKey} found in state.json.\n` +
                `Run 'pnpm run create-account' as ${activeWallet} first, then create-group again.\n` +
                `Slot 0 is currently unprotected — join manually before another wallet does.\n`
            );
        } else {
            // Compute contribution: total ADA locked for all intervals upfront
            const contributionAmount = groupDatum.num_intervals * groupDatum.contribution_fee;

            console.log(`\nJoining as slot 0 (contribution: ${contributionAmount / 1_000_000n} ADA)...`);
            const joinConfig: JoinGroupConfig = {
                groupTokenSuffix,
                accountTokenSuffix,
                contributionAmount,
            };

            const joinTx = await joinGroup(lucid, joinConfig).unsafeRun();
            const joinSigned = await joinTx.sign.withWallet().complete();
            const joinHash = await joinSigned.submit();
            console.log("Join transaction submitted. Hash:", joinHash);
            if (!isEmulator) console.log("View on Cexplorer:", cexplorerTxUrl(joinHash));

            console.log("Waiting for join confirmation...");
            await lucid.awaitTx(joinHash);
            console.log("Admin joined as slot 0. Race condition window closed.");

            if (TEST_MODE) {
                const payoutReady = new Date(Number(groupDatum.start_time) + Number(INTERVAL_LENGTH));
                console.log(`\ndistribute-payout ready: ${payoutReady.toLocaleTimeString()}`);
                console.log("Other members can join-group now.\n");
            }
        }
    }
}

main().catch((e) => {
    logError(e);
    process.exit(1);
});
