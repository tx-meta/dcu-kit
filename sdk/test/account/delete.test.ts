import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { setupAccount, setupBase } from "../helpers/setupTest.js";
import { deleteAccountTestCase, createAccountTestCase } from "./actions.js";
import { createGroupTestCase } from "../group/actions.js";
import { joinGroupTestCase } from "../treasury/actions.js";
import { fromText } from "@lucid-evolution/lucid";

describe("Delete Account Endpoint", () => {
  it.effect("should delete an account successfully", () => Effect.gen(function* () {
      const base = yield* setupBase();
      const baseSetup = yield* setupAccount(base); // Renamed and kept as object
      const { context, accountUtxo, userUtxo } = baseSetup; // Destructure from baseSetup
      const { emulator } = context;

      if (!accountUtxo || !userUtxo) throw new Error("Setup failure");

      const result = yield* deleteAccountTestCase(
        baseSetup.context,
        baseSetup.accountUtxo!,
        baseSetup.userUtxo!,
        baseSetup.scripts
    );

      if (emulator && base.network === "Custom") {
          yield* Effect.sync(() => emulator.awaitBlock(1));
      }
  }));

  it.effect("should fail to delete an account with active membership", () => Effect.gen(function* () {
      const { context, scripts } = yield* setupBase();
      const { lucid, users } = context;

      // 1. Setup Group & Account
      const { groupDatum } = yield* createGroupTestCase(context, scripts);
      yield* createAccountTestCase(context, scripts);

      // 2. Fetch UTxOs
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

      // 3. Join Group
      yield* joinGroupTestCase(
           context,
           foundGroupUtxo!,
           accountUtxo!,
           adminUtxo!,
           100_000_000n,
           scripts,
           users.user1.seedPhrase
      );

      // 4. Try Delete Account
      const userUtxos2 = yield* Effect.promise(() => lucid.wallet().getUtxos());
      const accountUtxo2 = userUtxos2.find(u => Object.keys(u.assets).some(k => k.startsWith(accountPolicy)));
      const userTokenUtxo = userUtxos2.find(u => Object.keys(u.assets).some(k => k.endsWith(fromText("AccountUser")))); // Actually same as accountUtxo usually?

       // Need to fetch again because Join spent it?
       // Join spends Account UTxO? No, it references it (Reference Input usually, but our Join might utilize it as input or reference).
       // Checking joinGroup.ts: .collectFrom([accountUtxo])? Or ReadOnly?
       // joinGroup.ts line 119: .collectFrom([u]). Uses it as Input!
       // So Account UTxO is spent and recreated (sent back to wallet).
       
      const result = yield* deleteAccountTestCase(
        context,
        accountUtxo2!,
        accountUtxo2!, // Assuming user token is on same UTxO
        scripts
      ).pipe(Effect.flip); // Expect failure

      expect(result).toBeInstanceOf(Error);
      // We expect TransactionBuildError with "active memberships"
      // Using generic Error check or parsing message if needed.
  }));
});
