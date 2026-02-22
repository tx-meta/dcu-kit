import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import {
  joinGroupTestCase,
  exitGroupTestCase,
  memberWithdrawTestCase,
  distributePayoutTestCase,
} from "./actions.js";
import { setupBase, setupGroup, setupAccount, setupMembership } from "./setup.js";
import { fromText } from "@lucid-evolution/lucid";
import { unsignedTerminateGroupTxProgram } from "../src/endpoints/terminateGroup.js";
import { signAndSubmit, findUtxoWithToken } from "../src/core/utils/index.js";
import { SetupError } from "../src/core/errors.js";

describe("Treasury Endpoints", () => {
  // --- Join Group ---
  it.effect("should allow a user with an account to join a group", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();

      const { context, scripts, groupUtxo } = yield* setupGroup(base);
      const { userUtxo } = yield* setupAccount(base);
      const { users, lucid } = context;

      if (!userUtxo) return yield* Effect.die(new SetupError({ message: "User Account UTxO not found" }));

      // Refetch Admin UTxO as it might have been spent by setupAccount
      const walletUtxos = yield* Effect.promise(() => lucid.wallet().getUtxos());
      const adminTokenName = fromText("GroupAdmin");
      const adminUtxo = yield* findUtxoWithToken(walletUtxos, scripts.group.mint.policyId!, adminTokenName).pipe(
        Effect.catchAll(() => Effect.die(new SetupError({ message: "Admin UTxO not found" })))
      );

      const result = yield* joinGroupTestCase(
        context,
        {
            groupUtxo,
            accountUtxo: userUtxo,
            adminUtxo,
            contributionAmount: 50_000_000n,
            userSeed: users.user1.seedPhrase
        }
      );
      expect(result.txHash).toHaveLength(64);
    }),
  );

  // --- Exit Group (Standard) ---
  it.effect("should allow a member to exit", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();

      const { context, scripts, groupUtxo, userUtxo, memberUtxo } = yield* setupMembership(base);
      const { users } = context;

      const result = yield* exitGroupTestCase(
        context,
        {
            groupUtxo,
            accountUtxo: userUtxo, // accountUtxo
            treasuryUtxo: memberUtxo,
            userSeed: users.user1.seedPhrase
        }
      );

      expect(result.txHash).toHaveLength(64);
    }),
  );

  // --- Exit Group (Mature) ---
  it.effect("should allow a member to exit gracefully (mature)", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();

      // Old start time
      const oneHour = 3600000n;
      const now = BigInt(Date.now());
      const oldStartTime = now - 11n * oneHour;

      const { context, scripts, groupUtxo, userUtxo, memberUtxo } = yield* setupMembership(base, 50_000_000n, { start_time: oldStartTime });
      const { users } = context;

      const result = yield* exitGroupTestCase(
        context,
        {
            groupUtxo,
            accountUtxo: userUtxo,
            treasuryUtxo: memberUtxo,
            userSeed: users.user1.seedPhrase
        }
      );

      expect(result.txHash).toHaveLength(64);
    }),
  );

  // --- Terminate Group ---
  it.effect("should allow terminating a membership (burn)", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      
      const { context, scripts, groupUtxo, memberUtxo, userUtxo } = yield* setupMembership(base);
      const { lucid } = context;

      // Group Reference 
       const groupName = fromText("GroupReference");
       // Re-verify Group Reference from setupMembership result or refetch if logic requires latest
       // setupMembership returns latest groupUtxo after join
      
      const unsignedTx = yield* unsignedTerminateGroupTxProgram(
        lucid,
        {
          groupUtxo,
          treasuryUtxo: memberUtxo,
        }
      );

      const txHash = yield* signAndSubmit(unsignedTx);
      expect(txHash).toHaveLength(64);
    }),
  );

  // --- Member Withdraw ---
  it.effect("should allow member to withdraw funds", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      
      const { context, scripts, groupUtxo, userUtxo, memberUtxo } = yield* setupMembership(base);
      const { users } = context;

      const result = yield* memberWithdrawTestCase(
        context,
        {
            groupUtxo,
            accountUtxo: userUtxo,
            treasuryUtxo: memberUtxo,
            withdrawAmount: 5_000_000n, // Withdraw 5 ADA
            userSeed: users.user1.seedPhrase
        }
      );

      expect(result.txHash).toBeDefined();
      expect(result.txHash).toHaveLength(64);
    }),
  );

  // --- Distribute Payout ---
  it.effect("should distribute payout to the assigned slot holder", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      
      const { context, scripts, groupUtxo, memberUtxo } = yield* setupMembership(base);
      const { users } = context;

      // Note: distributePayoutTestCase takes Array<UTxO> for Treasury?
      // Looking at params: context, groupUtxo, treasuryUtxo(s), scripts, seedPhrase
      // Previous call: treasuryUtxos (Array)
      
      const result = yield* distributePayoutTestCase(
        context,
        {
            groupUtxo,
            treasuryUtxos: [memberUtxo],
            callerSeed: users.user1.seedPhrase
        }
      );

      expect(result.txHash).toBeDefined();
      expect(result.txHash).toHaveLength(64);
    }),
  );
});
