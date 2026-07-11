import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import {
  Emulator,
  generateEmulatorAccount,
  Lucid,
  LucidEvolution,
  PROTOCOL_PARAMETERS_DEFAULT,
} from "@lucid-evolution/lucid";
import {
  selectWalletFromSeed,
  signAndSubmit,
} from "../src/core/utils/index.js";
import { unsignedCreateFundTxProgram } from "../src/savings/endpoints/createFund.js";
import { unsignedJoinFundTxProgram } from "../src/savings/endpoints/joinFund.js";
import { unsignedDepositTxProgram } from "../src/savings/endpoints/deposit.js";
import { unsignedWithdrawSavingsTxProgram } from "../src/savings/endpoints/withdrawSavings.js";
import { unsignedSocialPayoutTxProgram } from "../src/savings/endpoints/socialPayout.js";
import { unsignedUpdateFundTxProgram } from "../src/savings/endpoints/updateFund.js";
import { unsignedCloseCycleTxProgram } from "../src/savings/endpoints/closeCycle.js";
import { unsignedClaimShareOutTxProgram } from "../src/savings/endpoints/claimShareOut.js";
import { unsignedExitFundTxProgram } from "../src/savings/endpoints/exitFund.js";
import { unsignedCloseFundTxProgram } from "../src/savings/endpoints/closeFund.js";
import { getFundStateProgram } from "../src/savings/queries/getFundState.js";
import { getFundMembersProgram } from "../src/savings/queries/getFundMembers.js";
import { FUND_TAG_SOCIAL, FUND_TAG_TOPUP } from "../src/savings/types.js";
import { resolveMemberAccount } from "../src/savings/utils.js";
import { advanceBlock } from "./effects.js";

// ---------------------------------------------------------------------------
// Standalone context: a treasurer (fund creator = default quorum) and two
// members, all seed wallets so each can pay fees and sign.
// ---------------------------------------------------------------------------

type SavingsContext = {
  lucid: LucidEvolution;
  emulator: Emulator;
  treasurer: { seedPhrase: string; address: string };
  member1: { seedPhrase: string; address: string };
  member2: { seedPhrase: string; address: string };
};

const makeContext = Effect.gen(function* () {
  const treasurer = generateEmulatorAccount({ lovelace: 2_000_000_000n });
  const member1 = generateEmulatorAccount({ lovelace: 500_000_000n });
  const member2 = generateEmulatorAccount({ lovelace: 500_000_000n });
  const emulator = new Emulator(
    [treasurer, member1, member2],
    PROTOCOL_PARAMETERS_DEFAULT,
  );
  const lucid = yield* Effect.promise(() => Lucid(emulator, "Custom"));
  return {
    lucid,
    emulator,
    treasurer,
    member1,
    member2,
  } as SavingsContext;
});

const submitAs = (
  ctx: SavingsContext,
  who: { seedPhrase: string },
  tx: Parameters<typeof signAndSubmit>[0],
) =>
  Effect.gen(function* () {
    const txHash = yield* signAndSubmit(tx);
    yield* advanceBlock(ctx.emulator, 3);
    return txHash;
  });

describe("savings module — full VSLA lifecycle (emulator)", () => {
  it.effect(
    "create → join ×2 → deposits → social → close → claims → exits → close fund",
    () =>
      Effect.gen(function* () {
        const ctx = yield* makeContext;
        const { lucid } = ctx;

        // --- create the fund (treasurer = quorum, VSLA preset: locked) ---
        selectWalletFromSeed(lucid, ctx.treasurer.seedPhrase);
        const { tx: createTx, fundTokenName } =
          yield* unsignedCreateFundTxProgram(lucid, {
            title: "Test VSLA",
            shareValue: 1_000_000n,
            minSharesPerDeposit: 1n,
            maxSharesPerDeposit: 100n,
            withdrawalPolicy: 0n,
          });
        yield* submitAs(ctx, ctx.treasurer, createTx);

        // --- both members join (anchor is a reference input) ---
        selectWalletFromSeed(lucid, ctx.member1.seedPhrase);
        const { tx: join1, memberTokenSuffix: suffix1 } =
          yield* unsignedJoinFundTxProgram(lucid, {
            fundTokenName,
            consent: true,
          });
        yield* submitAs(ctx, ctx.member1, join1);

        selectWalletFromSeed(lucid, ctx.member2.seedPhrase);
        const { tx: join2, memberTokenSuffix: suffix2 } =
          yield* unsignedJoinFundTxProgram(lucid, { fundTokenName });
        yield* submitAs(ctx, ctx.member2, join2);

        const membersAfterJoin = yield* getFundMembersProgram(
          lucid,
          fundTokenName,
        );
        expect(membersAfterJoin.length).toBe(2);

        // --- share purchases: member1 buys 10 units, member2 buys 5 ---
        selectWalletFromSeed(lucid, ctx.member1.seedPhrase);
        const dep1 = yield* unsignedDepositTxProgram(lucid, {
          fundTokenName,
          memberTokenSuffix: suffix1,
          units: 10n,
        });
        yield* submitAs(ctx, ctx.member1, dep1);

        selectWalletFromSeed(lucid, ctx.member2.seedPhrase);
        const dep2 = yield* unsignedDepositTxProgram(lucid, {
          fundTokenName,
          memberTokenSuffix: suffix2,
          units: 5n,
        });
        yield* submitAs(ctx, ctx.member2, dep2);

        // --- social contribution (member1) + untagged penalty (member2) ---
        selectWalletFromSeed(lucid, ctx.member1.seedPhrase);
        const social1 = yield* unsignedDepositTxProgram(lucid, {
          fundTokenName,
          memberTokenSuffix: suffix1,
          fundTag: FUND_TAG_SOCIAL,
          amount: 3_000_000n,
        });
        yield* submitAs(ctx, ctx.member1, social1);

        selectWalletFromSeed(lucid, ctx.member2.seedPhrase);
        const topup = yield* unsignedDepositTxProgram(lucid, {
          fundTokenName,
          memberTokenSuffix: suffix2,
          fundTag: FUND_TAG_TOPUP,
          amount: 2_000_000n,
        });
        yield* submitAs(ctx, ctx.member2, topup);

        const afterDeposits = yield* getFundStateProgram(lucid, fundTokenName);
        expect(afterDeposits.fund.shares_total).toBe(15n);
        expect(afterDeposits.fund.savings_total).toBe(15_000_000n);
        expect(afterDeposits.fund.social_total).toBe(3_000_000n);
        // 2 ADA buffer + 15 savings + 3 social + 2 top-up
        expect(afterDeposits.vaultBalance).toBe(22_000_000n);

        // --- welfare payout under quorum authority ---
        selectWalletFromSeed(lucid, ctx.treasurer.seedPhrase);
        const payout = yield* unsignedSocialPayoutTxProgram(lucid, {
          fundTokenName,
          amount: 1_000_000n,
          destination: ctx.member2.address,
        });
        yield* submitAs(ctx, ctx.treasurer, payout);

        // --- charter update (band widened) ---
        const update = yield* unsignedUpdateFundTxProgram(lucid, {
          fundTokenName,
          maxSharesPerDeposit: 200n,
        });
        yield* submitAs(ctx, ctx.treasurer, update);

        // --- cycle close: pot = 21 - 2 social - 2 buffer = 17 ADA ---
        const close = yield* unsignedCloseCycleTxProgram(lucid, {
          fundTokenName,
        });
        yield* submitAs(ctx, ctx.treasurer, close);

        const afterClose = yield* getFundStateProgram(lucid, fundTokenName);
        expect(afterClose.phase).toBe("SharingOut");
        const status = afterClose.fund.status;
        if (typeof status === "string" || !("SharingOut" in status))
          throw new Error("expected SharingOut");
        expect(status.SharingOut.pot).toBe(17_000_000n);
        expect(status.SharingOut.shares).toBe(15n);

        // --- member-claimed share-out: 17M*10/15 then 17M*5/15 (floor) ---
        selectWalletFromSeed(lucid, ctx.member1.seedPhrase);
        const claim1 = yield* unsignedClaimShareOutTxProgram(lucid, {
          fundTokenName,
          memberTokenSuffix: suffix1,
        });
        yield* submitAs(ctx, ctx.member1, claim1);

        selectWalletFromSeed(lucid, ctx.member2.seedPhrase);
        const claim2 = yield* unsignedClaimShareOutTxProgram(lucid, {
          fundTokenName,
          memberTokenSuffix: suffix2,
        });
        yield* submitAs(ctx, ctx.member2, claim2);

        const m1 = yield* resolveMemberAccount(lucid, suffix1);
        expect(m1.account.share_units).toBe(0n);

        // --- exits burn the pairs ---
        selectWalletFromSeed(lucid, ctx.member1.seedPhrase);
        const exit1 = yield* unsignedExitFundTxProgram(lucid, {
          memberTokenSuffix: suffix1,
        });
        yield* submitAs(ctx, ctx.member1, exit1);

        selectWalletFromSeed(lucid, ctx.member2.seedPhrase);
        const exit2 = yield* unsignedExitFundTxProgram(lucid, {
          memberTokenSuffix: suffix2,
        });
        yield* submitAs(ctx, ctx.member2, exit2);

        const membersAfterExit = yield* getFundMembersProgram(
          lucid,
          fundTokenName,
        );
        expect(membersAfterExit.length).toBe(0);

        // --- fund closure: burn anchor, residual (dust + social) released ---
        selectWalletFromSeed(lucid, ctx.treasurer.seedPhrase);
        const closeF = yield* unsignedCloseFundTxProgram(lucid, {
          fundTokenName,
        });
        const closeHash = yield* submitAs(ctx, ctx.treasurer, closeF);
        expect(closeHash).toBeDefined();
      }),
  );

  it.effect("ASCA flexible withdrawal: deposit 10 units, withdraw 4", () =>
    Effect.gen(function* () {
      const ctx = yield* makeContext;
      const { lucid } = ctx;

      selectWalletFromSeed(lucid, ctx.treasurer.seedPhrase);
      const { tx: createTx, fundTokenName } =
        yield* unsignedCreateFundTxProgram(lucid, {
          title: "Test ASCA",
          shareValue: 2_000_000n,
          withdrawalPolicy: 1n,
        });
      yield* submitAs(ctx, ctx.treasurer, createTx);

      selectWalletFromSeed(lucid, ctx.member1.seedPhrase);
      const { tx: joinTx, memberTokenSuffix } =
        yield* unsignedJoinFundTxProgram(lucid, { fundTokenName });
      yield* submitAs(ctx, ctx.member1, joinTx);

      const dep = yield* unsignedDepositTxProgram(lucid, {
        fundTokenName,
        memberTokenSuffix,
        units: 10n,
      });
      yield* submitAs(ctx, ctx.member1, dep);

      const wd = yield* unsignedWithdrawSavingsTxProgram(lucid, {
        fundTokenName,
        memberTokenSuffix,
        units: 4n,
      });
      yield* submitAs(ctx, ctx.member1, wd);

      const state = yield* getFundStateProgram(lucid, fundTokenName);
      expect(state.fund.shares_total).toBe(6n);
      expect(state.fund.savings_total).toBe(12_000_000n);
      expect(state.vaultBalance).toBe(14_000_000n); // 12M + 2M buffer

      const m = yield* resolveMemberAccount(lucid, memberTokenSuffix);
      expect(m.account.share_units).toBe(6n);
    }),
  );

  it.effect(
    "native-token fund: deposits and claims move the token, not ADA",
    () =>
      Effect.gen(function* () {
        const unit =
          "deadbeef00000000000000000000000000000000000000000000beef" +
          "55534458";
        const treasurer = generateEmulatorAccount({ lovelace: 2_000_000_000n });
        const member = generateEmulatorAccount({
          lovelace: 500_000_000n,
          [unit]: 1_000_000n,
        });
        const emulator = new Emulator(
          [treasurer, member],
          PROTOCOL_PARAMETERS_DEFAULT,
        );
        const lucid = yield* Effect.promise(() => Lucid(emulator, "Custom"));
        const ctx = {
          lucid,
          emulator,
          treasurer,
          member1: member,
          member2: member,
        } as SavingsContext;

        selectWalletFromSeed(lucid, treasurer.seedPhrase);
        const { tx: createTx, fundTokenName } =
          yield* unsignedCreateFundTxProgram(lucid, {
            title: "Token Fund",
            assetPolicy: unit.slice(0, 56),
            assetName: unit.slice(56),
            shareValue: 1_000n,
            withdrawalPolicy: 0n,
          });
        yield* submitAs(ctx, treasurer, createTx);

        selectWalletFromSeed(lucid, member.seedPhrase);
        const { tx: joinTx, memberTokenSuffix } =
          yield* unsignedJoinFundTxProgram(lucid, { fundTokenName });
        yield* submitAs(ctx, member, joinTx);

        const dep = yield* unsignedDepositTxProgram(lucid, {
          fundTokenName,
          memberTokenSuffix,
          units: 100n,
        });
        yield* submitAs(ctx, member, dep);

        const state = yield* getFundStateProgram(lucid, fundTokenName);
        expect(state.fund.savings_total).toBe(100_000n);
        expect(state.vaultBalance).toBe(100_000n); // token balance, no buffer

        // token fund: the WHOLE token balance is the pot (buffer is ADA-only)
        selectWalletFromSeed(lucid, treasurer.seedPhrase);
        const close = yield* unsignedCloseCycleTxProgram(lucid, {
          fundTokenName,
        });
        yield* submitAs(ctx, treasurer, close);

        selectWalletFromSeed(lucid, member.seedPhrase);
        const claim = yield* unsignedClaimShareOutTxProgram(lucid, {
          fundTokenName,
          memberTokenSuffix,
        });
        yield* submitAs(ctx, member, claim);

        const after = yield* getFundStateProgram(lucid, fundTokenName);
        expect(after.vaultBalance).toBe(0n); // sole member claimed everything
      }),
  );
});
