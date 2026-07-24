import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { setupBase, setupGroup } from "./setup.js";
import { createDefaultGroupDatum } from "./utils.js";
import {
  assetNameLabels,
  selectWalletFromSeed,
} from "../src/core/utils/index.js";
import {
  captureRejection,
  deploymentIdentity,
  NegativeProofAcceptedError,
  rawCreateAccount,
  rawCreateGroup,
  rawUpdateGroup,
  RejectionEvidence,
} from "../src/harness/negativeProofs.js";
import { GroupDatum } from "../src/core/types.js";
import { LucidContext } from "./context.js";

// Matrix C (P2 acceptance): the validator-proof half of each dual negative
// proof. The SDK guards reject these requests before a transaction exists;
// the harness builds the transaction anyway and the validator must reject it
// at evaluation. Emulator run = real UPLC against real chain state; the same
// harness runs on Preprod with provider evaluation (localUPLCEval: false).

const expectEvidence = (evidence: RejectionEvidence, label: string) => {
  expect(evidence.rejected).toBe(true);
  expect(evidence.label).toBe(label);
  expect(evidence.evaluatorError.length).toBeGreaterThan(0);
  expect(evidence.attemptedDatum).toBeTruthy();
  expect(evidence.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(evidence.deployment.groupPolicyId).toMatch(/^[0-9a-f]{56}$/);
};

// Build + capture one sub-floor create-group attempt on a fresh context.
const createGroupProof = (
  context: LucidContext,
  label: string,
  datumOverride: Partial<GroupDatum>,
) =>
  Effect.gen(function* () {
    const { lucid, users } = context;
    selectWalletFromSeed(lucid, users.admin.seedPhrase);
    const utxos = yield* Effect.promise(() => lucid.wallet().getUtxos());
    const seed = utxos.filter((u) => !u.scriptRef)[0];

    const { attemptedDatum, program } = rawCreateGroup(
      context.protocol!,
      lucid,
      {
        groupDatum: createDefaultGroupDatum(datumOverride),
        utxoToSpend: { txHash: seed.txHash, outputIndex: seed.outputIndex },
        scriptRefs: context.scriptRefs,
      },
    );

    return yield* captureRejection(
      lucid,
      {
        label,
        deployment: deploymentIdentity(context.protocol!, "Custom"),
        evaluation: "local-uplc",
        attemptedDatum,
        seedOutRef: { txHash: seed.txHash, outputIndex: seed.outputIndex },
      },
      program,
    );
  });

describe("negative-proof harness (emulator)", () => {
  it.effect("C1: create-group recovery_threshold below the floor", () =>
    Effect.gen(function* () {
      const { context } = yield* setupBase();
      const evidence = yield* createGroupProof(
        context,
        "C1 create-group recovery_threshold=1",
        { recovery_threshold: 1n },
      );
      expectEvidence(evidence, "C1 create-group recovery_threshold=1");
      expect(evidence.seedUnspentAfter).toBe(true);
    }),
  );

  it.effect("C2: create-group recovery_timelock below the floor", () =>
    Effect.gen(function* () {
      const { context } = yield* setupBase();
      const evidence = yield* createGroupProof(
        context,
        "C2 create-group recovery_timelock=86_399_999",
        { recovery_timelock: 86_399_999n },
      );
      expectEvidence(evidence, "C2 create-group recovery_timelock=86_399_999");
      expect(evidence.seedUnspentAfter).toBe(true);
    }),
  );

  it.effect("C3: create-group recommit_window below the floor", () =>
    Effect.gen(function* () {
      const { context } = yield* setupBase();
      const evidence = yield* createGroupProof(
        context,
        "C3 create-group recommit_window=0",
        { recommit_window: 0n },
      );
      expectEvidence(evidence, "C3 create-group recommit_window=0");
    }),
  );

  it.effect(
    "control: an envelope-satisfying create-group is ACCEPTED (the harness rejects for the datum, not the plumbing)",
    () =>
      Effect.gen(function* () {
        const { context } = yield* setupBase();
        const result = yield* createGroupProof(
          context,
          "control valid create-group",
          {},
        ).pipe(Effect.flip);
        expect(result).toBeInstanceOf(NegativeProofAcceptedError);
      }),
  );

  it.effect("C4: pre-join update-group lowering recovery_timelock", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      const { context } = base;
      const { groupDatum, groupUtxo } = yield* setupGroup(base);
      const suffix = Object.keys(groupUtxo.assets)
        .find((k) => k.startsWith(context.protocol!.groupPolicyId))!
        .slice(
          context.protocol!.groupPolicyId.length +
            assetNameLabels.prefix100.length,
        );

      const { attemptedDatum, program } = yield* rawUpdateGroup(
        context.protocol!,
        context.lucid,
        {
          groupTokenSuffix: suffix,
          updatedDatum: { ...groupDatum, recovery_timelock: 86_399_999n },
        },
      );

      const evidence = yield* captureRejection(
        context.lucid,
        {
          label: "C4 pre-join update recovery_timelock=86_399_999",
          deployment: deploymentIdentity(context.protocol!, "Custom"),
          evaluation: "local-uplc",
          attemptedDatum,
        },
        program,
      );
      expectEvidence(
        evidence,
        "C4 pre-join update recovery_timelock=86_399_999",
      );
    }),
  );

  it.effect("C5: pre-join update-group mutating the CIP-68 version", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      const { context } = base;
      const { groupDatum, groupUtxo } = yield* setupGroup(base);
      const suffix = Object.keys(groupUtxo.assets)
        .find((k) => k.startsWith(context.protocol!.groupPolicyId))!
        .slice(
          context.protocol!.groupPolicyId.length +
            assetNameLabels.prefix100.length,
        );

      const { attemptedDatum, program } = yield* rawUpdateGroup(
        context.protocol!,
        context.lucid,
        {
          groupTokenSuffix: suffix,
          updatedDatum: groupDatum,
          versionOverride: 2n,
        },
      );

      const evidence = yield* captureRejection(
        context.lucid,
        {
          label: "C5 pre-join update version=2",
          deployment: deploymentIdentity(context.protocol!, "Custom"),
          evaluation: "local-uplc",
          attemptedDatum,
        },
        program,
      );
      expectEvidence(evidence, "C5 pre-join update version=2");
    }),
  );

  it.effect("C5: pre-join update-group emptying the metadata name", () =>
    Effect.gen(function* () {
      const base = yield* setupBase();
      const { context } = base;
      const { groupDatum, groupUtxo } = yield* setupGroup(base);
      const suffix = Object.keys(groupUtxo.assets)
        .find((k) => k.startsWith(context.protocol!.groupPolicyId))!
        .slice(
          context.protocol!.groupPolicyId.length +
            assetNameLabels.prefix100.length,
        );

      const { attemptedDatum, program } = yield* rawUpdateGroup(
        context.protocol!,
        context.lucid,
        {
          groupTokenSuffix: suffix,
          updatedDatum: groupDatum,
          metadataOverride: new Map<string, string>(),
        },
      );

      const evidence = yield* captureRejection(
        context.lucid,
        {
          label: "C5 pre-join update empty metadata",
          deployment: deploymentIdentity(context.protocol!, "Custom"),
          evaluation: "local-uplc",
          attemptedDatum,
        },
        program,
      );
      expectEvidence(evidence, "C5 pre-join update empty metadata");
    }),
  );

  it.effect("C6: create-account with a 31-byte commitment", () =>
    Effect.gen(function* () {
      const { context } = yield* setupBase();
      const { lucid, users } = context;
      selectWalletFromSeed(lucid, users.user1.seedPhrase);
      const utxos = yield* Effect.promise(() => lucid.wallet().getUtxos());
      const seed = utxos.filter((u) => !u.scriptRef)[0];

      const { attemptedDatum, program } = rawCreateAccount(
        context.protocol!,
        lucid,
        {
          selected_out_ref: {
            txHash: seed.txHash,
            outputIndex: seed.outputIndex,
          },
          profileCommitmentHex: "ab".repeat(31),
        },
      );

      const evidence = yield* captureRejection(
        lucid,
        {
          label: "C6 create-account 31-byte commitment",
          deployment: deploymentIdentity(context.protocol!, "Custom"),
          evaluation: "local-uplc",
          attemptedDatum,
          seedOutRef: { txHash: seed.txHash, outputIndex: seed.outputIndex },
        },
        program,
      );
      expectEvidence(evidence, "C6 create-account 31-byte commitment");
      expect(evidence.seedUnspentAfter).toBe(true);
    }),
  );

  it.effect("control: a 32-byte commitment create-account is ACCEPTED", () =>
    Effect.gen(function* () {
      const { context } = yield* setupBase();
      const { lucid, users } = context;
      selectWalletFromSeed(lucid, users.user1.seedPhrase);
      const utxos = yield* Effect.promise(() => lucid.wallet().getUtxos());
      const seed = utxos.filter((u) => !u.scriptRef)[0];

      const { attemptedDatum, program } = rawCreateAccount(
        context.protocol!,
        lucid,
        {
          selected_out_ref: {
            txHash: seed.txHash,
            outputIndex: seed.outputIndex,
          },
          profileCommitmentHex: "ab".repeat(32),
        },
      );

      const result = yield* captureRejection(
        lucid,
        {
          label: "control valid create-account",
          deployment: deploymentIdentity(context.protocol!, "Custom"),
          evaluation: "local-uplc",
          attemptedDatum,
        },
        program,
      ).pipe(Effect.flip);
      expect(result).toBeInstanceOf(NegativeProofAcceptedError);
    }),
  );
});
