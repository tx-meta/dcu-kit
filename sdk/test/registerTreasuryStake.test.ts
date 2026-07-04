import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { setupBase } from "./setup.js";
import { selectWalletFromSeed } from "../src/core/utils/index.js";
import { registerTreasuryStake } from "../src/admin/registerTreasuryStake.js";

// The fresh-registration path runs in every emulator context: deployEmulatorSettings
// registers the treasury stake credential through this same helper (and dies if the
// registration is not fresh). This file covers the other half — the duplicate
// registration that a re-run of deploy-scripts performs on an already-registered
// deployment, which the ledger rejects and the helper must absorb.
describe("registerTreasuryStake (emulator)", () => {
  it.effect("treats a duplicate registration as already registered", () =>
    Effect.gen(function* () {
      const { context } = yield* setupBase();
      selectWalletFromSeed(context.lucid, context.users.admin.seedPhrase);

      const result = yield* registerTreasuryStake(
        context.protocol!,
        context.lucid,
      );

      // All four treasury family stake credentials were registered by the
      // emulator context setup, so re-running absorbs every duplicate.
      expect(result.alreadyRegistered).toBe(true);
      expect(result.registrations).toHaveLength(4);
      for (const reg of result.registrations) {
        expect(reg.alreadyRegistered).toBe(true);
        expect(reg.txHash).toBeNull();
        expect(reg.rewardAddress.startsWith("stake")).toBe(true);
      }
    }),
  );
});
