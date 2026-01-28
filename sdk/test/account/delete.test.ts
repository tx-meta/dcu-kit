import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { setupAccount, setupBase } from "../helpers/setupTest.js";
import { deleteAccountTestCase } from "./actions.js";

describe("Delete Account Endpoint", () => {
  it.effect("should delete an account successfully", () => Effect.gen(function* () {
      const base = yield* setupBase();
      const baseSetup = yield* setupAccount(base); // Renamed and kept as object
      const { context, accountUtxo, userUtxo } = baseSetup; // Destructure from baseSetup
      const { emulator } = context;

      if (!accountUtxo || !userUtxo) throw new Error("Setup failure");

      const result = yield* deleteAccountTestCase(
        baseSetup.context,
        baseSetup.accountUtxo!,
        baseSetup.userUtxo!,
        baseSetup.scripts
    );

    expect(result.txHash).toBeDefined();

      if (emulator && base.network === "Custom") {
          yield* Effect.sync(() => emulator.awaitBlock(1));
      }
  }));
});
