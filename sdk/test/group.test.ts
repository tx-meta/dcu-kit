import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { setupBase, setupGroup, setupMembership } from "./setup.js";
import {
  createGroupTestCase,
  deleteGroupTestCase,
  updateGroupTestCase,
} from "./actions.js";
import { unsignedUpdateGroupTxProgram } from "../src/endpoints/updateGroup.js";
import { unsignedDeleteGroupTxProgram } from "../src/endpoints/deleteGroup.js";
import {
  selectWalletFromSeed,
  assetNameLabels,
  parseGroupCip68Datum,
  decodeGroupMetadata,
  getScriptAddress,
  patchInlineDatum,
} from "../src/core/utils/index.js";
import { createDefaultGroupDatum, extractTokenSuffix } from "./utils.js";
import { toText } from "@lucid-evolution/lucid";

describe("Group Endpoints", () => {
  // --- Create Group ---
  it.effect("should create a group successfully", () =>
    Effect.gen(function* () {
      const { context } = yield* setupBase();

      const { txHash, groupDatum } = yield* createGroupTestCase(context);

      expect(txHash).toBeDefined();
      expect(txHash).toHaveLength(64);
      expect(groupDatum.is_active).toBe(true);
      expect(groupDatum.member_count).toBe(0n);
    }),
  );

  // --- Group name readable from on-chain datum ---
  // Verifies the CIP-68 wrapper is written correctly and the metadata["name"] key
  // resolves to the groupName string passed to CreateGroupConfig.
  it.effect(
    "should store the group name and description in CIP-68 metadata on-chain",
    () =>
      Effect.gen(function* () {
        const { context } = yield* setupBase();

        const { txHash } = yield* createGroupTestCase(context, {
          datumOverride: {},
          groupDescription: "Kiambu land-buying chama",
        });

        const groupAddress = yield* getScriptAddress(
          context.lucid,
          context.protocol!.groupValidator.spendGroup,
        );
        const utxos = yield* Effect.tryPromise(() =>
          context.lucid.utxosAt(groupAddress),
        );
        const groupUtxo = utxos.find((u) => u.txHash === txHash);
        expect(groupUtxo).toBeDefined();

        const cip68 = yield* parseGroupCip68Datum(
          patchInlineDatum(groupUtxo!).datum,
        );

        // Raw map check: name + description are stored on-chain under their UTF-8 keys.
        const metadataMap = cip68.metadata as unknown as Map<string, string>;
        expect(toText(metadataMap.get("6e616d65")!)).toBe("Test Group");
        // fromText("description") = "6465736372697074696f6e"
        expect(toText(metadataMap.get("6465736372697074696f6e")!)).toBe(
          "Kiambu land-buying chama",
        );

        // The decodeGroupMetadata helper surfaces both as plain text.
        const decoded = decodeGroupMetadata(cip68.metadata);
        expect(decoded.name).toBe("Test Group");
        expect(decoded.description).toBe("Kiambu land-buying chama");
      }),
  );

  // --- Create Group with creator_bond ---
  it.effect("should create a group with creator_bond > 0", () =>
    Effect.gen(function* () {
      const { context } = yield* setupBase();

      const { txHash, groupDatum } = yield* createGroupTestCase(context, {
        datumOverride: { creator_bond: 2_000_000n },
      });

      expect(txHash).toBeDefined();
      expect(txHash).toHaveLength(64);
      expect(groupDatum.creator_bond).toBe(2_000_000n);
    }),
  );

  // --- Update Group ---
  it.effect("should update a group successfully", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      const { context, groupUtxo, groupDatum } = yield* setupGroup(base);

      const updatedDatum = {
        ...groupDatum,
        penalty_fee: groupDatum.penalty_fee + 1_000_000n,
      };

      const { txHash } = yield* updateGroupTestCase(context, {
        groupUtxo,
        updatedDatum,
      });

      expect(txHash).toBeDefined();
      expect(txHash).toHaveLength(64);
    }),
  );

  // --- Deactivate Group ---
  it.effect("should deactivate a group by setting is_active to false", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      const { context, groupUtxo, groupDatum } = yield* setupGroup(base);

      const deactivatedDatum = { ...groupDatum, is_active: false };

      const { txHash } = yield* updateGroupTestCase(context, {
        groupUtxo,
        updatedDatum: deactivatedDatum,
      });

      expect(txHash).toBeDefined();
      expect(txHash).toHaveLength(64);
    }),
  );

  // --- Delete Group (burn, after deactivation) ---
  it.effect(
    "should delete a group after deactivation, burning tokens and returning ADA",
    () =>
      Effect.gen(function* () {
        const base = yield* setupBase();
        const { context, groupUtxo, groupDatum } = yield* setupGroup(base);

        // Step 1: deactivate
        const deactivatedDatum = { ...groupDatum, is_active: false };
        yield* updateGroupTestCase(context, {
          groupUtxo,
          updatedDatum: deactivatedDatum,
        });

        // Step 2: delete (burn)
        const { txHash } = yield* deleteGroupTestCase(context, { groupUtxo });

        expect(txHash).toBeDefined();
        expect(txHash).toHaveLength(64);
      }),
  );

  // --- Negative: update group with a non-existent token suffix ---
  it.effect(
    "should fail updating a group when the token suffix does not exist on-chain",
    () =>
      Effect.gen(function* () {
        const { context } = yield* setupBase();
        const { lucid, users } = context;

        selectWalletFromSeed(lucid, users.admin.seedPhrase);

        const fakeSuffix = "00".repeat(28);

        const err = yield* Effect.flip(
          unsignedUpdateGroupTxProgram(context.protocol!,lucid, {
            groupTokenSuffix: fakeSuffix,
            updatedDatum: createDefaultGroupDatum(),
          }),
        );

        expect(err._tag).toBe("UtxoNotFoundError");
      }),
  );

  // --- Negative: delete group with a non-existent token suffix ---
  it.effect(
    "should fail deleting a group when the token suffix does not exist on-chain",
    () =>
      Effect.gen(function* () {
        const { context } = yield* setupBase();
        const { lucid, users } = context;

        selectWalletFromSeed(lucid, users.admin.seedPhrase);

        const fakeSuffix = "00".repeat(28);

        const err = yield* Effect.flip(
          unsignedDeleteGroupTxProgram(context.protocol!,lucid, { groupTokenSuffix: fakeSuffix }),
        );

        expect(err._tag).toBe("UtxoNotFoundError");
      }),
  );

  // --- Negative: update critical field while members are active ---
  // The is_critical_update guard freezes contribution_fee (and other economic fields)
  // when member_count > 0. Attempting an update after a member has joined must fail.
  it.effect(
    "should reject updating contribution_fee while members are active",
    () =>
      Effect.gen(function* () {
        const base = yield* setupBase();

        // After joinGroup, member_count == 1 in the on-chain group UTxO.
        const { context, groupUtxo, groupDatum } = yield* setupMembership(base);
        const { lucid, users } = context;

        selectWalletFromSeed(lucid, users.admin.seedPhrase);

        const groupTokenSuffix = extractTokenSuffix(
          groupUtxo,
          context.protocol!.groupPolicyId,
          assetNameLabels.prefix100,
        );
        const badDatum = {
          ...groupDatum,
          contribution_fee: groupDatum.contribution_fee + 1_000_000n,
        };

        const err = yield* Effect.flip(
          unsignedUpdateGroupTxProgram(context.protocol!,lucid, {
            groupTokenSuffix,
            updatedDatum: badDatum,
          }),
        );

        expect(err._tag).toBe("TransactionBuildError");
      }),
  );

  // --- Negative: delete a group that has not been deactivated ---
  // RemoveGroup requires is_active == false. Skipping the deactivation step (UpdateGroup
  // with is_active: false) and calling deleteGroup directly must be rejected by the validator.
  it.effect("should reject deleting a group that is still active", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      // Group freshly created — is_active == true, no deactivation performed.
      const { context, groupUtxo } = yield* setupGroup(base);
      const { lucid, users } = context;

      selectWalletFromSeed(lucid, users.admin.seedPhrase);

      const groupTokenSuffix = extractTokenSuffix(
        groupUtxo,
        context.protocol!.groupPolicyId,
        assetNameLabels.prefix100,
      );

      const err = yield* Effect.flip(
        unsignedDeleteGroupTxProgram(context.protocol!,lucid, { groupTokenSuffix }),
      );

      expect(err._tag).toBe("TransactionBuildError");
    }),
  );
});
