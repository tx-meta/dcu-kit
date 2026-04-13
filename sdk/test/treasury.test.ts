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
import { unsignedTerminateGroupTxProgram } from "../src/endpoints/terminateGroup.js";
import { unsignedDistributePayoutTxProgram } from "../src/endpoints/distributePayout.js";
import { unsignedMemberWithdrawTxProgram } from "../src/endpoints/memberWithdraw.js";
import { signAndSubmit, selectWalletFromSeed } from "../src/core/utils/index.js";
import { SetupError } from "../src/core/errors.js";

describe("Treasury Endpoints", () => {
  // --- Join Group ---
  it.effect("should allow a user with an account to join a group", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();

      const { context, groupUtxo } = yield* setupGroup(base);
      const { userUtxo } = yield* setupAccount(base);
      const { users } = context;

      if (!userUtxo) return yield* Effect.die(new SetupError({ message: "User Account UTxO not found" }));

      const result = yield* joinGroupTestCase(
        context,
        {
            groupUtxo,
            accountUtxo: userUtxo,
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

      const { context, groupUtxo, userUtxo, memberUtxo } = yield* setupMembership(base);
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

      const { context, groupUtxo, userUtxo, memberUtxo } = yield* setupMembership(base, 50_000_000n, { start_time: oldStartTime });
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

      // Default start_time = now → member is in active (non-mature) window → early exit
      const { context, scripts, groupUtxo, memberUtxo, userUtxo, adminUtxo } = yield* setupMembership(base);
      const { lucid, users } = context;

      // Step 1: Member does an early exit → creates a PenaltyState treasury UTxO
      const exitResult = yield* exitGroupTestCase(
        context,
        {
          groupUtxo,
          accountUtxo: userUtxo,
          treasuryUtxo: memberUtxo,
          userSeed: users.user1.seedPhrase,
        }
      );

      // Step 2: Find the PenaltyState UTxO and refreshed group UTxO from the exit tx
      const [penaltyUtxo, refreshedGroupUtxo] = yield* Effect.promise(async () => {
        const treasuryUtxos = await lucid.utxosAt(scripts.treasury.spend.address);
        const groupUtxos    = await lucid.utxosAt(scripts.group.spend.address);
        const penalty = treasuryUtxos.find(u => u.txHash === exitResult.txHash);
        const group   = groupUtxos.find(u => u.txHash === exitResult.txHash);
        if (!penalty) throw new Error("Penalty UTxO not found after early exit");
        if (!group)   throw new Error("Group UTxO not found after early exit");
        return [penalty, group] as const;
      });

      // Step 3: Admin terminates the penalty UTxO (wallet is already user1/admin after exitGroupTestCase)
      const unsignedTx = yield* unsignedTerminateGroupTxProgram(
        lucid,
        {
          groupUtxo: refreshedGroupUtxo,
          adminUtxo,
          treasuryUtxo: penaltyUtxo,
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
      
      const { context, groupUtxo, userUtxo, memberUtxo } = yield* setupMembership(base);
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

      // Use a start_time 20 intervals in the past so:
      // - currentSlot = 20 % 10 = 0 (matches the member's assigned_slot = 0)
      // - All 10 contribution_list entries are past their claimable_at timestamp
      const oneHour = 3600000n;
      const now = BigInt(Date.now());
      const oldStartTime = now - 20n * oneHour;

      const { context, groupUtxo, memberUtxo } = yield* setupMembership(
        base,
        50_000_000n,
        { start_time: oldStartTime, contribution_fee: 2_000_000n }
      );
      const { users } = context;

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

  // --- Negative: distributePayout with no claimable entries ---
  it.effect("should reject payout when no contributions are claimable yet", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();

      // Default start_time = now → all claimable_at are in the future → payoutAmount = 0
      const { context, groupUtxo, memberUtxo } = yield* setupMembership(base);
      const { lucid, users } = context;

      selectWalletFromSeed(lucid, users.user1.seedPhrase);

      const err = yield* Effect.flip(
        unsignedDistributePayoutTxProgram(lucid, { groupUtxo, treasuryUtxos: [memberUtxo] })
      );

      expect(err._tag).toBe("TransactionBuildError");
      expect((err as any).error).toContain("No claimable");
    }),
  );

  // --- Negative: memberWithdraw exceeding treasury balance ---
  it.effect("should reject withdrawal that exceeds treasury balance", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();

      // contribution = 50 ADA → treasury holds ~50 ADA; withdraw 60 ADA must fail
      const { context, groupUtxo, userUtxo, memberUtxo } = yield* setupMembership(base, 50_000_000n);
      const { lucid, users } = context;

      selectWalletFromSeed(lucid, users.user1.seedPhrase);

      const err = yield* Effect.flip(
        unsignedMemberWithdrawTxProgram(lucid, {
          groupUtxo,
          accountUtxo: userUtxo,
          treasuryUtxo: memberUtxo,
          withdrawAmount: 60_000_000n,
        })
      );

      expect(err._tag).toBe("TransactionBuildError");
      expect((err as any).error).toContain("Insufficient funds");
    }),
  );
});
