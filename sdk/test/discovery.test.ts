import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { setupBase, setupGroup } from "./setup.js";
import { createAccountTestCase, joinGroupTestCase } from "./actions.js";
import { extractTokenSuffix } from "./utils.js";
import {
  assetNameLabels,
  selectWalletFromSeed,
} from "../src/core/utils/index.js";
import {
  getGroupProgram,
  listGroupsProgram,
  listMyMembershipsProgram,
  listMembersProgram,
  summarizeMemberDatum,
} from "../src/queries/discovery.js";

describe("ROSCA discovery (emulator)", () => {
  it.effect("lists and decodes groups and their members", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      const { context, groupUtxo } = yield* setupGroup(base);
      const suffix = extractTokenSuffix(
        groupUtxo,
        context.protocol!.groupPolicyId,
        assetNameLabels.prefix100,
      );

      const {
        outputs: { userUtxo: account1 },
      } = yield* createAccountTestCase(context, {
        userSeed: context.users.user1.seedPhrase,
      });
      const {
        outputs: { userUtxo: account2 },
      } = yield* createAccountTestCase(context, {
        userSeed: context.users.user2.seedPhrase,
      });
      yield* joinGroupTestCase(context, {
        groupUtxo,
        accountUtxo: account1,
        userSeed: context.users.user1.seedPhrase,
      });
      yield* joinGroupTestCase(context, {
        groupUtxo,
        accountUtxo: account2,
        userSeed: context.users.user2.seedPhrase,
      });

      const group = yield* getGroupProgram(
        context.protocol!,
        context.lucid,
        suffix,
      );
      expect(group.tokenSuffix).toBe(suffix);
      expect(group.datum.member_count).toBe(2n);

      const groups = yield* listGroupsProgram(
        context.protocol!,
        context.lucid,
        { limit: 1 },
      );
      expect(groups.items).toHaveLength(1);
      expect(groups.items[0]?.tokenSuffix).toBe(suffix);
      expect(groups.diagnostics).toEqual([]);
      expect(groups.observedSlot).toBeNull();
      expect(groups.queryStrategy).toBe("full-address-scan");

      const members = yield* listMembersProgram(
        context.protocol!,
        context.lucid,
        suffix,
        { limit: 100 },
      );
      expect(members.items).toHaveLength(2);
      expect(
        members.items.every((member) => member.status === "TreasuryState"),
      ).toBe(true);
      expect(
        new Set(members.items.map((member) => member.tokenName)).size,
      ).toBe(2);

      selectWalletFromSeed(context.lucid, context.users.user1.seedPhrase);
      const memberships = yield* listMyMembershipsProgram(
        context.protocol!,
        context.lucid,
      );
      expect(memberships.items).toHaveLength(1);
      expect(memberships.items[0]?.groupTokenSuffix).toBe(suffix);
      expect(memberships.queryStrategy).toBe("asset-indexed");
    }),
  );

  it.effect("rejects malformed pagination rather than guessing", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      const result = yield* Effect.either(
        listGroupsProgram(base.context.protocol!, base.context.lucid, {
          cursor: "not-an-out-ref",
        }),
      );
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left._tag).toBe("ConfigurationError");
      }
    }),
  );

  it("retains PenaltyState members instead of silently dropping them", () => {
    const summary = summarizeMemberDatum(
      {
        PenaltyState: {
          group_reference_tokenname: "000643b0" + "11".repeat(28),
          member_reference_tokenname: "000643b0" + "22".repeat(28),
        },
      },
      {
        txHash: "aa".repeat(32),
        outputIndex: 1,
        address: "addr_test1penalty",
      } as never,
    );
    expect(summary).toMatchObject({
      status: "PenaltyState",
      paymentCredential: null,
      roundsPaid: null,
      claimableBalance: null,
    });
  });
});
