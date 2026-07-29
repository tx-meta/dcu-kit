import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { setupBase, setupGroup } from "./setup.js";
import { createAccountTestCase, joinGroupTestCase } from "./actions.js";
import { unsignedUpdatePayoutCredentialTxProgram } from "../src/endpoints/updatePayoutCredential.js";
import { unsignedContributeTxProgram } from "../src/endpoints/contribute.js";
import {
  assetNameLabels,
  getScriptAddress,
  parseSafeDatum,
  patchInlineDatum,
  resolveTreasuryUtxoForGroup,
  resolveUtxoByUnit,
  selectWalletFromSeed,
  signAndSubmit,
  treasuryGroupRefName,
} from "../src/core/utils/index.js";
import { TreasuryDatum, TreasuryDatumSchema } from "../src/core/types.js";
import { accountPolicyId } from "../src/core/validators/constants.js";
import { extractTokenSuffix } from "./utils.js";
import { advanceBlock, awaitWalletUtxo } from "./effects.js";

/**
 * One account joined to two groups. The treasury membership token name is the
 * member's account (222) token name, which the validator requires
 * (dcu/treasury_validation `member_has_user_token`), so both joins mint the SAME
 * unit and the unit alone stops identifying a UTxO. Every write path that resolved
 * the treasury by unit broke here, and the two scanning paths silently picked
 * whichever group came first.
 */
const setupTwoGroupMember = Effect.gen(function* () {
  const base = yield* setupBase();
  const { context } = base;
  const { lucid, users, protocol } = context;
  const groupPolicyId = protocol!.groupPolicyId;

  // Two independent groups, same admin.
  const { groupUtxo: groupA } = yield* setupGroup(base);
  const { groupUtxo: groupB } = yield* setupGroup(base);
  const groupASuffix = extractTokenSuffix(
    groupA,
    groupPolicyId,
    assetNameLabels.prefix100,
  );
  const groupBSuffix = extractTokenSuffix(
    groupB,
    groupPolicyId,
    assetNameLabels.prefix100,
  );

  // One account, joined to BOTH groups.
  const {
    outputs: { userUtxo: acct0 },
  } = yield* createAccountTestCase(context, {
    userSeed: users.user1.seedPhrase,
  });
  const accountTokenSuffix = extractTokenSuffix(
    acct0,
    accountPolicyId,
    assetNameLabels.prefix222,
  );

  yield* joinGroupTestCase(context, {
    groupUtxo: groupA,
    accountUtxo: acct0,
    userSeed: users.user1.seedPhrase,
  });

  // Re-fetch the account (222) token — join A moved it — before joining B.
  selectWalletFromSeed(lucid, users.user1.seedPhrase);
  const acct1 = yield* awaitWalletUtxo(
    lucid,
    (u) =>
      Object.keys(u.assets).some(
        (k) =>
          k.startsWith(accountPolicyId) &&
          k.slice(accountPolicyId.length).startsWith(assetNameLabels.prefix222),
      ),
    "Account (222) token not found in user1 wallet after joining group A",
  );
  yield* joinGroupTestCase(context, {
    groupUtxo: groupB,
    accountUtxo: acct1,
    userSeed: users.user1.seedPhrase,
  });
  yield* advanceBlock(context.emulator);

  const treasuryUnit =
    protocol!.treasuryPolicyId + assetNameLabels.prefix222 + accountTokenSuffix;
  const treasuryAddress = yield* getScriptAddress(
    lucid,
    protocol!.treasuryValidator.spendTreasury,
  );

  return {
    context,
    accountTokenSuffix,
    groupASuffix,
    groupBSuffix,
    groupARefName: assetNameLabels.prefix100 + groupASuffix,
    groupBRefName: assetNameLabels.prefix100 + groupBSuffix,
    treasuryUnit,
    treasuryAddress,
  };
});

const decodeTreasury = (utxo: {
  datum?: string | null;
}): Effect.Effect<TreasuryDatum, never, never> =>
  parseSafeDatum(patchInlineDatum(utxo as never).datum, TreasuryDatumSchema)
    .pipe(Effect.map((d) => d as unknown as TreasuryDatum))
    .pipe(Effect.orDie);

describe("multi-group membership", () => {
  it.effect("two joins mint one live treasury UTxO per group, same unit", () =>
    Effect.gen(function* () {
      const {
        context,
        treasuryUnit,
        treasuryAddress,
        groupARefName,
        groupBRefName,
      } = yield* setupTwoGroupMember;

      const candidates = yield* Effect.promise(() =>
        context.lucid.utxosAtWithUnit(treasuryAddress, treasuryUnit),
      );
      expect(candidates).toHaveLength(2);

      const groups = new Set<string>();
      for (const raw of candidates) {
        const datum = yield* decodeTreasury(raw);
        groups.add(treasuryGroupRefName(datum)!);
      }
      expect(groups).toEqual(new Set([groupARefName, groupBRefName]));
    }),
  );

  it.effect("resolveUtxoByUnit reports ambiguity, not absence", () =>
    Effect.gen(function* () {
      const { context, treasuryUnit } = yield* setupTwoGroupMember;

      const err = yield* Effect.flip(
        resolveUtxoByUnit(context.lucid, treasuryUnit),
      );
      expect(err._tag).toBe("AmbiguousUtxoError");
    }),
  );

  it.effect("resolveTreasuryUtxoForGroup selects the named group", () =>
    Effect.gen(function* () {
      const {
        context,
        treasuryUnit,
        treasuryAddress,
        groupARefName,
        groupBRefName,
      } = yield* setupTwoGroupMember;

      for (const groupRefName of [groupARefName, groupBRefName]) {
        const utxo = yield* resolveTreasuryUtxoForGroup(
          context.lucid,
          treasuryAddress,
          treasuryUnit,
          groupRefName,
        );
        const datum = yield* decodeTreasury(utxo);
        expect(treasuryGroupRefName(datum)).toBe(groupRefName);
      }

      const err = yield* Effect.flip(
        resolveTreasuryUtxoForGroup(
          context.lucid,
          treasuryAddress,
          treasuryUnit,
        ),
      );
      expect(err._tag).toBe("AmbiguousUtxoError");
      if (err._tag === "AmbiguousUtxoError") {
        expect(err.candidates).toBe(2);
        expect(new Set(err.groups)).toEqual(
          new Set([groupARefName, groupBRefName]),
        );
      }
    }),
  );

  it.effect(
    "updatePayoutCredential needs the group, then writes only that group",
    () =>
      Effect.gen(function* () {
        const {
          context,
          accountTokenSuffix,
          groupASuffix,
          groupBSuffix,
          groupARefName,
          groupBRefName,
          treasuryUnit,
          treasuryAddress,
        } = yield* setupTwoGroupMember;
        const { lucid, users } = context;

        selectWalletFromSeed(lucid, users.user1.seedPhrase);

        // Without the group the treasury unit is ambiguous and no transaction can
        // be built. This is the failure every multi-group member used to hit.
        const err = yield* Effect.flip(
          unsignedUpdatePayoutCredentialTxProgram(context.protocol!, lucid, {
            accountTokenSuffix,
            scriptRefs: context.scriptRefs,
          }),
        );
        expect(err._tag).toBe("AmbiguousUtxoError");

        const beforeA = yield* decodeTreasury(
          yield* resolveTreasuryUtxoForGroup(
            lucid,
            treasuryAddress,
            treasuryUnit,
            groupARefName,
          ),
        );

        const tx = yield* unsignedUpdatePayoutCredentialTxProgram(
          context.protocol!,
          lucid,
          {
            accountTokenSuffix,
            groupTokenSuffix: groupBSuffix,
            scriptRefs: context.scriptRefs,
          },
        );
        yield* signAndSubmit(tx);
        yield* advanceBlock(context.emulator);

        // Group B's treasury is the one that moved; group A's is byte-identical.
        const afterB = yield* decodeTreasury(
          yield* resolveTreasuryUtxoForGroup(
            lucid,
            treasuryAddress,
            treasuryUnit,
            groupBRefName,
          ),
        );
        const afterA = yield* decodeTreasury(
          yield* resolveTreasuryUtxoForGroup(
            lucid,
            treasuryAddress,
            treasuryUnit,
            groupARefName,
          ),
        );
        expect("TreasuryState" in afterB).toBe(true);
        expect(afterA).toEqual(beforeA);
        expect(groupASuffix).not.toBe(groupBSuffix);
      }),
  );

  it.effect("contribute tops up only the group named in its config", () =>
    Effect.gen(function* () {
      const {
        context,
        accountTokenSuffix,
        groupBSuffix,
        groupARefName,
        groupBRefName,
        treasuryUnit,
        treasuryAddress,
      } = yield* setupTwoGroupMember;
      const { lucid, users } = context;

      const lovelaceIn = (groupRefName: string) =>
        resolveTreasuryUtxoForGroup(
          lucid,
          treasuryAddress,
          treasuryUnit,
          groupRefName,
        ).pipe(Effect.map((u) => u.assets.lovelace));

      const beforeA = yield* lovelaceIn(groupARefName);
      const beforeB = yield* lovelaceIn(groupBRefName);

      selectWalletFromSeed(lucid, users.user1.seedPhrase);
      const tx = yield* unsignedContributeTxProgram(context.protocol!, lucid, {
        groupTokenSuffix: groupBSuffix,
        accountTokenSuffix,
        topUpAmount: 3_000_000n,
        scriptRefs: context.scriptRefs,
      });
      yield* signAndSubmit(tx);
      yield* advanceBlock(context.emulator);

      expect(yield* lovelaceIn(groupBRefName)).toBe(beforeB + 3_000_000n);
      expect(yield* lovelaceIn(groupARefName)).toBe(beforeA);
    }),
  );
});
