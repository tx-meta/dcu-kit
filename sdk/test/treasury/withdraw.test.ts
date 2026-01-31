
import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { joinGroupTestCase, memberWithdrawTestCase } from "./actions.js";
import { createAccountTestCase } from "../account/actions.js";
import { createGroupTestCase } from "../group/actions.js";
import { setupBase } from "../helpers/setupTest.js";
import { fromText } from "@lucid-evolution/lucid";

describe("Member Withdraw Endpoint", () => {
    it.effect("should allow member to withdraw funds", () => Effect.gen(function* () {
        const { context, scripts } = yield* setupBase();
        const { lucid, users } = context;

        // 1. Setup
        yield* createGroupTestCase(context, scripts);
        yield* createAccountTestCase(context, scripts);

        // Fetch UTxOs helpers (duplicated for isolation)
        const groupScriptAddr = scripts.group.spend.address;
        const groupUtxos = yield* Effect.promise(() => lucid.utxosAt(groupScriptAddr));
        const groupName = fromText("GroupReference");
        const foundGroupUtxo = groupUtxos.find(u => Object.keys(u.assets).some(k => k.includes(groupName)));

        lucid.selectWallet.fromSeed(users.user1.seedPhrase);
        const userUtxos = yield* Effect.promise(() => lucid.wallet().getUtxos());
        const accountPolicy = scripts.account.mint.policyId;
        const accountUtxo = userUtxos.find(u => Object.keys(u.assets).some(k => k.startsWith(accountPolicy)));

        const adminTokenName = fromText("GroupAdmin");
        const adminUtxo = userUtxos.find(u => Object.keys(u.assets).some(k => k.endsWith(adminTokenName)));
        if (!adminUtxo) throw new Error("Admin UTxO not found");

        // 2. Join
        yield* joinGroupTestCase(
            context,
            foundGroupUtxo!,
            accountUtxo!,
            adminUtxo,
            100_000_000n,
            scripts,
            users.user1.seedPhrase
        );

        // 3. Withdraw
        // Refetch states
        const groupUtxos2 = yield* Effect.promise(() => lucid.utxosAt(groupScriptAddr));
        const groupUtxo2 = groupUtxos2.find(u => Object.keys(u.assets).some(k => k.includes(groupName)));

        const treasuryAddr = scripts.treasury.spend.address;
        const treasuryUtxos = yield* Effect.promise(() => lucid.utxosAt(treasuryAddr));
        const treasuryUtxo = treasuryUtxos[0];

        const userUtxos2 = yield* Effect.promise(() => lucid.wallet().getUtxos());
        const accountUtxo2 = userUtxos2.find(u => Object.keys(u.assets).some(k => k.startsWith(accountPolicy)));

        const result = yield* memberWithdrawTestCase(
            context,
            groupUtxo2!,
            accountUtxo2!,
            treasuryUtxo,
            5_000_000n, // Withdraw 5 ADA
            scripts,
            users.user1.seedPhrase
        );

        expect(result.txHash).toBeDefined();
        expect(result.txHash).toHaveLength(64);
    }));
});
