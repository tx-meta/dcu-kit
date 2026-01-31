
import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { joinGroupTestCase, exitGroupTestCase } from "./actions.js";
import { createAccountTestCase } from "../account/actions.js";
import { createGroupTestCase } from "../group/actions.js";
import { setupBase } from "../helpers/setupTest.js";
import { fromText } from "@lucid-evolution/lucid";

describe("Exit Group Endpoint", () => {
    it.effect("should allow a member to exit", () => Effect.gen(function* () {
        const { context, scripts } = yield* setupBase();
        const { lucid, users } = context;

        // 1. Setup
        yield* createGroupTestCase(context, scripts);
        yield* createAccountTestCase(context, scripts);

        // 2. Fetch Group
        const groupScriptAddr = scripts.group.spend.address;
        const groupUtxos = yield* Effect.promise(() => lucid.utxosAt(groupScriptAddr));
        const groupName = fromText("GroupReference");
        const foundGroupUtxo = groupUtxos.find(u => Object.keys(u.assets).some(k => k.includes(groupName)));

        // 3. Fetch Account
        lucid.selectWallet.fromSeed(users.user1.seedPhrase);
        const userUtxos = yield* Effect.promise(() => lucid.wallet().getUtxos());
        const accountPolicy = scripts.account.mint.policyId;
        const accountUtxo = userUtxos.find(u => Object.keys(u.assets).some(k => k.startsWith(accountPolicy)));

        const adminTokenName = fromText("GroupAdmin");
        const adminUtxo = userUtxos.find(u => Object.keys(u.assets).some(k => k.endsWith(adminTokenName)));
        if (!adminUtxo) throw new Error("Admin UTxO not found");

        // 4. Join
        yield* joinGroupTestCase(
            context,
            foundGroupUtxo!,
            accountUtxo!,
            adminUtxo,
            100_000_000n,
            scripts,
            users.user1.seedPhrase
        );

        // 5. Exit
        // Need Account (refetch) & Treasury Member UTxO
        const userUtxos2 = yield* Effect.promise(() => lucid.wallet().getUtxos());
        const accountUtxo2 = userUtxos2.find(u => Object.keys(u.assets).some(k => k.startsWith(accountPolicy)));
        if (!accountUtxo2) throw new Error("Account UTxO not found for exit");

        const groupUtxos2 = yield* Effect.promise(() => lucid.utxosAt(groupScriptAddr));
        const groupUtxo2 = groupUtxos2.find(u => Object.keys(u.assets).some(k => k.includes(groupName)));

        const treasuryAddr = scripts.treasury.spend.address;
        const treasuryUtxos = yield* Effect.promise(() => lucid.utxosAt(treasuryAddr));
        const memberUtxo = treasuryUtxos[0]; // Simplified: assume only one member

        const result = yield* exitGroupTestCase(
            context,
            groupUtxo2!,
            accountUtxo2,
            memberUtxo,
            scripts,
            users.user1.seedPhrase
        );

        expect(result.txHash).toBeDefined();
        expect(result.txHash).toHaveLength(64);
    }));


  it.effect("should allow a member to exit gracefully (mature)", () => Effect.gen(function* () {
        const { context, scripts } = yield* setupBase();
        const { lucid, users } = context;

        // 1. Setup with OLD start time to ensure maturity
        // Interval = 1hr, Num = 10 -> 10hrs. 
        // Set start time to 11 hours ago.
        const oneHour = 3600000n;
        const now = BigInt(Date.now());
        const oldStartTime = now - (11n * oneHour);

        yield* createGroupTestCase(context, scripts, { start_time: oldStartTime });
        yield* createAccountTestCase(context, scripts);

        // 2. Fetch Group (Same logic)
        const groupScriptAddr = scripts.group.spend.address;
        const groupUtxos = yield* Effect.promise(() => lucid.utxosAt(groupScriptAddr));
        const groupName = fromText("GroupReference");
        const foundGroupUtxo = groupUtxos.find(u => Object.keys(u.assets).some(k => k.includes(groupName)));

        // 3. Join
        lucid.selectWallet.fromSeed(users.user1.seedPhrase);
        const userUtxos = yield* Effect.promise(() => lucid.wallet().getUtxos());
        const accountPolicy = scripts.account.mint.policyId;
        const accountUtxo = userUtxos.find(u => Object.keys(u.assets).some(k => k.startsWith(accountPolicy)));
        const adminTokenName = fromText("GroupAdmin");
        const adminUtxo = userUtxos.find(u => Object.keys(u.assets).some(k => k.endsWith(adminTokenName)));

        yield* joinGroupTestCase(
            context,
            foundGroupUtxo!,
            accountUtxo!,
            adminUtxo!,
            100_000_000n,
            scripts,
            users.user1.seedPhrase
        );

        // 4. Exit (Should be Mature -> Burn)
        const userUtxos3 = yield* Effect.promise(() => lucid.wallet().getUtxos());
        const accountUtxo3 = userUtxos3.find(u => Object.keys(u.assets).some(k => k.startsWith(accountPolicy)));
        const groupUtxos3 = yield* Effect.promise(() => lucid.utxosAt(groupScriptAddr));
        const groupUtxo3 = groupUtxos3.find(u => Object.keys(u.assets).some(k => k.includes(groupName)));
        const treasuryUtxos = yield* Effect.promise(() => lucid.utxosAt(scripts.treasury.spend.address));
        const memberUtxo = treasuryUtxos[0]; 

        const result = yield* exitGroupTestCase(
            context,
            groupUtxo3!,
            accountUtxo3!,
            memberUtxo!,
            scripts,
            users.user1.seedPhrase
        );

        expect(result.txHash).toHaveLength(64);
  }));
});
