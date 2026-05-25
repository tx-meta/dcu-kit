import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { paymentCredentialOf } from "@lucid-evolution/lucid";
import {
  createAccountTestCase,
  joinGroupTestCase,
  exitGroupTestCase,
  distributePayoutTestCase,
  startGroupTestCase,
  updateGroupTestCase,
  nextCycleTestCase,
} from "./actions.js";
import { setupBase, setupGroup, setupAccount, setupMembership } from "./setup.js";
import { unsignedTerminateGroupTxProgram } from "../src/endpoints/terminateGroup.js";
import { unsignedDistributePayoutTxProgram } from "../src/endpoints/distributePayout.js";
import { unsignedJoinGroupTxProgram } from "../src/endpoints/joinGroup.js";
import { unsignedExitGroupTxProgram } from "../src/endpoints/exitGroup.js";
import { unsignedContributeTxProgram } from "../src/endpoints/contribute.js";
import { unsignedDeferRoundTxProgram } from "../src/endpoints/deferRound.js";
import { unsignedUpdatePayoutCredentialTxProgram } from "../src/endpoints/updatePayoutCredential.js";
import { unsignedExtendGraceWindowTxProgram } from "../src/endpoints/extendGraceWindow.js";
import {
  signAndSubmit,
  selectWalletFromSeed,
  getWalletAddress,
  assetNameLabels,
  parseSafeDatum,
  patchInlineDatum,
} from "../src/core/utils/index.js";
import { SetupError } from "../src/core/errors.js";
import { groupPolicyId, accountPolicyId } from "../src/core/validators/constants.js";
import { GroupDatum, GroupDatumSchema, TreasuryDatum, TreasuryDatumSchema } from "../src/core/types.js";
import { extractTokenSuffix } from "./utils.js";
import { advanceBlock } from "./effects.js";

describe("Treasury Endpoints", () => {
  // --- Join Group ---
  it.effect("should allow a user with an account to join a group", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();

      const { context, groupUtxo } = yield* setupGroup(base);
      const { userUtxo } = yield* setupAccount(base);
      const { users } = context;

      if (!userUtxo) return yield* Effect.die(new SetupError({ message: "User Account UTxO not found" }));

      const result = yield* joinGroupTestCase(context, {
        groupUtxo,
        accountUtxo: userUtxo,
        userSeed: users.user1.seedPhrase,
      });
      expect(result.txHash).toHaveLength(64);
    }),
  );

  // --- Exit Group (Standard) ---
  // With num_intervals=0 (no startGroup called), maturityTime = start_time.
  // Any exit at or after start_time is a mature exit (token burn, full refund).
  it.effect("should allow a member to exit", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();

      const { context, groupUtxo, userUtxo } = yield* setupMembership(base);
      const { users } = context;

      const result = yield* exitGroupTestCase(context, {
        groupUtxo,
        accountUtxo: userUtxo,
        userSeed: users.user1.seedPhrase,
      });

      expect(result.txHash).toHaveLength(64);
    }),
  );

  // --- Terminate Group ---
  // startGroup (with >= 2 members) sets num_intervals=2 and anchors start_time.
  // An exit shortly after startGroup is an early exit → PenaltyState created.
  // terminateGroup then burns that PenaltyState UTxO.
  it.effect("should allow terminating a membership (burn)", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      const { context, groupUtxo } = yield* setupGroup(base);
      const { lucid, users } = context;

      // Create accounts for both users — startGroup requires member_count >= 2.
      const { outputs: { userUtxo: user1AccountUtxo } } = yield* createAccountTestCase(context, {
        userSeed: users.user1.seedPhrase,
      });
      const { outputs: { userUtxo: user2AccountUtxo } } = yield* createAccountTestCase(context, {
        userSeed: users.user2.seedPhrase,
      });

      // Both users join. The token suffix from the initial groupUtxo is permanent
      // across UTxO spends, so each joinGroupTestCase resolves the current UTxO internally.
      yield* joinGroupTestCase(context, {
        groupUtxo, accountUtxo: user1AccountUtxo, userSeed: users.user1.seedPhrase,
      });
      yield* joinGroupTestCase(context, {
        groupUtxo, accountUtxo: user2AccountUtxo, userSeed: users.user2.seedPhrase,
      });

      // startGroup: seals membership, sets num_intervals=2, start_time=now.
      yield* startGroupTestCase(context, { groupUtxo });

      // user1 early exit: now < start_time + 2*interval_length → PenaltyState created.
      const exitResult = yield* exitGroupTestCase(context, {
        groupUtxo, accountUtxo: user1AccountUtxo, userSeed: users.user1.seedPhrase,
      });
      expect(exitResult.txHash).toHaveLength(64);

      // Admin terminates the PenaltyState UTxO via permanent token suffixes.
      const groupTokenSuffix         = extractTokenSuffix(groupUtxo,         groupPolicyId!,   assetNameLabels.prefix100);
      const memberAccountTokenSuffix = extractTokenSuffix(user1AccountUtxo,  accountPolicyId,  assetNameLabels.prefix222);

      selectWalletFromSeed(lucid, users.admin.seedPhrase);
      const unsignedTx = yield* unsignedTerminateGroupTxProgram(lucid, { groupTokenSuffix, memberAccountTokenSuffix });
      const txHash = yield* signAndSubmit(unsignedTx);
      expect(txHash).toHaveLength(64);
    }),
  );

  // --- Distribute Payout ---
  // Round 0: fresh treasury UTxOs have rounds_paid=0, which equals roundNumber=0.
  // After distribute, all treasury outputs have rounds_paid=1.
  it.effect("should distribute payout for round 0 and set rounds_paid to 1 in all treasury outputs", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      const { context, groupUtxo } = yield* setupGroup(base);
      const { users } = context;

      // Create accounts for both users — startGroup requires member_count >= 2.
      const { outputs: { userUtxo: user1AccountUtxo } } = yield* createAccountTestCase(context, {
        userSeed: users.user1.seedPhrase,
      });
      const { outputs: { userUtxo: user2AccountUtxo } } = yield* createAccountTestCase(context, {
        userSeed: users.user2.seedPhrase,
      });

      // user1 joins first → assigned_slot=0 (borrower for round 0).
      // user2 joins second → assigned_slot=1.
      yield* joinGroupTestCase(context, {
        groupUtxo, accountUtxo: user1AccountUtxo, userSeed: users.user1.seedPhrase,
      });
      yield* joinGroupTestCase(context, {
        groupUtxo, accountUtxo: user2AccountUtxo, userSeed: users.user2.seedPhrase,
      });

      // startGroup: sets num_intervals=2, is_started=true, start_time=now.
      yield* startGroupTestCase(context, { groupUtxo });

      // Distribute round 0: currentSlot=0%2=0 → user1 receives the pot.
      const result = yield* distributePayoutTestCase(context, {
        groupUtxo,
        callerSeed: users.user1.seedPhrase,
      });

      expect(result.txHash).toHaveLength(64);
      expect(result.treasuryOutputs.length).toBeGreaterThan(0);

      // All output treasury UTxOs must have rounds_paid=1 (round 0 consumed).
      for (const utxo of result.treasuryOutputs) {
        const patched = patchInlineDatum(utxo);
        const datum = (yield* parseSafeDatum(patched.datum, TreasuryDatumSchema)) as unknown as TreasuryDatum;
        if ("TreasuryState" in datum) {
          expect(datum.TreasuryState.rounds_paid).toBe(1n);
        }
      }
    }),
  );

  // --- Negative: distributePayout when group has not been started ---
  it.effect("should reject payout when the group has not been started", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();

      // One member joined but startGroup never called → is_started=false.
      const { context, groupUtxo } = yield* setupMembership(base);
      const { lucid, users } = context;

      selectWalletFromSeed(lucid, users.user1.seedPhrase);

      const groupTokenSuffix = extractTokenSuffix(groupUtxo, groupPolicyId!, assetNameLabels.prefix100);
      const err = yield* Effect.flip(
        unsignedDistributePayoutTxProgram(lucid, { groupTokenSuffix })
      );

      expect(err._tag).toBe("TransactionBuildError");
      if (err._tag === "TransactionBuildError") {
        expect(err.error).toContain("not been started");
      }
    }),
  );

  // --- Negative: joinGroup with non-existent account ---
  it.effect("should fail joining a group when the account does not exist on-chain", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      const { context, groupUtxo } = yield* setupGroup(base);
      const { lucid, users } = context;

      selectWalletFromSeed(lucid, users.user1.seedPhrase);

      const groupTokenSuffix  = extractTokenSuffix(groupUtxo, groupPolicyId!, assetNameLabels.prefix100);
      const fakeAccountSuffix = "00".repeat(28);

      const err = yield* Effect.flip(
        unsignedJoinGroupTxProgram(lucid, {
          groupTokenSuffix,
          accountTokenSuffix: fakeAccountSuffix,
        })
      );

      expect(err._tag).toBe("UtxoNotFoundError");
    }),
  );

  // --- Negative: exitGroup after treasury UTxO has been burned ---
  // With num_intervals=0 (no startGroup), every exit is a mature exit (burn).
  // After the burn, no TreasuryState exists for that account → second exit fails.
  it.effect("should fail exiting when the treasury UTxO no longer exists", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();

      const { context, groupUtxo, userUtxo } = yield* setupMembership(base);
      const { lucid, users } = context;

      // Step 1: mature exit → membership token burned, treasury UTxO destroyed.
      yield* exitGroupTestCase(context, {
        groupUtxo,
        accountUtxo: userUtxo,
        userSeed: users.user1.seedPhrase,
      });

      // Step 2: second exit attempt — no TreasuryState found → UtxoNotFoundError.
      const groupTokenSuffix   = extractTokenSuffix(groupUtxo,  groupPolicyId!,  assetNameLabels.prefix100);
      const accountTokenSuffix = extractTokenSuffix(userUtxo,   accountPolicyId, assetNameLabels.prefix222);

      selectWalletFromSeed(lucid, users.user1.seedPhrase);
      const err = yield* Effect.flip(
        unsignedExitGroupTxProgram(lucid, { groupTokenSuffix, accountTokenSuffix })
      );

      expect(err._tag).toBe("UtxoNotFoundError");
    }),
  );

  // --- Positive: joinGroup routes joining_fee to admin wallet ---
  // When joining_fee > 0, the SDK adds an output to admin_payment_credential.
  // The Aiken validator enforces this: joining_fee_routed? fails if the output is absent.
  it.effect("should route joining_fee to the admin wallet when joining_fee > 0", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      const { lucid, users } = base.context;

      // Derive the group creator's PKH so admin_payment_credential points to a real wallet.
      selectWalletFromSeed(lucid, users.user1.seedPhrase);
      const adminAddress = yield* getWalletAddress(lucid);
      const adminPkh = paymentCredentialOf(adminAddress).hash;

      const { context, groupUtxo } = yield* setupGroup(base, {
        joining_fee: 1_000_000n,
        admin_payment_credential: adminPkh,
      });
      const { userUtxo } = yield* setupAccount(base);
      if (!userUtxo) return yield* Effect.fail(new SetupError({ message: "User UTxO not found" }));

      selectWalletFromSeed(lucid, users.user1.seedPhrase);
      const groupTokenSuffix   = extractTokenSuffix(groupUtxo, groupPolicyId!,  assetNameLabels.prefix100);
      const accountTokenSuffix = extractTokenSuffix(userUtxo,  accountPolicyId, assetNameLabels.prefix222);

      const currentTime = base.context.emulator
          ? BigInt(base.context.emulator.now())
          : BigInt(Date.now()) - 120_000n;
      const txBuilder = yield* unsignedJoinGroupTxProgram(lucid, {
        groupTokenSuffix,
        accountTokenSuffix,
        currentTime,
      });
      const txHash = yield* signAndSubmit(txBuilder);
      expect(txHash).toHaveLength(64);
    }),
  );

  // --- Negative: joinGroup when group is at max capacity ---
  // Group capped at 1 member; first join fills it (member_count becomes 1).
  // A second join attempt is rejected by the on-chain validator: member_count < max_members → 1 < 1 → False.
  it.effect("should reject joining a group when at max capacity", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();

      const { context, groupUtxo, userUtxo } = yield* setupMembership(base, { max_members: 1n });
      const { lucid, users } = context;

      selectWalletFromSeed(lucid, users.user1.seedPhrase);

      const groupTokenSuffix   = extractTokenSuffix(groupUtxo, groupPolicyId!,  assetNameLabels.prefix100);
      const accountTokenSuffix = extractTokenSuffix(userUtxo,  accountPolicyId, assetNameLabels.prefix222);

      const err = yield* Effect.flip(
        unsignedJoinGroupTxProgram(lucid, { groupTokenSuffix, accountTokenSuffix })
      );

      expect(err._tag).toBe("TransactionBuildError");
    }),
  );

  // --- Positive: exit when group is deactivated (is_active=false) ---
  // Admin deactivates the group via UpdateGroup. The !is_active branch in
  // validate_exit_group takes the burn path regardless of timing — no penalty.
  it.effect("should allow exit when group is deactivated (is_active=false)", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      const { context, groupUtxo, userUtxo } = yield* setupMembership(base);
      const { lucid, users } = context;

      // Parse the current on-chain group datum (post-join: member_count=1, member_token_names=[...]).
      // UpdateGroup enforces member_count and member_token_names are unchanged, so we
      // must pass the post-join datum — not the creation datum from setupMembership.
      const patchedGroupUtxo = patchInlineDatum(groupUtxo);
      const currentGroupDatum = (yield* parseSafeDatum(patchedGroupUtxo.datum, GroupDatumSchema)) as unknown as GroupDatum;

      // Deactivate the group: only is_active changes (True → False). All other fields preserved.
      selectWalletFromSeed(lucid, users.admin.seedPhrase);
      yield* updateGroupTestCase(context, {
        groupUtxo,
        updatedDatum: { ...currentGroupDatum, is_active: false },
      });

      // User exits — the !is_active path in validate_exit_group burns the membership
      // token and returns ADA regardless of time. No PenaltyState is created.
      const result = yield* exitGroupTestCase(context, {
        groupUtxo,
        accountUtxo: userUtxo,
        userSeed: users.user1.seedPhrase,
      });
      expect(result.txHash).toHaveLength(64);
    }),
  );

  // --- Positive: mature exit after all rounds distributed (post-cycle) ---
  // Full ROSCA cycle with 2 members and short intervals (20 s = 20 slots).
  // After round 1 distributes, the emulator has advanced to exactly maturity_time
  // (start_time + 2 × 20_000ms). The exit reads emulator.now() which equals
  // maturity_time, so is_early_exit = false → burn path, no PenaltyState.
  //
  // Why interval_length = 20_000n?
  // The emulator advances 20 slots per awaitBlock(1) call. With 1-hour intervals
  // (3_600_000ms = 3600 slots) the second distribute would need slot 3800 but the
  // emulator is only at slot 240 — the emulator rejects txs with validFrom > tip.
  // Using 20_000ms intervals aligns exactly with the 20-slot-per-block emulator cadence.
  it.effect("should allow mature exit after all rounds are distributed", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      // interval_length = 20_000ms (20 slots). Each awaitBlock(1) advances 20 slots,
      // so one block = one full interval. Round 1 distribute fires at slot 220,
      // maturity is slot 240, and exit with emulator.now() is exactly at maturity.
      const { context, groupUtxo } = yield* setupGroup(base, { interval_length: 20_000n });
      const { users } = context;

      // Create accounts for both members — startGroup requires member_count >= 2.
      const { outputs: { userUtxo: user1AccountUtxo } } = yield* createAccountTestCase(context, {
        userSeed: users.user1.seedPhrase,
      });
      const { outputs: { userUtxo: user2AccountUtxo } } = yield* createAccountTestCase(context, {
        userSeed: users.user2.seedPhrase,
      });

      // user1 → slot 0 (borrower for round 0), user2 → slot 1 (borrower for round 1).
      yield* joinGroupTestCase(context, {
        groupUtxo, accountUtxo: user1AccountUtxo, userSeed: users.user1.seedPhrase,
      });
      yield* joinGroupTestCase(context, {
        groupUtxo, accountUtxo: user2AccountUtxo, userSeed: users.user2.seedPhrase,
      });

      // startGroup: seals membership, num_intervals=2, start_time = emulator.now().
      yield* startGroupTestCase(context, { groupUtxo });

      // Distribute round 0 then round 1. The endpoint reads last_distributed_round
      // from the on-chain group UTxO, so sequential calls advance round 0 → 1 automatically.
      // Each awaitBlock(1) advances the emulator by 20 slots = one interval.
      yield* distributePayoutTestCase(context, { groupUtxo, callerSeed: users.user1.seedPhrase });
      yield* distributePayoutTestCase(context, { groupUtxo, callerSeed: users.user2.seedPhrase });

      // user1 exits. emulator.now() = start_time + 2 × 20_000ms = maturity_time.
      // is_early_exit = is_active && start_time <= now && now < maturity_time
      //               = true && true && false  →  false → burn path (no PenaltyState).
      const result = yield* exitGroupTestCase(context, {
        groupUtxo,
        accountUtxo: user1AccountUtxo,
        userSeed: users.user1.seedPhrase,
      });
      expect(result.txHash).toHaveLength(64);
    }),
  );

  // --- Contribute ---
  // Member tops up their treasury UTxO. Datum must be unchanged; ADA must increase.
  it.effect("should allow a member to top up their treasury balance (Contribute)", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      const { context, userUtxo } = yield* setupMembership(base);
      const { lucid, users } = context;

      const accountTokenSuffix = extractTokenSuffix(userUtxo, accountPolicyId, assetNameLabels.prefix222);

      selectWalletFromSeed(lucid, users.user1.seedPhrase);
      const txBuilder = yield* unsignedContributeTxProgram(lucid, {
        accountTokenSuffix,
        topUpAmount: 2_000_000n,
      });
      const txHash = yield* signAndSubmit(txBuilder);
      expect(txHash).toHaveLength(64);
    }),
  );

  // --- DeferRound ---
  // Member defers their scheduled payout round (is_deferred flips to true).
  it.effect("should allow a member to defer their scheduled round (DeferRound)", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      const { context, userUtxo } = yield* setupMembership(base);
      const { lucid, users } = context;

      const accountTokenSuffix = extractTokenSuffix(userUtxo, accountPolicyId, assetNameLabels.prefix222);

      selectWalletFromSeed(lucid, users.user1.seedPhrase);
      const txBuilder = yield* unsignedDeferRoundTxProgram(lucid, { accountTokenSuffix });
      const txHash = yield* signAndSubmit(txBuilder);
      expect(txHash).toHaveLength(64);
    }),
  );

  // --- UpdatePayoutCredential ---
  // Member updates their payout destination to their current wallet address.
  it.effect("should allow a member to update their payout credential (UpdatePayoutCredential)", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      const { context, userUtxo } = yield* setupMembership(base);
      const { lucid, users } = context;

      const accountTokenSuffix = extractTokenSuffix(userUtxo, accountPolicyId, assetNameLabels.prefix222);

      selectWalletFromSeed(lucid, users.user1.seedPhrase);
      const txBuilder = yield* unsignedUpdatePayoutCredentialTxProgram(lucid, { accountTokenSuffix });
      const txHash = yield* signAndSubmit(txBuilder);
      expect(txHash).toHaveLength(64);
    }),
  );

  // --- ExtendGraceWindow ---
  // User1 joins with an intentionally low deposit (3 ADA = 1.5 × contribution_fee).
  // After distribute round 0, user1's balance = 3M - 2M = 1M < 2M → InsufficientCollateralState.
  // Admin then extends the grace window (grace_extensions_used 0 → 1).
  //
  // Why overrideDepositLovelace = 3_000_000?
  //   Standard deposit is max_members × contribution_fee = 2 × 2M = 4M.
  //   After one round: 4M - 2M = 2M which is NOT < 2M (no ICS trigger).
  //   With 3M: 3M - 2M = 1M < 2M → ICS triggered on round 0.
  it.effect("should allow admin to extend a member's grace window (ExtendGraceWindow)", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      const { context, groupUtxo } = yield* setupGroup(base, { interval_length: 20_000n });
      const { lucid, users } = context;

      // Both users need accounts — startGroup requires member_count >= 2.
      const { outputs: { userUtxo: user1AccountUtxo } } = yield* createAccountTestCase(context, {
        userSeed: users.user1.seedPhrase,
      });
      const { outputs: { userUtxo: user2AccountUtxo } } = yield* createAccountTestCase(context, {
        userSeed: users.user2.seedPhrase,
      });

      // User1 joins with a reduced deposit so round 0 triggers ICS for them.
      const groupTokenSuffix    = extractTokenSuffix(groupUtxo,        groupPolicyId!,  assetNameLabels.prefix100);
      const user1TokenSuffix    = extractTokenSuffix(user1AccountUtxo, accountPolicyId, assetNameLabels.prefix222);
      const user2TokenSuffix    = extractTokenSuffix(user2AccountUtxo, accountPolicyId, assetNameLabels.prefix222);

      selectWalletFromSeed(lucid, users.user1.seedPhrase);
      const joinUser1Tx = yield* unsignedJoinGroupTxProgram(lucid, {
        groupTokenSuffix,
        accountTokenSuffix: user1TokenSuffix,
        currentTime: BigInt(context.emulator!.now()),
        overrideDepositLovelace: 3_000_000n,   // 1.5× fee — triggers ICS after round 0
      });
      yield* signAndSubmit(joinUser1Tx);
      yield* advanceBlock(context.emulator);

      yield* joinGroupTestCase(context, {
        groupUtxo, accountUtxo: user2AccountUtxo, userSeed: users.user2.seedPhrase,
      });

      yield* startGroupTestCase(context, { groupUtxo });

      // Distribute round 0: user1 has 3M - 2M = 1M < 2M → InsufficientCollateralState.
      yield* distributePayoutTestCase(context, { groupUtxo, callerSeed: users.user1.seedPhrase });

      // Admin extends the grace window for user1.
      const memberAccountTokenSuffix = extractTokenSuffix(user1AccountUtxo, accountPolicyId, assetNameLabels.prefix222);
      selectWalletFromSeed(lucid, users.admin.seedPhrase);
      const txBuilder = yield* unsignedExtendGraceWindowTxProgram(lucid, {
        groupTokenSuffix,
        memberAccountTokenSuffix,
      });
      const txHash = yield* signAndSubmit(txBuilder);
      expect(txHash).toHaveLength(64);
    }),
  );

  // --- NextCycle ---
  // After all rounds are distributed, admin resets the group for a new rotation.
  // Members keep their slots; rounds_paid and is_deferred reset to 0/false.
  it.effect("should reset a mature group for a new cycle (NextCycle)", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      // interval_length=20_000ms so each awaitBlock(1) = one interval.
      const { context, groupUtxo } = yield* setupGroup(base, { interval_length: 20_000n });
      const { lucid, users } = context;

      // Create accounts for both members (startGroup requires member_count >= 2).
      const { outputs: { userUtxo: user1AccountUtxo } } = yield* createAccountTestCase(context, {
        userSeed: users.user1.seedPhrase,
      });
      const { outputs: { userUtxo: user2AccountUtxo } } = yield* createAccountTestCase(context, {
        userSeed: users.user2.seedPhrase,
      });

      // user1 → slot 0, user2 → slot 1.
      yield* joinGroupTestCase(context, { groupUtxo, accountUtxo: user1AccountUtxo, userSeed: users.user1.seedPhrase });
      yield* joinGroupTestCase(context, { groupUtxo, accountUtxo: user2AccountUtxo, userSeed: users.user2.seedPhrase });

      // Seal membership: num_intervals=2, start_time=now.
      yield* startGroupTestCase(context, { groupUtxo });

      // Distribute all 2 rounds (one awaitBlock = one interval).
      yield* distributePayoutTestCase(context, { groupUtxo, callerSeed: users.user1.seedPhrase });
      yield* distributePayoutTestCase(context, { groupUtxo, callerSeed: users.user2.seedPhrase });

      // Reset the group for the next cycle. Admin must sign.
      selectWalletFromSeed(lucid, users.admin.seedPhrase);
      const { txHash } = yield* nextCycleTestCase(context, { groupUtxo, adminSeed: users.admin.seedPhrase });
      expect(txHash).toHaveLength(64);

      // Verify group datum is reset.
      const groupTokenSuffix = extractTokenSuffix(groupUtxo, groupPolicyId!, assetNameLabels.prefix100);
      const groupUnit = groupPolicyId! + assetNameLabels.prefix100 + groupTokenSuffix;
      const updatedGroupUtxo = yield* Effect.tryPromise(() => lucid.utxoByUnit(groupUnit));
      if (!updatedGroupUtxo) throw new Error("Group UTxO not found after nextCycle");
      const groupDatum = yield* parseSafeDatum(patchInlineDatum(updatedGroupUtxo).datum, GroupDatumSchema);
      expect(groupDatum.is_started).toBe(false);
      expect(groupDatum.last_distributed_round).toBe(-1n);
      expect(groupDatum.num_intervals).toBe(0n);
      expect(groupDatum.start_time).toBe(0n);
      // member_count and member_token_names preserved
      expect(groupDatum.member_count).toBe(2n);
    }),
  );
});
