
import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { joinGroupTestCase } from "./actions.js";
import { createAccountTestCase } from "../account/actions.js";
import { createGroupTestCase } from "../group/actions.js";
import { setupBase } from "../helpers/setupTest.js";
import { fromText } from "@lucid-evolution/lucid";

describe("Join Group Endpoint", () => {
    it.effect("should allow a user with an account to join a group", () => Effect.gen(function* () {
        const { context, scripts } = yield* setupBase();
        const { lucid, users } = context;

        // 1. Create Group first to avoid consuming Account UTxO
        yield* createGroupTestCase(context, scripts);

        // 2. Create Account
        yield* createAccountTestCase(context, scripts);

        // 3. Find Group Reference UTxO
        const groupScriptAddr = scripts.group.spend.address;
        const groupUtxos = yield* Effect.promise(() => lucid.utxosAt(groupScriptAddr));
        const groupName = fromText("GroupReference");
        const foundGroupUtxo = groupUtxos.find(u => Object.keys(u.assets).some(k => k.includes(groupName)));
        if (!foundGroupUtxo) throw new Error("Group UTxO not found");

        // 4. Find Account UTxO
        lucid.selectWallet.fromSeed(users.user1.seedPhrase);
        const userUtxos = yield* Effect.promise(() => lucid.wallet().getUtxos());
        const accountPolicy = scripts.account.mint.policyId;
        const accountUtxo = userUtxos.find(u => Object.keys(u.assets).some(k => k.startsWith(accountPolicy)));
        if (!accountUtxo) throw new Error("Account UTxO not found");

        const adminTokenName = fromText("GroupAdmin");
        const adminUtxo = userUtxos.find(u => Object.keys(u.assets).some(k => k.endsWith(adminTokenName)));
        if (!adminUtxo) throw new Error("Admin UTxO not found");

        // 4. Join
        const result = yield* joinGroupTestCase(
            context,
            foundGroupUtxo!,
            accountUtxo!,
            adminUtxo,
            100_000_000n,
            scripts,
            users.user1.seedPhrase
        );
        expect(result.txHash).toHaveLength(64);
    }));
});
