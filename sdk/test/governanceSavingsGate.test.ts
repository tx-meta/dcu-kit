import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import {
  Emulator,
  fromText,
  generateEmulatorAccount,
  Lucid,
  LucidEvolution,
  mintingPolicyToId,
  PROTOCOL_PARAMETERS_DEFAULT,
  scriptFromNative,
  UTxO,
} from "@lucid-evolution/lucid";
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

// A permissionless "membership" policy: eligibility = holding a token of it.
const membershipScript = scriptFromNative({ type: "all", scripts: [] });
const MEMBER_POLICY = mintingPolicyToId(membershipScript);
const MEMBER_NAME = fromText("member");
const MEMBER_UNIT = MEMBER_POLICY + MEMBER_NAME;

type Ctx = {
  lucid: LucidEvolution;
  emulator: Emulator;
  creator: { seedPhrase: string; address: string };
  member1: { seedPhrase: string; address: string };
  /** The ~15.5KB savings validator deployed once as a reference script. */
  savingsRef: UTxO;
};

const advancePast = (emulator: Emulator, deadlineMs: bigint) =>
  Effect.sync(() => {
    while (BigInt(emulator.now()) <= deadlineMs + 2_000n) {
      emulator.awaitBlock(10);
    }
  });

const makeContext = Effect.gen(function* () {
  const creator = generateEmulatorAccount({ lovelace: 2_000_000_000n });
  const member1 = generateEmulatorAccount({ lovelace: 500_000_000n });
  const emulator = new Emulator(
    [creator, member1],
    PROTOCOL_PARAMETERS_DEFAULT,
  );
  const lucid = yield* Effect.promise(() => Lucid(emulator, "Custom"));

  selectWalletFromSeed(lucid, creator.seedPhrase);
  const deploy = yield* Effect.promise(() =>
    lucid
      .newTx()
      .pay.ToAddressWithData(
        creator.address,
        undefined,
        { lovelace: 25_000_000n },
        savingsVaultValidator.spendVault,
      )
      .complete(),
  );
  yield* signAndSubmit(deploy);
  yield* advanceBlock(emulator, 2);
  const savingsRef = (yield* Effect.promise(() =>
    lucid.utxosAt(creator.address),
  )).find((u) => u.scriptRef);
  if (!savingsRef) throw new Error("savings script ref deploy failed");
  return { lucid, emulator, creator, member1, savingsRef } as Ctx;
});

// Deploy the instance's two large governance validators as reference scripts.
const deployGovRefs = (ctx: Ctx, instance: GovernanceInstance) =>
  Effect.gen(function* () {
    const { lucid, emulator } = ctx;
    const address = ctx.creator.address;
    const refs: { dispatcher?: UTxO; voting?: UTxO } = {};
    for (const [key, script] of [
      ["dispatcher", instance.dispatcherValidator.spend],
      ["voting", instance.votingValidator],
    ] as const) {
      const tx = yield* Effect.promise(() =>
        lucid
          .newTx()
          .pay.ToAddressWithData(
            address,
            undefined,
            { lovelace: 20_000_000n },
            script,
          )
          .complete(),
      );
      const signed = yield* Effect.promise(() =>
        tx.sign.withWallet().complete(),
      );
      const txHash = yield* Effect.promise(() => signed.submit());
      emulator.awaitBlock(2);
      const utxo = (yield* Effect.promise(() => lucid.utxosAt(address))).find(
        (u) => u.txHash === txHash && u.scriptRef,
      );
      if (!utxo) throw new Error(`ref-script UTxO for ${key} not found`);
      refs[key] = utxo;
    }
    return refs as GovScriptRefs;
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

    const mintTx = yield* Effect.promise(() =>
      lucid
        .newTx()
        .mintAssets({ [MEMBER_UNIT]: 1n })
        .attach.MintingPolicy(membershipScript)
        .complete(),
    );
    yield* signAndSubmit(mintTx);
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
        action: { ParamChange: { field_tag: 0n, new_value: 250n } },
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
        expect(proposalId).toBeDefined();
      }),
    { timeout: 120_000 },
  );
});
