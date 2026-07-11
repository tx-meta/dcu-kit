import { LucidEvolution, toText } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { DcuError } from "../../../core/errors.js";
import { makeReturn } from "../../../core/utils/index.js";
import { fromOnchainAddress } from "../types.js";
import {
  cureBoundary,
  disputeFrozen,
  escrowV2AssetUnit,
  resolveEscrowV2,
} from "../utils.js";

/**
 * Reads a live v2 escrow's full state: per-milestone schedule with evidence,
 * funding status, timeout policy, dispute state, and the current action
 * window. Read-only — resolves the state token's current UTxO.
 *
 * @param lucid - Lucid instance (no wallet needed).
 * @param config - GetEscrowV2StateConfig.
 * @returns Effect yielding EscrowV2State.
 */
export type GetEscrowV2StateConfig = {
  /** The escrow's permanent identity (returned by createEscrow). */
  stateTokenName: string;
  /** Clock override (POSIX ms) — pass `emulator.now()` in emulator tests. */
  currentTime?: bigint;
};

export type EscrowV2State = {
  title: string;
  funderAddress: string;
  beneficiaryAddress: string;
  fundingMode: "Upfront" | "PerMilestone";
  timeoutPolicy: "RefundToFunder" | "ReleaseToBeneficiary";
  hasArbiter: boolean;
  milestones: {
    amount: bigint;
    deadline: bigint;
    evidence: string | null;
    released: boolean;
  }[];
  releasedCount: number;
  totalMilestones: number;
  nextTranche: bigint | null;
  /** Escrow-asset balance currently locked (excludes the state token). */
  lockedBalance: bigint;
  /** Remaining unreleased milestone total. */
  remainingTotal: bigint;
  /** True when the locked balance covers the next tranche. */
  nextTrancheFunded: boolean;
  /** deadline + grace (+ dispute extension) of the current milestone. */
  cureBoundary: bigint;
  /** Whether the cure window has passed (timeout side is open). */
  overdue: boolean;
  /** Active dispute freeze, if any. */
  disputeFrozenUntil: bigint | null;
  contentHash: string | null;
  projectId: string | null;
};

export const getEscrowStateProgram = (
  lucid: LucidEvolution,
  config: GetEscrowV2StateConfig,
): Effect.Effect<EscrowV2State, DcuError, never> =>
  Effect.gen(function* () {
    const { utxo, datum } = yield* resolveEscrowV2(
      lucid,
      config.stateTokenName,
    );
    const network = lucid.config().network ?? "Preprod";
    const funderAddress = yield* fromOnchainAddress(network, datum.funder);
    const beneficiaryAddress = yield* fromOnchainAddress(
      network,
      datum.beneficiary,
    );
    const now = config.currentTime ?? BigInt(Date.now());
    const assetUnit = escrowV2AssetUnit(datum);
    const releasedCount = Number(datum.released_count);
    const lockedBalance = utxo.assets[assetUnit] ?? 0n;
    const remainingTotal = datum.milestones
      .slice(releasedCount)
      .reduce((a, m) => a + m.amount, 0n);
    const next = datum.milestones[releasedCount];
    const cure = cureBoundary(datum);

    return {
      title: toText(datum.title),
      funderAddress,
      beneficiaryAddress,
      fundingMode: datum.funding_mode,
      timeoutPolicy: datum.timeout_policy,
      hasArbiter: datum.arbiter !== null,
      milestones: datum.milestones.map((m, i) => ({
        amount: m.amount,
        deadline: m.deadline,
        evidence: datum.evidence[i] ?? null,
        released: i < releasedCount,
      })),
      releasedCount,
      totalMilestones: datum.milestones.length,
      nextTranche: next?.amount ?? null,
      lockedBalance,
      remainingTotal,
      nextTrancheFunded: next !== undefined && lockedBalance >= next.amount,
      cureBoundary: cure,
      overdue: next !== undefined && now > cure,
      disputeFrozenUntil: disputeFrozen(datum, now)
        ? datum.dispute!.until
        : null,
      contentHash: datum.content_hash,
      projectId: datum.project_id,
    };
  });

export const getEscrowState = (
  lucid: LucidEvolution,
  config: GetEscrowV2StateConfig,
) => makeReturn(getEscrowStateProgram(lucid, config));
