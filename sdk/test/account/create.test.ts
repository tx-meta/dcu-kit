import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { setupBase } from "../helpers/setupTest.js";
import { createAccountTestCase } from "./actions.js";

describe("Create Account Endpoint", () => {
  
  it.effect("should create an account successfully", () => Effect.gen(function* () {
      const baseSetup = yield* setupBase();
      const result = yield* createAccountTestCase(baseSetup.context, baseSetup.scripts);

    expect(result.txHash).toBeDefined();
    expect(result.txHash).toHaveLength(64);
  }));
});
