import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { UTxO } from "@lucid-evolution/lucid";
import { setupBase, setupGroup } from "./setup.js";
import {
  createGroupTestCase,
  deleteGroupTestCase,
  updateGroupTestCase,
} from "./actions.js";
import { unsignedUpdateGroupTxProgram } from "../src/endpoints/updateGroup.js";
import { unsignedDeleteGroupTxProgram } from "../src/endpoints/deleteGroup.js";
import { selectWalletFromSeed, getWalletAddress } from "../src/core/utils/index.js";
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
      console.log("[test] setupBase done");
      const { context, groupUtxo, adminUtxo, groupDatum } = yield* setupGroup(base);
      console.log("[test] setupGroup done, groupUtxo:", groupUtxo.txHash);

      const updatedDatum = { ...groupDatum, penalty_fee: groupDatum.penalty_fee + 1_000_000n };

      console.log("[test] calling updateGroupTestCase...");
      const { txHash } = yield* updateGroupTestCase(context, {
        groupUtxo,
        updatedDatum,
        adminUtxo,
      });
      console.log("[test] updateGroupTestCase done, txHash:", txHash);

      expect(txHash).toBeDefined();
      expect(txHash).toHaveLength(64);
    }),
  );

  // --- Delete Group ---
  it.effect("should delete (deactivate) a group successfully", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      const { context, groupUtxo, adminUtxo, groupDatum } = yield* setupGroup(base);

      const { txHash } = yield* deleteGroupTestCase(context, {
        groupUtxo,
        currentDatum: groupDatum,
        adminUtxo,
      });

      expect(txHash).toBeDefined();
      expect(txHash).toHaveLength(64);
    }),
  );

  // --- Negative: update group when UTxO carries no group policy asset ---
  it.effect("should fail updating a group when the UTxO has no group policy asset", () =>
    Effect.gen(function* () {
      const { context } = yield* setupBase();
      const { lucid, users } = context;

      selectWalletFromSeed(lucid, users.admin.seedPhrase);
      const walletAddress = yield* getWalletAddress(lucid);

      const fakeUtxo: UTxO = {
        txHash: "0".repeat(64),
        outputIndex: 0,
        address: walletAddress,
        assets: { lovelace: 2_000_000n },
        datum: null,
        datumHash: null,
        scriptRef: null,
      };

      const err = yield* Effect.flip(
        unsignedUpdateGroupTxProgram(lucid, {
          groupUtxo: fakeUtxo,
          updatedDatum: createDefaultGroupDatum(),
          adminUtxo: fakeUtxo,
        })
      );

      expect(err._tag).toBe("UtxoNotFoundError");
    }),
  );

  // --- Negative: delete group when UTxO carries no group policy asset ---
  it.effect("should fail deleting a group when the UTxO has no group policy asset", () =>
    Effect.gen(function* () {
      const { context } = yield* setupBase();
      const { lucid, users } = context;

      selectWalletFromSeed(lucid, users.admin.seedPhrase);
      const walletAddress = yield* getWalletAddress(lucid);

      const fakeUtxo: UTxO = {
        txHash: "0".repeat(64),
        outputIndex: 0,
        address: walletAddress,
        assets: { lovelace: 2_000_000n },
        datum: null,
        datumHash: null,
        scriptRef: null,
      };

      const err = yield* Effect.flip(
        unsignedDeleteGroupTxProgram(lucid, {
          groupUtxo: fakeUtxo,
          currentDatum: createDefaultGroupDatum(),
          adminUtxo: fakeUtxo,
        })
      );

      expect(err._tag).toBe("UtxoNotFoundError");
    }),
  );
});
