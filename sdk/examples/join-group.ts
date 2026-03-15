/**
 * Join Group Example
 *
 * Demonstrates a member joining an existing ROSCA group.
 *
 * Emulator mode  (no API key set):
 *   Sets up all prerequisites inline — creates group, creates account, then joins.
 *   Two generated wallets (admin + member) are used automatically.
 *
 * Live network mode (BLOCKFROST_KEY or MAESTRO_API_KEY set in .env):
 *   Expects existing on-chain state — a group must already exist and the member
 *   must already have an account. Requires both USER1_SEED (member) and
 *   ADMIN_SEED (group creator who holds the GroupAdmin NFT) in .env.
 *
 * Multi-signature: joinGroup spends both the member's account UTxO and the
 * admin's GroupAdmin NFT, so both wallets must co-sign the transaction.
 */

import {
    Lucid,
    Emulator,
    PROTOCOL_PARAMETERS_DEFAULT,
    generateEmulatorAccount,
    validatorToAddress,
    fromText,
    LucidEvolution,
} from "@lucid-evolution/lucid";
import {
    createAccount,
    createGroup,
    joinGroup,
    CreateAccountConfig,
    CreateGroupConfig,
    JoinGroupConfig,
    GroupDatum,
    accountValidator,
    groupValidator,
    accountPolicyId,
    groupPolicyId,
} from "@dcu/sdk";
import { makeLucid } from "./context.js";

// --- Helpers ---

async function submitAndAwait(lucid: LucidEvolution, txBuilder: any): Promise<string> {
    const signed = await txBuilder.sign.withWallet().complete();
    const txHash = await signed.submit();
    await lucid.awaitTx(txHash);
    return txHash;
}

// --- Emulator Setup ---
// Creates group + account inline so the example is fully self-contained.

async function runOnEmulator() {
    const admin = generateEmulatorAccount({ lovelace: 100_000_000n });
    const member = generateEmulatorAccount({ lovelace: 100_000_000n });
    const emulator = new Emulator([admin, member], { ...PROTOCOL_PARAMETERS_DEFAULT });
    const lucid = await Lucid(emulator, "Custom");
    const NETWORK = "Custom";

    const accountScriptAddr = validatorToAddress(NETWORK, accountValidator.spendAccount);
    const groupScriptAddr = validatorToAddress(NETWORK, groupValidator.spendGroup);

    // Step 1: Admin creates a group
    lucid.selectWallet.fromSeed(admin.seedPhrase);
    let adminUtxos = await lucid.wallet().getUtxos();
    const groupDatum: GroupDatum = {
        contribution_fee_policyid: "", contribution_fee_assetname: "",
        contribution_fee: 5_000_000n,
        joining_fee_policyid: "", joining_fee_assetname: "", joining_fee: 0n,
        penalty_fee_policyid: "", penalty_fee_assetname: "", penalty_fee: 0n,
        interval_length: 3_600_000n, num_intervals: 5n,
        member_count: 0n, share_holding: false, is_active: true,
        start_time: BigInt(Date.now()),
    };
    const createGroupTx = await createGroup(lucid, { groupDatum, utxoToSpend: adminUtxos[0] } as CreateGroupConfig).unsafeRun();
    console.log("1. Creating group...");
    await submitAndAwait(lucid, createGroupTx);

    // Step 2: Member creates an account
    lucid.selectWallet.fromSeed(member.seedPhrase);
    let memberUtxos = await lucid.wallet().getUtxos();
    const createAccountTx = await createAccount(lucid, {
        selected_out_ref: memberUtxos[0],
        account_datum: { email_hash: fromText("member@dcu.io"), phone_hash: fromText("555-0001") },
    } as CreateAccountConfig).unsafeRun();
    console.log("2. Creating member account...");
    await submitAndAwait(lucid, createAccountTx);

    return { lucid, admin, member, accountScriptAddr, groupScriptAddr };
}

// --- Join Group (shared between emulator and live network) ---

async function joinGroupStep(
    lucid: LucidEvolution,
    adminSeed: string,
    memberSeed: string,
    accountScriptAddr: string,
    groupScriptAddr: string,
) {
    const groupRefAssetId = groupPolicyId + fromText("GroupReference");
    const adminNftAssetId = groupPolicyId + fromText("GroupAdmin");

    const groupUtxo = (await lucid.utxosAt(groupScriptAddr))
        .find(u => (u.assets[groupRefAssetId] ?? 0n) > 0n);
    if (!groupUtxo) throw new Error("Group UTxO not found");

    const accountUtxo = (await lucid.utxosAt(accountScriptAddr))
        .find(u => Object.keys(u.assets).some(k => k.startsWith(accountPolicyId)));
    if (!accountUtxo) throw new Error("Account UTxO not found");

    lucid.selectWallet.fromSeed(adminSeed);
    const adminUtxos = await lucid.wallet().getUtxos();
    const adminNftUtxo = adminUtxos.find(u => (u.assets[adminNftAssetId] ?? 0n) > 0n);
    if (!adminNftUtxo) throw new Error("Admin GroupAdmin NFT not found");

    lucid.selectWallet.fromSeed(memberSeed);
    const joinTxBuilder = await joinGroup(lucid, {
        groupUtxo,
        accountUtxo,
        adminUtxo: adminNftUtxo,
        contributionAmount: 10_000_000n,
    } as JoinGroupConfig).unsafeRun();

    // Member signs first, then admin co-signs (their GroupAdmin NFT is being spent)
    lucid.selectWallet.fromSeed(memberSeed);
    const partial = joinTxBuilder.sign.withWallet();
    lucid.selectWallet.fromSeed(adminSeed);
    const joinTx = await partial.sign.withWallet().complete();
    const txHash = await joinTx.submit();
    await lucid.awaitTx(txHash);
    return txHash;
}

// --- Main ---

async function main() {
    const { isEmulator } = await makeLucid(); // Used only to determine mode

    if (isEmulator) {
        const { lucid, admin, member, accountScriptAddr, groupScriptAddr } = await runOnEmulator();
        console.log("3. Member joining group (emulator)...");
        const txHash = await joinGroupStep(lucid, admin.seedPhrase, member.seedPhrase, accountScriptAddr, groupScriptAddr);
        console.log("   Joined:", txHash);
    } else {
        // Live network: group and account must already exist on-chain
        const { lucid } = await makeLucid();
        const network = (process.env.NETWORK ?? "Preprod") as "Preprod" | "Mainnet" | "Preview";
        const accountScriptAddr = validatorToAddress(network, accountValidator.spendAccount);
        const groupScriptAddr = validatorToAddress(network, groupValidator.spendGroup);

        const adminSeed = process.env.ADMIN_SEED;
        const userSeed = process.env.USER1_SEED;
        if (!adminSeed || !userSeed) throw new Error("ADMIN_SEED and USER1_SEED are required for live network");

        console.log("Joining group on", network, "...");
        const txHash = await joinGroupStep(lucid, adminSeed, userSeed, accountScriptAddr, groupScriptAddr);
        console.log("Joined! Hash:", txHash);
        console.log(`View: https://${network.toLowerCase()}.cexplorer.io/tx/${txHash}`);
    }

    console.log("\nDone! Member has successfully joined the ROSCA group.");
}

main().catch((e) => {
    console.error("Error:", e);
    process.exit(1);
});
