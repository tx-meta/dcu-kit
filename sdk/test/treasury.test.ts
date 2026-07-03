import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import {
  paymentCredentialOf,
  generateEmulatorAccount,
} from "@lucid-evolution/lucid";
import {
  createAccountTestCase,
  joinGroupTestCase,
  exitGroupTestCase,
  distributePayoutTestCase,
  startGroupTestCase,
  updateGroupTestCase,
} from "./actions.js";
import {
  setupBase,
  setupGroup,
  setupAccount,
  setupMembership,
} from "./setup.js";
import { unsignedTerminateGroupTxProgram } from "../src/endpoints/terminateGroup.js";
import { unsignedTerminateDefaultTxProgram } from "../src/endpoints/terminateDefault.js";
import { unsignedDistributePayoutTxProgram } from "../src/endpoints/distributePayout.js";
import { unsignedJoinGroupTxProgram } from "../src/endpoints/joinGroup.js";
import { unsignedExitGroupTxProgram } from "../src/endpoints/exitGroup.js";
import { unsignedContributeTxProgram } from "../src/endpoints/contribute.js";
import { unsignedUpdatePayoutCredentialTxProgram } from "../src/endpoints/updatePayoutCredential.js";
import { unsignedExtendGraceWindowTxProgram } from "../src/endpoints/extendGraceWindow.js";
import { unsignedClaimPayoutTxProgram } from "../src/endpoints/claimPayout.js";
import {
  signAndSubmit,
  selectWalletFromSeed,
  getWalletAddress,
  assetNameLabels,
  parseSafeDatum,
  patchInlineDatum,
  parseGroupCip68Datum,
  buildMultisig,
} from "../src/core/utils/index.js";
import { SetupError } from "../src/core/errors.js";
import { accountPolicyId } from "../src/core/validators/constants.js";
import { TreasuryDatum, TreasuryDatumSchema } from "../src/core/types.js";
import { extractTokenSuffix } from "./utils.js";
import { advanceBlock } from "./effects.js";

// Shared Pull-mode fixture: a 2-member Pull group, started, with round 0 distributed so the
// borrower (user1, slot 0) holds a 4 ADA earmark (claimable_balance) in their own treasury.
const setupPullDistributed = (base: Parameters<typeof setupGroup>[0]) =>
  Effect.gen(function* () {
    // collateral_rounds: 2 prefunds both rounds for this 2-member group, so the non-borrower
    // stays solvent (no ICS) after round 0 and the borrower keeps collateral alongside the earmark.
    const { context, groupUtxo } = yield* setupGroup(base, {
      payout_mode: "Pull",
      collateral_rounds: 2n,
    });
    const { users } = context;

    const {
      outputs: { userUtxo: user1AccountUtxo },
    } = yield* createAccountTestCase(context, {
      userSeed: users.user1.seedPhrase,
    });
    const {
      outputs: { userUtxo: user2AccountUtxo },
    } = yield* createAccountTestCase(context, {
      userSeed: users.user2.seedPhrase,
    });

    yield* joinGroupTestCase(context, {
      groupUtxo,
      accountUtxo: user1AccountUtxo,
      userSeed: users.user1.seedPhrase,
    });
    yield* joinGroupTestCase(context, {
      groupUtxo,
      accountUtxo: user2AccountUtxo,
      userSeed: users.user2.seedPhrase,
    });
    yield* startGroupTestCase(context, { groupUtxo });

    const result = yield* distributePayoutTestCase(context, {
      groupUtxo,
      callerSeed: users.user1.seedPhrase,
    });

    const suffix1 = extractTokenSuffix(
      user1AccountUtxo,
      accountPolicyId,
      assetNameLabels.prefix222,
    );

    return { context, groupUtxo, user1AccountUtxo, suffix1, result };
  });

describe("Treasury Endpoints", () => {
  // --- Join Group ---
  it.effect("should allow a user with an account to join a group", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();

      const { context, groupUtxo } = yield* setupGroup(base);
      const { userUtxo } = yield* setupAccount(base);
      const { users } = context;

      if (!userUtxo)
        return yield* Effect.die(
          new SetupError({ message: "User Account UTxO not found" }),
        );

      const result = yield* joinGroupTestCase(context, {
        groupUtxo,
        accountUtxo: userUtxo,
        userSeed: users.user1.seedPhrase,
      });
      expect(result.txHash).toHaveLength(64);
    }),
  );

  // --- Start Group ---
  // Seals membership and anchors the rotation schedule: is_started flips true,
  // num_rounds is fixed to member_count, and start_time is set to the tx lower bound.
  // Exercised indirectly by every multi-round test; this asserts the sealed datum directly.
  it.effect("should seal membership and anchor the schedule (StartGroup)", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      const { context, groupUtxo } = yield* setupGroup(base);
      const { lucid, users } = context;

      const {
        outputs: { userUtxo: user1AccountUtxo },
      } = yield* createAccountTestCase(context, {
        userSeed: users.user1.seedPhrase,
      });
      const {
        outputs: { userUtxo: user2AccountUtxo },
      } = yield* createAccountTestCase(context, {
        userSeed: users.user2.seedPhrase,
      });

      yield* joinGroupTestCase(context, {
        groupUtxo,
        accountUtxo: user1AccountUtxo,
        userSeed: users.user1.seedPhrase,
      });
      yield* joinGroupTestCase(context, {
        groupUtxo,
        accountUtxo: user2AccountUtxo,
        userSeed: users.user2.seedPhrase,
      });

      yield* startGroupTestCase(context, { groupUtxo });

      // Read the sealed group datum back from chain.
      const groupTokenSuffix = extractTokenSuffix(
        groupUtxo,
        context.protocol!.groupPolicyId,
        assetNameLabels.prefix100,
      );
      const groupRefUnit =
        context.protocol!.groupPolicyId +
        assetNameLabels.prefix100 +
        groupTokenSuffix;
      const sealed = yield* Effect.promise(() =>
        lucid.utxoByUnit(groupRefUnit),
      );
      const cip = yield* parseGroupCip68Datum(patchInlineDatum(sealed).datum);
      expect(cip.groupDatum.is_started).toBe(true);
      expect(cip.groupDatum.member_count).toBe(2n);
      // num_rounds is sealed to member_count.
      expect(cip.groupDatum.num_rounds).toBe(2n);
      // start_time is anchored to the tx lower bound (a positive emulator timestamp).
      expect(cip.groupDatum.start_time > 0n).toBe(true);
    }),
  );

  // --- Exit Group (Standard) ---
  // With num_rounds=0 (no startGroup called), maturityTime = start_time.
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
  // startGroup (with >= 2 members) sets num_rounds=2 and anchors start_time.
  // An exit shortly after startGroup is an early exit → PenaltyState created.
  // terminateGroup then burns that PenaltyState UTxO.
  it.effect("should allow terminating a membership (burn)", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      const { context, groupUtxo } = yield* setupGroup(base);
      const { lucid, users } = context;

      // Create accounts for both users — startGroup requires member_count >= 2.
      const {
        outputs: { userUtxo: user1AccountUtxo },
      } = yield* createAccountTestCase(context, {
        userSeed: users.user1.seedPhrase,
      });
      const {
        outputs: { userUtxo: user2AccountUtxo },
      } = yield* createAccountTestCase(context, {
        userSeed: users.user2.seedPhrase,
      });

      // Both users join. The token suffix from the initial groupUtxo is permanent
      // across UTxO spends, so each joinGroupTestCase resolves the current UTxO internally.
      yield* joinGroupTestCase(context, {
        groupUtxo,
        accountUtxo: user1AccountUtxo,
        userSeed: users.user1.seedPhrase,
      });
      yield* joinGroupTestCase(context, {
        groupUtxo,
        accountUtxo: user2AccountUtxo,
        userSeed: users.user2.seedPhrase,
      });

      // startGroup: seals membership, sets num_rounds=2, start_time=now.
      yield* startGroupTestCase(context, { groupUtxo });

      // user1 early exit: now < start_time + 2*interval_length → PenaltyState created.
      const exitResult = yield* exitGroupTestCase(context, {
        groupUtxo,
        accountUtxo: user1AccountUtxo,
        userSeed: users.user1.seedPhrase,
      });
      expect(exitResult.txHash).toHaveLength(64);

      // Admin terminates the PenaltyState UTxO via permanent token suffixes.
      const groupTokenSuffix = extractTokenSuffix(
        groupUtxo,
        context.protocol!.groupPolicyId,
        assetNameLabels.prefix100,
      );
      const memberAccountTokenSuffix = extractTokenSuffix(
        user1AccountUtxo,
        accountPolicyId,
        assetNameLabels.prefix222,
      );

      selectWalletFromSeed(lucid, users.admin.seedPhrase);
      const unsignedTx = yield* unsignedTerminateGroupTxProgram(
        context.protocol!,
        lucid,
        {
          groupTokenSuffix,
          memberAccountTokenSuffix,
        },
      );
      const txHash = yield* signAndSubmit(unsignedTx);
      expect(txHash).toHaveLength(64);
    }),
  );

  // --- Distribute Payout ---
  // Round 0: fresh treasury UTxOs have rounds_paid=0, which equals roundNumber=0.
  // After distribute, all treasury outputs have rounds_paid=1.
  it.effect(
    "should distribute payout for round 0 and set rounds_paid to 1 in all treasury outputs",
    () =>
      Effect.gen(function* () {
        const base = yield* setupBase();
        const { context, groupUtxo } = yield* setupGroup(base);
        const { users } = context;

        // Create accounts for both users — startGroup requires member_count >= 2.
        const {
          outputs: { userUtxo: user1AccountUtxo },
        } = yield* createAccountTestCase(context, {
          userSeed: users.user1.seedPhrase,
        });
        const {
          outputs: { userUtxo: user2AccountUtxo },
        } = yield* createAccountTestCase(context, {
          userSeed: users.user2.seedPhrase,
        });

        // user1 joins first → assigned_slot=0 (borrower for round 0).
        // user2 joins second → assigned_slot=1.
        yield* joinGroupTestCase(context, {
          groupUtxo,
          accountUtxo: user1AccountUtxo,
          userSeed: users.user1.seedPhrase,
        });
        yield* joinGroupTestCase(context, {
          groupUtxo,
          accountUtxo: user2AccountUtxo,
          userSeed: users.user2.seedPhrase,
        });

        // startGroup: sets num_rounds=2, is_started=true, start_time=now.
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
          const datum = (yield* parseSafeDatum(
            patched.datum,
            TreasuryDatumSchema,
          )) as unknown as TreasuryDatum;
          if ("TreasuryState" in datum) {
            expect(datum.TreasuryState.rounds_paid).toBe(1n);
          }
        }
      }),
  );

  // --- Pull payout mode: distribute earmarks into the borrower's treasury, then claim ---
  // Full round-trip: a Pull group distributes round 0 → the borrower's own treasury accrues
  // claimable_balance (no wallet payout) → the member claims it to their wallet → balance 0.
  it.effect(
    "should earmark the pot under Pull mode and let the borrower claim it (ClaimPayout)",
    () =>
      Effect.gen(function* () {
        const base = yield* setupBase();
        // Pull mode is fixed at group creation.
        const { context, groupUtxo } = yield* setupGroup(base, {
          payout_mode: "Pull",
        });
        const { lucid, users } = context;

        const {
          outputs: { userUtxo: user1AccountUtxo },
        } = yield* createAccountTestCase(context, {
          userSeed: users.user1.seedPhrase,
        });
        const {
          outputs: { userUtxo: user2AccountUtxo },
        } = yield* createAccountTestCase(context, {
          userSeed: users.user2.seedPhrase,
        });

        // user1 → slot 0 (borrower for round 0); user2 → slot 1.
        yield* joinGroupTestCase(context, {
          groupUtxo,
          accountUtxo: user1AccountUtxo,
          userSeed: users.user1.seedPhrase,
        });
        yield* joinGroupTestCase(context, {
          groupUtxo,
          accountUtxo: user2AccountUtxo,
          userSeed: users.user2.seedPhrase,
        });
        yield* startGroupTestCase(context, { groupUtxo });

        // Distribute round 0 under Pull: the pot (2 members × 2 ADA = 4 ADA) is earmarked
        // into user1's own treasury, NOT paid to a wallet.
        const result = yield* distributePayoutTestCase(context, {
          groupUtxo,
          callerSeed: users.user1.seedPhrase,
        });

        const suffix1 = extractTokenSuffix(
          user1AccountUtxo,
          accountPolicyId,
          assetNameLabels.prefix222,
        );
        const treasuryUnit1 =
          context.protocol!.treasuryPolicyId +
          assetNameLabels.prefix222 +
          suffix1;

        // The borrower's treasury output carries the earmark; nobody else does.
        const borrowerTreasury = result.treasuryOutputs.find(
          (u) => u.assets[treasuryUnit1] === 1n,
        );
        expect(borrowerTreasury).toBeDefined();
        const earmarkDatum = (yield* parseSafeDatum(
          patchInlineDatum(borrowerTreasury!).datum,
          TreasuryDatumSchema,
        )) as unknown as TreasuryDatum;
        expect("TreasuryState" in earmarkDatum).toBe(true);
        if ("TreasuryState" in earmarkDatum) {
          expect(earmarkDatum.TreasuryState.claimable_balance).toBe(4_000_000n);
          expect(earmarkDatum.TreasuryState.rounds_paid).toBe(1n);
        }

        // user1 claims their earmarked payout (auth by holding the 222 token).
        selectWalletFromSeed(lucid, users.user1.seedPhrase);
        const claimTx = yield* unsignedClaimPayoutTxProgram(
          context.protocol!,
          lucid,
          {
            accountTokenSuffix: suffix1,
            scriptRefs: context.scriptRefs,
          },
        );
        const claimHash = yield* signAndSubmit(claimTx);
        yield* advanceBlock(context.emulator);
        expect(claimHash).toHaveLength(64);

        // After claiming, the treasury's claimable_balance is reset to 0.
        const claimedTreasury = yield* Effect.promise(() =>
          lucid.utxoByUnit(treasuryUnit1),
        );
        const claimedDatum = (yield* parseSafeDatum(
          patchInlineDatum(claimedTreasury).datum,
          TreasuryDatumSchema,
        )) as unknown as TreasuryDatum;
        expect("TreasuryState" in claimedDatum).toBe(true);
        if ("TreasuryState" in claimedDatum) {
          expect(claimedDatum.TreasuryState.claimable_balance).toBe(0n);
        }
      }),
  );

  // --- Pull: claim to a fresh address (lost-wallet recovery) ---
  // Auth is by membership-token possession, and the destination is chosen at claim time, so
  // a member can direct the payout to a brand-new address that has never held funds.
  it.effect(
    "should let a member claim their Pull payout to a fresh address (lost-wallet recovery)",
    () =>
      Effect.gen(function* () {
        const base = yield* setupBase();
        const { context, suffix1 } = yield* setupPullDistributed(base);
        const { lucid, users } = context;

        // A fresh address with no prior UTxOs.
        const fresh = generateEmulatorAccount({ lovelace: 0n });

        selectWalletFromSeed(lucid, users.user1.seedPhrase);
        const claimTx = yield* unsignedClaimPayoutTxProgram(
          context.protocol!,
          lucid,
          {
            accountTokenSuffix: suffix1,
            scriptRefs: context.scriptRefs,
            destinationAddress: fresh.address,
          },
        );
        const claimHash = yield* signAndSubmit(claimTx);
        yield* advanceBlock(context.emulator);
        expect(claimHash).toHaveLength(64);

        // The previously-empty fresh address now holds exactly the 4 ADA pot.
        const freshUtxos = yield* Effect.promise(() =>
          lucid.utxosAt(fresh.address),
        );
        const total = freshUtxos.reduce((s, u) => s + u.assets.lovelace, 0n);
        expect(total).toBe(4_000_000n);
      }),
  );

  // --- Pull: an unclaimed earmark is returned to the member at exit ---
  // A Pull member who never claims doesn't lose the earmark — it is physically in their
  // treasury value, so a mature exit returns it along with the collateral.
  it.effect(
    "should return an unclaimed Pull earmark to the member at exit",
    () =>
      Effect.gen(function* () {
        const base = yield* setupBase();
        const { context, groupUtxo, user1AccountUtxo } =
          yield* setupPullDistributed(base);
        const { lucid, users } = context;

        // Deactivate the group so exit takes the mature burn path (full refund), regardless
        // of timing. UpdateGroup must preserve every field except is_active, so read the
        // current on-chain datum (post-join / start / distribute).
        const groupSuffix = extractTokenSuffix(
          groupUtxo,
          context.protocol!.groupPolicyId,
          assetNameLabels.prefix100,
        );
        const groupRefUnit =
          context.protocol!.groupPolicyId +
          assetNameLabels.prefix100 +
          groupSuffix;
        const currentGroupUtxo = yield* Effect.promise(() =>
          lucid.utxoByUnit(groupRefUnit),
        );
        const currentCip68 = yield* parseGroupCip68Datum(
          patchInlineDatum(currentGroupUtxo).datum,
        );

        selectWalletFromSeed(lucid, users.admin.seedPhrase);
        yield* updateGroupTestCase(context, {
          groupUtxo: currentGroupUtxo,
          updatedDatum: { ...currentCip68.groupDatum, is_active: false },
        });

        // Measure user1's wallet before and after the exit. Treasury holds 6 ADA after round 0
        // (4 deposit − 2 fee + 4 earmark); a full refund returns > 4 ADA. A stranded earmark
        // would refund only ~2 ADA (the leftover collateral).
        selectWalletFromSeed(lucid, users.user1.seedPhrase);
        const before = yield* Effect.promise(() => lucid.wallet().getUtxos());
        const beforeLovelace = before.reduce(
          (s, u) => s + u.assets.lovelace,
          0n,
        );

        const exitResult = yield* exitGroupTestCase(context, {
          groupUtxo: currentGroupUtxo,
          accountUtxo: user1AccountUtxo,
          userSeed: users.user1.seedPhrase,
        });
        expect(exitResult.txHash).toHaveLength(64);

        const after = yield* Effect.promise(() => lucid.wallet().getUtxos());
        const afterLovelace = after.reduce((s, u) => s + u.assets.lovelace, 0n);
        // > 4 ADA recovered ⇒ the 4 ADA earmark came home on top of the 2 ADA collateral
        // (a stranded earmark would refund only the ~2 ADA leftover collateral).
        expect(afterLovelace - beforeLovelace).toBeGreaterThan(4_000_000n);
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

      const groupTokenSuffix = extractTokenSuffix(
        groupUtxo,
        context.protocol!.groupPolicyId,
        assetNameLabels.prefix100,
      );
      const err = yield* Effect.flip(
        unsignedDistributePayoutTxProgram(context.protocol!, lucid, {
          groupTokenSuffix,
        }),
      );

      expect(err._tag).toBe("TransactionBuildError");
      if (err._tag === "TransactionBuildError") {
        expect(err.error).toContain("not been started");
      }
    }),
  );

  // --- Negative: joinGroup with non-existent account ---
  it.effect(
    "should fail joining a group when the account does not exist on-chain",
    () =>
      Effect.gen(function* () {
        const base = yield* setupBase();
        const { context, groupUtxo } = yield* setupGroup(base);
        const { lucid, users } = context;

        selectWalletFromSeed(lucid, users.user1.seedPhrase);

        const groupTokenSuffix = extractTokenSuffix(
          groupUtxo,
          context.protocol!.groupPolicyId,
          assetNameLabels.prefix100,
        );
        const fakeAccountSuffix = "00".repeat(28);

        const err = yield* Effect.flip(
          unsignedJoinGroupTxProgram(context.protocol!, lucid, {
            groupTokenSuffix,
            accountTokenSuffix: fakeAccountSuffix,
          }),
        );

        expect(err._tag).toBe("UtxoNotFoundError");
      }),
  );

  // --- Negative: exitGroup after treasury UTxO has been burned ---
  // With num_rounds=0 (no startGroup), every exit is a mature exit (burn).
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
      const groupTokenSuffix = extractTokenSuffix(
        groupUtxo,
        context.protocol!.groupPolicyId,
        assetNameLabels.prefix100,
      );
      const accountTokenSuffix = extractTokenSuffix(
        userUtxo,
        accountPolicyId,
        assetNameLabels.prefix222,
      );

      selectWalletFromSeed(lucid, users.user1.seedPhrase);
      const err = yield* Effect.flip(
        unsignedExitGroupTxProgram(context.protocol!, lucid, {
          groupTokenSuffix,
          accountTokenSuffix,
        }),
      );

      expect(err._tag).toBe("UtxoNotFoundError");
    }),
  );

  // --- Positive: joinGroup routes joining_fee to admin wallet ---
  // When joining_fee > 0, the SDK adds an output to creator_payment_credential.
  // The Aiken validator enforces this: joining_fee_routed? fails if the output is absent.
  it.effect(
    "should route joining_fee to the admin wallet when joining_fee > 0",
    () =>
      Effect.gen(function* () {
        const base = yield* setupBase();
        const { lucid, users } = base.context;

        // Derive the group creator's PKH so creator_payment_credential points to a real wallet.
        selectWalletFromSeed(lucid, users.user1.seedPhrase);
        const adminAddress = yield* getWalletAddress(lucid);
        const adminPkh = paymentCredentialOf(adminAddress).hash;

        const { groupUtxo } = yield* setupGroup(base, {
          joining_fee: 1_000_000n,
          creator_payment_credential: {
            VerificationKey: [adminPkh] as [string],
          },
        });
        const { userUtxo } = yield* setupAccount(base);
        if (!userUtxo)
          return yield* Effect.fail(
            new SetupError({ message: "User UTxO not found" }),
          );

        selectWalletFromSeed(lucid, users.user1.seedPhrase);
        const groupTokenSuffix = extractTokenSuffix(
          groupUtxo,
          base.context.protocol!.groupPolicyId,
          assetNameLabels.prefix100,
        );
        const accountTokenSuffix = extractTokenSuffix(
          userUtxo,
          accountPolicyId,
          assetNameLabels.prefix222,
        );

        const currentTime = base.context.emulator
          ? BigInt(base.context.emulator.now())
          : BigInt(Date.now()) - 120_000n;
        const txBuilder = yield* unsignedJoinGroupTxProgram(
          base.context.protocol!,
          lucid,
          {
            groupTokenSuffix,
            accountTokenSuffix,
            currentTime,
            scriptRefs: base.context.scriptRefs,
          },
        );
        const txHash = yield* signAndSubmit(txBuilder);
        expect(txHash).toHaveLength(64);
      }),
  );

  // --- Positive: joinGroup routes joining_fee to a MULTISIG creator credential ---
  // The creator credential is a Script (native multisig) hash; the SDK derives the fee
  // address from the credential kind and the validator's credential-equality check
  // accepts it. The fee must land at the multisig script address.
  it.effect(
    "should route joining_fee to a multisig script creator credential",
    () =>
      Effect.gen(function* () {
        const base = yield* setupBase();
        const { lucid, users } = base.context;

        selectWalletFromSeed(lucid, users.admin.seedPhrase);
        const multisig = yield* buildMultisig(lucid, {
          signers: ["a".repeat(56), "b".repeat(56), "c".repeat(56)],
          required: 2,
        });

        const { groupUtxo } = yield* setupGroup(
          base,
          {
            joining_fee: 1_000_000n,
            creator_payment_credential: {
              Script: [multisig.policyHash] as [string],
            },
          },
          { creatorScript: multisig.script },
        );
        const { userUtxo } = yield* setupAccount(base);
        if (!userUtxo)
          return yield* Effect.fail(
            new SetupError({ message: "User UTxO not found" }),
          );

        selectWalletFromSeed(lucid, users.user1.seedPhrase);
        const groupTokenSuffix = extractTokenSuffix(
          groupUtxo,
          base.context.protocol!.groupPolicyId,
          assetNameLabels.prefix100,
        );
        const accountTokenSuffix = extractTokenSuffix(
          userUtxo,
          accountPolicyId,
          assetNameLabels.prefix222,
        );

        const currentTime = base.context.emulator
          ? BigInt(base.context.emulator.now())
          : BigInt(Date.now()) - 120_000n;
        const txBuilder = yield* unsignedJoinGroupTxProgram(
          base.context.protocol!,
          lucid,
          {
            groupTokenSuffix,
            accountTokenSuffix,
            currentTime,
            scriptRefs: base.context.scriptRefs,
          },
        );
        const txHash = yield* signAndSubmit(txBuilder);
        expect(txHash).toHaveLength(64);
        yield* advanceBlock(base.context.emulator);

        // The joining fee must sit at the multisig script address.
        const multisigUtxos = yield* Effect.tryPromise(() =>
          lucid.utxosAt(multisig.address),
        );
        const feeUtxo = multisigUtxos.find(
          (u) => u.txHash === txHash && u.assets.lovelace >= 1_000_000n,
        );
        expect(feeUtxo).toBeDefined();
      }),
  );

  // --- Negative: joinGroup when group is at max capacity ---
  // Group capped at 1 member; first join fills it (member_count becomes 1).
  // A second join attempt is rejected by the on-chain validator: member_count < max_members → 1 < 1 → False.
  it.effect("should reject joining a group when at max capacity", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();

      const { context, groupUtxo, userUtxo } = yield* setupMembership(base, {
        max_members: 1n,
      });
      const { lucid, users } = context;

      selectWalletFromSeed(lucid, users.user1.seedPhrase);

      const groupTokenSuffix = extractTokenSuffix(
        groupUtxo,
        context.protocol!.groupPolicyId,
        assetNameLabels.prefix100,
      );
      const accountTokenSuffix = extractTokenSuffix(
        userUtxo,
        accountPolicyId,
        assetNameLabels.prefix222,
      );

      const err = yield* Effect.flip(
        unsignedJoinGroupTxProgram(context.protocol!, lucid, {
          groupTokenSuffix,
          accountTokenSuffix,
        }),
      );

      expect(err._tag).toBe("TransactionBuildError");
    }),
  );

  // --- Positive: exit when group is deactivated (is_active=false) ---
  // Admin deactivates the group via UpdateGroup. The !is_active branch in
  // validate_exit_group takes the burn path regardless of timing — no penalty.
  it.effect(
    "should allow exit when group is deactivated (is_active=false)",
    () =>
      Effect.gen(function* () {
        const base = yield* setupBase();
        const { context, groupUtxo, userUtxo } = yield* setupMembership(base);
        const { lucid, users } = context;

        // Parse the current on-chain group datum (post-join: member_count=1, member_token_names=[...]).
        // UpdateGroup enforces member_count and member_token_names are unchanged, so we
        // must pass the post-join datum — not the creation datum from setupMembership.
        const patchedGroupUtxo = patchInlineDatum(groupUtxo);
        const rawCip68 = yield* parseGroupCip68Datum(patchedGroupUtxo.datum);
        const currentGroupDatum = rawCip68.groupDatum;

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
      // collateral_rounds: 2 → each member prefunds both rounds (deposit = 2 × fee), so
      // neither defaults mid-cycle. (The default PerRound deposit covers only round 0.)
      const { context, groupUtxo } = yield* setupGroup(base, {
        interval_length: 20_000n,
        collateral_rounds: 2n,
      });
      const { users } = context;

      // Create accounts for both members — startGroup requires member_count >= 2.
      const {
        outputs: { userUtxo: user1AccountUtxo },
      } = yield* createAccountTestCase(context, {
        userSeed: users.user1.seedPhrase,
      });
      const {
        outputs: { userUtxo: user2AccountUtxo },
      } = yield* createAccountTestCase(context, {
        userSeed: users.user2.seedPhrase,
      });

      // user1 → slot 0 (borrower for round 0), user2 → slot 1 (borrower for round 1).
      yield* joinGroupTestCase(context, {
        groupUtxo,
        accountUtxo: user1AccountUtxo,
        userSeed: users.user1.seedPhrase,
      });
      yield* joinGroupTestCase(context, {
        groupUtxo,
        accountUtxo: user2AccountUtxo,
        userSeed: users.user2.seedPhrase,
      });

      // startGroup: seals membership, num_rounds=2, start_time = emulator.now().
      yield* startGroupTestCase(context, { groupUtxo });

      // Distribute round 0 then round 1. The endpoint reads last_distributed_round
      // from the on-chain group UTxO, so sequential calls advance round 0 → 1 automatically.
      // Each awaitBlock(1) advances the emulator by 20 slots = one interval.
      yield* distributePayoutTestCase(context, {
        groupUtxo,
        callerSeed: users.user1.seedPhrase,
      });
      yield* distributePayoutTestCase(context, {
        groupUtxo,
        callerSeed: users.user2.seedPhrase,
      });

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
  it.effect(
    "should allow a member to top up their treasury balance (Contribute)",
    () =>
      Effect.gen(function* () {
        const base = yield* setupBase();
        const { context, groupUtxo, userUtxo } = yield* setupMembership(base);
        const { lucid, users } = context;

        const groupTokenSuffix = extractTokenSuffix(
          groupUtxo,
          context.protocol!.groupPolicyId,
          assetNameLabels.prefix100,
        );
        const accountTokenSuffix = extractTokenSuffix(
          userUtxo,
          accountPolicyId,
          assetNameLabels.prefix222,
        );

        selectWalletFromSeed(lucid, users.user1.seedPhrase);
        const txBuilder = yield* unsignedContributeTxProgram(
          context.protocol!,
          lucid,
          {
            groupTokenSuffix,
            accountTokenSuffix,
            scriptRefs: context.scriptRefs,
            topUpAmount: 2_000_000n,
          },
        );
        const txHash = yield* signAndSubmit(txBuilder);
        expect(txHash).toHaveLength(64);
      }),
  );

  // --- Native-token group (end-to-end) ---
  // A group whose contribution asset is a native token (not ADA): Join must lock the
  // token in the treasury, and Contribute must top up the token balance.
  it.effect(
    "should support a native-token contribution group (Join locks token, Contribute tops up)",
    () =>
      Effect.gen(function* () {
        const tokenPolicy =
          "f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0";
        const tokenName = "55534454"; // "USDT"
        const tokenUnit = tokenPolicy + tokenName;

        // Seed every emulator wallet with the native token so members can deposit it.
        const base = yield* setupBase({ [tokenUnit]: 1_000_000n });
        const { context, groupUtxo, userUtxo, memberUtxo } =
          yield* setupMembership(base, {
            contribution_fee_policyid: tokenPolicy,
            contribution_fee_assetname: tokenName,
            contribution_fee: 5n,
          });
        const { lucid, users } = context;

        // Join locks the collateral floor: collateral_rounds (1, PerRound default) ×
        // contribution_fee (5) = 5 tokens in the treasury.
        expect(memberUtxo.assets[tokenUnit]).toBe(5n);

        const groupTokenSuffix = extractTokenSuffix(
          groupUtxo,
          context.protocol!.groupPolicyId,
          assetNameLabels.prefix100,
        );
        const accountTokenSuffix = extractTokenSuffix(
          userUtxo,
          accountPolicyId,
          assetNameLabels.prefix222,
        );

        selectWalletFromSeed(lucid, users.user1.seedPhrase);
        const txBuilder = yield* unsignedContributeTxProgram(
          context.protocol!,
          lucid,
          {
            groupTokenSuffix,
            accountTokenSuffix,
            scriptRefs: context.scriptRefs,
            topUpAmount: 5n,
          },
        );
        const txHash = yield* signAndSubmit(txBuilder);
        expect(txHash).toHaveLength(64);
      }),
  );

  // --- Native-token group: full distribute round (end-to-end) ---
  // Closes the coverage gap noted in the roadmap: a 2-member group whose contribution asset
  // is a native token, driven Join -> StartGroup -> DistributeRound. Round 0 debits each
  // member's treasury by the fee in the TOKEN (Push mode pays the borrower from the pool to
  // their wallet). Join locks collateral_rounds(2) x fee(5) = 10 tokens; round 0 deducts 5,
  // so each treasury output holds 5 tokens afterward.
  it.effect("should distribute a native-token round to two members", () =>
    Effect.gen(function* () {
      const tokenPolicy =
        "f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0";
      const tokenName = "55534454"; // "USDT"
      const tokenUnit = tokenPolicy + tokenName;

      const base = yield* setupBase({ [tokenUnit]: 1_000_000n });
      const { context, groupUtxo } = yield* setupGroup(base, {
        contribution_fee_policyid: tokenPolicy,
        contribution_fee_assetname: tokenName,
        contribution_fee: 5n,
        collateral_rounds: 2n,
      });
      const { users } = context;

      const {
        outputs: { userUtxo: user1AccountUtxo },
      } = yield* createAccountTestCase(context, {
        userSeed: users.user1.seedPhrase,
      });
      const {
        outputs: { userUtxo: user2AccountUtxo },
      } = yield* createAccountTestCase(context, {
        userSeed: users.user2.seedPhrase,
      });

      yield* joinGroupTestCase(context, {
        groupUtxo,
        accountUtxo: user1AccountUtxo,
        userSeed: users.user1.seedPhrase,
      });
      yield* joinGroupTestCase(context, {
        groupUtxo,
        accountUtxo: user2AccountUtxo,
        userSeed: users.user2.seedPhrase,
      });
      yield* startGroupTestCase(context, { groupUtxo });

      const result = yield* distributePayoutTestCase(context, {
        groupUtxo,
        callerSeed: users.user1.seedPhrase,
      });

      expect(result.txHash).toHaveLength(64);
      // Both members' treasuries are spent and re-output, each debited exactly the fee
      // (5) in the contribution token: 10 locked - 5 = 5 remaining.
      expect(result.treasuryOutputs).toHaveLength(2);
      for (const out of result.treasuryOutputs) {
        expect(out.assets[tokenUnit]).toBe(5n);
      }
    }),
  );

  // --- UpdatePayout ---
  // Member updates their payout destination to their current wallet address.
  it.effect(
    "should allow a member to update their payout credential (UpdatePayout)",
    () =>
      Effect.gen(function* () {
        const base = yield* setupBase();
        const { context, userUtxo } = yield* setupMembership(base);
        const { lucid, users } = context;

        const accountTokenSuffix = extractTokenSuffix(
          userUtxo,
          accountPolicyId,
          assetNameLabels.prefix222,
        );

        selectWalletFromSeed(lucid, users.user1.seedPhrase);
        const txBuilder = yield* unsignedUpdatePayoutCredentialTxProgram(
          context.protocol!,
          lucid,
          { accountTokenSuffix, scriptRefs: context.scriptRefs },
        );
        const txHash = yield* signAndSubmit(txBuilder);
        expect(txHash).toHaveLength(64);
      }),
  );

  // --- ExtendGrace ---
  // User1 joins as a PerRound member (collateral_rounds = 1): the default deposit is
  // contribution_fee + MIN_ADA_RESERVE = 2M + 2M = 4M, i.e. exactly one round of
  // *contributable* collateral. After distribute round 0 debits the fee, user1's
  // contributable balance is 0 < 2M (and round 0 is not the last of 2) → DefaultState.
  // Admin then extends the grace window (grace_extensions_used 0 → 1). No deposit override
  // is needed — a single-round member naturally defaults after one round under B3, and a
  // thinner deposit would (correctly) be rejected by the join floor.
  it.effect(
    "should allow admin to extend a member's grace window (ExtendGrace)",
    () =>
      Effect.gen(function* () {
        const base = yield* setupBase();
        const { context, groupUtxo } = yield* setupGroup(base, {
          interval_length: 20_000n,
        });
        const { lucid, users } = context;

        // Both users need accounts — startGroup requires member_count >= 2.
        const {
          outputs: { userUtxo: user1AccountUtxo },
        } = yield* createAccountTestCase(context, {
          userSeed: users.user1.seedPhrase,
        });
        const {
          outputs: { userUtxo: user2AccountUtxo },
        } = yield* createAccountTestCase(context, {
          userSeed: users.user2.seedPhrase,
        });

        // User1 joins with a reduced deposit so round 0 triggers ICS for them.
        const groupTokenSuffix = extractTokenSuffix(
          groupUtxo,
          context.protocol!.groupPolicyId,
          assetNameLabels.prefix100,
        );
        const user1TokenSuffix = extractTokenSuffix(
          user1AccountUtxo,
          accountPolicyId,
          assetNameLabels.prefix222,
        );
        selectWalletFromSeed(lucid, users.user1.seedPhrase);
        const joinUser1Tx = yield* unsignedJoinGroupTxProgram(
          context.protocol!,
          lucid,
          {
            groupTokenSuffix,
            accountTokenSuffix: user1TokenSuffix,
            currentTime: BigInt(context.emulator!.now()),
            scriptRefs: context.scriptRefs,
          },
        );
        yield* signAndSubmit(joinUser1Tx);
        yield* advanceBlock(context.emulator);

        yield* joinGroupTestCase(context, {
          groupUtxo,
          accountUtxo: user2AccountUtxo,
          userSeed: users.user2.seedPhrase,
        });

        yield* startGroupTestCase(context, { groupUtxo });

        // Distribute round 0: user1's contributable 2M − 2M fee = 0 < 2M → DefaultState.
        yield* distributePayoutTestCase(context, {
          groupUtxo,
          callerSeed: users.user1.seedPhrase,
        });

        // Admin extends the grace window for user1.
        const memberAccountTokenSuffix = extractTokenSuffix(
          user1AccountUtxo,
          accountPolicyId,
          assetNameLabels.prefix222,
        );
        selectWalletFromSeed(lucid, users.admin.seedPhrase);
        const txBuilder = yield* unsignedExtendGraceWindowTxProgram(
          context.protocol!,
          lucid,
          {
            groupTokenSuffix,
            memberAccountTokenSuffix,
            scriptRefs: context.scriptRefs,
          },
        );
        const txHash = yield* signAndSubmit(txBuilder);
        expect(txHash).toHaveLength(64);
      }),
  );

  // --- TerminateDefault (B2) ---
  // A member who defaults (DefaultState) and never recovers can be removed by the admin
  // once their grace window has fully expired: the membership token is burned, member_count
  // decrements, and the collateral is forfeited to the admin. grace_period_length = 0 (the
  // default), so grace expires at the distribute round's timestamp; advancing the emulator
  // past it makes `now > grace_expires_at` hold.
  it.effect(
    "should let the admin terminate a defaulter after grace expires (TerminateDefault)",
    () =>
      Effect.gen(function* () {
        const base = yield* setupBase();
        const { context, groupUtxo } = yield* setupGroup(base, {
          interval_length: 20_000n,
        });
        const { lucid, users } = context;

        const {
          outputs: { userUtxo: user1AccountUtxo },
        } = yield* createAccountTestCase(context, {
          userSeed: users.user1.seedPhrase,
        });
        const {
          outputs: { userUtxo: user2AccountUtxo },
        } = yield* createAccountTestCase(context, {
          userSeed: users.user2.seedPhrase,
        });

        const groupTokenSuffix = extractTokenSuffix(
          groupUtxo,
          context.protocol!.groupPolicyId,
          assetNameLabels.prefix100,
        );
        const user1TokenSuffix = extractTokenSuffix(
          user1AccountUtxo,
          accountPolicyId,
          assetNameLabels.prefix222,
        );

        // user1 joins PerRound (default deposit) → defaults to DefaultState after round 0.
        yield* joinGroupTestCase(context, {
          groupUtxo,
          accountUtxo: user1AccountUtxo,
          userSeed: users.user1.seedPhrase,
        });
        yield* joinGroupTestCase(context, {
          groupUtxo,
          accountUtxo: user2AccountUtxo,
          userSeed: users.user2.seedPhrase,
        });
        yield* startGroupTestCase(context, { groupUtxo });

        // Distribute round 0: user1 (slot 0) is debited the fee → contributable 0 → DefaultState.
        yield* distributePayoutTestCase(context, {
          groupUtxo,
          callerSeed: users.user1.seedPhrase,
        });

        // Advance past grace_expires_at so the termination time-gate opens.
        yield* advanceBlock(context.emulator, 2);

        // Admin terminates the defaulter.
        selectWalletFromSeed(lucid, users.admin.seedPhrase);
        const terminateTx = yield* unsignedTerminateDefaultTxProgram(
          context.protocol!,
          lucid,
          {
            groupTokenSuffix,
            memberAccountTokenSuffix: user1TokenSuffix,
            currentTime: BigInt(context.emulator!.now()),
            scriptRefs: context.scriptRefs,
          },
        );
        const terminateHash = yield* signAndSubmit(terminateTx);
        yield* advanceBlock(context.emulator);
        expect(terminateHash).toHaveLength(64);

        // Group member_count decremented 2 → 1, and user1 removed from the registry —
        // this is the definitive on-chain proof: the count only drops via the group Exit
        // handler, which requires the burned membership token to be spent at the treasury.
        const groupRefUnit =
          context.protocol!.groupPolicyId +
          assetNameLabels.prefix100 +
          groupTokenSuffix;
        const currentGroup = yield* Effect.promise(() =>
          lucid.utxoByUnit(groupRefUnit),
        );
        const groupCip68 = yield* parseGroupCip68Datum(
          patchInlineDatum(currentGroup).datum,
        );
        expect(groupCip68.groupDatum.member_count).toBe(1n);
        const memberRefName = assetNameLabels.prefix222 + user1TokenSuffix;
        expect(
          groupCip68.groupDatum.member_token_names.includes(memberRefName),
        ).toBe(false);
      }),
  );

  // --- Contribute: DefaultState recovery ---
  // A defaulted (DefaultState/ICS) member tops up via Contribute to recover back to
  // TreasuryState. Mirrors the validator's recovery branch (recovery_funded): the
  // post-top-up balance must reach contribution_fee, and the preserved fields
  // (slot, rounds_paid, payout credential, earmark) carry through unchanged.
  it.effect(
    "should recover a DefaultState member to TreasuryState via Contribute",
    () =>
      Effect.gen(function* () {
        const base = yield* setupBase();
        const { context, groupUtxo } = yield* setupGroup(base, {
          interval_length: 20_000n,
        });
        const { lucid, users } = context;

        const {
          outputs: { userUtxo: user1AccountUtxo },
        } = yield* createAccountTestCase(context, {
          userSeed: users.user1.seedPhrase,
        });
        const {
          outputs: { userUtxo: user2AccountUtxo },
        } = yield* createAccountTestCase(context, {
          userSeed: users.user2.seedPhrase,
        });

        const groupTokenSuffix = extractTokenSuffix(
          groupUtxo,
          context.protocol!.groupPolicyId,
          assetNameLabels.prefix100,
        );
        const user1TokenSuffix = extractTokenSuffix(
          user1AccountUtxo,
          accountPolicyId,
          assetNameLabels.prefix222,
        );

        // user1 joins PerRound (default deposit = fee + reserve = 4M, contributable 2M),
        // so round 0 debits the fee and drops them to contributable 0 < 2M → DefaultState.
        selectWalletFromSeed(lucid, users.user1.seedPhrase);
        const joinUser1Tx = yield* unsignedJoinGroupTxProgram(
          context.protocol!,
          lucid,
          {
            groupTokenSuffix,
            accountTokenSuffix: user1TokenSuffix,
            currentTime: BigInt(context.emulator!.now()),
            scriptRefs: context.scriptRefs,
          },
        );
        yield* signAndSubmit(joinUser1Tx);
        yield* advanceBlock(context.emulator);

        yield* joinGroupTestCase(context, {
          groupUtxo,
          accountUtxo: user2AccountUtxo,
          userSeed: users.user2.seedPhrase,
        });
        yield* startGroupTestCase(context, { groupUtxo });

        // Distribute round 0: user1's contributable 2M − 2M fee = 0 < 2M → DefaultState.
        yield* distributePayoutTestCase(context, {
          groupUtxo,
          callerSeed: users.user1.seedPhrase,
        });

        const treasuryUnit1 =
          context.protocol!.treasuryPolicyId +
          assetNameLabels.prefix222 +
          user1TokenSuffix;

        const defaultedTreasury = yield* Effect.promise(() =>
          lucid.utxoByUnit(treasuryUnit1),
        );
        const defaultedDatum = (yield* parseSafeDatum(
          patchInlineDatum(defaultedTreasury).datum,
          TreasuryDatumSchema,
        )) as unknown as TreasuryDatum;
        expect("DefaultState" in defaultedDatum).toBe(true);

        // user1 contributes enough to reach contribution_fee → recovers to TreasuryState.
        selectWalletFromSeed(lucid, users.user1.seedPhrase);
        const recoverTx = yield* unsignedContributeTxProgram(
          context.protocol!,
          lucid,
          {
            groupTokenSuffix,
            accountTokenSuffix: user1TokenSuffix,
            topUpAmount: 2_000_000n, // raw 2M + 2M = 4M → contributable 2M ≥ 2M fee
            scriptRefs: context.scriptRefs,
          },
        );
        const recoverHash = yield* signAndSubmit(recoverTx);
        yield* advanceBlock(context.emulator);
        expect(recoverHash).toHaveLength(64);

        // Output transitions back to TreasuryState, preserving slot 0 and rounds_paid = 1.
        const recoveredTreasury = yield* Effect.promise(() =>
          lucid.utxoByUnit(treasuryUnit1),
        );
        const recoveredDatum = (yield* parseSafeDatum(
          patchInlineDatum(recoveredTreasury).datum,
          TreasuryDatumSchema,
        )) as unknown as TreasuryDatum;
        expect("TreasuryState" in recoveredDatum).toBe(true);
        if ("TreasuryState" in recoveredDatum) {
          expect(recoveredDatum.TreasuryState.rounds_paid).toBe(1n);
        }
      }),
  );
});
