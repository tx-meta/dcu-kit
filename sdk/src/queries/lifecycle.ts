import type { LucidEvolution } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import type { GroupDatum, TreasuryDatum } from "../core/types.js";
import { TreasuryDatumSchema } from "../core/types.js";
import type { Protocol } from "../core/validators/constants.js";
import type { DcuError } from "../core/errors.js";
import { InvalidDatumError } from "../core/errors.js";
import {
  assetNameLabels,
  makeReturn,
  parseSafeDatum,
  patchInlineDatum,
  reserveTokenName,
  resolveUtxoByUnit,
} from "../core/utils/index.js";
import { getGroupProgram } from "./discovery.js";
import { blockfrostTipSlot, type BlockfrostConfig } from "./blockfrost.js";

export type EligibilityReason =
  | "GROUP_INACTIVE"
  | "GROUP_ALREADY_STARTED"
  | "GROUP_NOT_STARTED"
  | "INSUFFICIENT_MEMBERS"
  | "NO_ACTIVE_MEMBERS"
  | "NO_ROUND_SCHEDULE"
  | "ROUND_NOT_OPEN"
  | "NEXT_SLOT_VACANT"
  | "ROTATION_CAN_CONTINUE"
  | "MEMBERS_NOT_CLEAN"
  | "COVER_PENDING"
  | "RECOMMIT_WINDOW_OPEN"
  | "GROUP_STILL_ACTIVE"
  | "MEMBERS_REMAIN";

export type EligibilityVerdict = {
  eligible: boolean;
  reasons: EligibilityReason[];
};

export type GroupLifecycleEligibility = {
  distribute: EligibilityVerdict;
  beginRecommit: EligibilityVerdict;
  startGroup: EligibilityVerdict;
  deleteGroup: EligibilityVerdict;
  nextRound: bigint;
  nextSlot: bigint | null;
  roundOpensAt: bigint | null;
  slotVacant: boolean | null;
  atBoundary: boolean | null;
  standinRounds: bigint;
  /** Chain state on which this verdict was calculated. */
  observedOutRefs: { group: string | null; reserve: string | null };
  /** Null unless an authoritative tip provider was supplied. */
  observedSlot: bigint | null;
};

const verdict = (reasons: EligibilityReason[]): EligibilityVerdict => ({
  eligible: reasons.length === 0,
  reasons,
});

/**
 * Mirrors the protocol-state gates for group-level lifecycle actions. Signer,
 * wallet-balance and reference-script availability are deliberately separate:
 * this verdict answers whether the authenticated state itself is eligible.
 */
export const evaluateGroupLifecycle = (
  group: GroupDatum,
  standinRounds: bigint,
  now: bigint,
  observation: {
    groupOutRef?: string;
    reserveOutRef?: string;
    slot?: bigint;
  } = {},
): GroupLifecycleEligibility => {
  const nextRound = group.last_distributed_round + 1n;
  const hasSchedule = group.num_rounds > 0n;
  const eraRound = nextRound - group.era_start_round;
  const nextSlot = hasSchedule ? eraRound % group.num_rounds : null;
  const atBoundary = hasSchedule ? nextSlot === 0n : null;
  const slotVacant =
    nextSlot === null
      ? null
      : !group.member_slots.some((slot) => slot === nextSlot);
  const roundOpensAt = hasSchedule
    ? group.start_time + eraRound * group.interval_length
    : null;

  const distributeReasons: EligibilityReason[] = [];
  if (!group.is_active) distributeReasons.push("GROUP_INACTIVE");
  if (!group.is_started) distributeReasons.push("GROUP_NOT_STARTED");
  if (!hasSchedule) distributeReasons.push("NO_ROUND_SCHEDULE");
  if (group.active_member_count <= 0n)
    distributeReasons.push("NO_ACTIVE_MEMBERS");
  if (slotVacant === true) distributeReasons.push("NEXT_SLOT_VACANT");
  if (roundOpensAt !== null && now < roundOpensAt)
    distributeReasons.push("ROUND_NOT_OPEN");

  const recommitReasons: EligibilityReason[] = [];
  if (!group.is_active) recommitReasons.push("GROUP_INACTIVE");
  if (!group.is_started) recommitReasons.push("GROUP_NOT_STARTED");
  if (group.active_member_count !== group.member_count)
    recommitReasons.push("MEMBERS_NOT_CLEAN");
  if (atBoundary !== true && slotVacant !== true)
    recommitReasons.push("ROTATION_CAN_CONTINUE");
  if (standinRounds > 0n && slotVacant !== true)
    recommitReasons.push("COVER_PENDING");

  const startReasons: EligibilityReason[] = [];
  if (group.is_started) startReasons.push("GROUP_ALREADY_STARTED");
  if (group.member_count < 2n) startReasons.push("INSUFFICIENT_MEMBERS");
  if (
    group.last_distributed_round >= 0n &&
    now < group.start_time + group.recommit_window
  ) {
    startReasons.push("RECOMMIT_WINDOW_OPEN");
  }

  const deleteReasons: EligibilityReason[] = [];
  if (group.is_active) deleteReasons.push("GROUP_STILL_ACTIVE");
  if (group.member_count !== 0n) deleteReasons.push("MEMBERS_REMAIN");

  return {
    distribute: verdict(distributeReasons),
    beginRecommit: verdict(recommitReasons),
    startGroup: verdict(startReasons),
    deleteGroup: verdict(deleteReasons),
    nextRound,
    nextSlot,
    roundOpensAt,
    slotVacant,
    atBoundary,
    standinRounds,
    observedOutRefs: {
      group: observation.groupOutRef ?? null,
      reserve: observation.reserveOutRef ?? null,
    },
    observedSlot: observation.slot ?? null,
  };
};

export const getGroupEligibilityProgram = (
  protocol: Protocol,
  lucid: LucidEvolution,
  tokenSuffix: string,
  currentTime: bigint = BigInt(Date.now()),
  blockfrost?: BlockfrostConfig,
): Effect.Effect<GroupLifecycleEligibility, DcuError> =>
  Effect.gen(function* () {
    const group = yield* getGroupProgram(protocol, lucid, tokenSuffix);
    const groupRefName = assetNameLabels.prefix100 + tokenSuffix;
    const reserveUnit =
      protocol.treasuryPolicyId + reserveTokenName(groupRefName);
    const reserveRaw = yield* resolveUtxoByUnit(lucid, reserveUnit);
    const reserveUtxo = patchInlineDatum(reserveRaw);
    const decoded = (yield* parseSafeDatum(
      reserveUtxo.datum,
      TreasuryDatumSchema,
    )) as unknown as TreasuryDatum;
    if (!("ReserveState" in decoded)) {
      return yield* Effect.fail(
        new InvalidDatumError({
          field: "reserveDatum",
          reason: "Expected ReserveState on the reserve UTxO",
        }),
      );
    }
    const slot = blockfrost ? yield* blockfrostTipSlot(blockfrost) : null;
    return evaluateGroupLifecycle(
      group.datum,
      decoded.ReserveState.standin_rounds,
      currentTime,
      {
        groupOutRef: group.outRef,
        reserveOutRef: `${reserveUtxo.txHash}#${reserveUtxo.outputIndex}`,
        slot: slot ?? undefined,
      },
    );
  });

export const getGroupEligibility = (
  protocol: Protocol,
  lucid: LucidEvolution,
  tokenSuffix: string,
  currentTime?: bigint,
  blockfrost?: BlockfrostConfig,
) =>
  makeReturn(
    getGroupEligibilityProgram(
      protocol,
      lucid,
      tokenSuffix,
      currentTime,
      blockfrost,
    ),
  );
