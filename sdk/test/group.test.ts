import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { setupBase, setupGroup } from "./setup.js";
import {
  createGroupTestCase,
  deleteGroupTestCase,
  updateGroupTestCase,
} from "./actions.js";
import { unsignedUpdateGroupTxProgram } from "../src/endpoints/updateGroup.js";
import { unsignedDeleteGroupTxProgram } from "../src/endpoints/deleteGroup.js";
import { selectWalletFromSeed } from "../src/core/utils/index.js";
import { createDefaultGroupDatum } from "./utils.js";

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

  // --- Update Group ---
  it.effect("should update a group successfully", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      const { context, groupUtxo, groupDatum } = yield* setupGroup(base);

      const updatedDatum = { ...groupDatum, penalty_fee: groupDatum.penalty_fee + 1_000_000n };

      const { txHash } = yield* updateGroupTestCase(context, {
        groupUtxo,
        updatedDatum,
      });

      expect(txHash).toBeDefined();
      expect(txHash).toHaveLength(64);
    }),
  );

  // --- Delete Group ---
  it.effect("should delete (deactivate) a group successfully", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      const { context, groupUtxo } = yield* setupGroup(base);

      const { txHash } = yield* deleteGroupTestCase(context, { groupUtxo });

      expect(txHash).toBeDefined();
      expect(txHash).toHaveLength(64);
    }),
  );

  // --- Negative: update group with a non-existent token suffix ---
  it.effect("should fail updating a group when the token suffix does not exist on-chain", () =>
    Effect.gen(function* () {
      const { context } = yield* setupBase();
      const { lucid, users } = context;

      selectWalletFromSeed(lucid, users.admin.seedPhrase);

      // Fake suffix → resolveUtxoByUnit will fail with UtxoNotFoundError
      const fakeSuffix = "00".repeat(28);

      const err = yield* Effect.flip(
        unsignedUpdateGroupTxProgram(lucid, {
          groupTokenSuffix: fakeSuffix,
          updatedDatum: createDefaultGroupDatum(),
        })
      );

      expect(err._tag).toBe("UtxoNotFoundError");
    }),
  );

  // --- Negative: delete group with a non-existent token suffix ---
  it.effect("should fail deleting a group when the token suffix does not exist on-chain", () =>
    Effect.gen(function* () {
      const { context } = yield* setupBase();
      const { lucid, users } = context;

      selectWalletFromSeed(lucid, users.admin.seedPhrase);

      const fakeSuffix = "00".repeat(28);

      const err = yield* Effect.flip(
        unsignedDeleteGroupTxProgram(lucid, { groupTokenSuffix: fakeSuffix })
      );

      expect(err._tag).toBe("UtxoNotFoundError");
    }),
  );
});
