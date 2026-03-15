import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { setupBase, setupGroup } from "./setup.js";
import {
  createGroupTestCase,
  deleteGroupTestCase,
  updateGroupTestCase,
} from "./actions.js";
import { fromText } from "@lucid-evolution/lucid";

describe("Group Endpoints", () => {
  // --- Create Group ---
  it.effect("should create a group successfully", () =>
    Effect.gen(function* () {
      const { context, scripts } = yield* setupBase();

      const { txHash, groupDatum } = yield* createGroupTestCase(
        context,
      );

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
      const { context, scripts, groupUtxo, adminUtxo, groupDatum } = yield* setupGroup(base);

      // Update Datum
      const updatedDatum = { ...groupDatum, member_count: 1n };

      const { txHash } = yield* updateGroupTestCase(
        context,
        {
            groupUtxo,
            updatedDatum,
            adminUtxo
        }
      );

      expect(txHash).toBeDefined();
      expect(txHash).toHaveLength(64);
    }),
  );

  // --- Delete Group ---
  it.effect("should delete (deactivate) a group successfully", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      const { context, scripts, groupUtxo, adminUtxo, groupDatum } = yield* setupGroup(base);

      const { txHash } = yield* deleteGroupTestCase(
        context,
        {
            groupUtxo,
            currentDatum: groupDatum,
            adminUtxo
        }
      );

      expect(txHash).toBeDefined();
      expect(txHash).toHaveLength(64);
    }),
  );
});
