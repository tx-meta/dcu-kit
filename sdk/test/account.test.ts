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
import {
  assetNameLabels,
  computeProfileCommitment,
  parseSafeDatum,
  patchInlineDatum,
} from "../src/core/utils/index.js";
import { AccountDatum } from "../src/core/types.js";
import { extractTokenSuffix } from "./utils.js";

describe("Account Endpoints", () => {
  // --- Create Account ---
  it.effect("should create an account successfully", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      const { txHash, outputs, accountTokenSuffix } =
        yield* createAccountTestCase(base.context);

      expect(txHash).toBeDefined();
      expect(txHash).toHaveLength(64);
      expect(outputs.accountUtxo).toBeDefined();

      // #59: the suffix surfaced by createAccount must be the permanent 28-byte
      // (56 hex char) CIP-68 identity, and must match the token actually minted
      // on-chain — i.e. consumers can trust it instead of re-deriving from output 0.
      expect(accountTokenSuffix).toHaveLength(56);
      expect(accountTokenSuffix).toBe(
        extractTokenSuffix(
          outputs.accountUtxo,
          accountPolicyId,
          assetNameLabels.prefix100,
        ),
      );
    }).pipe(Effect.asVoid),
  );

  // --- Profile commitment lifecycle ---
  it.effect(
    "creates with no profile by default, preserves on omitted update, clears on explicit empty",
    () =>
      Effect.gen(function* () {
        const base = yield* setupBase();

        // Default create → empty commitment on-chain.
        const { outputs } = yield* createAccountTestCase(base.context);
        const createdDatum = yield* parseSafeDatum<AccountDatum>(
          patchInlineDatum(outputs.accountUtxo).datum,
          AccountDatum,
        );
        expect(createdDatum.profile_commitment).toBe("");

        // Set a real commitment via update.
        const commitment = computeProfileCommitment(
          '{"name":"@alice"}',
          "0f".repeat(32),
        );
        const afterSet = yield* updateAccountTestCase(base.context, {
          accountUtxo: outputs.accountUtxo,
          profileCommitment: commitment,
        });
        const setDatum = yield* parseSafeDatum<AccountDatum>(
          patchInlineDatum(afterSet.outputs.accountUtxo).datum,
          AccountDatum,
        );
        expect(setDatum.profile_commitment).toBe(commitment);

        // Omitted commitment → the current value is PRESERVED.
        const afterOmit = yield* updateAccountTestCase(base.context, {
          accountUtxo: afterSet.outputs.accountUtxo,
        });
        const omitDatum = yield* parseSafeDatum<AccountDatum>(
          patchInlineDatum(afterOmit.outputs.accountUtxo).datum,
          AccountDatum,
        );
        expect(omitDatum.profile_commitment).toBe(commitment);

        // Explicit "" → cleared.
        const afterClear = yield* updateAccountTestCase(base.context, {
          accountUtxo: afterOmit.outputs.accountUtxo,
          profileCommitment: "",
        });
        const clearDatum = yield* parseSafeDatum<AccountDatum>(
          patchInlineDatum(afterClear.outputs.accountUtxo).datum,
          AccountDatum,
        );
        expect(clearDatum.profile_commitment).toBe("");
      }),
  );

  it.effect("rejects a malformed profile commitment", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      const result = yield* Effect.either(
        createAccountTestCase(base.context, {
          profileCommitment: "ab".repeat(31) + "a", // 63 hex chars
        }),
      );
      expect(result._tag).toBe("Left");
    }),
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
        profileCommitment: "ab".repeat(32),
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
