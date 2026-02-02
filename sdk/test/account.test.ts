import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { setupAccount, setupBase, setupMembership } from "./setup.js";
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
        baseSetup.scripts,
      );

      if (emulator && base.network === "Custom") {
        yield* Effect.sync(() => emulator.awaitBlock(1));
      }
    }),
  );

  it.effect("should fail to delete an account with active membership", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      
      // Setup Group, Account, and Join Membership
      const { context, scripts, userUtxo } = yield* setupMembership(base);

      // Try Delete Account (Should fail)
      // Note: deleteAccount logic queries Treasury. If membership exists, it fails.
      
      // Need to refetch Account UTxO because setupMembership might return an older utxo version?
      // setupMembership returns `userUtxo` (Account UTxO) after Join.
      
      const result = yield* deleteAccountTestCase(
        context,
        scripts,
      ).pipe(Effect.flip); // Expect failure

      expect(result).toBeInstanceOf(Error);
    }),
  );
});
