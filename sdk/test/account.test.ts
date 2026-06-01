import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { setupAccount, setupBase, setupMembership } from "./setup.js";
import {
  createAccountTestCase,
  updateAccountTestCase,
  deleteAccountTestCase,
} from "./actions.js";
import { SetupError } from "../src/core/errors.js";
import { unsignedDeleteAccountTxProgram } from "../src/endpoints/deleteAccount.js";
import { accountPolicyId } from "../src/core/validators/constants.js";
import { assetNameLabels } from "../src/core/utils/index.js";
import { extractTokenSuffix } from "./utils.js";

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
      const { context, accountUtxo } = yield* setupAccount(base);

      if (!accountUtxo)
        return yield* Effect.die(new SetupError({ message: "Setup failure" }));

      const { txHash } = yield* updateAccountTestCase(context, {
        accountUtxo,
        display_name: "updated_alice",
        contact: "updated@dcu.io",
      });

      expect(txHash).toBeDefined();
      expect(txHash).toHaveLength(64);
    }),
  );

  // --- Delete Account ---
  it.effect("should delete an account successfully", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      const { context, accountUtxo } = yield* setupAccount(base);

      if (!accountUtxo)
        return yield* Effect.die(new SetupError({ message: "Setup failure" }));

      const { txHash } = yield* deleteAccountTestCase(context, { accountUtxo });

      expect(txHash).toBeDefined();
      expect(txHash).toHaveLength(64);
    }),
  );

  // --- Negative: delete account with active membership ---
  it.effect(
    "should reject deleting an account that has an active group membership",
    () =>
      Effect.gen(function* () {
        const base = yield* setupBase();
        // setupMembership: account created → group created → user joined
        const { context, scripts } = yield* setupMembership(base);
        const { lucid } = context;

        // userUtxo from setupMembership is the wallet-side 222 auth token.
        // deleteAccount needs the script-side 100 reference token to derive the suffix.
        const scriptUtxos = yield* Effect.promise(() =>
          lucid.utxosAt(scripts.account.spend.address),
        );
        const accountRefUtxo = scriptUtxos.find((u) =>
          Object.keys(u.assets).some((k) =>
            k.startsWith(scripts.account.mint.policyId),
          ),
        );
        if (!accountRefUtxo)
          return yield* Effect.die(
            new SetupError({ message: "Account ref UTxO not found at script" }),
          );

        const accountTokenSuffix = extractTokenSuffix(
          accountRefUtxo,
          accountPolicyId,
          assetNameLabels.prefix100,
        );

        const err = yield* Effect.flip(
          unsignedDeleteAccountTxProgram(context.protocol!, lucid, {
            accountTokenSuffix,
          }),
        );

        expect(err._tag).toBe("TransactionBuildError");
        // err.error is a typed field on TransactionBuildError — no cast needed
        if (err._tag === "TransactionBuildError") {
          expect(err.error).toContain("active membership");
        }
      }),
  );
});
