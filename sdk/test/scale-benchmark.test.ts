import { Effect } from "effect";
import { it } from "@effect/vitest";
import { describe } from "vitest";
import { makeEmulatorContextWithMembers } from "./context.js";
import {
  createAccountTestCase,
  createGroupTestCase,
  joinGroupTestCase,
  startGroupTestCase,
} from "./actions.js";
import { unsignedDistributePayoutTxProgram } from "../src/endpoints/distributePayout.js";
import { extractTokenSuffix } from "./utils.js";
import { assetNameLabels } from "../src/core/utils/assets.js";
import { selectWalletFromSeed } from "../src/core/utils/wallet.js";
import { resolveUtxoByUnit } from "../src/core/utils/resolve.js";

// ─── Scale benchmark: full distribute-round structure vs member count ─────────
//
// Builds a real N-member group on the Lucid emulator (Join × N → StartGroup →
// DistributeRound) and reports, per N:
//   - scriptExecs: redeemer count = N treasury spends + 1 group spend = N+1. This
//     empirically confirms the per-tx cost MULTIPLIER: the treasury validator runs
//     once per member, so per-tx cost ≈ (N+1) × per-execution cost.
//   - sizeBytes: INLINE tx size (the emulator inlines the ~15 KB validator;
//     production uses reference scripts, so treat this as an upper bound only).
//
// EX-UNITS are NOT measured here: the Lucid emulator's evaluateTx is a no-op for
// ex-units, and local UPLC eval fails on distribute's settings .readFrom input
// (hence localUPLCEval:false in the endpoint). Per-execution ex-units come from the
// Aiken benchmark (lib/tests/treasury.ak, bench_count_active_*); the exact full-tx
// figure comes from a real Preprod submit (roadmap Task 10).
//
// Run explicitly: `BENCH=1 NETWORK=Emulator pnpm exec vitest run test/scale-benchmark.test.ts`
// Skipped in the normal suite.

const MEMBER_COUNTS = [2, 10, 20, 40, 60, 80, 100];

// Sum ex-units from the built tx's redeemers (CML), mirroring Lucid's own
// makeTxSignBuilder. With local UPLC eval enabled (BENCH_LOCAL_EVAL=1) the redeemers
// carry the real per-script mem/cpu the node would charge.
type CmlRedeemer = {
  ex_units: () => { mem: () => bigint; steps: () => bigint };
};
const sumTxExUnits = (txb: {
  toTransaction: () => {
    witness_set: () => {
      redeemers: () => {
        as_arr_legacy_redeemer?: () => {
          len: () => number;
          get: (i: number) => CmlRedeemer;
        } | null;
        as_map_redeemer_key_to_redeemer_val?: () => {
          keys: () => { len: () => number; get: (i: number) => unknown };
          get: (k: unknown) => CmlRedeemer;
        } | null;
      } | null;
    };
  };
}): { mem: number; cpu: number; count: number } => {
  let mem = 0;
  let cpu = 0;
  let count = 0;
  const reds = txb.toTransaction().witness_set().redeemers();
  if (reds) {
    const arr = reds.as_arr_legacy_redeemer?.();
    if (arr) {
      for (let i = 0; i < arr.len(); i++) {
        const r = arr.get(i);
        mem += Number(r.ex_units().mem().toString());
        cpu += Number(r.ex_units().steps().toString());
        count++;
      }
    }
    const map = reds.as_map_redeemer_key_to_redeemer_val?.();
    if (map) {
      const keys = map.keys();
      for (let i = 0; i < keys.len(); i++) {
        const v = map.get(keys.get(i));
        mem += Number(v.ex_units().mem().toString());
        cpu += Number(v.ex_units().steps().toString());
        count++;
      }
    }
  }
  return { mem, cpu, count };
};

const benchOne = (n: number) =>
  Effect.gen(function* () {
    const context = yield* makeEmulatorContextWithMembers(n);
    const { lucid, protocol, memberSeeds } = context;

    // Group sized for n members, one round of collateral (PerRound default).
    const { groupTokenSuffix } = yield* createGroupTestCase(context, {
      datumOverride: { max_members: BigInt(n), collateral_rounds: 1n },
    });
    const groupRefUnit =
      protocol!.groupPolicyId + assetNameLabels.prefix100 + groupTokenSuffix;
    const groupUtxo = yield* resolveUtxoByUnit(lucid, groupRefUnit);

    // Each member: create a CIP-68 account, then join.
    for (const userSeed of memberSeeds) {
      const {
        outputs: { userUtxo },
      } = yield* createAccountTestCase(context, { userSeed });
      yield* joinGroupTestCase(context, {
        groupUtxo,
        accountUtxo: userUtxo,
        userSeed,
      });
    }

    yield* startGroupTestCase(context, { groupUtxo });

    // Build the distribute round, then evaluate it against the emulator to get the
    // real per-tx ex-units (the built tx carries zeros under localUPLCEval:false).
    selectWalletFromSeed(lucid, context.users.admin.seedPhrase);
    const distributeTx = yield* unsignedDistributePayoutTxProgram(
      protocol!,
      lucid,
      { groupTokenSuffix },
    );
    const size = distributeTx.toCBOR().length / 2;
    const { count } = sumTxExUnits(distributeTx as never);
    return { size, scriptExecs: count };
  });

const runEnabled = process.env.BENCH === "1";

describe("Scale benchmark — distribute ex-units vs members", () => {
  (runEnabled ? it.effect : it.effect.skip)(
    "measures distribute structure (script execs + size) vs member count",
    () =>
      Effect.gen(function* () {
        const rows: Array<Record<string, string | number>> = [];
        for (const n of MEMBER_COUNTS) {
          const result = yield* Effect.either(benchOne(n));
          if (result._tag === "Left") {
            rows.push({ members: n, status: `build failed: ${result.left}` });
            continue;
          }
          const { size, scriptExecs } = result.right;
          rows.push({
            members: n,
            scriptExecs,
            inlineSizeBytes: size,
            status: "built ok",
          });
        }
        // eslint-disable-next-line no-console
        console.table(rows);
      }),
    { timeout: 600_000 },
  );
});
