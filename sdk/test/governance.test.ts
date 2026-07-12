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
} from "@lucid-evolution/lucid";
import {
  selectWalletFromSeed,
  signAndSubmit,
} from "../src/core/utils/index.js";
import { unsignedInitGovernanceTxProgram } from "../src/governance/endpoints/initGovernance.js";
import { unsignedRegisterVotingStakeTxProgram } from "../src/governance/endpoints/registerVotingStake.js";
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
} from "../src/governance/utils.js";
import { advanceBlock } from "./effects.js";

const TARGET = "bb".repeat(28);

// A permissionless "membership" policy: eligibility = holding a token of it.
// Stands in for the savings user-token policy in cross-module production use.
const membershipScript = scriptFromNative({ type: "all", scripts: [] });
const MEMBER_POLICY = mintingPolicyToId(membershipScript);
const MEMBER_UNIT = MEMBER_POLICY + fromText("member");

// The governed vault's state token: the gate binds a decision to the input that
// carries a token NAMED target_id. Stands in for a savings fund anchor.
const TARGET_UNIT = MEMBER_POLICY + TARGET;

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

describe("governance module (emulator, real validators)", () => {
  it.effect("initGovernance mints the anchor and publishes the hashes", () =>
    Effect.gen(function* () {
      const ctx = yield* makeContext;
      const { lucid } = ctx;

      selectWalletFromSeed(lucid, ctx.creator.seedPhrase);
      const { tx, instance } = yield* unsignedInitGovernanceTxProgram(lucid, {
        title: "Test Chama Governance",
        memberPolicy: MEMBER_POLICY,
        governedTargets: [TARGET],
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
      expect(anchor.governed_targets).toEqual([TARGET]);
    }),
  );

  it.effect("register stake → open proposal → proposal is Open", () =>
    Effect.gen(function* () {
      const ctx = yield* makeContext;
      const { lucid } = ctx;
      selectWalletFromSeed(lucid, ctx.creator.seedPhrase);

      const { tx: initTx, instance } = yield* unsignedInitGovernanceTxProgram(
        lucid,
        {
          title: "Chama",
          memberPolicy: MEMBER_POLICY,
          governedTargets: [TARGET],
          quorum: 2n,
          threshold: 5000n,
        },
      );
      yield* signAndSubmit(initTx);
      yield* advanceBlock(ctx.emulator, 2);

      // One-time: register the voting stake credential (withdraw-zero trigger).
      const regTx = yield* unsignedRegisterVotingStakeTxProgram(
        lucid,
        instance,
      );
      yield* signAndSubmit(regTx);
      yield* advanceBlock(ctx.emulator, 2);

      // The opener needs a membership token (eligibility).
      yield* mintMembership(lucid);
      yield* advanceBlock(ctx.emulator, 2);

      // Open a ParamChange proposal on the governed target.
      const { tx: openTx, proposalId } = yield* unsignedOpenProposalTxProgram(
        lucid,
        {
          instance,
          targetId: TARGET,
          action: { ParamChange: { field_tag: 0n, new_value: 100n } },
          deadline: BigInt(Date.now() + 7 * 24 * 3600 * 1000),
          openerTokenUnit: MEMBER_UNIT,
        },
      );
      yield* signAndSubmit(openTx);
      yield* advanceBlock(ctx.emulator, 2);

      const { proposal } = yield* resolveProposal(lucid, instance, proposalId);
      expect(proposal.status).toBe("Open");
      expect(proposal.target_id).toBe(TARGET);
      expect(proposal.tally_yes).toBe(0n);
      expect(proposal.quorum).toBe(2n);

      // Cast one approving vote — tally and turnout advance by one.
      const { tx: voteTx } = yield* unsignedCastVoteTxProgram(lucid, {
        instance,
        proposalId,
        approve: true,
        voterTokenUnit: MEMBER_UNIT,
      });
      yield* signAndSubmit(voteTx);
      yield* advanceBlock(ctx.emulator, 2);

      const { proposal: voted } = yield* resolveProposal(
        lucid,
        instance,
        proposalId,
      );
      expect(voted.tally_yes).toBe(1n);
      expect(voted.tally_no).toBe(0n);
      expect(voted.votes_cast).toBe(1n);
      expect(voted.status).toBe("Open");
    }),
  );

  it.effect(
    "full core loop: open → vote → finalize (Passed) → execute → decision at gate",
    () =>
      Effect.gen(function* () {
        const ctx = yield* makeContext;
        const { lucid } = ctx;
        selectWalletFromSeed(lucid, ctx.creator.seedPhrase);

        // quorum 1 so a single vote passes.
        const { tx: initTx, instance } = yield* unsignedInitGovernanceTxProgram(
          lucid,
          {
            title: "Chama",
            memberPolicy: MEMBER_POLICY,
            governedTargets: [TARGET],
            quorum: 1n,
            threshold: 5000n,
          },
        );
        yield* signAndSubmit(initTx);
        yield* advanceBlock(ctx.emulator, 2);

        const regTx = yield* unsignedRegisterVotingStakeTxProgram(
          lucid,
          instance,
        );
        yield* signAndSubmit(regTx);
        yield* advanceBlock(ctx.emulator, 2);

        yield* mintMembership(lucid);
        yield* advanceBlock(ctx.emulator, 2);

        const { tx: openTx, proposalId } = yield* unsignedOpenProposalTxProgram(
          lucid,
          {
            instance,
            targetId: TARGET,
            action: {
              SocialPayout: { recipient: "cc".repeat(28), amount: 5_000_000n },
            },
            deadline: BigInt(Date.now() + 3600_000),
            openerTokenUnit: MEMBER_UNIT,
          },
        );
        yield* signAndSubmit(openTx);
        yield* advanceBlock(ctx.emulator, 2);

        const { tx: voteTx } = yield* unsignedCastVoteTxProgram(lucid, {
          instance,
          proposalId,
          approve: true,
          voterTokenUnit: MEMBER_UNIT,
        });
        yield* signAndSubmit(voteTx);
        yield* advanceBlock(ctx.emulator, 2);

        const { tx: finalizeTx, passed } =
          yield* unsignedFinalizeProposalTxProgram(lucid, {
            instance,
            proposalId,
          });
        expect(passed).toBe(true);
        yield* signAndSubmit(finalizeTx);
        yield* advanceBlock(ctx.emulator, 2);

        const { proposal: finalized } = yield* resolveProposal(
          lucid,
          instance,
          proposalId,
        );
        expect(finalized.status).toBe("Passed");

        const { tx: execTx, decisionName } =
          yield* unsignedExecuteDecisionTxProgram(lucid, {
            instance,
            proposalId,
          });
        yield* signAndSubmit(execTx);
        yield* advanceBlock(ctx.emulator, 2);

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
        yield* advanceBlock(ctx.emulator, 2);
        const targetUtxo = yield* findTargetUtxo(lucid);
        const authTx = yield* unsignedAuthorizeActionTxProgram(lucid, {
          instance,
          proposalId,
          targetUtxo,
        });
        yield* signAndSubmit(authTx);
        yield* advanceBlock(ctx.emulator, 2);

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
        const { lucid } = ctx;
        selectWalletFromSeed(lucid, ctx.creator.seedPhrase);

        const { tx: initTx, instance } = yield* unsignedInitGovernanceTxProgram(
          lucid,
          {
            title: "Chama",
            memberPolicy: MEMBER_POLICY,
            governedTargets: [TARGET],
            quorum: 2n,
            threshold: 5000n,
          },
        );
        yield* signAndSubmit(initTx);
        yield* advanceBlock(ctx.emulator, 2);

        // Amend the charter: raise the default quorum, keep hashes immutable.
        const upTx = yield* unsignedUpdateCharterTxProgram(lucid, {
          instance,
          quorum: 5n,
        });
        yield* signAndSubmit(upTx);
        yield* advanceBlock(ctx.emulator, 2);
        const { anchor } = yield* resolveAnchor(lucid, instance);
        expect(anchor.default_quorum).toBe(5n);
        expect(anchor.gate_hash).toBe(instance.gateHash);

        // Open then expire a proposal — the Proposal State NFT is burned.
        const regTx = yield* unsignedRegisterVotingStakeTxProgram(
          lucid,
          instance,
        );
        yield* signAndSubmit(regTx);
        yield* advanceBlock(ctx.emulator, 2);
        yield* mintMembership(lucid);
        yield* advanceBlock(ctx.emulator, 2);
        const { tx: openTx, proposalId } = yield* unsignedOpenProposalTxProgram(
          lucid,
          {
            instance,
            targetId: TARGET,
            action: { ParamChange: { field_tag: 0n, new_value: 1n } },
            deadline: BigInt(Date.now() + 1000),
            openerTokenUnit: MEMBER_UNIT,
          },
        );
        yield* signAndSubmit(openTx);
        yield* advanceBlock(ctx.emulator, 2);

        const expTx = yield* unsignedExpireProposalTxProgram(lucid, {
          instance,
          proposalId,
        });
        yield* signAndSubmit(expTx);
        yield* advanceBlock(ctx.emulator, 2);

        const remaining = yield* getProposalsProgram(lucid, instance);
        expect(remaining.length).toBe(0);
      }),
  );
});
