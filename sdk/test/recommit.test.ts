import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { BaseSetup, setupBase, setupGroup } from "./setup.js";
import {
  createAccountTestCase,
  joinGroupTestCase,
  startGroupTestCase,
  distributePayoutTestCase,
  exitGroupTestCase,
} from "./actions.js";
import { advanceBlock } from "./effects.js";
import { extractTokenSuffix } from "./utils.js";
import {
  selectWalletFromSeed,
  signAndSubmit,
} from "../src/core/utils/index.js";
import { assetNameLabels } from "../src/core/utils/index.js";
import { unsignedBeginRecommitTxProgram } from "../src/endpoints/beginRecommit.js";
import { unsignedDistributePayoutTxProgram } from "../src/endpoints/distributePayout.js";
import {
  parseGroupCip68Datum,
  getScriptAddress,
} from "../src/core/utils/index.js";
import { UTxO } from "@lucid-evolution/lucid";

// Recommit lifecycle on the emulator. interval_length = 20_000ms (one block);
// recommit_window = 86_400_000ms (the envelope floor; 4320 emulator blocks — awaitBlock is instant, so the warp is cheap).
// collateral_rounds = 4 covers two full 2-member laps without defaults.

const beginRecommitAction = (context: BaseSetup["context"], groupUtxo: UTxO) =>
  Effect.gen(function* () {
    const { lucid, users } = context;
    selectWalletFromSeed(lucid, users.admin.seedPhrase);
    const groupTokenSuffix = extractTokenSuffix(
      groupUtxo,
      context.protocol!.groupPolicyId,
      assetNameLabels.prefix100,
    );
    const tx = yield* unsignedBeginRecommitTxProgram(context.protocol!, lucid, {
      groupTokenSuffix,
      currentTime: BigInt(context.emulator!.now()),
      scriptRefs: context.scriptRefs,
    });
    const txHash = yield* signAndSubmit(tx);
    yield* advanceBlock(context.emulator);
    return txHash;
  });

const readGroupDatum = (context: BaseSetup["context"]) =>
  Effect.gen(function* () {
    const { lucid } = context;
    const addr = yield* getScriptAddress(
      lucid,
      context.protocol!.groupValidator.spendGroup,
    );
    const utxos = yield* Effect.promise(() => lucid.utxosAt(addr));
    const groupUtxo = utxos.find((u) =>
      Object.keys(u.assets).some(
        (k) =>
          k.startsWith(context.protocol!.groupPolicyId) &&
          k.includes(assetNameLabels.prefix100),
      ),
    );
    if (!groupUtxo) return yield* Effect.die(new Error("group UTxO not found"));
    const parsed = yield* parseGroupCip68Datum(groupUtxo.datum);
    return parsed.groupDatum;
  });

describe("recommit lifecycle (emulator)", () => {
  it.effect(
    "boundary recommit: full lap → window → re-seal → era-2 round runs",
    () =>
      Effect.gen(function* () {
        const base = yield* setupBase();
        const { context, groupUtxo } = yield* setupGroup(base, {
          interval_length: 20_000n,
          collateral_rounds: 4n,
          recommit_window: 86_400_000n, // envelope floor (min_recommit_window)
        });
        const { users } = context;

        const {
          outputs: { userUtxo: u1Account },
        } = yield* createAccountTestCase(context, {
          userSeed: users.user1.seedPhrase,
        });
        const {
          outputs: { userUtxo: u2Account },
        } = yield* createAccountTestCase(context, {
          userSeed: users.user2.seedPhrase,
        });
        yield* joinGroupTestCase(context, {
          groupUtxo,
          accountUtxo: u1Account,
          userSeed: users.user1.seedPhrase,
        });
        yield* joinGroupTestCase(context, {
          groupUtxo,
          accountUtxo: u2Account,
          userSeed: users.user2.seedPhrase,
        });
        yield* startGroupTestCase(context, { groupUtxo });

        // Full era-0 lap: rounds 0 and 1.
        yield* distributePayoutTestCase(context, {
          groupUtxo,
          callerSeed: users.user1.seedPhrase,
        });
        yield* distributePayoutTestCase(context, {
          groupUtxo,
          callerSeed: users.user2.seedPhrase,
        });

        // Clean boundary → the window opens.
        yield* beginRecommitAction(context, groupUtxo);
        const windowDatum = yield* readGroupDatum(context);
        expect(windowDatum.is_started).toBe(false);
        expect(windowDatum.member_slots).toEqual([]);
        expect(windowDatum.last_distributed_round).toBe(1n);

        // Opt-out window elapses (1 day = 4320 blocks past era start); nobody
        // leaves — re-seal.
        yield* advanceBlock(context.emulator, 4321);
        yield* startGroupTestCase(context, { groupUtxo });

        const era2 = yield* readGroupDatum(context);
        expect(era2.is_started).toBe(true);
        expect(era2.era_start_round).toBe(2n);
        expect(era2.num_rounds).toBe(2n);
        expect(era2.member_slots).toEqual([1n, 0n]);

        // Era-2 round 2 runs immediately (time gate re-based at the new start_time).
        const r2 = yield* distributePayoutTestCase(context, {
          groupUtxo,
          callerSeed: users.user1.seedPhrase,
        });
        expect(r2.txHash).toHaveLength(64);

        const after = yield* readGroupDatum(context);
        expect(after.last_distributed_round).toBe(2n);
      }),
  );

  it.effect(
    "D10 halt release: mid-cycle exit halts the rotation, recommit opens, remaining member exits free",
    () =>
      Effect.gen(function* () {
        const base = yield* setupBase();
        const { context, groupUtxo } = yield* setupGroup(base, {
          interval_length: 20_000n,
          collateral_rounds: 4n,
          recommit_window: 86_400_000n, // envelope floor (min_recommit_window)
          penalty_fee: 1_000_000n,
        });
        const { users } = context;

        const {
          outputs: { userUtxo: u1Account },
        } = yield* createAccountTestCase(context, {
          userSeed: users.user1.seedPhrase,
        });
        const {
          outputs: { userUtxo: u2Account },
        } = yield* createAccountTestCase(context, {
          userSeed: users.user2.seedPhrase,
        });
        yield* joinGroupTestCase(context, {
          groupUtxo,
          accountUtxo: u1Account,
          userSeed: users.user1.seedPhrase,
        });
        yield* joinGroupTestCase(context, {
          groupUtxo,
          accountUtxo: u2Account,
          userSeed: users.user2.seedPhrase,
        });
        yield* startGroupTestCase(context, { groupUtxo });

        // Round 0 pays user1 (slot 0).
        yield* distributePayoutTestCase(context, {
          groupUtxo,
          callerSeed: users.user1.seedPhrase,
        });

        // user2 (slot 1, turn not yet reached) penalty-exits mid-cycle → slot 1 vacant.
        yield* exitGroupTestCase(context, {
          groupUtxo,
          accountUtxo: u2Account,
          userSeed: users.user2.seedPhrase,
        });
        const halted = yield* readGroupDatum(context);
        expect(halted.member_slots).toEqual([0n]);

        // Round 1's slot is vacant — the rotation is halted; distribute cannot build.
        selectWalletFromSeed(context.lucid, users.user1.seedPhrase);
        const groupTokenSuffix = extractTokenSuffix(
          groupUtxo,
          context.protocol!.groupPolicyId,
          assetNameLabels.prefix100,
        );
        const blocked = yield* Effect.either(
          unsignedDistributePayoutTxProgram(context.protocol!, context.lucid, {
            groupTokenSuffix,
            currentTime: BigInt(context.emulator!.now()),
            scriptRefs: context.scriptRefs,
          }),
        );
        expect(blocked._tag).toBe("Left");

        // The D10 gate: vacancy + all remaining members clean → the window opens.
        yield* beginRecommitAction(context, groupUtxo);
        const windowDatum = yield* readGroupDatum(context);
        expect(windowDatum.is_started).toBe(false);

        // The remaining member walks away FREE during the window (mid-cycle!).
        const exit = yield* exitGroupTestCase(context, {
          groupUtxo,
          accountUtxo: u1Account,
          userSeed: users.user1.seedPhrase,
        });
        expect(exit.txHash).toHaveLength(64);
        const emptied = yield* readGroupDatum(context);
        expect(emptied.member_count).toBe(0n);
      }),
  );

  it.effect(
    "guards: no recommit mid-cycle without vacancy; no re-seal before the window",
    () =>
      Effect.gen(function* () {
        const base = yield* setupBase();
        const { context, groupUtxo } = yield* setupGroup(base, {
          interval_length: 20_000n,
          collateral_rounds: 4n,
          recommit_window: 86_400_000n, // envelope floor (min_recommit_window)
        });
        const { users } = context;

        const {
          outputs: { userUtxo: u1Account },
        } = yield* createAccountTestCase(context, {
          userSeed: users.user1.seedPhrase,
        });
        const {
          outputs: { userUtxo: u2Account },
        } = yield* createAccountTestCase(context, {
          userSeed: users.user2.seedPhrase,
        });
        yield* joinGroupTestCase(context, {
          groupUtxo,
          accountUtxo: u1Account,
          userSeed: users.user1.seedPhrase,
        });
        yield* joinGroupTestCase(context, {
          groupUtxo,
          accountUtxo: u2Account,
          userSeed: users.user2.seedPhrase,
        });
        yield* startGroupTestCase(context, { groupUtxo });

        // Round 0 done; round 1's slot is HELD — mid-cycle begin must fail on-chain.
        yield* distributePayoutTestCase(context, {
          groupUtxo,
          callerSeed: users.user1.seedPhrase,
        });
        const midCycle = yield* Effect.either(
          beginRecommitAction(context, groupUtxo),
        );
        expect(midCycle._tag).toBe("Left");

        // Complete the lap, open the window legitimately.
        yield* distributePayoutTestCase(context, {
          groupUtxo,
          callerSeed: users.user2.seedPhrase,
        });
        yield* beginRecommitAction(context, groupUtxo);

        // Re-seal before recommit_window (1 day) elapses must fail on-chain.
        const early = yield* Effect.either(
          startGroupTestCase(context, { groupUtxo }),
        );
        expect(early._tag).toBe("Left");

        // After the window it succeeds.
        yield* advanceBlock(context.emulator, 4321);
        const sealed = yield* startGroupTestCase(context, { groupUtxo });
        expect(sealed.txHash).toHaveLength(64);
      }),
  );
});
