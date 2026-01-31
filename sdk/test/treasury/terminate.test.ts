
import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { joinGroupTestCase } from "./actions.js"; // Reuse existing
import { createAccountTestCase } from "../account/actions.js";
import { createGroupTestCase } from "../group/actions.js";
import { setupBase } from "../helpers/setupTest.js";
import { fromText } from "@lucid-evolution/lucid";
import { unsignedTerminateGroupTxProgram } from "../../src/endpoints/terminateGroup.js";
import { signAndSubmit } from "../../src/core/utils.js";

describe("Terminate Group Endpoint", () => {
    it.effect("should allow terminating a membership (burn)", () => Effect.gen(function* () {
        const { context, scripts } = yield* setupBase();
        const { lucid, users } = context;

        // 1. Setup
        yield* createGroupTestCase(context, scripts);
        yield* createAccountTestCase(context, scripts);

        // Fetch Group
        const groupScriptAddr = scripts.group.spend.address;
        const groupUtxos = yield* Effect.promise(() => lucid.utxosAt(groupScriptAddr));
        const groupName = fromText("GroupReference");
        const foundGroupUtxo = groupUtxos.find(u => Object.keys(u.assets).some(k => k.includes(groupName)));

        // Fetch Account
        lucid.selectWallet.fromSeed(users.user1.seedPhrase);
        const userUtxos = yield* Effect.promise(() => lucid.wallet().getUtxos());
        const accountPolicy = scripts.account.mint.policyId;
        const accountUtxo = userUtxos.find(u => Object.keys(u.assets).some(k => k.startsWith(accountPolicy)));
        const adminTokenName = fromText("GroupAdmin");
        const adminUtxo = userUtxos.find(u => Object.keys(u.assets).some(k => k.endsWith(adminTokenName)));

        // 2. Join
        yield* joinGroupTestCase(
            context,
            foundGroupUtxo!,
            accountUtxo!,
            adminUtxo!,
            100_000_000n,
            scripts,
            users.user1.seedPhrase
        );

        // 3. Terminate (Burn)
        // Refetch Treasury UTxO
        const treasuryAddr = scripts.treasury.spend.address;
        const treasuryUtxos = yield* Effect.promise(() => lucid.utxosAt(treasuryAddr));
        const memberUtxo = treasuryUtxos[0];
        
        // Refetch Group (Reference)
        const groupUtxos2 = yield* Effect.promise(() => lucid.utxosAt(groupScriptAddr));
        const groupUtxoRef = groupUtxos2.find(u => Object.keys(u.assets).some(k => k.includes(groupName)));
        
        // Refetch User Account (if needed? Endpoint doesn't seemingly require it, checking my impl)
        // My implementation above commented out accountUtxo collection. 
        // Let's pass accountUtxo just in case if I decide to use it, but `unsignedTerminateGroupTxProgram` ignores it currently.
        
        const unsignedTx = yield* unsignedTerminateGroupTxProgram(
            lucid,
            groupUtxoRef!,
            memberUtxo,
            scripts
        );

        const txHash = yield* signAndSubmit(unsignedTx);
        
        expect(txHash).toHaveLength(64);
    }));
});
