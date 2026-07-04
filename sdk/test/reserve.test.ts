import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { BaseSetup, setupBase, setupGroup } from "./setup.js";
import {
  createAccountTestCase,
  joinGroupTestCase,
  startGroupTestCase,
  distributePayoutTestCase,
  exitGroupTestCase,
  updateGroupTestCase,
} from "./actions.js";
import { advanceBlock } from "./effects.js";
import { extractTokenSuffix } from "./utils.js";
import {
  selectWalletFromSeed,
  signAndSubmit,
  assetNameLabels,
  parseGroupCip68Datum,
  resolveUtxoByUnit,
  reserveTokenName,
} from "../src/core/utils/index.js";
import { unsignedTopUpReserveTxProgram } from "../src/endpoints/topUpReserve.js";
import { unsignedTerminateDefaultTxProgram } from "../src/endpoints/terminateDefault.js";
import { unsignedDeleteGroupTxProgram } from "../src/endpoints/deleteGroup.js";
import { getReserveStateProgram } from "../src/queries/getReserveState.js";
import { UTxO } from "@lucid-evolution/lucid";

// Mutual reserve lifecycle on the emulator (real UPLC via script refs):
// create (levies on) → 2 joins (join levy accrues) → top-up → start →
// round 0 (borrower drains, ICS) → terminate (stand-in 1) → round 1 (the draw
// tops the pot, counter drains) → deactivate → wind-down exit takes the share →
// delete closes the reserve.
//
// Fee 2 ADA, 2 members (num_rounds = 2). interval_length = 20_000ms (one
// emulator block); grace 0 so the defaulter is terminable immediately;
// join levy 0.5 ADA, round levy 0.1 ADA.

const readReserve = (context: BaseSetup["context"], groupTokenSuffix: string) =>
  getReserveStateProgram(context.protocol!, context.lucid, groupTokenSuffix);

describe("mutual reserve lifecycle (emulator)", () => {
  it.effect(
    "levies accrue, stand-in covers a terminated defaulter, wind-down refunds and close-out",
    () =>
      Effect.gen(function* () {
        const base = yield* setupBase();
        const { context, groupUtxo } = yield* setupGroup(base, {
          interval_length: 20_000n,
          grace_period_length: 0n,
          reserve_join_levy: 500_000n,
          reserve_round_levy: 100_000n,
        });
        const { users, lucid } = context;
        const groupTokenSuffix = extractTokenSuffix(
          groupUtxo,
          context.protocol!.groupPolicyId,
          assetNameLabels.prefix100,
        );

        // Reserve exists from creation, empty (contributable 0) and idle.
        const atCreate = yield* readReserve(context, groupTokenSuffix);
        expect(atCreate.balance).toBe(0n);
        expect(atCreate.standinRounds).toBe(0n);
        expect(atCreate.joinLevy).toBe(500_000n);
        expect(atCreate.roundLevy).toBe(100_000n);

        // user1 joins FIRST (slot 0 — round-0 borrower) with only the 1-round
        // floor, so round 0 drains them into DefaultState. user2 prefunds.
        const {
          outputs: { userUtxo: u1Account },
        } = yield* createAccountTestCase(context, {
          userSeed: users.user1.seedPhrase,
        });
        const {
          outputs: { userUtxo: u2Account },
        } = yield* createAccountTestCase(context, {
          userSeed: users.user2.seedPhrase,
        });
        yield* joinGroupTestCase(context, {
          groupUtxo,
          accountUtxo: u1Account,
          userSeed: users.user1.seedPhrase,
        });
        yield* joinGroupTestCase(context, {
          groupUtxo,
          accountUtxo: u2Account,
          userSeed: users.user2.seedPhrase,
          overrideDepositLovelace: 10_000_000n,
        });

        // Join levies accrued: 2 × 0.5 ADA.
        const afterJoins = yield* readReserve(context, groupTokenSuffix);
        expect(afterJoins.balance).toBe(1_000_000n);

        // Voluntary top-up (harambee): +1 ADA from the admin wallet.
        selectWalletFromSeed(lucid, users.admin.seedPhrase);
        const topUpTx = yield* unsignedTopUpReserveTxProgram(
          context.protocol!,
          lucid,
          {
            groupTokenSuffix,
            amount: 1_000_000n,
            scriptRefs: context.scriptRefs,
          },
        );
        yield* signAndSubmit(topUpTx);
        yield* advanceBlock(context.emulator);
        const afterTopUp = yield* readReserve(context, groupTokenSuffix);
        expect(afterTopUp.balance).toBe(2_000_000n);

        yield* startGroupTestCase(context, { groupUtxo });

        // Round 0: borrower user1 (slot 0) receives the pot to their wallet
        // (Push) while their treasury drains to 0 → DefaultState. Levy 2×0.1.
        yield* distributePayoutTestCase(context, {
          groupUtxo,
          callerSeed: users.user1.seedPhrase,
        });
        const afterRound0 = yield* readReserve(context, groupTokenSuffix);
        expect(afterRound0.balance).toBe(2_200_000n);
        expect(afterRound0.standinRounds).toBe(0n);

        // Terminate the defaulter: their (drained) forfeit flows to the reserve
        // and the stand-in counter grows by their remaining round this lap (1).
        selectWalletFromSeed(lucid, users.admin.seedPhrase);
        const u1Suffix = extractTokenSuffix(
          u1Account,
          context.protocol!.accountPolicyId,
          assetNameLabels.prefix222,
        );
        const terminateTx = yield* unsignedTerminateDefaultTxProgram(
          context.protocol!,
          lucid,
          {
            groupTokenSuffix,
            memberAccountTokenSuffix: u1Suffix,
            currentTime: BigInt(context.emulator!.now()),
            scriptRefs: context.scriptRefs,
          },
        );
        yield* signAndSubmit(terminateTx);
        yield* advanceBlock(context.emulator);
        const afterTerminate = yield* readReserve(context, groupTokenSuffix);
        expect(afterTerminate.standinRounds).toBe(1n);
        expect(afterTerminate.balance).toBe(2_200_000n);

        // Round 1: the stand-in draws one full fee (2 ADA) into the pot and the
        // counter drains. Levy 1×0.1 first: 2.2 + 0.1 − 2.0 = 0.3 ADA left.
        // Borrower user2 (slot 1) receives 1×2.0 − 0.1 + 2.0 = 3.9 ADA.
        yield* distributePayoutTestCase(context, {
          groupUtxo,
          callerSeed: users.user2.seedPhrase,
        });
        const afterRound1 = yield* readReserve(context, groupTokenSuffix);
        expect(afterRound1.standinRounds).toBe(0n);
        expect(afterRound1.balance).toBe(300_000n);

        // Wind-down: deactivate, then the exiting member takes their equal
        // share — floor(balance / pre-exit member_count) = the full 0.3 ADA.
        const groupUnit =
          context.protocol!.groupPolicyId +
          assetNameLabels.prefix100 +
          groupTokenSuffix;
        const groupNowRaw = yield* resolveUtxoByUnit(lucid, groupUnit);
        const groupNow: UTxO = groupNowRaw;
        const parsed = yield* parseGroupCip68Datum(groupNow.datum!);
        selectWalletFromSeed(lucid, users.admin.seedPhrase);
        yield* updateGroupTestCase(context, {
          groupUtxo: groupNow,
          updatedDatum: { ...parsed.groupDatum, is_active: false },
        });
        yield* advanceBlock(context.emulator);

        yield* exitGroupTestCase(context, {
          groupUtxo,
          accountUtxo: u2Account,
          userSeed: users.user2.seedPhrase,
        });
        const afterExit = yield* readReserve(context, groupTokenSuffix);
        expect(afterExit.balance).toBe(0n);

        // Delete the group — the reserve token burns with it and the UTxO is gone.
        selectWalletFromSeed(lucid, users.admin.seedPhrase);
        const deleteTx = yield* unsignedDeleteGroupTxProgram(
          context.protocol!,
          lucid,
          { groupTokenSuffix, scriptRefs: context.scriptRefs },
        );
        yield* signAndSubmit(deleteTx);
        yield* advanceBlock(context.emulator);

        const reserveUnit =
          context.protocol!.treasuryPolicyId +
          reserveTokenName(assetNameLabels.prefix100 + groupTokenSuffix);
        const gone = yield* Effect.either(
          resolveUtxoByUnit(lucid, reserveUnit),
        );
        expect(gone._tag).toBe("Left");
      }),
  );
});
