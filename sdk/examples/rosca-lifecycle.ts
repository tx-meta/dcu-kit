/**
 * ROSCA Lifecycle Example
 *
 * Demonstrates the complete end-to-end flow of a DCU ROSCA group on the Emulator:
 *
 *   1. Admin creates a group
 *   2. Member creates an account
 *   3. Member joins the group
 *   4. Distribute payout to the current slot borrower (member, slot 0)
 *   5. Member exits the group (mature exit — no penalty since group has matured)
 *   6. Admin deletes the group (member_count = 0)
 *
 * Time setup:
 *   - start_time is set 3 intervals in the past so currentSlot = 3 % 3 = 0 and
 *     all contribution_list entries are past their claimable_at timestamp.
 *   - The member who joined first is assigned slot 0, so they are the borrower.
 *   - contributionAmount includes a 2 ADA min-ADA buffer above the contribution total,
 *     so the treasury remains spendable after the full payout is distributed.
 */

import "dotenv/config";
import {
    Lucid,
    Emulator,
    PROTOCOL_PARAMETERS_DEFAULT,
    generateEmulatorAccount,
    getAddressDetails,
} from "@lucid-evolution/lucid";
import {
    createAccount,
    createGroup,
    joinGroup,
    distributePayout,
    exitGroup,
    deleteGroup,
    CreateAccountConfig,
    CreateGroupConfig,
    JoinGroupConfig,
    DistributePayoutConfig,
    ExitGroupConfig,
    DeleteGroupConfig,
    GroupDatum,
    groupPolicyId,
    accountPolicyId,
    assetNameLabels,
} from "@dcu/sdk";
import { logError } from "./context.js";

const NETWORK = "Custom"; // emulator network

type LucidInstance = Awaited<ReturnType<typeof Lucid>>;

async function submitAndAwait(lucid: LucidInstance, txBuilder: any): Promise<string> {
    const signed = await txBuilder.sign.withWallet().complete();
    const txHash = await signed.submit();
    await lucid.awaitTx(txHash);
    return txHash;
}

function extractSuffix(assets: Record<string, bigint>, policyId: string, prefix: string): string {
    const key = Object.keys(assets).find(k =>
        k.startsWith(policyId) && k.slice(policyId.length).startsWith(prefix)
    );
    if (!key) throw new Error(`Token not found: policyId=${policyId} prefix=${prefix}`);
    return key.slice(policyId.length + prefix.length);
}

async function main() {
    // Two wallets: admin creates the group, member joins and receives payout
    const admin = generateEmulatorAccount({ lovelace: 100_000_000n });
    const member = generateEmulatorAccount({ lovelace: 100_000_000n });
    const emulator = new Emulator([admin, member], { ...PROTOCOL_PARAMETERS_DEFAULT });
    const lucid = await Lucid(emulator, NETWORK);

    // --- Timing: set start_time 3 intervals in the past so:
    //   - currentSlot = floor(3 + ε) % 3 = 0 → member (slot 0) is the borrower
    //   - all 3 contribution_list entries (claimable_at = start + i*interval) are past due
    const NUM_INTERVALS   = 3n;
    const INTERVAL_LENGTH = 3_600_000n; // 1 hour in ms
    const CONTRIBUTION_FEE = 2_000_000n; // 2 ADA per interval
    const start_time = BigInt(emulator.now()) - NUM_INTERVALS * INTERVAL_LENGTH - 60_000n;

    // contributionAmount = total contribution + 2 ADA min-ADA buffer.
    // After all 3 contributions (6 ADA) are distributed as payout, the treasury
    // still holds 2 ADA so the output UTxO meets Cardano's minimum ADA requirement.
    const contributionAmount = NUM_INTERVALS * CONTRIBUTION_FEE + 2_000_000n; // 8 ADA total

    // ─────────────────────────────────────────────────────────────────────────
    // Step 1: Admin creates the group
    // ─────────────────────────────────────────────────────────────────────────
    lucid.selectWallet.fromSeed(admin.seedPhrase);
    const adminUtxos = await lucid.wallet().getUtxos();

    const adminAddress = await lucid.wallet().address();
    const { paymentCredential: adminCred } = getAddressDetails(adminAddress);
    if (!adminCred || adminCred.type !== "Key") {
        throw new Error("Admin wallet must be a key-hash address (not a script address).");
    }
    const adminPkh = adminCred.hash;

    const groupDatum: GroupDatum = {
        contribution_fee_policyid: "",
        contribution_fee_assetname: "",
        contribution_fee: CONTRIBUTION_FEE,

        joining_fee_policyid: "",
        joining_fee_assetname: "",
        joining_fee: 0n,

        penalty_fee_policyid: "",
        penalty_fee_assetname: "",
        penalty_fee: 0n,

        interval_length: INTERVAL_LENGTH,
        num_intervals: NUM_INTERVALS,
        max_members: 10n,

        member_count: 0n,
        is_active: true,
        start_time,
        admin_payment_credential: adminPkh,
    };

    const createGroupTx = await createGroup(lucid, {
        groupDatum,
        utxoToSpend: adminUtxos[0],
    } as CreateGroupConfig).unsafeRun();

    console.log("1. Creating group...");
    const createGroupHash = await submitAndAwait(lucid, createGroupTx);
    console.log("   Hash:", createGroupHash);

    // Extract the permanent group token suffix from output 0
    const [groupMintUtxo] = await lucid.utxosByOutRef([{ txHash: createGroupHash, outputIndex: 0 }]);
    if (!groupMintUtxo) throw new Error("Could not fetch group mint UTxO");
    const groupTokenSuffix = extractSuffix(groupMintUtxo.assets, groupPolicyId!, assetNameLabels.prefix100);
    console.log("   groupTokenSuffix:", groupTokenSuffix);

    // ─────────────────────────────────────────────────────────────────────────
    // Step 2: Member creates an account
    // ─────────────────────────────────────────────────────────────────────────
    lucid.selectWallet.fromSeed(member.seedPhrase);
    const memberUtxos = await lucid.wallet().getUtxos();

    const createAccountTx = await createAccount(lucid, {
        selected_out_ref: memberUtxos[0],
        email: "member@dcu.io",
        phone: "555-0001",
    } as CreateAccountConfig).unsafeRun();

    console.log("2. Creating member account...");
    const createAccountHash = await submitAndAwait(lucid, createAccountTx);
    console.log("   Hash:", createAccountHash);

    // Extract the permanent account token suffix from output 0
    const [accountMintUtxo] = await lucid.utxosByOutRef([{ txHash: createAccountHash, outputIndex: 0 }]);
    if (!accountMintUtxo) throw new Error("Could not fetch account mint UTxO");
    const accountTokenSuffix = extractSuffix(accountMintUtxo.assets, accountPolicyId, assetNameLabels.prefix100);
    console.log("   accountTokenSuffix:", accountTokenSuffix);

    // ─────────────────────────────────────────────────────────────────────────
    // Step 3: Member joins the group (assigned_slot = 0 → borrower for currentSlot 0)
    //   Locks contributionAmount (8 ADA) in the Treasury NFT UTxO.
    // ─────────────────────────────────────────────────────────────────────────
    lucid.selectWallet.fromSeed(member.seedPhrase);

    const joinTxBuilder = await joinGroup(lucid, {
        groupTokenSuffix,
        accountTokenSuffix,
        contributionAmount,
        currentTime: BigInt(emulator.now()),
    } as JoinGroupConfig).unsafeRun();

    console.log("3. Member joining group (8 ADA deposited, assigned slot 0)...");
    const joinHash = await submitAndAwait(lucid, joinTxBuilder);
    console.log("   Hash:", joinHash);

    // ─────────────────────────────────────────────────────────────────────────
    // Step 4: Distribute payout to the current slot borrower (member, slot 0)
    //   All 3 entries claimable → payout = 3 × 2 ADA = 6 ADA → member wallet.
    //   Treasury retains 2 ADA (the min-ADA buffer).
    // ─────────────────────────────────────────────────────────────────────────
    lucid.selectWallet.fromSeed(member.seedPhrase);

    const distributePayoutTx = await distributePayout(lucid, {
        groupTokenSuffix,
    } as DistributePayoutConfig).unsafeRun();

    console.log("4. Distributing payout to slot-0 borrower (6 ADA → member wallet)...");
    const distributeHash = await submitAndAwait(lucid, distributePayoutTx);
    console.log("   Hash:", distributeHash);

    // ─────────────────────────────────────────────────────────────────────────
    // Step 5: Member exits the group (mature exit — no penalty)
    //   The group has matured: now >= start_time + num_intervals * interval_length.
    //   is_early_exit = is_active && now < maturity → False → mature exit.
    //   Treasury NFT is burned, remaining 2 ADA returned to the member.
    //   Group member_count decrements to 0.
    // ─────────────────────────────────────────────────────────────────────────
    lucid.selectWallet.fromSeed(member.seedPhrase);

    const exitGroupTx = await exitGroup(lucid, {
        groupTokenSuffix,
        accountTokenSuffix,
    } as ExitGroupConfig).unsafeRun();

    console.log("5. Member exiting group (mature exit — 2 ADA returned, no penalty)...");
    const exitHash = await submitAndAwait(lucid, exitGroupTx);
    console.log("   Hash:", exitHash);

    // ─────────────────────────────────────────────────────────────────────────
    // Step 6: Admin deletes the group (member_count = 0)
    //   RemoveGroup redeemer enforces member_count == 0. Group tokens are burned,
    //   ADA is reclaimed by the admin.
    // ─────────────────────────────────────────────────────────────────────────
    lucid.selectWallet.fromSeed(admin.seedPhrase);

    const deleteGroupTx = await deleteGroup(lucid, {
        groupTokenSuffix,
    } as DeleteGroupConfig).unsafeRun();

    console.log("6. Admin deleting group (member_count = 0, ADA reclaimed)...");
    const deleteHash = await submitAndAwait(lucid, deleteGroupTx);
    console.log("   Hash:", deleteHash);

    // ─────────────────────────────────────────────────────────────────────────
    console.log("\nROSCA lifecycle complete!");
    console.log("  Group created      ✓");
    console.log("  Account created    ✓");
    console.log("  Group joined       ✓  (8 ADA deposited, slot 0 assigned)");
    console.log("  Payout distributed ✓  (6 ADA → member, 2 ADA remaining in treasury)");
    console.log("  Group exited       ✓  (mature exit, 2 ADA returned, NFT burned)");
    console.log("  Group deleted      ✓  (admin reclaimed ADA, group tokens burned)");
}

main().catch(logError);
