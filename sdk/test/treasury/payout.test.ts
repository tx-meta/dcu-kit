
import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { joinGroupTestCase, distributePayoutTestCase } from "./actions.js";
import { createAccountTestCase } from "../account/actions.js";
import { createGroupTestCase } from "../group/actions.js";
import { setupBase } from "../helpers/setupTest.js";
import { fromText } from "@lucid-evolution/lucid";

describe("Distribute Payout Endpoint", () => {
    it.effect("should distribute payout to the assigned slot holder", () => Effect.gen(function* () {
        const { context, scripts } = yield* setupBase();
        const { lucid, users } = context;

        // 1. Setup Account & Group
        yield* createGroupTestCase(context, scripts);
        yield* createAccountTestCase(context, scripts);

        // 2. Fetch Group UTxO
        const groupScriptAddr = scripts.group.spend.address;
        const groupUtxos = yield* Effect.promise(() => lucid.utxosAt(groupScriptAddr));
        const groupName = fromText("GroupReference");
        const foundGroupUtxo = groupUtxos.find(u => Object.keys(u.assets).some(k => k.includes(groupName)));
        if (!foundGroupUtxo) throw new Error("Group UTxO not found");

        // 3. Fetch Account UTxO
        lucid.selectWallet.fromSeed(users.user1.seedPhrase);
        const userUtxos = yield* Effect.promise(() => lucid.wallet().getUtxos());
        const accountPolicy = scripts.account.mint.policyId;
        const accountUtxo = userUtxos.find(u => Object.keys(u.assets).some(k => k.startsWith(accountPolicy)));
        if (!accountUtxo) throw new Error("Account UTxO not found");
        
        const adminTokenName = fromText("GroupAdmin");
        const adminUtxo = userUtxos.find(u => Object.keys(u.assets).some(k => k.endsWith(adminTokenName)));
        if (!adminUtxo) throw new Error("Admin UTxO not found");

        // 4. Join Group (User 1, Slot 0)
        yield* joinGroupTestCase(
            context,
            foundGroupUtxo!,
            accountUtxo!,
            adminUtxo,
            100_000_000n,
            scripts,
            users.user1.seedPhrase
        );

        // 5. Distribute Payout
        // Needs Updated Group UTxO & Treasury UTxOs
        const groupUtxos2 = yield* Effect.promise(() => lucid.utxosAt(groupScriptAddr));
        const groupUtxo2 = groupUtxos2.find(u => Object.keys(u.assets).some(k => k.includes(groupName)));
        if(!groupUtxo2) throw new Error("Updated Group UTxO not found");

        const treasuryAddr = scripts.treasury.spend.address;
        const treasuryUtxos = yield* Effect.promise(() => lucid.utxosAt(treasuryAddr));

        const result = yield* distributePayoutTestCase(
            context,
            groupUtxo2,
            treasuryUtxos,
            scripts,
            users.user1.seedPhrase
        );

        expect(result.txHash).toBeDefined();
        expect(result.txHash).toHaveLength(64);
    }));
});
