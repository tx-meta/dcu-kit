import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { setupAccount, setupBase, setupMembership } from "./setup.js";
import {
  createAccountTestCase,
  updateAccountTestCase,
  deleteAccountTestCase,
} from "./actions.js";
import { createDefaultAccountDatum } from "./utils.js";
import { SetupError } from "../src/core/errors.js";
import { unsignedDeleteAccountTxProgram } from "../src/endpoints/deleteAccount.js";

describe("Account Endpoints", () => {
  // --- Create Account ---
  it.effect("should create an account successfully", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      const { txHash, outputs } = yield* createAccountTestCase(base.context);

      expect(txHash).toBeDefined();
      expect(txHash).toHaveLength(64);
      expect(outputs.accountUtxo).toBeDefined();
    }).pipe(Effect.asVoid),
  );

  // --- Update Account ---
  it.effect("should update an account successfully", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      const { context, accountUtxo, userUtxo } = yield* setupAccount(base);

      if (!accountUtxo || !userUtxo)
        return yield* Effect.die(new SetupError({ message: "Setup failure" }));

      const { txHash } = yield* updateAccountTestCase(context, {
        accountUtxo,
        userUtxo,
        updatedDatum: createDefaultAccountDatum({
          email_hash: "ff".repeat(32),
          phone_hash: "ff".repeat(32),
        }),
      });

      expect(txHash).toBeDefined();
      expect(txHash).toHaveLength(64);
    }),
  );

  // --- Delete Account ---
  it.effect("should delete an account successfully", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      const { context, accountUtxo, userUtxo } = yield* setupAccount(base);

      if (!accountUtxo || !userUtxo)
        return yield* Effect.die(new SetupError({ message: "Setup failure" }));

      const { txHash } = yield* deleteAccountTestCase(context, { accountUtxo, userUtxo });

      expect(txHash).toBeDefined();
      expect(txHash).toHaveLength(64);
    }),
  );

  // --- Negative: delete account with active membership ---
  it.effect("should reject deleting an account that has an active group membership", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      // setupMembership: account created → group created → user joined
      const { context, scripts, userUtxo: accountAuthUtxo } = yield* setupMembership(base);
      const { lucid } = context;

      // userUtxo from setupMembership is the wallet-side 222 auth token.
      // deleteAccount also needs the script-side 100 reference token.
      const scriptUtxos = yield* Effect.promise(() =>
        lucid.utxosAt(scripts.account.spend.address)
      );
      const accountRefUtxo = scriptUtxos.find(u =>
        Object.keys(u.assets).some(k => k.startsWith(scripts.account.mint.policyId))
      );
      if (!accountRefUtxo)
        return yield* Effect.die(new SetupError({ message: "Account ref UTxO not found at script" }));

      const err = yield* Effect.flip(
        unsignedDeleteAccountTxProgram(lucid, {
          user_utxo: accountAuthUtxo,
          account_utxo: accountRefUtxo,
        })
      );

      expect(err._tag).toBe("TransactionBuildError");
      expect((err as any).error).toContain("active membership");
    }),
  );
});
