/**
 * ROSCA Lifecycle Example
 *
 * Demonstrates the complete end-to-end flow of a DCU ROSCA group on the Emulator:
 *
 *   1. Admin creates a group
 *   2. Member creates an account
 *   3. Member joins the group (deposits 10 ADA into Treasury)
 *   4. Distribute payout to the current slot borrower (member, slot 0)
 *   5. Member withdraws their remaining Treasury balance
 *
 * Time setup:
 *   - start_time is set 3 intervals in the past so currentSlot = 0 and
 *     all contribution_list entries are already claimable.
 *   - The member who joined first is assigned slot 0, so they are the borrower.
 */

import "dotenv/config";
import {
    Lucid,
    Emulator,
    PROTOCOL_PARAMETERS_DEFAULT,
    generateEmulatorAccount,
    validatorToAddress,
    fromText,
} from "@lucid-evolution/lucid";
import {
    createAccount,
    createGroup,
    joinGroup,
    distributePayout,
    memberWithdraw,
    CreateAccountConfig,
    CreateGroupConfig,
    JoinGroupConfig,
    DistributePayoutConfig,
    MemberWithdrawConfig,
    GroupDatum,
    accountValidator,
    groupValidator,
    treasuryValidator,
    accountPolicyId,
    groupPolicyId,
    treasuryPolicyId,
} from "@dcu/sdk";

const NETWORK = "Custom"; // emulator network

// --- Helpers ---

type LucidInstance = Awaited<ReturnType<typeof Lucid>>;

async function submitAndAwait(lucid: LucidInstance, txBuilder: any): Promise<string> {
    const signed = await txBuilder.sign.withWallet().complete();
    const txHash = await signed.submit();
    await lucid.awaitTx(txHash);
    return txHash;
}

// --- Main ---

async function main() {
    // Two wallets: admin creates the group, member joins and receives payout
    const admin = generateEmulatorAccount({ lovelace: 100_000_000n });
    const member = generateEmulatorAccount({ lovelace: 100_000_000n });
    const emulator = new Emulator([admin, member], { ...PROTOCOL_PARAMETERS_DEFAULT });
    const lucid = await Lucid(emulator, NETWORK);

    // Script addresses for UTxO queries
    const accountScriptAddr = validatorToAddress(NETWORK, accountValidator.spendAccount);
    const groupScriptAddr = validatorToAddress(NETWORK, groupValidator.spendGroup);
    const treasuryScriptAddr = validatorToAddress(NETWORK, treasuryValidator.spendTreasury);

    // --- Timing: set start_time in the past so all contributions are claimable ---
    // With num_intervals=3 and start_time = now - 3*interval - buffer:
    //   currentSlot = floor((now - start_time) / interval) % 3 = floor(3.016) % 3 = 0
    //   All contribution_list entries have claimable_at <= now
    const NUM_INTERVALS = 3n;
    const INTERVAL_LENGTH = 3_600_000n; // 1 hour in ms
    const CONTRIBUTION_FEE = 2_000_000n; // 2 ADA
    const start_time = BigInt(Date.now()) - NUM_INTERVALS * INTERVAL_LENGTH - 60_000n;

    // ─────────────────────────────────────────────────────────────────────────
    // Step 1: Admin creates the group
    // ─────────────────────────────────────────────────────────────────────────
    lucid.selectWallet.fromSeed(admin.seedPhrase);
    let adminUtxos = await lucid.wallet().getUtxos();

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
        member_count: 0n,
        share_holding: false,
        is_active: true,
        start_time,
    };

    const createGroupTx = await createGroup(lucid, {
        groupDatum,
        utxoToSpend: adminUtxos[0],
    } as CreateGroupConfig).unsafeRun();

    console.log("1. Creating group...");
    const createGroupHash = await submitAndAwait(lucid, createGroupTx);
    console.log("   Hash:", createGroupHash);

    // ─────────────────────────────────────────────────────────────────────────
    // Step 2: Member creates an account
    // ─────────────────────────────────────────────────────────────────────────
    lucid.selectWallet.fromSeed(member.seedPhrase);
    let memberUtxos = await lucid.wallet().getUtxos();

    const createAccountTx = await createAccount(lucid, {
        selected_out_ref: memberUtxos[0],
        account_datum: {
            email_hash: fromText("member@dcu.io"),
            phone_hash: fromText("555-0001"),
        },
    } as CreateAccountConfig).unsafeRun();

    console.log("2. Creating member account...");
    const createAccountHash = await submitAndAwait(lucid, createAccountTx);
    console.log("   Hash:", createAccountHash);

    // ─────────────────────────────────────────────────────────────────────────
    // Step 3: Member joins the group
    //   - Deposits 10 ADA into Treasury
    //   - Gets assigned_slot = 0 (first member, currentSlot = 0 → they are borrower)
    //   - Admin co-signs since their GroupAdmin NFT is spent as auth proof
    // ─────────────────────────────────────────────────────────────────────────

    // Find UTxOs needed for joinGroup
    const groupRefAssetId = groupPolicyId + fromText("GroupReference");
    const groupUtxo = (await lucid.utxosAt(groupScriptAddr))
        .find(u => (u.assets[groupRefAssetId] ?? 0n) > 0n);
    if (!groupUtxo) throw new Error("Group UTxO not found");

    const accountScriptUtxos = await lucid.utxosAt(accountScriptAddr);
    const accountUtxo = accountScriptUtxos.find(u =>
        Object.keys(u.assets).some(k => k.startsWith(accountPolicyId))
    );
    if (!accountUtxo) throw new Error("Account UTxO not found");

    lucid.selectWallet.fromSeed(admin.seedPhrase);
    adminUtxos = await lucid.wallet().getUtxos();
    const adminNftAssetId = groupPolicyId + fromText("GroupAdmin");
    const adminNftUtxo = adminUtxos.find(u => (u.assets[adminNftAssetId] ?? 0n) > 0n);
    if (!adminNftUtxo) throw new Error("Admin GroupAdmin NFT not found");

    lucid.selectWallet.fromSeed(member.seedPhrase);
    const joinTxBuilder = await joinGroup(lucid, {
        groupUtxo,
        accountUtxo,
        adminUtxo: adminNftUtxo,
        contributionAmount: 10_000_000n, // 10 ADA deposited
    } as JoinGroupConfig).unsafeRun();

    console.log("3. Member joining group (member + admin co-sign)...");
    lucid.selectWallet.fromSeed(member.seedPhrase);
    const partialJoin = joinTxBuilder.sign.withWallet();
    lucid.selectWallet.fromSeed(admin.seedPhrase);
    const joinTx = await partialJoin.sign.withWallet().complete();
    const joinHash = await joinTx.submit();
    await lucid.awaitTx(joinHash);
    console.log("   Hash:", joinHash);

    // ─────────────────────────────────────────────────────────────────────────
    // Step 4: Distribute payout to the current slot borrower (member, slot 0)
    //   - Payout = sum of claimable contributions = 3 intervals × 2 ADA = 6 ADA
    //   - Sent to caller's wallet (member is both borrower and trigger here)
    // ─────────────────────────────────────────────────────────────────────────

    // Find updated group UTxO and all treasury UTxOs
    const updatedGroupUtxo = (await lucid.utxosAt(groupScriptAddr))
        .find(u => (u.assets[groupRefAssetId] ?? 0n) > 0n);
    if (!updatedGroupUtxo) throw new Error("Updated group UTxO not found");

    const treasuryUtxos = (await lucid.utxosAt(treasuryScriptAddr))
        .filter(u => Object.keys(u.assets).some(k => k.startsWith(treasuryPolicyId)));
    if (treasuryUtxos.length === 0) throw new Error("No treasury UTxOs found");

    lucid.selectWallet.fromSeed(member.seedPhrase);
    const distributePayoutTx = await distributePayout(lucid, {
        groupUtxo: updatedGroupUtxo,
        treasuryUtxos,
    } as DistributePayoutConfig).unsafeRun();

    console.log("4. Distributing payout to slot-0 borrower (6 ADA → member)...");
    const distributeHash = await submitAndAwait(lucid, distributePayoutTx);
    console.log("   Hash:", distributeHash);

    // ─────────────────────────────────────────────────────────────────────────
    // Step 5: Member withdraws their remaining Treasury balance (2 ADA)
    //   Treasury after payout: 10 ADA − 6 ADA = 4 ADA remaining
    //   Withdraw 2 ADA; 2 ADA stays in treasury as min-ADA
    // ─────────────────────────────────────────────────────────────────────────

    // Find updated treasury UTxO and member's account UTxO (now in wallet after joinGroup)
    const updatedTreasuryUtxo = (await lucid.utxosAt(treasuryScriptAddr))
        .find(u => Object.keys(u.assets).some(k => k.startsWith(treasuryPolicyId)));
    if (!updatedTreasuryUtxo) throw new Error("Updated treasury UTxO not found");

    // After joinGroup, the account reference NFT is returned to the member's wallet
    lucid.selectWallet.fromSeed(member.seedPhrase);
    memberUtxos = await lucid.wallet().getUtxos();
    const accountUtxoInWallet = memberUtxos.find(u =>
        Object.keys(u.assets).some(k => k.startsWith(accountPolicyId))
    );
    if (!accountUtxoInWallet) throw new Error("Account UTxO not found in member wallet");

    const finalGroupUtxo = (await lucid.utxosAt(groupScriptAddr))
        .find(u => (u.assets[groupRefAssetId] ?? 0n) > 0n);
    if (!finalGroupUtxo) throw new Error("Final group UTxO not found");

    const memberWithdrawTx = await memberWithdraw(lucid, {
        groupUtxo: finalGroupUtxo,
        accountUtxo: accountUtxoInWallet,
        treasuryUtxo: updatedTreasuryUtxo,
        withdrawAmount: 2_000_000n, // 2 ADA
    } as MemberWithdrawConfig).unsafeRun();

    console.log("5. Member withdrawing 2 ADA from treasury...");
    const withdrawHash = await submitAndAwait(lucid, memberWithdrawTx);
    console.log("   Hash:", withdrawHash);

    // ─────────────────────────────────────────────────────────────────────────
    console.log("\nROSCA lifecycle complete!");
    console.log("  Group created      ✓");
    console.log("  Account created    ✓");
    console.log("  Group joined       ✓  (10 ADA deposited)");
    console.log("  Payout distributed ✓  (6 ADA → member)");
    console.log("  Member withdrew    ✓  (2 ADA from treasury)");
}

main().catch((e) => {
    console.error("Error:", e);
    process.exit(1);
});
