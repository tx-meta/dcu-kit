import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { fromText, LucidEvolution } from "@lucid-evolution/lucid";
import {
  selectWalletFromSeed,
  signAndSubmit,
} from "../src/core/utils/index.js";
import { unsignedInitGovernanceTxProgram } from "../src/governance/endpoints/initGovernance.js";
import { unsignedRegisterVotingStakeTxProgram } from "../src/governance/endpoints/registerVotingStake.js";
import { unsignedRegisterVoterTxProgram } from "../src/governance/endpoints/registerVoter.js";
import { splitEligibility } from "../src/governance/endpoints/splitEligibility.js";
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
  resolveAnchor,
  resolveProposal,
  resolveRoster,
  resolveVoterRecord,
} from "../src/governance/utils.js";
import { advanceBlock } from "./effects.js";
import {
  advancePast,
  deployGovRefs,
  GovTestContext,
  makeGovContext,
  membershipScript,
  MEMBER_NAME,
  MEMBER_POLICY,
  MEMBER_UNIT,
  mintMemberAccount,
  mintMembership,
  readCip20,
} from "./utils.js";
import { assetNameLabels } from "../src/core/utils/index.js";

const TARGET = "bb".repeat(28);

// A second CIP-68 member, with the same (100)/(222) pairing the savings policy
// this fixture stands in for produces.
const MEMBER2_SUFFIX = "22".repeat(28);
const MEMBER2_NAME = assetNameLabels.prefix222 + MEMBER2_SUFFIX;
const MEMBER2_REF_UNIT =
  MEMBER_POLICY + assetNameLabels.prefix100 + MEMBER2_SUFFIX;

// The governed vault's state token: the gate binds a decision to the input that
// carries the exact (policy, name) of the vault's state NFT.
const TARGET_POLICY = MEMBER_POLICY;
const TARGET_UNIT = TARGET_POLICY + TARGET;

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

type GovContext = GovTestContext;
const makeContext = makeGovContext;

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
    // The eligibility policy IS the governed vault's policy here, so the voter
    // must prove which vault they belong to.
    yield* mintMemberAccount(lucid, TARGET);
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

        // Authorize: the gate binds the decision to the target vault input.
        // A target spent with NO redeemer performs no action, so nothing can be
        // bound to it and the gate rejects the spend. The positive path lives in
        // governanceSavingsGate.test.ts, where a real fund is spent with its own
        // UpdateFund redeemer and the decision names that operation.
        yield* mintTargetVault(lucid);
        yield* advanceBlock(emulator, 2);
        const targetUtxo = yield* findTargetUtxo(lucid);
        // Local UPLC evaluation runs during build, so the gate's rejection
        // surfaces before anything is submitted.
        const unbound = yield* Effect.flip(
          unsignedAuthorizeActionTxProgram(lucid, {
            instance,
            proposalId,
            targetUtxo,
          }),
        );
        expect(unbound._tag).toBe("TransactionBuildError");
        yield* advanceBlock(emulator, 2);

        // The one-shot decision is therefore still at the gate, unspent.
        const gateAfter = yield* Effect.promise(() =>
          lucid.utxosAt(gateAddress(network, instance)),
        );
        expect(
          gateAfter.find((u) => (u.assets[decisionUnit] ?? 0n) > 0n),
        ).toBeDefined();
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

  it.effect(
    "registerVoter rejects an eligibility UTxO holding two names under member_policy",
    () =>
      Effect.gen(function* () {
        const ctx = yield* makeContext;
        const { lucid, emulator } = ctx;
        const { instance, scriptRefs } = yield* setupInstance(ctx, 2n);

        // A distinct member (different token name, same member_policy) whose
        // eligibility token lands in a UTxO that also carries a second name
        // under member_policy — the exact shape ordinary change handling
        // produces once a member also holds e.g. a savings-module token
        // minted under the same policy.
        selectWalletFromSeed(lucid, ctx.creator.seedPhrase);
        const member2Unit = MEMBER_POLICY + MEMBER2_NAME;
        const decoyUnit = MEMBER_POLICY + fromText("decoy");
        const mergeTx = yield* Effect.promise(() =>
          lucid
            .newTx()
            .mintAssets({ [member2Unit]: 1n, [decoyUnit]: 1n })
            .attach.MintingPolicy(membershipScript)
            .pay.ToAddress(ctx.creator.address, {
              [member2Unit]: 1n,
              [decoyUnit]: 1n,
            })
            .complete(),
        );
        yield* signAndSubmit(mergeTx);
        yield* advanceBlock(emulator, 2);

        const err = yield* Effect.flip(
          unsignedRegisterVoterTxProgram(lucid, {
            instance,
            voterTokenUnit: member2Unit,
            scriptRefs,
          }),
        );
        expect(String(err)).toContain("exactly one token name");
      }),
  );

  it.effect(
    "splitEligibility separates a merged UTxO so registerVoter succeeds afterward",
    () =>
      Effect.gen(function* () {
        const ctx = yield* makeContext;
        const { lucid, emulator } = ctx;
        const { instance, scriptRefs } = yield* setupInstance(ctx, 2n);

        // Same merged shape as the sibling rejection test: a second member's
        // eligibility token lands in a UTxO that also carries a decoy name
        // under member_policy.
        selectWalletFromSeed(lucid, ctx.creator.seedPhrase);
        const member2Unit = MEMBER_POLICY + MEMBER2_NAME;
        const decoyUnit = MEMBER_POLICY + fromText("decoy");
        const mergeTx = yield* Effect.promise(() =>
          lucid
            .newTx()
            .mintAssets({ [member2Unit]: 1n, [decoyUnit]: 1n })
            .attach.MintingPolicy(membershipScript)
            .pay.ToAddress(ctx.creator.address, {
              [member2Unit]: 1n,
              [decoyUnit]: 1n,
            })
            .complete(),
        );
        yield* signAndSubmit(mergeTx);
        yield* advanceBlock(emulator, 2);

        // Confirms the precondition: registration is blocked before the split.
        const rejected = yield* Effect.flip(
          unsignedRegisterVoterTxProgram(lucid, {
            instance,
            voterTokenUnit: member2Unit,
            scriptRefs,
          }),
        );
        expect(String(rejected)).toContain("exactly one token name");

        // Split the merged tokens apart via the SDK endpoint.
        const splitTx = yield* splitEligibility(lucid, {
          tokenUnits: [member2Unit, decoyUnit],
        }).program();
        yield* signAndSubmit(splitTx);
        yield* advanceBlock(emulator, 2);

        const utxos = yield* Effect.promise(() => lucid.wallet().getUtxos());
        const holder = utxos.find((u) => (u.assets[member2Unit] ?? 0n) > 0n)!;
        expect(
          Object.keys(holder.assets).filter((k) => k.startsWith(MEMBER_POLICY))
            .length,
        ).toBe(1);

        // member2 needs their own account: the eligibility policy is the
        // governed vault's policy here, so registration is fund-bound.
        yield* mintMemberAccount(lucid, TARGET, 1n, MEMBER2_REF_UNIT);
        yield* advanceBlock(emulator, 2);

        // registerVoter, which failed before the split, now succeeds.
        const { tx: voterTx } = yield* unsignedRegisterVoterTxProgram(lucid, {
          instance,
          voterTokenUnit: member2Unit,
          scriptRefs,
        });
        yield* signAndSubmit(voterTx);
        yield* advanceBlock(emulator, 2);

        const { roster } = yield* resolveRoster(lucid, instance);
        expect(roster.members).toContain(MEMBER2_NAME);
      }),
  );

  it.effect(
    "castVote rejects an eligibility UTxO holding two names under member_policy",
    () =>
      Effect.gen(function* () {
        const ctx = yield* makeContext;
        const { lucid, emulator } = ctx;
        const { instance, scriptRefs } = yield* setupInstance(ctx, 2n);

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

        // Merge a second token name under member_policy into the UTxO holding
        // the registered member's eligibility token — again the shape
        // ordinary change handling produces.
        selectWalletFromSeed(lucid, ctx.creator.seedPhrase);
        const decoyUnit = MEMBER_POLICY + fromText("decoy");
        const mergeTx = yield* Effect.promise(() =>
          lucid
            .newTx()
            .mintAssets({ [decoyUnit]: 1n })
            .attach.MintingPolicy(membershipScript)
            .pay.ToAddress(ctx.creator.address, {
              [MEMBER_UNIT]: 1n,
              [decoyUnit]: 1n,
            })
            .complete(),
        );
        yield* signAndSubmit(mergeTx);
        yield* advanceBlock(emulator, 2);

        const err = yield* Effect.flip(
          unsignedCastVoteTxProgram(lucid, {
            instance,
            proposalId,
            approve: true,
            voterTokenUnit: MEMBER_UNIT,
            currentTime: BigInt(emulator.now()),
            scriptRefs,
          }),
        );
        expect(String(err)).toContain("exactly one token name");
      }),
  );
});

describe("governance — CIP-20 transaction message", () => {
  it.effect("openProposal carries the rationale members vote against", () =>
    Effect.gen(function* () {
      const ctx = yield* makeContext;
      const { lucid, emulator } = ctx;
      const { instance, scriptRefs } = yield* setupInstance(ctx, 2n);

      const now = BigInt(emulator.now());
      const rationale =
        "Raise quorum to 3 so no two members can move funds alone.";
      const { tx } = yield* unsignedOpenProposalTxProgram(lucid, {
        instance,
        targetPolicy: TARGET_POLICY,
        targetId: TARGET,
        action: { ParamChange: { field_tag: 0n, new_value: 100n } },
        deadline: now + 7n * 24n * 3600_000n,
        openerTokenUnit: MEMBER_UNIT,
        currentTime: now,
        scriptRefs,
        message: rationale,
      });

      expect(readCip20(tx.toCBOR())).toContain(rationale);
    }),
  );
});

describe("governance — proposal rationale budget", () => {
  it.effect(
    "openProposal accepts a rationale beyond the 1024-byte default",
    () =>
      Effect.gen(function* () {
        const ctx = yield* makeContext;
        const { lucid, emulator } = ctx;
        const { instance, scriptRefs } = yield* setupInstance(ctx, 2n);

        const now = BigInt(emulator.now());
        // 2000 bytes: rejected under the default memo budget, allowed here.
        const rationale = "R".repeat(2000);
        const { tx } = yield* unsignedOpenProposalTxProgram(lucid, {
          instance,
          targetPolicy: TARGET_POLICY,
          targetId: TARGET,
          action: { ParamChange: { field_tag: 0n, new_value: 100n } },
          deadline: now + 7n * 24n * 3600_000n,
          openerTokenUnit: MEMBER_UNIT,
          currentTime: now,
          scriptRefs,
          message: rationale,
        });

        expect(readCip20(tx.toCBOR())).toContain("R".repeat(64));
      }),
  );
});
