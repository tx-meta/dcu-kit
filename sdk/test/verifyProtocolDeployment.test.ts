import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { setupBase } from "./setup.js";
import {
  verifyProtocolDeployment,
  VerifyProtocolDeploymentConfig,
} from "../src/admin/verifyProtocolDeployment.js";
import {
  DeployedScriptKey,
  ScriptRefOutRef,
} from "../src/admin/deployScripts.js";
import { ScriptRefs } from "../src/core/scripts.js";

const REF_KEYS: DeployedScriptKey[] = [
  "treasury",
  "group",
  "treasuryRounds",
  "treasuryLifecycle",
  "treasuryRecovery",
  "treasuryReserve",
];

// The emulator context deploys the six reference scripts and exposes the full
// UTxOs; the verifier takes plain out-refs (what a deployment manifest records).
const refsFromContext = (
  scriptRefs: ScriptRefs,
): Record<DeployedScriptKey, ScriptRefOutRef> => {
  const out = {} as Record<DeployedScriptKey, ScriptRefOutRef>;
  for (const key of REF_KEYS) {
    const utxo = scriptRefs[key];
    if (!utxo) throw new Error(`emulator context missing scriptRef ${key}`);
    out[key] = { txHash: utxo.txHash, outputIndex: utxo.outputIndex };
  }
  return out;
};

describe("verifyProtocolDeployment (emulator)", () => {
  it.effect("passes on the emulator context's own deployment", () =>
    Effect.gen(function* () {
      const { context } = yield* setupBase();
      const config: VerifyProtocolDeploymentConfig = {
        settingsPolicy: context.protocol!.settingsPolicy,
        refs: refsFromContext(context.scriptRefs!),
        expected: {
          settingsUnit: context.settingsUnit!,
          network: "Custom",
        },
      };

      const result = yield* verifyProtocolDeployment(context.lucid, config);

      expect(result.issues).toEqual([]);
      expect(result.ok).toBe(true);

      // All six reference scripts verified down to CBOR + ledger hash.
      for (const key of REF_KEYS) {
        const ref = result.refs[key];
        expect(ref.found).toBe(true);
        expect(ref.atDeployAddress).toBe(true);
        expect(ref.scriptMatches).toBe(true);
        expect(ref.hashMatches).toBe(true);
        expect(ref.onChainScriptHash).toBe(ref.expectedScriptHash);
      }

      // Settings NFT found at the always-fails address, datum consistent.
      expect(result.settings.found).toBe(true);
      expect(result.settings.consistent).toBe(true);
      expect(result.settingsAtDeployAddress).toBe(true);

      // All four treasury family stake credentials registered (read-only check).
      for (const family of [
        "rounds",
        "lifecycle",
        "recovery",
        "reserve",
      ] as const) {
        expect(result.stakeRegistrations[family].status).toBe("registered");
        expect(
          result.stakeRegistrations[family].rewardAddress.startsWith("stake"),
        ).toBe(true);
      }

      // Registry fingerprints agree with the bundled blueprint.
      expect(result.registry.fingerprintsMatch).toBe(true);
      expect(result.registry.mismatches).toEqual([]);
    }),
  );

  it.effect("reports a missing reference UTxO", () =>
    Effect.gen(function* () {
      const { context } = yield* setupBase();
      const refs = refsFromContext(context.scriptRefs!);
      refs.group = { txHash: "0".repeat(64), outputIndex: 0 };

      const result = yield* verifyProtocolDeployment(context.lucid, {
        settingsPolicy: context.protocol!.settingsPolicy,
        refs,
      });

      expect(result.ok).toBe(false);
      expect(result.refs.group.found).toBe(false);
      expect(result.issues.some((i) => i.includes("group"))).toBe(true);
      // The other five still verify.
      expect(result.refs.treasury.scriptMatches).toBe(true);
    }),
  );

  it.effect("reports a ref UTxO holding the wrong script", () =>
    Effect.gen(function* () {
      const { context } = yield* setupBase();
      const refs = refsFromContext(context.scriptRefs!);
      // Point the group slot at the treasury ref: exists, at the deploy
      // address, but carries the wrong validator.
      refs.group = refs.treasury;

      const result = yield* verifyProtocolDeployment(context.lucid, {
        settingsPolicy: context.protocol!.settingsPolicy,
        refs,
      });

      expect(result.ok).toBe(false);
      expect(result.refs.group.found).toBe(true);
      expect(result.refs.group.scriptMatches).toBe(false);
      expect(result.refs.group.hashMatches).toBe(false);
    }),
  );

  it.effect("reports manifest disagreement on settingsUnit and network", () =>
    Effect.gen(function* () {
      const { context } = yield* setupBase();

      const result = yield* verifyProtocolDeployment(context.lucid, {
        settingsPolicy: context.protocol!.settingsPolicy,
        refs: refsFromContext(context.scriptRefs!),
        expected: {
          settingsUnit: "deadbeef" + context.settingsUnit!.slice(8),
          network: "Preprod",
        },
      });

      expect(result.ok).toBe(false);
      expect(result.issues.some((i) => i.includes("settingsUnit"))).toBe(true);
      expect(result.issues.some((i) => i.includes("network"))).toBe(true);
    }),
  );

  it.effect("fails against a settings policy that was never deployed", () =>
    Effect.gen(function* () {
      const { context } = yield* setupBase();

      const result = yield* verifyProtocolDeployment(context.lucid, {
        settingsPolicy: "ab".repeat(28),
        refs: refsFromContext(context.scriptRefs!),
      });

      expect(result.ok).toBe(false);
      // No settings NFT under that policy...
      expect(result.settings.found).toBe(false);
      // ...and the deployed scripts don't match the re-derived validators
      // (treasury/group/stakes are parameterized by the settings policy).
      expect(result.refs.treasury.scriptMatches).toBe(false);
      // The account-independent registry check still passes.
      expect(result.registry.fingerprintsMatch).toBe(true);
    }),
  );
});
