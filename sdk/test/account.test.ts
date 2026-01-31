import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { setupAccount, setupBase } from "./setup.js";
import {
  createAccountTestCase,
  updateAccountTestCase,
  deleteAccountTestCase,
  createGroupTestCase,
  joinGroupTestCase
} from "./actions.js";
import { fromText } from "@lucid-evolution/lucid";
import { AccountDatum } from "../src/core/types.js";
import { createDefaultAccountDatum } from "./utils.js";
import { SetupError } from "../src/core/errors.js";

describe("Account Endpoints", () => {
  // --- Create Account ---
  it.effect(
    "should create an account successfully",
    () =>
      Effect.gen(function* () {
        const baseSetup = yield* setupBase();
        const result = yield* createAccountTestCase(
          baseSetup.context,
          baseSetup.scripts,
        );

        expect(result.txHash).toBeDefined();
        expect(result.txHash).toHaveLength(64);
      }).pipe(Effect.asVoid),
  );

  // --- Update Account ---
  it.effect("should update an account successfully", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      const baseSetup = yield* setupAccount(base);
      const { emulator } = baseSetup.context;

      if (!baseSetup.accountUtxo || !baseSetup.userUtxo)
        return yield* Effect.die(new SetupError({ message: "Setup failure" }));

      const result = yield* updateAccountTestCase(
        baseSetup.context,
        baseSetup.accountUtxo!,
        baseSetup.userUtxo!,
        createDefaultAccountDatum({
          email_hash: fromText("updated"),
          phone_hash: fromText("updated"),
        }),
        baseSetup.scripts,
      );

      expect(result.txHash).toBeDefined();

      if (emulator && base.network === "Custom") {
        yield* Effect.sync(() => emulator.awaitBlock(1));
      }
    }),
  );

  // --- Delete Account ---
  it.effect("should delete an account successfully", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      const baseSetup = yield* setupAccount(base);
      const { context, accountUtxo, userUtxo } = baseSetup;
      const { emulator } = context;

      if (!accountUtxo || !userUtxo) return yield* Effect.die(new SetupError({ message: "Setup failure" }));

      const result = yield* deleteAccountTestCase(
        baseSetup.context,
        baseSetup.accountUtxo!,
        baseSetup.userUtxo!,
        baseSetup.scripts,
      );

      if (emulator && base.network === "Custom") {
        yield* Effect.sync(() => emulator.awaitBlock(1));
      }
    }),
  );

  it.effect("should fail to delete an account with active membership", () =>
    Effect.gen(function* () {
      const { context, scripts } = yield* setupBase();
      const { lucid, users } = context;

      // 1. Setup Group & Account
      yield* createGroupTestCase(context, scripts);
      yield* createAccountTestCase(context, scripts);

      // 2. Fetch UTxOs
      const groupScriptAddr = scripts.group.spend.address;
      const groupUtxos = yield* Effect.promise(() =>
        lucid.utxosAt(groupScriptAddr),
      );
      const groupName = fromText("GroupReference");
      const foundGroupUtxo = groupUtxos.find((u) =>
        Object.keys(u.assets).some((k) => k.includes(groupName)),
      );

      lucid.selectWallet.fromSeed(users.user1.seedPhrase);
      const userUtxos = yield* Effect.promise(() => lucid.wallet().getUtxos());
      const accountPolicy = scripts.account.mint.policyId;
      const accountUtxo = userUtxos.find((u) =>
        Object.keys(u.assets).some((k) => k.startsWith(accountPolicy)),
      );
      const adminTokenName = fromText("GroupAdmin");
      const adminUtxo = userUtxos.find((u) =>
        Object.keys(u.assets).some((k) => k.endsWith(adminTokenName)),
      );

      // 3. Join Group
      yield* joinGroupTestCase(
        context,
        foundGroupUtxo!,
        accountUtxo!,
        adminUtxo!,
        100_000_000n,
        scripts,
        users.user1.seedPhrase,
      );

      // 4. Try Delete Account
      const userUtxos2 = yield* Effect.promise(() => lucid.wallet().getUtxos());
      const accountUtxo2 = userUtxos2.find((u) =>
        Object.keys(u.assets).some((k) => k.startsWith(accountPolicy)),
      );

      const result = yield* deleteAccountTestCase(
        context,
        accountUtxo2!,
        accountUtxo2!,
        scripts,
      ).pipe(Effect.flip); // Expect failure

      expect(result).toBeInstanceOf(Error);
    }),
  );
});
