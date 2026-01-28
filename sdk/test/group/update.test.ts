import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { setupBase } from "../helpers/setupTest.js";
import { createGroupTestCase, updateGroupTestCase } from "./actions.js";
import { fromText } from "@lucid-evolution/lucid";
import { findUtxoWithToken } from "../../src/core/utils.js";

describe("Update Group Endpoint", () => {
  it.effect("should update a group successfully", () => Effect.gen(function* () {
      const { context, scripts } = yield* setupBase();

      // 1. Create Group
      const { groupDatum } = yield* createGroupTestCase(context, scripts);
      
      // Await Block
      if (context.emulator) yield* Effect.promise(async () => await context.emulator!.awaitBlock(1));

      // 2. Find Group UTxO
      const groupPolicyId = scripts.group.mint.policyId!;
      const groupRefTokenName = fromText("GroupReference");
      
      const utxosAtAddress = yield* Effect.promise(() => 
          context.lucid.utxosAt(scripts.group.spend.address)
      );
      const groupUtxo = findUtxoWithToken(utxosAtAddress, groupPolicyId, groupRefTokenName);

      // 3. Update Datum
      const updatedDatum = { ...groupDatum, member_count: 1n };
      
      // 4. Get admin UTxO
      const walletUtxos = yield* Effect.promise(() => context.lucid.wallet().getUtxos());
      const adminUtxo = walletUtxos[0]; 

      if (!groupUtxo) return yield* Effect.fail(new Error("Group UTxO not found"));
      if (!adminUtxo) return yield* Effect.fail(new Error("Admin UTxO not found"));

      const { txHash } = yield* updateGroupTestCase(
          context,
          groupUtxo,
          updatedDatum,
          adminUtxo,
          scripts
      );

      expect(txHash).toBeDefined();
      expect(txHash).toHaveLength(64);
  }));
});
