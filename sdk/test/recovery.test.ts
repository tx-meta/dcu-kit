import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { paymentCredentialOf } from "@lucid-evolution/lucid";
import {
  createAccountTestCase,
  joinGroupTestCase,
  startGroupTestCase,
} from "./actions.js";
import { setupBase, setupGroup } from "./setup.js";
import { unsignedProposeRecoveryTxProgram } from "../src/endpoints/proposeRecovery.js";
import { unsignedApproveRecoveryTxProgram } from "../src/endpoints/approveRecovery.js";
import { unsignedCancelRecoveryTxProgram } from "../src/endpoints/cancelRecovery.js";
import { unsignedExecuteRecoveryTxProgram } from "../src/endpoints/executeRecovery.js";
import { unsignedContributeTxProgram } from "../src/endpoints/contribute.js";
import {
  signAndSubmit,
  selectWalletFromSeed,
  getWalletAddress,
  assetNameLabels,
  parseSafeDatum,
  patchInlineDatum,
  parseGroupCip68Datum,
} from "../src/core/utils/index.js";
import { accountPolicyId } from "../src/core/validators/constants.js";
import { TreasuryDatum, TreasuryDatumSchema } from "../src/core/types.js";
import { extractTokenSuffix } from "./utils.js";
import { advanceBlock } from "./effects.js";

// Cluster A — lost-member recovery (propose/approve/cancel/execute).
//
// Setup shared by both tests: a 2-member group (user1 = the "lost" member who will be
// recovered, user2 = the approver) at the envelope-floor recovery_timelock (1 day =
// 4320 emulator blocks; awaitBlock advances instantly, so the warp is cheap).
// recovery_threshold = 2 (the envelope floor); in the 2-member fixture the execute-time
// clamp (member_count - 1, floored at 1) makes a single approver sufficient quorum.
const setupRecoveryFixture = (options?: { withSecondApprover?: boolean }) =>
  Effect.gen(function* () {
    const base = yield* setupBase();
    const { context, groupUtxo } = yield* setupGroup(base, {
      recovery_timelock: 86_400_000n, // envelope floor (min_recovery_timelock)
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

    // Optional third registry member: a second, distinct account held by user2's
    // wallet, joined BEFORE the group seals. ApproveRecovery requires the approver
    // token to be in the group's member registry (spec ApproveRecovery 3a), so a
    // second approver must be a real member — a freshly minted account is not enough.
    let secondApproverTokenSuffix: string | undefined;
    if (options?.withSecondApprover) {
      const {
        outputs: { userUtxo: secondApproverUtxo },
      } = yield* createAccountTestCase(context, {
        userSeed: users.user2.seedPhrase,
      });
      yield* joinGroupTestCase(context, {
        groupUtxo,
        accountUtxo: secondApproverUtxo,
        userSeed: users.user2.seedPhrase,
      });
      secondApproverTokenSuffix = extractTokenSuffix(
        secondApproverUtxo,
        accountPolicyId,
        assetNameLabels.prefix222,
      );
    }

    yield* startGroupTestCase(context, { groupUtxo });

    // The recoveree's brand-new account (N') — admin's wallet creates it (admin's
    // GroupAdmin (222) token is under groupPolicyId, unrelated to accountPolicyId, so
    // this is a clean, independent account creation).
    const {
      outputs: { userUtxo: newAccountUtxo },
    } = yield* createAccountTestCase(context, {
      userSeed: users.admin.seedPhrase,
    });

    const groupTokenSuffix = extractTokenSuffix(
      groupUtxo,
      context.protocol!.groupPolicyId,
      assetNameLabels.prefix100,
    );
    const targetTokenSuffix = extractTokenSuffix(
      user1AccountUtxo,
      accountPolicyId,
      assetNameLabels.prefix222,
    );
    const approverTokenSuffix = extractTokenSuffix(
      user2AccountUtxo,
      accountPolicyId,
      assetNameLabels.prefix222,
    );
    const newAccountTokenSuffix = extractTokenSuffix(
      newAccountUtxo,
      accountPolicyId,
      assetNameLabels.prefix222,
    );

    selectWalletFromSeed(lucid, users.admin.seedPhrase);
    const newAddress = yield* getWalletAddress(lucid);
    const newPaymentCredential = paymentCredentialOf(newAddress).hash;

    return {
      context,
      groupUtxo,
      groupTokenSuffix,
      targetTokenSuffix,
      approverTokenSuffix,
      secondApproverTokenSuffix,
      newAccountTokenSuffix,
      newPaymentCredential,
    };
  });

describe("Cluster A — lost-member recovery", () => {
  it.effect(
    "happy round-trip: propose -> execute rotates N -> N', new account controls the position",
    () =>
      Effect.gen(function* () {
        const {
          context,
          groupTokenSuffix,
          targetTokenSuffix,
          approverTokenSuffix,
          newAccountTokenSuffix,
          newPaymentCredential,
        } = yield* setupRecoveryFixture();
        const { lucid, users } = context;

        // --- ProposeRecovery ---
        // Recoveree (admin's wallet, holding N') proposes; user2 (approver) co-signs.
        selectWalletFromSeed(lucid, users.admin.seedPhrase);
        const proposeTx = yield* unsignedProposeRecoveryTxProgram(
          context.protocol!,
          lucid,
          {
            groupTokenSuffix,
            targetTokenSuffix,
            newAccountTokenSuffix,
            newPaymentCredential,
            approverTokenSuffixes: [approverTokenSuffix],
            currentTime: BigInt(context.emulator!.now()),
            scriptRefs: context.scriptRefs,
          },
        );
        // Multi-party signing: admin (fee payer + recoveree) signs, then user2 (approver)
        // co-signs the same built tx before submission.
        const proposeSignedByAdmin = yield* Effect.tryPromise(() =>
          proposeTx.sign.withWallet().complete(),
        );
        selectWalletFromSeed(lucid, users.user2.seedPhrase);
        const proposeFullySigned = yield* Effect.tryPromise(() =>
          lucid
            .fromTx(proposeSignedByAdmin.toCBOR())
            .sign.withWallet()
            .complete(),
        );
        const proposeHash = yield* Effect.tryPromise(() =>
          proposeFullySigned.submit(),
        );
        yield* advanceBlock(context.emulator);
        expect(proposeHash).toHaveLength(64);

        // RecoveryRequest UTxO exists, holds exactly {N': 1}, approvals == [user2's token].
        const requestUnit =
          context.protocol!.treasuryPolicyId +
          assetNameLabels.prefix222 +
          newAccountTokenSuffix;
        const requestUtxo = yield* Effect.promise(() =>
          lucid.utxoByUnit(requestUnit),
        );
        expect(requestUtxo.assets[requestUnit]).toBe(1n);
        const requestDatum = (yield* parseSafeDatum(
          patchInlineDatum(requestUtxo).datum,
          TreasuryDatumSchema,
        )) as unknown as TreasuryDatum;
        expect("RecoveryRequest" in requestDatum).toBe(true);
        if ("RecoveryRequest" in requestDatum) {
          expect(requestDatum.RecoveryRequest.approvals.length).toBe(1);
        }

        // --- ExecuteRecovery (after timelock) ---
        // 4321 blocks × 20s = 86,420s > the 1-day timelock.
        yield* advanceBlock(context.emulator, 4321);

        selectWalletFromSeed(lucid, users.user1.seedPhrase); // anyone may execute
        const executeTx = yield* unsignedExecuteRecoveryTxProgram(
          context.protocol!,
          lucid,
          {
            groupTokenSuffix,
            targetTokenSuffix,
            newAccountTokenSuffix,
            currentTime: BigInt(context.emulator!.now()),
            scriptRefs: context.scriptRefs,
          },
        );
        const executeHash = yield* signAndSubmit(executeTx);
        yield* advanceBlock(context.emulator);
        expect(executeHash).toHaveLength(64);

        // The RecoveryRequest UTxO (identified by its OWN out-ref) is consumed — N'
        // (the `requestUnit`) was RELOCATED into the rotated treasury output, not
        // burned, so the unit itself still resolves (to the new UTxO below); what
        // must be gone is the specific request out-ref.
        const requestStillAtOldOutRef = yield* Effect.tryPromise(() =>
          lucid.utxosByOutRef([
            {
              txHash: requestUtxo.txHash,
              outputIndex: requestUtxo.outputIndex,
            },
          ]),
        );
        expect(requestStillAtOldOutRef.length).toBe(0);

        // N (the old account token) is burned — no UTxO anywhere holds it.
        const oldMemberUnit =
          context.protocol!.treasuryPolicyId +
          assetNameLabels.prefix222 +
          targetTokenSuffix;
        // utxoByUnit either rejects or resolves undefined when no UTxO holds the
        // unit; both mean the token was burned (see multisig.test.ts's
        // expectAdminTokenBurned for the same idiom).
        const oldResult = yield* Effect.tryPromise(() =>
          lucid.utxoByUnit(oldMemberUnit),
        ).pipe(Effect.either);
        const oldStillExists =
          oldResult._tag === "Right" && oldResult.right !== undefined;
        expect(oldStillExists).toBe(false);

        // Rotated member treasury now holds N' at the treasury script. N' is the
        // SAME unit (treasuryPolicyId + N') that the (now-consumed) request UTxO
        // held — it was relocated, not re-minted, so this unit now resolves to the
        // rotated treasury output instead.
        const rotatedTreasury = yield* Effect.tryPromise(() =>
          lucid.utxoByUnit(requestUnit),
        );
        expect(rotatedTreasury.assets[requestUnit]).toBe(1n);
        const rotatedDatum = (yield* parseSafeDatum(
          patchInlineDatum(rotatedTreasury).datum,
          TreasuryDatumSchema,
        )) as unknown as TreasuryDatum;
        expect("TreasuryState" in rotatedDatum).toBe(true);
        if ("TreasuryState" in rotatedDatum) {
          expect(rotatedDatum.TreasuryState.member_reference_tokenname).toBe(
            assetNameLabels.prefix222 + newAccountTokenSuffix,
          );
          expect(rotatedDatum.TreasuryState.member_payment_credential).toBe(
            newPaymentCredential,
          );
        }

        // Group registry now lists N', no longer N.
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
        const oldName = assetNameLabels.prefix222 + targetTokenSuffix;
        const newName = assetNameLabels.prefix222 + newAccountTokenSuffix;
        expect(groupCip68.groupDatum.member_token_names.includes(oldName)).toBe(
          false,
        );
        expect(groupCip68.groupDatum.member_token_names.includes(newName)).toBe(
          true,
        );

        // Control proof: a Contribute authorized by N' (the NEW account) succeeds —
        // proving the new key now genuinely controls the recovered position.
        selectWalletFromSeed(lucid, users.admin.seedPhrase); // holds N'
        const contributeTx = yield* unsignedContributeTxProgram(
          context.protocol!,
          lucid,
          {
            groupTokenSuffix,
            accountTokenSuffix: newAccountTokenSuffix,
            topUpAmount: 1_000_000n,
            scriptRefs: context.scriptRefs,
          },
        );
        const contributeHash = yield* signAndSubmit(contributeTx);
        expect(contributeHash).toHaveLength(64);
      }),
  );

  it.effect(
    "veto: cancelRecovery by the target-token holder destroys the request and burns N'",
    () =>
      Effect.gen(function* () {
        const {
          context,
          groupTokenSuffix,
          targetTokenSuffix,
          approverTokenSuffix,
          newAccountTokenSuffix,
          newPaymentCredential,
        } = yield* setupRecoveryFixture();
        const { lucid, users } = context;

        // --- ProposeRecovery ---
        selectWalletFromSeed(lucid, users.admin.seedPhrase);
        const proposeTx = yield* unsignedProposeRecoveryTxProgram(
          context.protocol!,
          lucid,
          {
            groupTokenSuffix,
            targetTokenSuffix,
            newAccountTokenSuffix,
            newPaymentCredential,
            approverTokenSuffixes: [approverTokenSuffix],
            currentTime: BigInt(context.emulator!.now()),
            scriptRefs: context.scriptRefs,
          },
        );
        const proposeSignedByAdmin = yield* Effect.tryPromise(() =>
          proposeTx.sign.withWallet().complete(),
        );
        selectWalletFromSeed(lucid, users.user2.seedPhrase);
        const proposeFullySigned = yield* Effect.tryPromise(() =>
          lucid
            .fromTx(proposeSignedByAdmin.toCBOR())
            .sign.withWallet()
            .complete(),
        );
        const proposeHash = yield* Effect.tryPromise(() =>
          proposeFullySigned.submit(),
        );
        yield* advanceBlock(context.emulator);
        expect(proposeHash).toHaveLength(64);

        // --- CancelRecovery: VETO by the real holder of N (target_token), BEFORE the
        // timelock elapses — proves the veto window has no time gate at all.
        selectWalletFromSeed(lucid, users.user1.seedPhrase); // holds target N
        const cancelTx = yield* unsignedCancelRecoveryTxProgram(
          context.protocol!,
          lucid,
          {
            targetTokenSuffix,
            newAccountTokenSuffix,
            scriptRefs: context.scriptRefs,
          },
        );
        const cancelHash = yield* signAndSubmit(cancelTx);
        yield* advanceBlock(context.emulator);
        expect(cancelHash).toHaveLength(64);

        // RecoveryRequest UTxO consumed, N' burned (no UTxO anywhere holds it).
        // utxoByUnit either rejects or resolves undefined when no UTxO holds the
        // unit; both mean N' was burned (see multisig.test.ts's
        // expectAdminTokenBurned for the same idiom).
        const requestUnit =
          context.protocol!.treasuryPolicyId +
          assetNameLabels.prefix222 +
          newAccountTokenSuffix;
        const requestResult = yield* Effect.tryPromise(() =>
          lucid.utxoByUnit(requestUnit),
        ).pipe(Effect.either);
        const requestStillExists =
          requestResult._tag === "Right" && requestResult.right !== undefined;
        expect(requestStillExists).toBe(false);

        // Group registry unchanged — still lists N (the original member), no rotation
        // happened (CancelRecovery never spends/edits the group).
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
        const oldName = assetNameLabels.prefix222 + targetTokenSuffix;
        expect(groupCip68.groupDatum.member_token_names.includes(oldName)).toBe(
          true,
        );
      }),
  );

  it.effect(
    "approveRecovery adds a second signed approval to a pending request",
    () =>
      Effect.gen(function* () {
        const {
          context,
          groupTokenSuffix,
          targetTokenSuffix,
          approverTokenSuffix,
          secondApproverTokenSuffix,
          newAccountTokenSuffix,
          newPaymentCredential,
        } = yield* setupRecoveryFixture({ withSecondApprover: true });
        const { lucid, users } = context;
        const extraApproverSuffix = secondApproverTokenSuffix!;

        // --- ProposeRecovery (1 approval: user2) ---
        selectWalletFromSeed(lucid, users.admin.seedPhrase);
        const proposeTx = yield* unsignedProposeRecoveryTxProgram(
          context.protocol!,
          lucid,
          {
            groupTokenSuffix,
            targetTokenSuffix,
            newAccountTokenSuffix,
            newPaymentCredential,
            approverTokenSuffixes: [approverTokenSuffix],
            currentTime: BigInt(context.emulator!.now()),
            scriptRefs: context.scriptRefs,
          },
        );
        const proposeSignedByAdmin = yield* Effect.tryPromise(() =>
          proposeTx.sign.withWallet().complete(),
        );
        selectWalletFromSeed(lucid, users.user2.seedPhrase);
        const proposeFullySigned = yield* Effect.tryPromise(() =>
          lucid
            .fromTx(proposeSignedByAdmin.toCBOR())
            .sign.withWallet()
            .complete(),
        );
        yield* Effect.tryPromise(() => proposeFullySigned.submit());
        yield* advanceBlock(context.emulator);

        // --- ApproveRecovery: a distinct registry member (not yet in approvals, not
        // the target) adds a second signed approval. The second approver joined the
        // group before it sealed — spec ApproveRecovery 3a requires registry membership.
        selectWalletFromSeed(lucid, users.user2.seedPhrase);
        const approveTx = yield* unsignedApproveRecoveryTxProgram(
          context.protocol!,
          lucid,
          {
            groupTokenSuffix,
            targetTokenSuffix,
            newAccountTokenSuffix,
            approverTokenSuffix: extraApproverSuffix,
            scriptRefs: context.scriptRefs,
          },
        );
        const approveHash = yield* signAndSubmit(approveTx);
        yield* advanceBlock(context.emulator);
        expect(approveHash).toHaveLength(64);

        const requestUnit =
          context.protocol!.treasuryPolicyId +
          assetNameLabels.prefix222 +
          newAccountTokenSuffix;
        const requestUtxo = yield* Effect.promise(() =>
          lucid.utxoByUnit(requestUnit),
        );
        const requestDatum = (yield* parseSafeDatum(
          patchInlineDatum(requestUtxo).datum,
          TreasuryDatumSchema,
        )) as unknown as TreasuryDatum;
        expect("RecoveryRequest" in requestDatum).toBe(true);
        if ("RecoveryRequest" in requestDatum) {
          expect(requestDatum.RecoveryRequest.approvals.length).toBe(2);
        }
      }),
  );
});
