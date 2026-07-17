import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import {
  CML,
  Emulator,
  generateEmulatorAccount,
  generatePrivateKey,
  Lucid,
  LucidEvolution,
  PROTOCOL_PARAMETERS_DEFAULT,
  UTxO,
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
import { unsignedDisburseLoanTxProgram } from "../src/savings/endpoints/disburseLoan.js";
import { unsignedRepayLoanTxProgram } from "../src/savings/endpoints/repayLoan.js";
import { unsignedMarkArrearsTxProgram } from "../src/savings/endpoints/markArrears.js";
import { unsignedWriteOffLoanTxProgram } from "../src/savings/endpoints/writeOffLoan.js";
import { getFundLoansProgram } from "../src/savings/queries/getFundLoans.js";
import { unsignedCloseFundTxProgram } from "../src/savings/endpoints/closeFund.js";
import { getFundStateProgram } from "../src/savings/queries/getFundState.js";
import { getFundMembersProgram } from "../src/savings/queries/getFundMembers.js";
import { FUND_TAG_SOCIAL, FUND_TAG_TOPUP } from "../src/savings/types.js";
import { resolveMemberAccount } from "../src/savings/utils.js";
import { savingsVaultValidator } from "../src/savings/validators.js";
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
  /** The ~15.5KB validator deployed once as a reference script. */
  scriptRef: UTxO;
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
  // Deploy the validator once as a reference script (it cannot ride inline
  // within the 16KB tx limit).
  selectWalletFromSeed(lucid, treasurer.seedPhrase);
  const deploy = yield* Effect.promise(() =>
    lucid
      .newTx()
      .pay.ToAddressWithData(
        treasurer.address,
        undefined,
        { lovelace: 25_000_000n },
        savingsVaultValidator.spendVault,
      )
      .complete(),
  );
  yield* signAndSubmit(deploy);
  yield* advanceBlock(emulator, 2);
  const scriptRef = (yield* Effect.promise(() =>
    lucid.utxosAt(treasurer.address),
  )).find((u) => u.scriptRef);
  if (!scriptRef) throw new Error("script ref deploy failed");
  return {
    lucid,
    emulator,
    treasurer,
    member1,
    member2,
    scriptRef,
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
            scriptRef: ctx.scriptRef,
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
            scriptRef: ctx.scriptRef,
            fundTokenName,
            consent: true,
          });
        yield* submitAs(ctx, ctx.member1, join1);

        selectWalletFromSeed(lucid, ctx.member2.seedPhrase);
        const { tx: join2, memberTokenSuffix: suffix2 } =
          yield* unsignedJoinFundTxProgram(lucid, {
            scriptRef: ctx.scriptRef,
            fundTokenName,
          });
        yield* submitAs(ctx, ctx.member2, join2);

        const membersAfterJoin = yield* getFundMembersProgram(
          lucid,
          fundTokenName,
        );
        expect(membersAfterJoin.length).toBe(2);

        // --- share purchases: member1 buys 10 units, member2 buys 5 ---
        selectWalletFromSeed(lucid, ctx.member1.seedPhrase);
        const dep1 = yield* unsignedDepositTxProgram(lucid, {
          scriptRef: ctx.scriptRef,
          fundTokenName,
          memberTokenSuffix: suffix1,
          units: 10n,
        });
        yield* submitAs(ctx, ctx.member1, dep1);

        selectWalletFromSeed(lucid, ctx.member2.seedPhrase);
        const dep2 = yield* unsignedDepositTxProgram(lucid, {
          scriptRef: ctx.scriptRef,
          fundTokenName,
          memberTokenSuffix: suffix2,
          units: 5n,
        });
        yield* submitAs(ctx, ctx.member2, dep2);

        // --- social contribution (member1) + untagged penalty (member2) ---
        selectWalletFromSeed(lucid, ctx.member1.seedPhrase);
        const social1 = yield* unsignedDepositTxProgram(lucid, {
          scriptRef: ctx.scriptRef,
          fundTokenName,
          memberTokenSuffix: suffix1,
          fundTag: FUND_TAG_SOCIAL,
          amount: 3_000_000n,
        });
        yield* submitAs(ctx, ctx.member1, social1);

        selectWalletFromSeed(lucid, ctx.member2.seedPhrase);
        const topup = yield* unsignedDepositTxProgram(lucid, {
          scriptRef: ctx.scriptRef,
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
          scriptRef: ctx.scriptRef,
          fundTokenName,
          amount: 1_000_000n,
          destination: ctx.member2.address,
        });
        yield* submitAs(ctx, ctx.treasurer, payout);

        // --- charter update (band widened) ---
        const update = yield* unsignedUpdateFundTxProgram(lucid, {
          scriptRef: ctx.scriptRef,
          fundTokenName,
          maxSharesPerDeposit: 200n,
        });
        yield* submitAs(ctx, ctx.treasurer, update);

        // --- cycle close: pot = 21 - 2 social - 2 buffer = 17 ADA ---
        const close = yield* unsignedCloseCycleTxProgram(lucid, {
          scriptRef: ctx.scriptRef,
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
          scriptRef: ctx.scriptRef,
          fundTokenName,
          memberTokenSuffix: suffix1,
        });
        yield* submitAs(ctx, ctx.member1, claim1);

        selectWalletFromSeed(lucid, ctx.member2.seedPhrase);
        const claim2 = yield* unsignedClaimShareOutTxProgram(lucid, {
          scriptRef: ctx.scriptRef,
          fundTokenName,
          memberTokenSuffix: suffix2,
        });
        yield* submitAs(ctx, ctx.member2, claim2);

        const m1 = yield* resolveMemberAccount(lucid, suffix1);
        expect(m1.account.share_units).toBe(0n);

        // --- exits burn the pairs ---
        selectWalletFromSeed(lucid, ctx.member1.seedPhrase);
        const exit1 = yield* unsignedExitFundTxProgram(lucid, {
          scriptRef: ctx.scriptRef,
          memberTokenSuffix: suffix1,
        });
        yield* submitAs(ctx, ctx.member1, exit1);

        selectWalletFromSeed(lucid, ctx.member2.seedPhrase);
        const exit2 = yield* unsignedExitFundTxProgram(lucid, {
          scriptRef: ctx.scriptRef,
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
          scriptRef: ctx.scriptRef,
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
          scriptRef: ctx.scriptRef,
          title: "Test ASCA",
          shareValue: 2_000_000n,
          withdrawalPolicy: 1n,
        });
      yield* submitAs(ctx, ctx.treasurer, createTx);

      selectWalletFromSeed(lucid, ctx.member1.seedPhrase);
      const { tx: joinTx, memberTokenSuffix } =
        yield* unsignedJoinFundTxProgram(lucid, {
          scriptRef: ctx.scriptRef,
          fundTokenName,
        });
      yield* submitAs(ctx, ctx.member1, joinTx);

      const dep = yield* unsignedDepositTxProgram(lucid, {
        scriptRef: ctx.scriptRef,
        fundTokenName,
        memberTokenSuffix,
        units: 10n,
      });
      yield* submitAs(ctx, ctx.member1, dep);

      const wd = yield* unsignedWithdrawSavingsTxProgram(lucid, {
        scriptRef: ctx.scriptRef,
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
        selectWalletFromSeed(lucid, treasurer.seedPhrase);
        const deploy = yield* Effect.promise(() =>
          lucid
            .newTx()
            .pay.ToAddressWithData(
              treasurer.address,
              undefined,
              { lovelace: 25_000_000n },
              savingsVaultValidator.spendVault,
            )
            .complete(),
        );
        yield* signAndSubmit(deploy);
        yield* advanceBlock(emulator, 2);
        const scriptRefNt = (yield* Effect.promise(() =>
          lucid.utxosAt(treasurer.address),
        )).find((u) => u.scriptRef);
        if (!scriptRefNt) throw new Error("script ref deploy failed");
        const ctx = {
          lucid,
          emulator,
          treasurer,
          member1: member,
          member2: member,
          scriptRef: scriptRefNt,
        } as SavingsContext;

        const { tx: createTx, fundTokenName } =
          yield* unsignedCreateFundTxProgram(lucid, {
            scriptRef: ctx.scriptRef,
            title: "Token Fund",
            assetPolicy: unit.slice(0, 56),
            assetName: unit.slice(56),
            shareValue: 1_000n,
            withdrawalPolicy: 0n,
          });
        yield* submitAs(ctx, treasurer, createTx);

        selectWalletFromSeed(lucid, member.seedPhrase);
        const { tx: joinTx, memberTokenSuffix } =
          yield* unsignedJoinFundTxProgram(lucid, {
            scriptRef: ctx.scriptRef,
            fundTokenName,
          });
        yield* submitAs(ctx, member, joinTx);

        const dep = yield* unsignedDepositTxProgram(lucid, {
          scriptRef: ctx.scriptRef,
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
          scriptRef: ctx.scriptRef,
          fundTokenName,
        });
        yield* submitAs(ctx, treasurer, close);

        selectWalletFromSeed(lucid, member.seedPhrase);
        const claim = yield* unsignedClaimShareOutTxProgram(lucid, {
          scriptRef: ctx.scriptRef,
          fundTokenName,
          memberTokenSuffix,
        });
        yield* submitAs(ctx, member, claim);

        const after = yield* getFundStateProgram(lucid, fundTokenName);
        expect(after.vaultBalance).toBe(0n); // sole member claimed everything
      }),
  );

  it.effect(
    "loan lifecycle: disburse -> partial repay -> close; charge feeds the pot",
    () =>
      Effect.gen(function* () {
        const ctx = yield* makeContext;
        const { lucid, emulator } = ctx;
        // A raw-key quorum (the loan committee) that only signs, never pays.
        const quorumKey = generatePrivateKey();
        const quorumHash = CML.PrivateKey.from_bech32(quorumKey)
          .to_public()
          .hash()
          .to_hex();

        selectWalletFromSeed(lucid, ctx.treasurer.seedPhrase);
        const { tx: createTx, fundTokenName } =
          yield* unsignedCreateFundTxProgram(lucid, {
            scriptRef: ctx.scriptRef,
            title: "Loan Fund",
            shareValue: 1_000_000n,
            withdrawalPolicy: 0n,
            maxLoanMultiple: 1n,
            quorum: { type: "Key", hash: quorumHash },
          });
        yield* submitAs(ctx, ctx.treasurer, createTx);

        selectWalletFromSeed(lucid, ctx.member1.seedPhrase);
        const { tx: joinTx, memberTokenSuffix } =
          yield* unsignedJoinFundTxProgram(lucid, {
            scriptRef: ctx.scriptRef,
            fundTokenName,
          });
        yield* submitAs(ctx, ctx.member1, joinTx);

        const dep = yield* unsignedDepositTxProgram(lucid, {
          scriptRef: ctx.scriptRef,
          fundTokenName,
          memberTokenSuffix,
          units: 10n,
        });
        yield* submitAs(ctx, ctx.member1, dep);

        // Disburse 8 ADA against 10 ADA of shares: borrower builds and signs,
        // the quorum co-signs.
        const now = BigInt(emulator.now());
        const { tx: disburseTx, loanTokenName } =
          yield* unsignedDisburseLoanTxProgram(lucid, {
            scriptRef: ctx.scriptRef,
            fundTokenName,
            memberTokenSuffix,
            principal: 8_000_000n,
            serviceCharge: 400_000n,
            due: now + 2_000_000n,
            currentTime: now,
          });
        const disburseSigned = yield* Effect.promise(() =>
          disburseTx.sign
            .withWallet()
            .sign.withPrivateKey(quorumKey)
            .complete(),
        );
        yield* Effect.promise(() => disburseSigned.submit());
        yield* advanceBlock(emulator, 3);

        const afterDisburse = yield* getFundStateProgram(lucid, fundTokenName);
        expect(afterDisburse.fund.loans_outstanding).toBe(8_000_000n);
        expect(afterDisburse.vaultBalance).toBe(4_000_000n); // 12 - 8
        const loans = yield* getFundLoansProgram(lucid, fundTokenName);
        expect(loans.length).toBe(1);
        expect(loans[0].loan.outstanding).toBe(8_000_000n);

        // Partial repayment: 5 ADA principal + the full 0.4 ADA charge.
        const partial = yield* unsignedRepayLoanTxProgram(lucid, {
          scriptRef: ctx.scriptRef,
          fundTokenName,
          memberTokenSuffix,
          loanTokenName,
          principal: 5_000_000n,
          charge: 400_000n,
        });
        yield* submitAs(ctx, ctx.member1, partial);

        const afterPartial = yield* getFundStateProgram(lucid, fundTokenName);
        expect(afterPartial.fund.loans_outstanding).toBe(3_000_000n);
        expect(afterPartial.vaultBalance).toBe(9_400_000n);

        // Closing repayment: remaining 3 ADA principal; the NFT burns.
        const closeRepay = yield* unsignedRepayLoanTxProgram(lucid, {
          scriptRef: ctx.scriptRef,
          fundTokenName,
          memberTokenSuffix,
          loanTokenName,
        });
        yield* submitAs(ctx, ctx.member1, closeRepay);

        const afterClose = yield* getFundStateProgram(lucid, fundTokenName);
        expect(afterClose.fund.loans_outstanding).toBe(0n);
        expect(afterClose.vaultBalance).toBe(12_400_000n); // 12 + 0.4 charge
        const loansAfter = yield* getFundLoansProgram(lucid, fundTokenName);
        expect(loansAfter.length).toBe(0);
        const m = yield* resolveMemberAccount(lucid, memberTokenSuffix);
        expect(m.account.borrowed).toBe(0n);

        // Cycle close: the pot carries the loan income (12.4 - buffer = 10.4).
        selectWalletFromSeed(lucid, ctx.treasurer.seedPhrase);
        const close = yield* unsignedCloseCycleTxProgram(lucid, {
          scriptRef: ctx.scriptRef,
          fundTokenName,
        });
        const closeSigned = yield* Effect.promise(() =>
          close.sign.withWallet().sign.withPrivateKey(quorumKey).complete(),
        );
        yield* Effect.promise(() => closeSigned.submit());
        yield* advanceBlock(emulator, 3);

        const closed = yield* getFundStateProgram(lucid, fundTokenName);
        const status = closed.fund.status;
        if (typeof status === "string" || !("SharingOut" in status))
          throw new Error("expected SharingOut");
        expect(status.SharingOut.pot).toBe(10_400_000n);
      }),
  );

  it.effect(
    "arrears + write-off: default seizes shares, socializes the rest",
    () =>
      Effect.gen(function* () {
        const ctx = yield* makeContext;
        const { lucid, emulator } = ctx;
        const quorumKey = generatePrivateKey();
        const quorumHash = CML.PrivateKey.from_bech32(quorumKey)
          .to_public()
          .hash()
          .to_hex();

        selectWalletFromSeed(lucid, ctx.treasurer.seedPhrase);
        const { tx: createTx, fundTokenName } =
          yield* unsignedCreateFundTxProgram(lucid, {
            scriptRef: ctx.scriptRef,
            title: "Arrears Fund",
            shareValue: 1_000_000n,
            withdrawalPolicy: 0n,
            maxLoanMultiple: 1n,
            loanGrace: 200_000n,
            quorum: { type: "Key", hash: quorumHash },
          });
        yield* submitAs(ctx, ctx.treasurer, createTx);

        selectWalletFromSeed(lucid, ctx.member1.seedPhrase);
        const { tx: joinTx, memberTokenSuffix } =
          yield* unsignedJoinFundTxProgram(lucid, {
            scriptRef: ctx.scriptRef,
            fundTokenName,
          });
        yield* submitAs(ctx, ctx.member1, joinTx);
        const dep = yield* unsignedDepositTxProgram(lucid, {
          scriptRef: ctx.scriptRef,
          fundTokenName,
          memberTokenSuffix,
          units: 10n,
        });
        yield* submitAs(ctx, ctx.member1, dep);

        const now = BigInt(emulator.now());
        const { tx: disburseTx, loanTokenName } =
          yield* unsignedDisburseLoanTxProgram(lucid, {
            scriptRef: ctx.scriptRef,
            fundTokenName,
            memberTokenSuffix,
            principal: 8_000_000n,
            serviceCharge: 400_000n,
            due: now + 1_000_000n,
            currentTime: now,
          });
        const disburseSigned = yield* Effect.promise(() =>
          disburseTx.sign
            .withWallet()
            .sign.withPrivateKey(quorumKey)
            .complete(),
        );
        yield* Effect.promise(() => disburseSigned.submit());
        yield* advanceBlock(emulator, 3);

        // Past due (blocks advance 20s each): 60 blocks = +1200s > 1000s.
        yield* advanceBlock(emulator, 60);
        selectWalletFromSeed(lucid, ctx.member2.seedPhrase); // anyone cranks
        const toLate = yield* unsignedMarkArrearsTxProgram(lucid, {
          scriptRef: ctx.scriptRef,
          loanTokenName,
          currentTime: BigInt(emulator.now()),
        });
        yield* submitAs(ctx, ctx.member2, toLate);

        // Past due + grace (200s): 15 more blocks = +300s.
        yield* advanceBlock(emulator, 15);
        const toDefaulted = yield* unsignedMarkArrearsTxProgram(lucid, {
          scriptRef: ctx.scriptRef,
          loanTokenName,
          currentTime: BigInt(emulator.now()),
        });
        yield* submitAs(ctx, ctx.member2, toDefaulted);

        // The quorum writes the loan off: 8 of 10 shares seized.
        selectWalletFromSeed(lucid, ctx.treasurer.seedPhrase);
        const writeOff = yield* unsignedWriteOffLoanTxProgram(lucid, {
          scriptRef: ctx.scriptRef,
          fundTokenName,
          loanTokenName,
        });
        const writeOffSigned = yield* Effect.promise(() =>
          writeOff.sign.withWallet().sign.withPrivateKey(quorumKey).complete(),
        );
        yield* Effect.promise(() => writeOffSigned.submit());
        yield* advanceBlock(emulator, 3);

        const state = yield* getFundStateProgram(lucid, fundTokenName);
        expect(state.fund.loans_outstanding).toBe(0n);
        expect(state.fund.shares_total).toBe(2n);
        expect(state.fund.savings_total).toBe(2_000_000n);
        expect(state.vaultBalance).toBe(4_000_000n); // unchanged by write-off
        const m = yield* resolveMemberAccount(lucid, memberTokenSuffix);
        expect(m.account.share_units).toBe(2n);
        expect(m.account.borrowed).toBe(0n);
        const loans = yield* getFundLoansProgram(lucid, fundTokenName);
        expect(loans.length).toBe(0);
      }),
  );
});
