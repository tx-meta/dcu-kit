import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { TxBuilder, UTxO } from "@lucid-evolution/lucid";
import {
  selectWalletFromSeed,
  signAndSubmit,
} from "../src/core/utils/index.js";
import { unsignedInitGovernanceTxProgram } from "../src/governance/endpoints/initGovernance.js";
import { unsignedRegisterVotingStakeTxProgram } from "../src/governance/endpoints/registerVotingStake.js";
import { unsignedRegisterVoterTxProgram } from "../src/governance/endpoints/registerVoter.js";
import { unsignedOpenProposalTxProgram } from "../src/governance/endpoints/openProposal.js";
import { unsignedCastVoteTxProgram } from "../src/governance/endpoints/castVote.js";
import { unsignedFinalizeProposalTxProgram } from "../src/governance/endpoints/finalizeProposal.js";
import { unsignedExecuteDecisionTxProgram } from "../src/governance/endpoints/executeDecision.js";
import { gateWitnessProgram } from "../src/governance/endpoints/authorizeAction.js";
import {
  govActionForOperation,
  SavingsOperation,
} from "../src/governance/utils.js";
import {
  decisionTokenName,
  gateAddress,
  GovScriptRefs,
} from "../src/governance/utils.js";
import { GovernanceInstance } from "../src/governance/validators.js";
import { unsignedCreateFundTxProgram } from "../src/savings/endpoints/createFund.js";
import { unsignedUpdateFundTxProgram } from "../src/savings/endpoints/updateFund.js";
import { getFundStateProgram } from "../src/savings/queries/getFundState.js";
import {
  savingsPolicyId,
  savingsVaultValidator,
} from "../src/savings/validators.js";
import { resolveFund } from "../src/savings/utils.js";
import { advanceBlock } from "./effects.js";
import {
  advancePast,
  deployGovRefs,
  deployScriptRef,
  GovTestContext,
  makeGovContext,
  MEMBER_UNIT,
  MEMBER_POLICY,
  mintMembership,
} from "./utils.js";

/** The governance context plus the savings validator's reference script. */
type Ctx = GovTestContext & {
  /** The ~15.5KB savings validator deployed once as a reference script. */
  savingsRef: UTxO;
};

const makeContext = Effect.gen(function* () {
  const base = yield* makeGovContext;
  selectWalletFromSeed(base.lucid, base.creator.seedPhrase);
  const savingsRef = yield* deployScriptRef(
    base,
    savingsVaultValidator.spendVault,
    25_000_000n,
  );
  return { ...base, savingsRef } as Ctx;
});

/**
 * The full cross-module prelude:
 *   1. a real savings fund exists (quorum = the creator's key);
 *   2. a governance instance is created that names THAT fund's state token as
 *      its single governed target;
 *   3. the fund rotates its quorum to `Script(gateHash)` — from here only a
 *      transaction that spends a decision at the gate can mutate it.
 */
const setupGovernedFund = (ctx: Ctx) =>
  Effect.gen(function* () {
    const { lucid, emulator } = ctx;
    selectWalletFromSeed(lucid, ctx.creator.seedPhrase);

    // --- 1. the fund, initially under the creator's own key ---
    const { tx: createTx, fundTokenName } = yield* unsignedCreateFundTxProgram(
      lucid,
      {
        scriptRef: ctx.savingsRef,
        title: "gate-governed fund",
        shareValue: 1_000_000n,
        minSharesPerDeposit: 1n,
        maxSharesPerDeposit: 100n,
        withdrawalPolicy: 1n,
      },
    );
    yield* signAndSubmit(createTx);
    yield* advanceBlock(emulator, 2);

    // --- 2. governance whose ONLY governed target is that fund ---
    const { tx: initTx, instance } = yield* unsignedInitGovernanceTxProgram(
      lucid,
      {
        title: "Fund Governance",
        memberPolicy: MEMBER_POLICY,
        governedTargets: [[savingsPolicyId, fundTokenName]],
        quorum: 1n,
        threshold: 5000n,
      },
    );
    yield* signAndSubmit(initTx);
    yield* advanceBlock(emulator, 2);

    const scriptRefs = yield* deployGovRefs(ctx, instance);

    const regTx = yield* unsignedRegisterVotingStakeTxProgram(lucid, instance);
    yield* signAndSubmit(regTx);
    yield* advanceBlock(emulator, 2);

    yield* mintMembership(lucid);
    yield* advanceBlock(emulator, 2);

    const { tx: voterTx } = yield* unsignedRegisterVoterTxProgram(lucid, {
      instance,
      voterTokenUnit: MEMBER_UNIT,
      scriptRefs,
    });
    yield* signAndSubmit(voterTx);
    yield* advanceBlock(emulator, 2);

    // --- 3. the fund hands its ratification authority to the gate ---
    const rotate = yield* unsignedUpdateFundTxProgram(lucid, {
      scriptRef: ctx.savingsRef,
      fundTokenName,
      quorum: { type: "Script", hash: instance.gateHash },
    });
    yield* signAndSubmit(rotate);
    yield* advanceBlock(emulator, 3);

    const governed = yield* getFundStateProgram(lucid, fundTokenName);
    const q = governed.fund.quorum;
    if (typeof q === "string" || !("Script" in q))
      throw new Error("quorum rotation did not take");
    expect(q.Script[0]).toBe(instance.gateHash);

    return { instance, scriptRefs, fundTokenName };
  });

/** open → vote → finalize → execute, leaving a live decision at the gate. */
const runProposalToExecuted = (
  ctx: Ctx,
  instance: GovernanceInstance,
  scriptRefs: GovScriptRefs,
  fundTokenName: string,
) =>
  Effect.gen(function* () {
    const { lucid, emulator } = ctx;
    selectWalletFromSeed(lucid, ctx.creator.seedPhrase);

    const now = BigInt(emulator.now());
    const deadline = now + 120_000n;
    const { tx: openTx, proposalId } = yield* unsignedOpenProposalTxProgram(
      lucid,
      {
        instance,
        targetPolicy: savingsPolicyId,
        targetId: fundTokenName,
        // "raise the per-deposit share ceiling" — the charter change the
        // members are ratifying.
        // The decision authorizes exactly one operation on this fund: an
        // UpdateFund. It cannot later be spent to write off a loan.
        action: govActionForOperation(SavingsOperation.UpdateFund),
        deadline,
        openerTokenUnit: MEMBER_UNIT,
        currentTime: now,
        scriptRefs,
      },
    );
    yield* signAndSubmit(openTx);
    yield* advanceBlock(emulator, 2);

    const { tx: voteTx } = yield* unsignedCastVoteTxProgram(lucid, {
      instance,
      proposalId,
      approve: true,
      voterTokenUnit: MEMBER_UNIT,
      currentTime: BigInt(emulator.now()),
      scriptRefs,
    });
    yield* signAndSubmit(voteTx);
    yield* advancePast(emulator, deadline);

    const { tx: finalizeTx, passed } = yield* unsignedFinalizeProposalTxProgram(
      lucid,
      {
        instance,
        proposalId,
        currentTime: BigInt(emulator.now()),
        scriptRefs,
      },
    );
    expect(passed).toBe(true);
    yield* signAndSubmit(finalizeTx);
    yield* advanceBlock(emulator, 2);

    const { tx: execTx, decisionName } =
      yield* unsignedExecuteDecisionTxProgram(lucid, {
        instance,
        proposalId,
        currentTime: BigInt(emulator.now()),
        scriptRefs,
      });
    yield* signAndSubmit(execTx);
    yield* advanceBlock(emulator, 3);

    expect(decisionName).toBe(decisionTokenName(proposalId));
    return { proposalId, decisionName };
  });

describe("governance gate governs a real savings fund", () => {
  it.effect(
    "an executed decision mutates a fund whose quorum is Script(gateHash)",
    () =>
      Effect.gen(function* () {
        const ctx = yield* makeContext;
        const { lucid, emulator } = ctx;
        const { instance, scriptRefs, fundTokenName } =
          yield* setupGovernedFund(ctx);

        const { proposalId, decisionName } = yield* runProposalToExecuted(
          ctx,
          instance,
          scriptRefs,
          fundTokenName,
        );

        // The decision is live at the gate, ready to authorize the mutation.
        const network = lucid.config().network!;
        const decisionUnit = instance.govPolicy + decisionName;
        const gateUtxos = yield* Effect.promise(() =>
          lucid.utxosAt(gateAddress(network, instance)),
        );
        expect(
          gateUtxos.find((u) => (u.assets[decisionUnit] ?? 0n) > 0n),
        ).toBeDefined();

        const before = yield* getFundStateProgram(lucid, fundTokenName);
        expect(before.fund.max_shares_per_deposit).toBe(100n);

        // The mutation itself: quorum-gated updateFund, authorized by spending
        // the decision at the gate in the SAME transaction. The gate fragment
        // indexes the fund input without collecting it — updateFund spends it
        // with its own UpdateFund redeemer.
        const { utxo: fundUtxo } = yield* resolveFund(lucid, fundTokenName);
        const gateWitness = yield* gateWitnessProgram(lucid, {
          instance,
          proposalId,
          targetUtxo: fundUtxo,
          scriptRefs,
        });
        const mutate = yield* unsignedUpdateFundTxProgram(lucid, {
          scriptRef: ctx.savingsRef,
          fundTokenName,
          maxSharesPerDeposit: 250n,
          quorumWitness: { extend: gateWitness },
        });
        yield* signAndSubmit(mutate);
        yield* advanceBlock(emulator, 3);

        const after = yield* getFundStateProgram(lucid, fundTokenName);
        expect(after.fund.max_shares_per_deposit).toBe(250n);

        // One-shot: the decision token is gone.
        const gateAfter = yield* Effect.promise(() =>
          lucid.utxosAt(gateAddress(network, instance)),
        );
        expect(
          gateAfter.find((u) => (u.assets[decisionUnit] ?? 0n) > 0n),
        ).toBeUndefined();
      }),
    { timeout: 120_000 },
  );

  // Necessity, not just sufficiency. Without these the gate spend could become
  // decorative — a refactor that stopped requiring it would still go green.
  it.effect(
    "the same mutation is REJECTED without the decision spent at the gate",
    () =>
      Effect.gen(function* () {
        const ctx = yield* makeContext;
        const { lucid } = ctx;
        const { instance, scriptRefs, fundTokenName } =
          yield* setupGovernedFund(ctx);
        yield* runProposalToExecuted(ctx, instance, scriptRefs, fundTokenName);

        // (a) No witness at all: the SDK refuses up front, because a script
        //     quorum cannot be satisfied by the wallet's signature.
        const noWitness = yield* Effect.flip(
          unsignedUpdateFundTxProgram(lucid, {
            scriptRef: ctx.savingsRef,
            fundTokenName,
            maxSharesPerDeposit: 250n,
          }),
        );
        expect(String(noWitness)).toContain("script credential");

        // (b) A no-op extension: the SDK is satisfied and builds the very same
        //     UpdateFund transaction, minus the decision input. Nothing then
        //     sits at the gate credential, so `credential_authorized` fails and
        //     the savings validator rejects it under real UPLC evaluation.
        const noopExtend = yield* Effect.flip(
          unsignedUpdateFundTxProgram(lucid, {
            scriptRef: ctx.savingsRef,
            fundTokenName,
            maxSharesPerDeposit: 250n,
            quorumWitness: { extend: (tx: TxBuilder) => tx },
          }),
        );
        // `TransactionBuildError` carries its cause in `error`, not `message`,
        // so stringify the whole failure rather than String()-ing it.
        const detail = JSON.stringify(noopExtend);
        expect(noopExtend._tag).toBe("TransactionBuildError");
        expect(detail).toContain('"operation":"updateFund"');
        // The savings vault itself refused it — not a build or balance error.
        expect(detail).toContain("failed script execution");

        // The charter is untouched and the decision is still live at the gate.
        const after = yield* getFundStateProgram(lucid, fundTokenName);
        expect(after.fund.max_shares_per_deposit).toBe(100n);
        const network = lucid.config().network!;
        const gateUtxos = yield* Effect.promise(() =>
          lucid.utxosAt(gateAddress(network, instance)),
        );
        expect(gateUtxos.length).toBe(1);
      }),
    { timeout: 120_000 },
  );

  // Finding 1: `extend` must never be silently dropped or silently preferred.
  it.effect("rejects a witness that cannot mean what the caller intends", () =>
    Effect.gen(function* () {
      const ctx = yield* makeContext;
      const { lucid, emulator } = ctx;
      selectWalletFromSeed(lucid, ctx.creator.seedPhrase);

      // A fund left under the creator's KEY quorum.
      const { tx: createTx, fundTokenName } =
        yield* unsignedCreateFundTxProgram(lucid, {
          scriptRef: ctx.savingsRef,
          title: "key-quorum fund",
          shareValue: 1_000_000n,
          withdrawalPolicy: 1n,
        });
      yield* signAndSubmit(createTx);
      yield* advanceBlock(emulator, 2);

      // `extend` against a key quorum would build the spend and prove nothing —
      // a decision consumed for a signature that authorized it anyway.
      const keyQuorum = yield* Effect.flip(
        unsignedUpdateFundTxProgram(lucid, {
          scriptRef: ctx.savingsRef,
          fundTokenName,
          maxSharesPerDeposit: 250n,
          quorumWitness: { extend: (tx: TxBuilder) => tx },
        }),
      );
      expect(String(keyQuorum)).toContain("cannot authorize it");

      // Both witness forms at once hides which one ran and skips the
      // hash-equality guard on `script`.
      const both = yield* Effect.flip(
        unsignedUpdateFundTxProgram(lucid, {
          scriptRef: ctx.savingsRef,
          fundTokenName,
          maxSharesPerDeposit: 250n,
          quorumWitness: {
            script: savingsVaultValidator.spendVault,
            extend: (tx: TxBuilder) => tx,
          },
        }),
      );
      expect(String(both)).toContain("not both");
    }),
  );
});
