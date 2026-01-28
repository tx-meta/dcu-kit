import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { setupBase } from "../helpers/setupTest.js";
import { createGroupTestCase, deleteGroupTestCase } from "./actions.js";
import { fromText } from "@lucid-evolution/lucid";
import { findUtxoWithToken } from "../../src/core/utils.js";

describe("Delete Group Endpoint", () => {
  it.effect("should delete (deactivate) a group successfully", () => Effect.gen(function* () {
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

      const walletUtxos = yield* Effect.promise(() => context.lucid.wallet().getUtxos());
      const adminUtxo = walletUtxos[0]; 

      if (!groupUtxo) return yield* Effect.fail(new Error("Group UTxO not found"));
      if (!adminUtxo) return yield* Effect.fail(new Error("Admin UTxO not found"));

      const { txHash } = yield* deleteGroupTestCase(
          context,
          groupUtxo,
          groupDatum, // Pass current datum state
          adminUtxo,
          scripts
      );

      expect(txHash).toBeDefined();
      expect(txHash).toHaveLength(64);
  }));
});
