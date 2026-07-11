import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import {
  CML,
  credentialToAddress,
  Emulator,
  generateEmulatorAccount,
  generatePrivateKey,
  Lucid,
  LucidEvolution,
  PROTOCOL_PARAMETERS_DEFAULT,
  TxSignBuilder,
} from "@lucid-evolution/lucid";
import {
  selectWalletFromSeed,
  signAndSubmit,
} from "../src/core/utils/index.js";
import {
  unsignedCreateEscrowV2TxProgram,
  CreateEscrowV2Config,
} from "../src/escrow/v2/endpoints/createEscrow.js";
import { unsignedReleaseMilestoneV2TxProgram } from "../src/escrow/v2/endpoints/releaseMilestone.js";
import { unsignedTimeoutReleaseTxProgram } from "../src/escrow/v2/endpoints/timeoutRelease.js";
import { unsignedReclaimEscrowV2TxProgram } from "../src/escrow/v2/endpoints/reclaimEscrow.js";
import { unsignedContributeTxProgram } from "../src/escrow/v2/endpoints/contribute.js";
import { unsignedSubmitEvidenceTxProgram } from "../src/escrow/v2/endpoints/submitEvidence.js";
import { unsignedRotatePartyTxProgram } from "../src/escrow/v2/endpoints/rotateParty.js";
import { unsignedAmendMilestonesTxProgram } from "../src/escrow/v2/endpoints/amendMilestones.js";
import { unsignedRaiseDisputeTxProgram } from "../src/escrow/v2/endpoints/raiseDispute.js";
import { unsignedResolveDisputeTxProgram } from "../src/escrow/v2/endpoints/resolveDispute.js";
import { unsignedCreateProjectTxProgram } from "../src/escrow/v2/endpoints/createProject.js";
import { unsignedUpdateProjectTxProgram } from "../src/escrow/v2/endpoints/updateProject.js";
import { unsignedCloseProjectTxProgram } from "../src/escrow/v2/endpoints/closeProject.js";
import { unsignedCreatePoolTxProgram } from "../src/escrow/v2/endpoints/createPool.js";
import { unsignedDepositToPoolTxProgram } from "../src/escrow/v2/endpoints/depositToPool.js";
import { unsignedExitDepositTxProgram } from "../src/escrow/v2/endpoints/exitDeposit.js";
import { unsignedAllocateToEscrowTxProgram } from "../src/escrow/v2/endpoints/allocateToEscrow.js";
import { getPoolStateProgram } from "../src/escrow/v2/queries/getPoolState.js";
import { escrowV2Validator } from "../src/escrow/v2/validators.js";
import { getPoolDepositsProgram } from "../src/escrow/v2/queries/getPoolDeposits.js";
import { getEscrowStateProgram } from "../src/escrow/v2/queries/getEscrowState.js";
import { getProjectStateProgram } from "../src/escrow/v2/queries/getProjectState.js";
import { getProjectEscrowsProgram } from "../src/escrow/v2/queries/getProjectEscrows.js";
import { advanceBlock } from "./effects.js";

// ---------------------------------------------------------------------------
// Standalone context, as in the v1 escrow suite, plus an arbiter wallet.
// ---------------------------------------------------------------------------

const HOUR = 3_600_000n;

type EscrowV2Context = {
  lucid: LucidEvolution;
  emulator: Emulator;
  funder: { seedPhrase: string; address: string };
  beneficiary: { privateKey: string; address: string };
  verifier: { privateKey: string; address: string };
  arbiter: { privateKey: string; address: string };
};

const rawKeyWallet = () => {
  const privateKey = generatePrivateKey();
  const hash = CML.PrivateKey.from_bech32(privateKey)
    .to_public()
    .hash()
    .to_hex();
  return {
    privateKey,
    address: credentialToAddress("Custom", { type: "Key", hash }),
  };
};

const makeContext = Effect.gen(function* () {
  const funder = generateEmulatorAccount({ lovelace: 2_000_000_000n });
  const beneficiary = rawKeyWallet();
  const verifier = rawKeyWallet();
  const arbiter = rawKeyWallet();
  const emulator = new Emulator([funder], PROTOCOL_PARAMETERS_DEFAULT);
  const lucid = yield* Effect.promise(() => Lucid(emulator, "Custom"));

  selectWalletFromSeed(lucid, funder.seedPhrase);
  const fundTx = yield* Effect.promise(() =>
    lucid
      .newTx()
      .pay.ToAddress(beneficiary.address, { lovelace: 100_000_000n })
      .pay.ToAddress(verifier.address, { lovelace: 100_000_000n })
      .pay.ToAddress(arbiter.address, { lovelace: 100_000_000n })
      .complete(),
  );
  yield* signAndSubmit(fundTx);
  yield* advanceBlock(emulator);

  return { lucid, emulator, funder, beneficiary, verifier, arbiter };
});

/** Default 3-tranche Upfront ADA escrow, hour-scale deadlines, 1h grace. */
const createDefault = (
  ctx: EscrowV2Context,
  overrides?: Partial<CreateEscrowV2Config>,
) =>
  Effect.gen(function* () {
    selectWalletFromSeed(ctx.lucid, ctx.funder.seedPhrase);
    const now = BigInt(ctx.emulator.now());
    const { tx, stateTokenName } = yield* unsignedCreateEscrowV2TxProgram(
      ctx.lucid,
      {
        beneficiaryAddress: ctx.beneficiary.address,
        verifier: ctx.verifier.address,
        milestones: [
          { amount: 40_000_000n, deadline: now + 1n * HOUR },
          { amount: 40_000_000n, deadline: now + 2n * HOUR },
          { amount: 20_000_000n, deadline: now + 3n * HOUR },
        ],
        grace: HOUR,
        fundingMode: "Upfront",
        timeoutPolicy: "RefundToFunder",
        title: "well drilling",
        currentTime: now,
        ...overrides,
      },
    );
    yield* signAndSubmit(tx);
    yield* advanceBlock(ctx.emulator);
    return stateTokenName;
  });

const releaseAsVerifier = (ctx: EscrowV2Context, stateTokenName: string) =>
  Effect.gen(function* () {
    ctx.lucid.selectWallet.fromPrivateKey(ctx.verifier.privateKey);
    const tx = yield* unsignedReleaseMilestoneV2TxProgram(ctx.lucid, {
      stateTokenName,
      currentTime: BigInt(ctx.emulator.now()),
    });
    yield* signAndSubmit(tx);
    yield* advanceBlock(ctx.emulator);
  });

const coSignAndSubmit = (
  ctx: EscrowV2Context,
  tx: TxSignBuilder,
  privateKeys: string[],
) =>
  Effect.gen(function* () {
    const signed = yield* Effect.promise(() =>
      privateKeys
        .reduce((t, pk) => t.sign.withPrivateKey(pk), tx.sign.withWallet())
        .complete(),
    );
    const txHash = yield* Effect.promise(() => signed.submit());
    yield* advanceBlock(ctx.emulator);
    return txHash;
  });

const lovelaceAt = (ctx: EscrowV2Context, address: string) =>
  Effect.promise(() => ctx.lucid.utxosAt(address)).pipe(
    Effect.map((utxos) => utxos.reduce((s, u) => s + u.assets.lovelace, 0n)),
  );

describe("escrow v2 lifecycle (emulator)", () => {
  it.effect("upfront: three releases, buffer back to the funder, burn", () =>
    Effect.gen(function* () {
      const ctx = yield* makeContext;
      const stateTokenName = yield* createDefault(ctx);

      const state = yield* getEscrowStateProgram(ctx.lucid, {
        stateTokenName,
        currentTime: BigInt(ctx.emulator.now()),
      });
      expect(state.totalMilestones).toBe(3);
      expect(state.lockedBalance).toBe(102_000_000n);
      expect(state.nextTrancheFunded).toBe(true);

      yield* releaseAsVerifier(ctx, stateTokenName);
      yield* releaseAsVerifier(ctx, stateTokenName);

      const funderBefore = yield* lovelaceAt(ctx, ctx.funder.address);
      yield* releaseAsVerifier(ctx, stateTokenName);
      const funderAfter = yield* lovelaceAt(ctx, ctx.funder.address);
      expect(funderAfter - funderBefore).toBe(2_000_000n);

      const gone = yield* Effect.either(
        getEscrowStateProgram(ctx.lucid, { stateTokenName }),
      );
      expect(gone._tag).toBe("Left");
    }),
  );

  it.effect(
    "per-milestone: underfunded release fails on-chain, contribute unblocks it",
    () =>
      Effect.gen(function* () {
        const ctx = yield* makeContext;
        const stateTokenName = yield* createDefault(ctx, {
          fundingMode: "PerMilestone",
        });

        const state = yield* getEscrowStateProgram(ctx.lucid, {
          stateTokenName,
          currentTime: BigInt(ctx.emulator.now()),
        });
        // Lucid raises the output to the real min-ADA for a token + datum
        // UTxO; the validator only requires >= the 2 ADA buffer.
        expect(state.lockedBalance >= 2_000_000n).toBe(true);
        expect(state.lockedBalance < 40_000_000n).toBe(true);
        expect(state.nextTrancheFunded).toBe(false);

        // Real UPLC: the validator rejects the underfunded tranche.
        ctx.lucid.selectWallet.fromPrivateKey(ctx.verifier.privateKey);
        const underfunded = yield* Effect.either(
          unsignedReleaseMilestoneV2TxProgram(ctx.lucid, {
            stateTokenName,
            currentTime: BigInt(ctx.emulator.now()),
          }),
        );
        expect(underfunded._tag).toBe("Left");

        selectWalletFromSeed(ctx.lucid, ctx.funder.seedPhrase);
        const topUp = yield* unsignedContributeTxProgram(ctx.lucid, {
          stateTokenName,
          amount: 40_000_000n,
        });
        yield* signAndSubmit(topUp);
        yield* advanceBlock(ctx.emulator);

        yield* releaseAsVerifier(ctx, stateTokenName);
        const after = yield* getEscrowStateProgram(ctx.lucid, {
          stateTokenName,
          currentTime: BigInt(ctx.emulator.now()),
        });
        expect(after.releasedCount).toBe(1);
      }),
  );

  it.effect(
    "timeout policy: silence auto-releases to the beneficiary; reclaim is closed",
    () =>
      Effect.gen(function* () {
        const ctx = yield* makeContext;
        const now = BigInt(ctx.emulator.now());
        const stateTokenName = yield* createDefault(ctx, {
          timeoutPolicy: "ReleaseToBeneficiary",
          milestones: [
            { amount: 40_000_000n, deadline: now + 300_000n },
            { amount: 62_000_000n, deadline: now + 100n * HOUR },
          ],
          grace: 60_000n,
        });

        // Reclaim never works in this mode.
        selectWalletFromSeed(ctx.lucid, ctx.funder.seedPhrase);
        const noReclaim = yield* Effect.either(
          unsignedReclaimEscrowV2TxProgram(ctx.lucid, {
            stateTokenName,
            currentTime: BigInt(ctx.emulator.now()),
          }),
        );
        expect(noReclaim._tag).toBe("Left");

        // Push past deadline[0] + grace (20s per block).
        yield* advanceBlock(ctx.emulator, 20);

        // The beneficiary cranks the overdue tranche — no verifier signature.
        ctx.lucid.selectWallet.fromPrivateKey(ctx.beneficiary.privateKey);
        const beneficiaryBefore = yield* lovelaceAt(
          ctx,
          ctx.beneficiary.address,
        );
        const crank = yield* unsignedTimeoutReleaseTxProgram(ctx.lucid, {
          stateTokenName,
          currentTime: BigInt(ctx.emulator.now()),
        });
        yield* signAndSubmit(crank);
        yield* advanceBlock(ctx.emulator);

        const beneficiaryAfter = yield* lovelaceAt(
          ctx,
          ctx.beneficiary.address,
        );
        expect(beneficiaryAfter > beneficiaryBefore).toBe(true);
        const state = yield* getEscrowStateProgram(ctx.lucid, {
          stateTokenName,
          currentTime: BigInt(ctx.emulator.now()),
        });
        expect(state.releasedCount).toBe(1);
      }),
  );

  it.effect("refund policy: funder reclaims strictly after the cure window", () =>
    Effect.gen(function* () {
      const ctx = yield* makeContext;
      const now = BigInt(ctx.emulator.now());
      const stateTokenName = yield* createDefault(ctx, {
        milestones: [
          { amount: 40_000_000n, deadline: now + 300_000n },
          { amount: 62_000_000n, deadline: now + 100n * HOUR },
        ],
        grace: 60_000n,
      });

      yield* advanceBlock(ctx.emulator, 20);

      selectWalletFromSeed(ctx.lucid, ctx.funder.seedPhrase);
      const tx = yield* unsignedReclaimEscrowV2TxProgram(ctx.lucid, {
        stateTokenName,
        currentTime: BigInt(ctx.emulator.now()),
      });
      yield* signAndSubmit(tx);
      yield* advanceBlock(ctx.emulator);

      const gone = yield* Effect.either(
        getEscrowStateProgram(ctx.lucid, { stateTokenName }),
      );
      expect(gone._tag).toBe("Left");
    }),
  );

  it.effect("evidence: beneficiary anchors and overwrites a deliverable hash", () =>
    Effect.gen(function* () {
      const ctx = yield* makeContext;
      const stateTokenName = yield* createDefault(ctx);

      ctx.lucid.selectWallet.fromPrivateKey(ctx.beneficiary.privateKey);
      const first = yield* unsignedSubmitEvidenceTxProgram(ctx.lucid, {
        stateTokenName,
        milestoneIndex: 0,
        evidenceHash: "11".repeat(32),
      });
      yield* signAndSubmit(first);
      yield* advanceBlock(ctx.emulator);

      const overwrite = yield* unsignedSubmitEvidenceTxProgram(ctx.lucid, {
        stateTokenName,
        milestoneIndex: 0,
        evidenceHash: "22".repeat(32),
      });
      yield* signAndSubmit(overwrite);
      yield* advanceBlock(ctx.emulator);

      const state = yield* getEscrowStateProgram(ctx.lucid, {
        stateTokenName,
        currentTime: BigInt(ctx.emulator.now()),
      });
      expect(state.milestones[0]!.evidence).toBe("22".repeat(32));
    }),
  );

  it.effect(
    "rotation: beneficiary assigns the receivable; the payout follows",
    () =>
      Effect.gen(function* () {
        const ctx = yield* makeContext;
        const stateTokenName = yield* createDefault(ctx);
        const assignee = rawKeyWallet();

        ctx.lucid.selectWallet.fromPrivateKey(ctx.beneficiary.privateKey);
        const rotate = yield* unsignedRotatePartyTxProgram(ctx.lucid, {
          stateTokenName,
          party: "beneficiary",
          newParty: assignee.address,
        });
        yield* signAndSubmit(rotate);
        yield* advanceBlock(ctx.emulator);

        yield* releaseAsVerifier(ctx, stateTokenName);

        const assigneeUtxos = yield* Effect.promise(() =>
          ctx.lucid.utxosAt(assignee.address),
        );
        const received = assigneeUtxos.some(
          (u) => u.assets.lovelace === 40_000_000n,
        );
        expect(received).toBe(true);
      }),
  );

  it.effect("amendment: both parties push a deadline by consent", () =>
    Effect.gen(function* () {
      const ctx = yield* makeContext;
      const now = BigInt(ctx.emulator.now());
      const stateTokenName = yield* createDefault(ctx);

      selectWalletFromSeed(ctx.lucid, ctx.funder.seedPhrase);
      const amended = [
        { amount: 40_000_000n, deadline: now + 2n * HOUR },
        { amount: 40_000_000n, deadline: now + 3n * HOUR },
        { amount: 20_000_000n, deadline: now + 4n * HOUR },
      ];
      const tx = yield* unsignedAmendMilestonesTxProgram(ctx.lucid, {
        stateTokenName,
        milestones: amended,
      });
      yield* coSignAndSubmit(ctx, tx, [ctx.beneficiary.privateKey]);

      const state = yield* getEscrowStateProgram(ctx.lucid, {
        stateTokenName,
        currentTime: BigInt(ctx.emulator.now()),
      });
      expect(state.milestones[0]!.deadline).toBe(now + 2n * HOUR);
    }),
  );

  it.effect(
    "dispute: a raise freezes releases; the arbiter resolves with a split",
    () =>
      Effect.gen(function* () {
        const ctx = yield* makeContext;
        const stateTokenName = yield* createDefault(ctx, {
          arbiter: ctx.arbiter.address,
          disputeWindow: 60_000n,
        });

        selectWalletFromSeed(ctx.lucid, ctx.funder.seedPhrase);
        const raise = yield* unsignedRaiseDisputeTxProgram(ctx.lucid, {
          stateTokenName,
          raisedBy: "funder",
          currentTime: BigInt(ctx.emulator.now()),
        });
        yield* signAndSubmit(raise);
        yield* advanceBlock(ctx.emulator);

        // Frozen: the release endpoint refuses while the dispute is active.
        ctx.lucid.selectWallet.fromPrivateKey(ctx.verifier.privateKey);
        const frozen = yield* Effect.either(
          unsignedReleaseMilestoneV2TxProgram(ctx.lucid, {
            stateTokenName,
            currentTime: BigInt(ctx.emulator.now()),
          }),
        );
        expect(frozen._tag).toBe("Left");

        // The arbiter's terminal split: 62 back to the funder, 40 to the
        // beneficiary (the whole 102 ADA remainder).
        ctx.lucid.selectWallet.fromPrivateKey(ctx.arbiter.privateKey);
        const funderBefore = yield* lovelaceAt(ctx, ctx.funder.address);
        const resolve = yield* unsignedResolveDisputeTxProgram(ctx.lucid, {
          stateTokenName,
          funderAmount: 62_000_000n,
          beneficiaryAmount: 40_000_000n,
        });
        yield* signAndSubmit(resolve);
        yield* advanceBlock(ctx.emulator);

        const funderAfter = yield* lovelaceAt(ctx, ctx.funder.address);
        expect(funderAfter - funderBefore).toBe(62_000_000n);
        const gone = yield* Effect.either(
          getEscrowStateProgram(ctx.lucid, { stateTokenName }),
        );
        expect(gone._tag).toBe("Left");
      }),
  );

  it.effect("split beneficiaries: every tranche pays the fixed shares", () =>
    Effect.gen(function* () {
      const ctx = yield* makeContext;
      const coA = rawKeyWallet();
      const coB = rawKeyWallet();
      // Primary 70% / co A 20% / co B 10% of the 40 ADA first tranche.
      const stateTokenName = yield* createDefault(ctx, {
        coBeneficiaries: [
          { address: coA.address, shareBps: 2_000n },
          { address: coB.address, shareBps: 1_000n },
        ],
      });

      yield* releaseAsVerifier(ctx, stateTokenName);

      const balA = yield* lovelaceAt(ctx, coA.address);
      const balB = yield* lovelaceAt(ctx, coB.address);
      expect(balA).toBe(8_000_000n);
      expect(balB).toBe(4_000_000n);
      const primaryUtxos = yield* Effect.promise(() =>
        ctx.lucid.utxosAt(ctx.beneficiary.address),
      );
      expect(
        primaryUtxos.some((u) => u.assets.lovelace === 28_000_000n),
      ).toBe(true);
    }),
  );

  it.effect(
    "pool vault: deposits, contributor exit, quorum allocation into a new escrow",
    () =>
      Effect.gen(function* () {
        const ctx = yield* makeContext;
        // The arbiter wallet plays the quorum here (a 1-of-1 "committee").
        selectWalletFromSeed(ctx.lucid, ctx.funder.seedPhrase);
        const { tx: poolTx, poolTokenName } =
          yield* unsignedCreatePoolTxProgram(ctx.lucid, {
            title: "angel pool",
            quorum: ctx.arbiter.address,
          });
        yield* signAndSubmit(poolTx);
        yield* advanceBlock(ctx.emulator);

        const pool = yield* getPoolStateProgram(ctx.lucid, { poolTokenName });
        expect(pool.status).toBe("Active");
        expect(pool.quorum.type).toBe("Key");

        // Two contributors commit; one changes their mind and exits.
        const dep1 = yield* unsignedDepositToPoolTxProgram(ctx.lucid, {
          poolTokenName,
          amount: 120_000_000n,
        });
        yield* signAndSubmit(dep1);
        yield* advanceBlock(ctx.emulator);

        ctx.lucid.selectWallet.fromPrivateKey(ctx.verifier.privateKey);
        const dep2 = yield* unsignedDepositToPoolTxProgram(ctx.lucid, {
          poolTokenName,
          amount: 50_000_000n,
        });
        yield* signAndSubmit(dep2);
        yield* advanceBlock(ctx.emulator);

        const before = yield* getPoolDepositsProgram(ctx.lucid, {
          poolTokenName,
        });
        expect(before.length).toBe(2);

        // Deploy the escrow script as a reference script — the allocation tx
        // cannot carry the 11 KB validator inline under the 16 KB ceiling.
        selectWalletFromSeed(ctx.lucid, ctx.funder.seedPhrase);
        const refDeploy = yield* Effect.promise(() =>
          ctx.lucid
            .newTx()
            .pay.ToAddressWithData(
              ctx.funder.address,
              undefined,
              { lovelace: 20_000_000n },
              escrowV2Validator.spendEscrow,
            )
            .complete(),
        );
        yield* signAndSubmit(refDeploy);
        yield* advanceBlock(ctx.emulator);
        const escrowScriptRef = (yield* Effect.promise(() =>
          ctx.lucid.utxosAt(ctx.funder.address),
        )).find((u) => u.scriptRef);
        expect(escrowScriptRef).toBeDefined();

        ctx.lucid.selectWallet.fromPrivateKey(ctx.verifier.privateKey);
        const exit = yield* unsignedExitDepositTxProgram(ctx.lucid, {
          poolTokenName,
          currentTime: BigInt(ctx.emulator.now()),
        });
        yield* signAndSubmit(exit);
        yield* advanceBlock(ctx.emulator);

        const afterExit = yield* getPoolDepositsProgram(ctx.lucid, {
          poolTokenName,
        });
        expect(afterExit.length).toBe(1);
        expect(afterExit[0]!.amount).toBe(120_000_000n);

        // The quorum ratifies an allocation: the deposit seeds a milestone
        // escrow; the 18 ADA remainder continues as the same deposit.
        ctx.lucid.selectWallet.fromPrivateKey(ctx.arbiter.privateKey);
        const now = BigInt(ctx.emulator.now());
        const { tx: allocTx, stateTokenName } =
          yield* unsignedAllocateToEscrowTxProgram(ctx.lucid, {
            poolTokenName,
            currentTime: now,
            escrowScriptRef,
            newEscrow: {
              beneficiaryAddress: ctx.beneficiary.address,
              verifier: ctx.verifier.address,
              milestones: [
                { amount: 40_000_000n, deadline: now + 1n * HOUR },
                { amount: 40_000_000n, deadline: now + 2n * HOUR },
                { amount: 20_000_000n, deadline: now + 3n * HOUR },
              ],
              grace: HOUR,
              fundingMode: "Upfront",
              timeoutPolicy: "RefundToFunder",
              title: "portfolio company A",
              currentTime: now,
            },
          });
        yield* signAndSubmit(allocTx);
        yield* advanceBlock(ctx.emulator);

        const escrow = yield* getEscrowStateProgram(ctx.lucid, {
          stateTokenName,
          currentTime: BigInt(ctx.emulator.now()),
        });
        expect(escrow.lockedBalance).toBe(102_000_000n);
        expect(escrow.title).toBe("portfolio company A");

        const remaining = yield* getPoolDepositsProgram(ctx.lucid, {
          poolTokenName,
        });
        expect(remaining.length).toBe(1);
        expect(remaining[0]!.amount).toBe(18_000_000n);

        // The funded escrow is live: the verifier releases the first tranche.
        yield* releaseAsVerifier(ctx, stateTokenName);
        const after = yield* getEscrowStateProgram(ctx.lucid, {
          stateTokenName,
          currentTime: BigInt(ctx.emulator.now()),
        });
        expect(after.releasedCount).toBe(1);
      }),
  );

  it.effect("project: anchor lifecycle and the cap-table query", () =>
    Effect.gen(function* () {
      const ctx = yield* makeContext;

      selectWalletFromSeed(ctx.lucid, ctx.funder.seedPhrase);
      const { tx: projectTx, projectTokenName } =
        yield* unsignedCreateProjectTxProgram(ctx.lucid, {
          title: "borehole program",
        });
      yield* signAndSubmit(projectTx);
      yield* advanceBlock(ctx.emulator);

      const project = yield* getProjectStateProgram(ctx.lucid, {
        projectTokenName,
      });
      expect(project.status).toBe("Active");
      expect(project.title).toBe("borehole program");

      const escrowA = yield* createDefault(ctx, {
        projectId: projectTokenName,
        title: "site A",
      });
      const escrowB = yield* createDefault(ctx, {
        projectId: projectTokenName,
        title: "site B",
      });
      expect(escrowA).not.toBe(escrowB);

      const rows = yield* getProjectEscrowsProgram(ctx.lucid, {
        projectId: projectTokenName,
      });
      expect(rows.length).toBe(2);
      expect(rows.map((r) => r.title).sort()).toEqual(["site A", "site B"]);

      const update = yield* unsignedUpdateProjectTxProgram(ctx.lucid, {
        projectTokenName,
        status: "Closed",
      });
      yield* signAndSubmit(update);
      yield* advanceBlock(ctx.emulator);
      const closed = yield* getProjectStateProgram(ctx.lucid, {
        projectTokenName,
      });
      expect(closed.status).toBe("Closed");

      const burn = yield* unsignedCloseProjectTxProgram(ctx.lucid, {
        projectTokenName,
      });
      yield* signAndSubmit(burn);
      yield* advanceBlock(ctx.emulator);
      const gone = yield* Effect.either(
        getProjectStateProgram(ctx.lucid, { projectTokenName }),
      );
      expect(gone._tag).toBe("Left");
    }),
  );
});
