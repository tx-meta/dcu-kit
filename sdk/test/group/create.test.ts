import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { setupBase } from "../helpers/setupTest.js";
import { createGroupTestCase } from "./actions.js";

describe("Create Group Endpoint", () => {
  it.effect("should create a group successfully", () => Effect.gen(function* () {
      const { context, scripts } = yield* setupBase();

      const { txHash, groupDatum } = yield* createGroupTestCase(
          context,
          scripts
      );

      expect(txHash).toBeDefined();
      expect(txHash).toHaveLength(64);
      expect(groupDatum.is_active).toBe(true);
      expect(groupDatum.member_count).toBe(0n);
  }));
});
