import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Schedule } from "effect";
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
import { unsignedJoinGroupTxProgram } from "../src/endpoints/joinGroup.js";
import { unsignedExitGroupTxProgram } from "../src/endpoints/exitGroup.js";
import { signAndSubmit, selectWalletFromSeed, getScriptAddress, assetNameLabels } from "../src/core/utils/index.js";
import { SetupError } from "../src/core/errors.js";
import { treasuryValidator, groupValidator, groupPolicyId, accountPolicyId } from "../src/core/validators/constants.js";
import { extractTokenSuffix } from "./utils.js";

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

      const { context, groupUtxo, userUtxo } = yield* setupMembership(base);
      const { users } = context;

      const result = yield* exitGroupTestCase(
        context,
        {
            groupUtxo,
            accountUtxo: userUtxo,
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

      const { context, groupUtxo, userUtxo } = yield* setupMembership(base, 50_000_000n, { start_time: oldStartTime });
      const { users } = context;

      const result = yield* exitGroupTestCase(
        context,
        {
            groupUtxo,
            accountUtxo: userUtxo,
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
      const { context, groupUtxo, userUtxo } = yield* setupMembership(base);
      const { lucid, users } = context;

      // Step 1: Member does an early exit → creates a PenaltyState treasury UTxO
      const exitResult = yield* exitGroupTestCase(
        context,
        {
          groupUtxo,
          accountUtxo: userUtxo,
          userSeed: users.user1.seedPhrase,
        }
      );

      // Step 2: Find the PenaltyState UTxO and refreshed group UTxO from the exit tx.
      const treasuryScriptAddress = yield* getScriptAddress(lucid, treasuryValidator.spendTreasury);
      const groupScriptAddress    = yield* getScriptAddress(lucid, groupValidator.spendGroup);
      const [, refreshedGroupUtxo] = yield* Effect.tryPromise({
        try: async () => {
          const treasuryUtxos = await lucid.utxosAt(treasuryScriptAddress);
          const groupUtxos    = await lucid.utxosAt(groupScriptAddress);
          const penalty = treasuryUtxos.find(u => u.txHash === exitResult.txHash);
          const group   = groupUtxos.find(u => u.txHash === exitResult.txHash);
          if (!penalty) throw new Error("Penalty UTxO not indexed yet");
          if (!group)   throw new Error("Group UTxO not indexed yet");
          return [penalty, group] as const;
        },
        catch: (e) => e,
      }).pipe(
        Effect.retry({ schedule: Schedule.spaced(5000).pipe(Schedule.upTo(60000)) }),
        Effect.catchAll(() => Effect.die(new Error("Penalty or Group UTxO not found after early exit"))),
      );

      // Step 3: Admin terminates the penalty UTxO using token suffixes.
      // groupTokenSuffix from the refreshed group UTxO; memberAccountTokenSuffix from the account token.
      const groupTokenSuffix          = extractTokenSuffix(refreshedGroupUtxo, groupPolicyId!,  assetNameLabels.prefix100);
      const memberAccountTokenSuffix  = extractTokenSuffix(userUtxo,           accountPolicyId, assetNameLabels.prefix222);

      selectWalletFromSeed(lucid, users.user1.seedPhrase);
      const unsignedTx = yield* unsignedTerminateGroupTxProgram(
        lucid,
        { groupTokenSuffix, memberAccountTokenSuffix }
      );

      const txHash = yield* signAndSubmit(unsignedTx);
      expect(txHash).toHaveLength(64);
    }),
  );

  // --- Member Withdraw ---
  it.effect("should allow member to withdraw funds", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();

      // Start 3 intervals in the past so first 3 contribution_list entries are claimable:
      // total_claimable = 3 × 2 ADA = 6 ADA ≥ withdrawAmount 5 ADA.
      const oneHour = 3_600_000n;
      const pastStart = BigInt(Date.now()) - 3n * oneHour;

      const { context, groupUtxo, userUtxo } = yield* setupMembership(
        base,
        50_000_000n,
        { start_time: pastStart }
      );
      const { users } = context;

      const result = yield* memberWithdrawTestCase(
        context,
        {
            groupUtxo,
            accountUtxo: userUtxo,
            withdrawAmount: 5_000_000n, // Withdraw 5 ADA (≤ 6 ADA claimable)
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

      const { context, groupUtxo } = yield* setupMembership(
        base,
        50_000_000n,
        { start_time: oldStartTime, contribution_fee: 2_000_000n }
      );
      const { users } = context;

      const result = yield* distributePayoutTestCase(
        context,
        {
            groupUtxo,
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
      const { context, groupUtxo } = yield* setupMembership(base);
      const { lucid, users } = context;

      selectWalletFromSeed(lucid, users.user1.seedPhrase);

      const groupTokenSuffix = extractTokenSuffix(groupUtxo, groupPolicyId!, assetNameLabels.prefix100);
      const err = yield* Effect.flip(
        unsignedDistributePayoutTxProgram(lucid, { groupTokenSuffix })
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
      const { context, groupUtxo, userUtxo } = yield* setupMembership(base, 50_000_000n);
      const { lucid, users } = context;

      selectWalletFromSeed(lucid, users.user1.seedPhrase);

      const groupTokenSuffix   = extractTokenSuffix(groupUtxo, groupPolicyId!,  assetNameLabels.prefix100);
      const accountTokenSuffix = extractTokenSuffix(userUtxo,  accountPolicyId, assetNameLabels.prefix222);

      const err = yield* Effect.flip(
        unsignedMemberWithdrawTxProgram(lucid, {
          groupTokenSuffix,
          accountTokenSuffix,
          withdrawAmount: 60_000_000n,
        })
      );

      expect(err._tag).toBe("TransactionBuildError");
      expect((err as any).error).toContain("Insufficient funds");
    }),
  );

  // --- Negative: joinGroup with non-existent account ---
  it.effect("should fail joining a group when the account does not exist on-chain", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      const { context, groupUtxo } = yield* setupGroup(base);
      const { lucid, users } = context;

      selectWalletFromSeed(lucid, users.user1.seedPhrase);

      const groupTokenSuffix = extractTokenSuffix(groupUtxo, groupPolicyId!, assetNameLabels.prefix100);
      // Use a fake account suffix that does not exist on-chain → UtxoNotFoundError
      const fakeAccountSuffix = "00".repeat(28);

      const err = yield* Effect.flip(
        unsignedJoinGroupTxProgram(lucid, {
          groupTokenSuffix,
          accountTokenSuffix: fakeAccountSuffix,
          contributionAmount: 50_000_000n,
        })
      );

      expect(err._tag).toBe("UtxoNotFoundError");
    }),
  );

  // --- Negative: exitGroup when treasury UTxO is already in PenaltyState ---
  // After an early exit, the treasury moves to PenaltyState. A second exit attempt
  // should fail because no TreasuryState exists for that account anymore.
  it.effect("should fail exiting when the treasury UTxO is in PenaltyState", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();

      // Default start_time = now → early exit (is_active && now < maturity)
      const { context, groupUtxo, userUtxo } = yield* setupMembership(base);
      const { lucid, users } = context;

      // Step 1: early exit → treasury transitions to PenaltyState
      yield* exitGroupTestCase(context, {
        groupUtxo,
        accountUtxo: userUtxo,
        userSeed: users.user1.seedPhrase,
      });

      // Step 2: try to exit again — scan for TreasuryState finds nothing → UtxoNotFoundError
      const groupTokenSuffix   = extractTokenSuffix(groupUtxo, groupPolicyId!,  assetNameLabels.prefix100);
      const accountTokenSuffix = extractTokenSuffix(userUtxo,  accountPolicyId, assetNameLabels.prefix222);

      selectWalletFromSeed(lucid, users.user1.seedPhrase);
      const err = yield* Effect.flip(
        unsignedExitGroupTxProgram(lucid, { groupTokenSuffix, accountTokenSuffix })
      );

      expect(err._tag).toBe("UtxoNotFoundError");
    }),
  );

  // --- Negative: memberWithdraw when treasury UTxO is in PenaltyState ---
  // After an early exit, any withdrawal attempt should also fail for the same reason.
  it.effect("should fail a member withdrawal when the treasury UTxO is in PenaltyState", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();

      const { context, groupUtxo, userUtxo } = yield* setupMembership(base);
      const { lucid, users } = context;

      // Step 1: early exit → treasury transitions to PenaltyState
      yield* exitGroupTestCase(context, {
        groupUtxo,
        accountUtxo: userUtxo,
        userSeed: users.user1.seedPhrase,
      });

      // Step 2: try to withdraw — scan for TreasuryState finds nothing → UtxoNotFoundError
      const groupTokenSuffix   = extractTokenSuffix(groupUtxo, groupPolicyId!,  assetNameLabels.prefix100);
      const accountTokenSuffix = extractTokenSuffix(userUtxo,  accountPolicyId, assetNameLabels.prefix222);

      selectWalletFromSeed(lucid, users.user1.seedPhrase);
      const err = yield* Effect.flip(
        unsignedMemberWithdrawTxProgram(lucid, {
          groupTokenSuffix,
          accountTokenSuffix,
          withdrawAmount: 1_000_000n,
        })
      );

      expect(err._tag).toBe("UtxoNotFoundError");
    }),
  );

  // --- Negative: joinGroup when group is at max capacity ---
  // Creates a group capped at 1 member, fills it with user1, then attempts a second
  // join. The on-chain validator rejects: member_count < max_members → 1 < 1 → False.
  it.effect("should reject joining a group when at max capacity", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();

      // Group with max_members = 1; first join fills it (member_count becomes 1)
      const { context, groupUtxo, userUtxo } = yield* setupMembership(
        base,
        50_000_000n,
        { max_members: 1n }
      );
      const { lucid, users } = context;

      selectWalletFromSeed(lucid, users.user1.seedPhrase);

      const groupTokenSuffix   = extractTokenSuffix(groupUtxo, groupPolicyId!,  assetNameLabels.prefix100);
      const accountTokenSuffix = extractTokenSuffix(userUtxo,  accountPolicyId, assetNameLabels.prefix222);

      // Second join attempt — validator rejects because group is full
      const err = yield* Effect.flip(
        unsignedJoinGroupTxProgram(lucid, {
          groupTokenSuffix,
          accountTokenSuffix,
          contributionAmount: 50_000_000n,
        })
      );

      expect(err._tag).toBe("TransactionBuildError");
    }),
  );
});
