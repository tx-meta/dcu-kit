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
import { LucidContext } from "./context.js";
import { deployModuleScripts } from "../src/admin/deployModuleScripts.js";
import { selectWalletFromSeed } from "../src/core/utils/index.js";
import { registerSavingsStake } from "../src/savings/registerSavingsStake.js";
import {
  savingsDirectValidator,
  savingsGovernedValidator,
  savingsVaultValidator,
} from "../src/savings/validators.js";
import { advanceBlock } from "./effects.js";

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

  it.effect("reports a missing module ref as an issue, not silence", () =>
    Effect.gen(function* () {
      const { context } = yield* setupBase();

      const result = yield* verifyProtocolDeployment(context.lucid, {
        settingsPolicy: context.protocol!.settingsPolicy,
        refs: {
          ...refsFromContext(context.scriptRefs!),
          // Present in the config (so it's in scope) but no value recorded —
          // this must not pass silently as `ok`.
          savings: undefined,
        },
        expected: {
          settingsUnit: context.settingsUnit!,
          network: "Custom",
        },
      });

      expect(result.ok).toBe(false);
      expect(result.issues.some((i) => i.includes("savings"))).toBe(true);
      expect(result.refs.savings.found).toBe(false);
      // The six ROSCA refs are unaffected by the unrelated missing module ref.
      expect(result.refs.treasury.scriptMatches).toBe(true);
    }),
  );

  it.effect(
    "reports the governance refs as unverifiable when no governanceSeed is given",
    () =>
      Effect.gen(function* () {
        const { context } = yield* setupBase();

        const result = yield* verifyProtocolDeployment(context.lucid, {
          settingsPolicy: context.protocol!.settingsPolicy,
          refs: {
            ...refsFromContext(context.scriptRefs!),
            // A ref is recorded, but governanceDispatcher/Voting are
            // seed-parameterised — with no governanceSeed given, the
            // expected script can never be derived to hash-check against.
            governanceDispatcher: { txHash: "0".repeat(64), outputIndex: 0 },
          },
          // no governanceSeed
        });

        expect(result.ok).toBe(false);
        expect(
          result.issues.some(
            (i) =>
              i.includes("governanceDispatcher") &&
              i.includes("governanceSeed"),
          ),
        ).toBe(true);
        expect(result.refs.governanceDispatcher.expectedScriptHash).toBeNull();
        // Nothing to derive a voting stake credential from without a seed.
        expect(result.governanceVotingStake).toBeNull();
        // Never crashes, and the six ROSCA refs are unaffected.
        expect(result.refs.treasury.scriptMatches).toBe(true);
      }),
  );

  it.effect("reports an unregistered governance voting stake credential", () =>
    Effect.gen(function* () {
      const { context } = yield* setupBase();

      // A governance instance that was never bootstrapped. Its voting stake
      // credential is unregistered, so every propose/vote/finalize/execute
      // call would be rejected at submit with
      // ConwayWithdrawalsMissingAccounts — a failure that otherwise only
      // surfaces on a live network, after the refs are already paid for.
      const result = yield* verifyProtocolDeployment(context.lucid, {
        settingsPolicy: context.protocol!.settingsPolicy,
        refs: {
          ...refsFromContext(context.scriptRefs!),
          governanceDispatcher: { txHash: "0".repeat(64), outputIndex: 0 },
        },
        governanceSeed: { txHash: "1".repeat(64), outputIndex: 0 },
      });

      expect(result.ok).toBe(false);
      expect(result.governanceVotingStake?.status).toBe("not-registered");
      expect(
        result.governanceVotingStake?.rewardAddress.startsWith("stake"),
      ).toBe(true);
      expect(
        result.issues.some(
          (i) =>
            i.includes("governance voting stake") &&
            i.includes("registerVotingStake"),
        ),
      ).toBe(true);
      // The treasury families are registered by setup and stay unaffected.
      expect(result.refs.treasury.scriptMatches).toBe(true);
    }),
  );
});

// ─── ADR-0003: the savings module verifies as a unit ────────────────────────
// Savings needs three reference scripts AND two registered stake credentials.
// A verifier that checked only the dispatcher could report `ok: true` on a
// deployment where every savings transaction fails at submit time, which is
// worse than not checking savings at all.
describe("verifyProtocolDeployment — savings module (emulator)", () => {
  const deploySavingsTrio = (context: LucidContext) =>
    Effect.gen(function* () {
      selectWalletFromSeed(context.lucid, context.users.admin.seedPhrase);
      const deployed = yield* deployModuleScripts(
        {
          savings: savingsVaultValidator.spendVault,
          savingsGoverned: savingsGovernedValidator,
          savingsDirect: savingsDirectValidator,
        },
        context.lucid,
        {
          awaitSettled: () =>
            Effect.sync(() => context.emulator?.awaitBlock(1)),
        },
      );
      yield* advanceBlock(context.emulator, 1);
      return deployed;
    });

  it.effect("passes on a complete trio with both credentials registered", () =>
    Effect.gen(function* () {
      const { context } = yield* setupBase();
      const deployed = yield* deploySavingsTrio(context);
      yield* registerSavingsStake(context.lucid);
      yield* advanceBlock(context.emulator, 1);

      const result = yield* verifyProtocolDeployment(context.lucid, {
        settingsPolicy: context.protocol!.settingsPolicy,
        refs: {
          ...refsFromContext(context.scriptRefs!),
          savings: deployed.refs.savings,
          savingsGoverned: deployed.refs.savingsGoverned,
          savingsDirect: deployed.refs.savingsDirect,
        },
        expected: {
          settingsUnit: context.settingsUnit!,
          network: "Custom",
        },
      });

      expect(result.issues).toEqual([]);
      expect(result.ok).toBe(true);
      for (const key of [
        "savings",
        "savingsGoverned",
        "savingsDirect",
      ] as const)
        expect(result.refs[key].hashMatches).toBe(true);
      expect(result.savingsStakeRegistrations?.governed.status).toBe(
        "registered",
      );
      expect(result.savingsStakeRegistrations?.direct.status).toBe(
        "registered",
      );
    }),
  );

  it.effect("rejects a savings deployment missing a family reference", () =>
    Effect.gen(function* () {
      const { context } = yield* setupBase();
      const deployed = yield* deploySavingsTrio(context);
      yield* registerSavingsStake(context.lucid);
      yield* advanceBlock(context.emulator, 1);

      // Only the dispatcher is named. Before ADR-0003 this was a complete
      // savings deployment; now it is one third of one.
      const result = yield* verifyProtocolDeployment(context.lucid, {
        settingsPolicy: context.protocol!.settingsPolicy,
        refs: {
          ...refsFromContext(context.scriptRefs!),
          savings: deployed.refs.savings,
        },
        expected: {
          settingsUnit: context.settingsUnit!,
          network: "Custom",
        },
      });

      expect(result.ok).toBe(false);
      expect(result.issues.some((i) => i.includes("savingsGoverned"))).toBe(
        true,
      );
      expect(result.issues.some((i) => i.includes("savingsDirect"))).toBe(true);
    }),
  );

  it.effect("rejects an unregistered savings family credential", () =>
    Effect.gen(function* () {
      const { context } = yield* setupBase();
      const deployed = yield* deploySavingsTrio(context);
      // References published, credentials never registered: the shape a deploy
      // that skipped registerSavingsStake leaves behind.

      const result = yield* verifyProtocolDeployment(context.lucid, {
        settingsPolicy: context.protocol!.settingsPolicy,
        refs: {
          ...refsFromContext(context.scriptRefs!),
          savings: deployed.refs.savings,
          savingsGoverned: deployed.refs.savingsGoverned,
          savingsDirect: deployed.refs.savingsDirect,
        },
        expected: {
          settingsUnit: context.settingsUnit!,
          network: "Custom",
        },
      });

      expect(result.ok).toBe(false);
      expect(result.savingsStakeRegistrations?.governed.status).toBe(
        "not-registered",
      );
      expect(result.savingsStakeRegistrations?.direct.status).toBe(
        "not-registered",
      );
      expect(
        result.issues.some((i) => i.includes("registerSavingsStake")),
      ).toBe(true);
      // Every reference is sound — only the registrations are missing.
      for (const key of [
        "savings",
        "savingsGoverned",
        "savingsDirect",
      ] as const)
        expect(result.refs[key].hashMatches).toBe(true);
    }),
  );
});
