import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { setupAccount, setupBase } from "../helpers/setupTest.js";
import { updateAccountTestCase } from "./actions.js";
import { fromText } from "@lucid-evolution/lucid";

describe("Update Account Endpoint", () => {
  it.effect("should update an account successfully", () => Effect.gen(function* () {
      const base = yield* setupBase();
      const baseSetup = yield* setupAccount(base);
      const { emulator } = baseSetup.context;

      if (!baseSetup.accountUtxo || !baseSetup.userUtxo) throw new Error("Setup failure");
      
      const result = yield* updateAccountTestCase(
        baseSetup.context, 
        baseSetup.accountUtxo!, 
        baseSetup.userUtxo!,
        { email_hash: fromText("updated"), phone_hash: fromText("updated") } as any, 
        baseSetup.scripts
    );

    expect(result.txHash).toBeDefined();

      if (emulator && base.network === "Custom") {
          yield* Effect.sync(() => emulator.awaitBlock(1));
      }
  }));
});
