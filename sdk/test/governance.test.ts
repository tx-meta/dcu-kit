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
import { resolveAnchor } from "../src/governance/utils.js";
import { advanceBlock } from "./effects.js";

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
        governedTargets: ["bb".repeat(28)],
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
      expect(anchor.governed_targets).toEqual(["bb".repeat(28)]);
    }),
  );
});
