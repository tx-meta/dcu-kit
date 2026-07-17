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
import { unsignedAuthorizeActionTxProgram } from "../src/governance/endpoints/authorizeAction.js";
import { unsignedUpdateCharterTxProgram } from "../src/governance/endpoints/updateCharter.js";
import { unsignedExpireProposalTxProgram } from "../src/governance/endpoints/expireProposal.js";
import { getProposalsProgram } from "../src/governance/queries/getProposals.js";
import {
  decisionTokenName,
  gateAddress,
  GovScriptRefs,
  resolveAnchor,
  resolveProposal,
  resolveRoster,
  resolveVoterRecord,
} from "../src/governance/utils.js";
import { GovernanceInstance } from "../src/governance/validators.js";
import { advanceBlock } from "./effects.js";

const TARGET = "bb".repeat(28);

// A permissionless "membership" policy: eligibility = holding a token of it.
// Stands in for the savings user-token policy in cross-module production use.
const membershipScript = scriptFromNative({ type: "all", scripts: [] });
const MEMBER_POLICY = mintingPolicyToId(membershipScript);
const MEMBER_NAME = fromText("member");
const MEMBER_UNIT = MEMBER_POLICY + MEMBER_NAME;

// The governed vault's state token: the gate binds a decision to the input that
// carries the exact (policy, name) of the vault's state NFT.
const TARGET_POLICY = MEMBER_POLICY;
const TARGET_UNIT = TARGET_POLICY + TARGET;

// Mint one membership token to the connected wallet (idempotent per test wallet).
const mintMembership = (lucid: LucidEvolution) =>
  Effect.gen(function* () {
    const tx = yield* Effect.promise(() =>
      lucid
        .newTx()
        .mintAssets({ [MEMBER_UNIT]: 1n })
        .attach.MintingPolicy(membershipScript)
        .complete(),
    );
    yield* signAndSubmit(tx);
  });

// Mint the target vault's state token and return the UTxO holding it.
const mintTargetVault = (lucid: LucidEvolution) =>
  Effect.gen(function* () {
    const tx = yield* Effect.promise(() =>
      lucid
        .newTx()
        .mintAssets({ [TARGET_UNIT]: 1n })
        .attach.MintingPolicy(membershipScript)
        .complete(),
    );
    yield* signAndSubmit(tx);
  });

const findTargetUtxo = (lucid: LucidEvolution) =>
  Effect.gen(function* () {
    const utxos = yield* Effect.promise(() => lucid.wallet().getUtxos());
    const found = utxos.find((u) => (u.assets[TARGET_UNIT] ?? 0n) > 0n);
    if (!found) throw new Error("target vault UTxO not found");
    return found;
  });

// Advance the emulator clock past a POSIX-ms deadline (slots are 1s).
const advancePast = (emulator: Emulator, deadlineMs: bigint) =>
  Effect.sync(() => {
    while (BigInt(emulator.now()) <= deadlineMs + 2_000n) {
      emulator.awaitBlock(10);
    }
  });

// A creator plus two members, all seed wallets so each can pay fees and sign.
type GovContext = {
  lucid: LucidEvolution;
  emulator: Emulator;
  creator: { seedPhrase: string; address: string };
  member1: { seedPhrase: string; address: string };
  member2: { seedPhrase: string; address: string };
};

const makeContext = Effect.gen(function* () {
  const creator = generateEmulatorAccount({ lovelace: 2_000_000_000n });
  const member1 = generateEmulatorAccount({ lovelace: 500_000_000n });
  const member2 = generateEmulatorAccount({ lovelace: 500_000_000n });
  const emulator = new Emulator(
    [creator, member1, member2],
    PROTOCOL_PARAMETERS_DEFAULT,
  );
  const lucid = yield* Effect.promise(() => Lucid(emulator, "Custom"));
  return { lucid, emulator, creator, member1, member2 } as GovContext;
});

// Deploy the instance's two large validators as reference scripts (the
// dispatcher + voting no longer fit inline together in one tx).
const deployGovRefs = (ctx: GovContext, instance: GovernanceInstance) =>
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

// init + ref-script deploy + stake registration + membership mint + voter
// registration — the prelude every lifecycle needs.
const setupInstance = (ctx: GovContext, quorum: bigint) =>
  Effect.gen(function* () {
    const { lucid, emulator } = ctx;
    selectWalletFromSeed(lucid, ctx.creator.seedPhrase);
    const { tx: initTx, instance } = yield* unsignedInitGovernanceTxProgram(
      lucid,
      {
        title: "Chama",
        memberPolicy: MEMBER_POLICY,
        governedTargets: [[TARGET_POLICY, TARGET]],
        quorum,
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

    const { tx: voterTx, recordName } = yield* unsignedRegisterVoterTxProgram(
      lucid,
      { instance, voterTokenUnit: MEMBER_UNIT, scriptRefs },
    );
    yield* signAndSubmit(voterTx);
    yield* advanceBlock(emulator, 2);

    return { instance, recordName, scriptRefs };
  });

describe("governance module (emulator, real validators)", () => {
  it.effect(
    "initGovernance mints the anchor + roster and publishes the hashes",
    () =>
      Effect.gen(function* () {
        const ctx = yield* makeContext;
        const { lucid } = ctx;

        selectWalletFromSeed(lucid, ctx.creator.seedPhrase);
        const { tx, instance } = yield* unsignedInitGovernanceTxProgram(lucid, {
          title: "Test Chama Governance",
          memberPolicy: MEMBER_POLICY,
          governedTargets: [[TARGET_POLICY, TARGET]],
          quorum: 2n,
          threshold: 5000n,
        });
        yield* signAndSubmit(tx);
        yield* advanceBlock(ctx.emulator, 2);

        // The anchor is now locked at the dispatcher address and resolvable.
        const { anchor } = yield* resolveAnchor(lucid, instance);
        expect(anchor.default_quorum).toBe(2n);
        expect(anchor.default_threshold).toBe(5000n);
        expect(anchor.voting_mode).toBe("OneMemberOneVote");
        // The charter publishes this instance's derived hashes.
        expect(anchor.voting_stake_hash).toBe(instance.votingStakeHash);
        expect(anchor.gate_hash).toBe(instance.gateHash);
        expect([...anchor.governed_targets.entries()]).toEqual([
          [TARGET_POLICY, TARGET],
        ]);

        // The roster is born as the EMPTY ever-registered set.
        const { roster } = yield* resolveRoster(lucid, instance);
        expect(roster.members).toEqual([]);
      }),
  );

  it.effect("register voter → open proposal → vote appends the record", () =>
    Effect.gen(function* () {
      const ctx = yield* makeContext;
      const { lucid, emulator } = ctx;
      const { instance, scriptRefs } = yield* setupInstance(ctx, 2n);

      // Registration appended the member to the roster and created the record.
      const { roster } = yield* resolveRoster(lucid, instance);
      expect(roster.members).toEqual([MEMBER_NAME]);
      const { record } = yield* resolveVoterRecord(
        lucid,
        instance,
        MEMBER_NAME,
      );
      expect(record.voted).toEqual([]);

      // Open a ParamChange proposal on the governed target.
      const now = BigInt(emulator.now());
      const { tx: openTx, proposalId } = yield* unsignedOpenProposalTxProgram(
        lucid,
        {
          instance,
          targetPolicy: TARGET_POLICY,
          targetId: TARGET,
          action: { ParamChange: { field_tag: 0n, new_value: 100n } },
          deadline: now + 7n * 24n * 3600_000n,
          openerTokenUnit: MEMBER_UNIT,
          currentTime: now,
          scriptRefs,
        },
      );
      yield* signAndSubmit(openTx);
      yield* advanceBlock(emulator, 2);

      const { proposal } = yield* resolveProposal(lucid, instance, proposalId);
      expect(proposal.status).toBe("Open");
      expect(proposal.target_id).toBe(TARGET);
      expect(proposal.target_policy).toBe(TARGET_POLICY);
      expect(proposal.tally_yes).toBe(0n);
      expect(proposal.quorum).toBe(2n);

      // Cast one approving vote — tally, turnout, and the record advance.
      const { tx: voteTx } = yield* unsignedCastVoteTxProgram(lucid, {
        instance,
        proposalId,
        approve: true,
        voterTokenUnit: MEMBER_UNIT,
        currentTime: BigInt(emulator.now()),
        scriptRefs,
      });
      yield* signAndSubmit(voteTx);
      yield* advanceBlock(emulator, 2);

      const { proposal: voted } = yield* resolveProposal(
        lucid,
        instance,
        proposalId,
      );
      expect(voted.tally_yes).toBe(1n);
      expect(voted.tally_no).toBe(0n);
      expect(voted.votes_cast).toBe(1n);
      expect(voted.status).toBe("Open");

      // The voter record now lists this proposal — the nullifier.
      const { record: after } = yield* resolveVoterRecord(
        lucid,
        instance,
        MEMBER_NAME,
      );
      expect(after.voted).toEqual([proposalId]);

      // A second vote on the same proposal is rejected up front.
      const again = yield* Effect.flip(
        unsignedCastVoteTxProgram(lucid, {
          instance,
          proposalId,
          approve: true,
          voterTokenUnit: MEMBER_UNIT,
          currentTime: BigInt(emulator.now()),
          scriptRefs,
        }),
      );
      expect(String(again)).toContain("already voted");

      // A second registration for the same member is rejected up front.
      const reRegister = yield* Effect.flip(
        unsignedRegisterVoterTxProgram(lucid, {
          instance,
          voterTokenUnit: MEMBER_UNIT,
          scriptRefs,
        }),
      );
      expect(String(reRegister)).toContain("already registered");
    }),
  );

  it.effect(
    "full core loop: open → vote → finalize (Passed) → execute → decision at gate",
    () =>
      Effect.gen(function* () {
        const ctx = yield* makeContext;
        const { lucid, emulator } = ctx;
        // quorum 1 so a single vote passes.
        const { instance, scriptRefs } = yield* setupInstance(ctx, 1n);

        const now = BigInt(emulator.now());
        const deadline = now + 120_000n;
        const { tx: openTx, proposalId } = yield* unsignedOpenProposalTxProgram(
          lucid,
          {
            instance,
            targetPolicy: TARGET_POLICY,
            targetId: TARGET,
            action: {
              SocialPayout: { recipient: "cc".repeat(28), amount: 5_000_000n },
            },
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

        // Voting closes at the deadline; finalize only lands after it.
        yield* advancePast(emulator, deadline);

        const { tx: finalizeTx, passed } =
          yield* unsignedFinalizeProposalTxProgram(lucid, {
            instance,
            proposalId,
            currentTime: BigInt(emulator.now()),
            scriptRefs,
          });
        expect(passed).toBe(true);
        yield* signAndSubmit(finalizeTx);
        yield* advanceBlock(emulator, 2);

        const { proposal: finalized } = yield* resolveProposal(
          lucid,
          instance,
          proposalId,
        );
        expect(finalized.status).toBe("Passed");
        expect(finalized.timelock_until).not.toBeNull();

        // Execute after the (zero) timelock elapses.
        yield* advancePast(emulator, finalized.timelock_until!);

        const { tx: execTx, decisionName } =
          yield* unsignedExecuteDecisionTxProgram(lucid, {
            instance,
            proposalId,
            currentTime: BigInt(emulator.now()),
            scriptRefs,
          });
        yield* signAndSubmit(execTx);
        yield* advanceBlock(emulator, 2);

        const { proposal: executed } = yield* resolveProposal(
          lucid,
          instance,
          proposalId,
        );
        expect(executed.status).toBe("Executed");
        expect(decisionName).toBe(decisionTokenName(proposalId));

        // The one-shot decision now sits at the gate address, ready to authorize.
        const network = lucid.config().network!;
        const gateUtxos = yield* Effect.promise(() =>
          lucid.utxosAt(gateAddress(network, instance)),
        );
        const decisionUnit = instance.govPolicy + decisionName;
        const decision = gateUtxos.find(
          (u) => (u.assets[decisionUnit] ?? 0n) > 0n,
        );
        expect(decision).toBeDefined();

        // Authorize: the gate binds the decision to the target vault input,
        // then burns it (one-shot). In production the vault action composes here.
        yield* mintTargetVault(lucid);
        yield* advanceBlock(emulator, 2);
        const targetUtxo = yield* findTargetUtxo(lucid);
        const authTx = yield* unsignedAuthorizeActionTxProgram(lucid, {
          instance,
          proposalId,
          targetUtxo,
        });
        yield* signAndSubmit(authTx);
        yield* advanceBlock(emulator, 2);

        const gateAfter = yield* Effect.promise(() =>
          lucid.utxosAt(gateAddress(network, instance)),
        );
        const stillThere = gateAfter.find(
          (u) => (u.assets[decisionUnit] ?? 0n) > 0n,
        );
        expect(stillThere).toBeUndefined();
      }),
  );

  it.effect(
    "updateCharter amends mutable fields; expireProposal retires a proposal",
    () =>
      Effect.gen(function* () {
        const ctx = yield* makeContext;
        const { lucid, emulator } = ctx;
        const { instance, scriptRefs } = yield* setupInstance(ctx, 2n);

        // Amend the charter: raise the default quorum, keep hashes immutable.
        const upTx = yield* unsignedUpdateCharterTxProgram(lucid, {
          instance,
          quorum: 5n,
        });
        yield* signAndSubmit(upTx);
        yield* advanceBlock(emulator, 2);
        const { anchor } = yield* resolveAnchor(lucid, instance);
        expect(anchor.default_quorum).toBe(5n);
        expect(anchor.gate_hash).toBe(instance.gateHash);

        // Open then expire a proposal — allowed only after its deadline.
        const now = BigInt(emulator.now());
        const deadline = now + 60_000n;
        const { tx: openTx, proposalId } = yield* unsignedOpenProposalTxProgram(
          lucid,
          {
            instance,
            targetPolicy: TARGET_POLICY,
            targetId: TARGET,
            action: { ParamChange: { field_tag: 0n, new_value: 1n } },
            deadline,
            openerTokenUnit: MEMBER_UNIT,
            currentTime: now,
            scriptRefs,
          },
        );
        yield* signAndSubmit(openTx);
        yield* advancePast(emulator, deadline);

        const expTx = yield* unsignedExpireProposalTxProgram(lucid, {
          instance,
          proposalId,
          currentTime: BigInt(emulator.now()),
          scriptRefs,
        });
        yield* signAndSubmit(expTx);
        yield* advanceBlock(emulator, 2);

        const remaining = yield* getProposalsProgram(lucid, instance);
        expect(remaining.length).toBe(0);
      }),
  );
});
