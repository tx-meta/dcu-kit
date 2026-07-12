import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import {
  Emulator,
  generateEmulatorAccount,
  Lucid,
  LucidEvolution,
  PROTOCOL_PARAMETERS_DEFAULT,
} from "@lucid-evolution/lucid";
import {
  selectWalletFromSeed,
  signAndSubmit,
} from "../src/core/utils/index.js";
import { unsignedInitGovernanceTxProgram } from "../src/governance/endpoints/initGovernance.js";
import { unsignedRegisterVotingStakeTxProgram } from "../src/governance/endpoints/registerVotingStake.js";
import { unsignedOpenProposalTxProgram } from "../src/governance/endpoints/openProposal.js";
import { resolveAnchor, resolveProposal } from "../src/governance/utils.js";
import { advanceBlock } from "./effects.js";

const TARGET = "bb".repeat(28);

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

describe("governance module (emulator, always-succeeds scaffold)", () => {
  it.effect("initGovernance mints the anchor and publishes the hashes", () =>
    Effect.gen(function* () {
      const ctx = yield* makeContext;
      const { lucid } = ctx;

      selectWalletFromSeed(lucid, ctx.creator.seedPhrase);
      const { tx, instance } = yield* unsignedInitGovernanceTxProgram(lucid, {
        title: "Test Chama Governance",
        memberPolicy: "aa".repeat(28),
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
          memberPolicy: "aa".repeat(28),
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

      // Open a ParamChange proposal on the governed target.
      const { tx: openTx, proposalId } = yield* unsignedOpenProposalTxProgram(
        lucid,
        {
          instance,
          targetId: TARGET,
          action: { ParamChange: { field_tag: 0n, new_value: 100n } },
          deadline: BigInt(Date.now() + 7 * 24 * 3600 * 1000),
        },
      );
      yield* signAndSubmit(openTx);
      yield* advanceBlock(ctx.emulator, 2);

      const { proposal } = yield* resolveProposal(lucid, instance, proposalId);
      expect(proposal.status).toBe("Open");
      expect(proposal.target_id).toBe(TARGET);
      expect(proposal.tally_yes).toBe(0n);
      expect(proposal.quorum).toBe(2n);
    }),
  );
});
