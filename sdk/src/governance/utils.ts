import {
  Constr,
  Data,
  fromText,
  LucidEvolution,
  Network,
  UTxO,
  validatorToAddress,
  validatorToRewardAddress,
} from "@lucid-evolution/lucid";
import { blake2b } from "@noble/hashes/blake2";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { Effect } from "effect";
import {
  ConfigurationError,
  LucidError,
  UtxoNotFoundError,
} from "../core/errors.js";
import { parseSafeDatum, resolveUtxoByUnit } from "../core/utils/index.js";
import { patchInlineDatum } from "../core/utils/index.js";
import {
  GovernanceAnchorFields,
  GovernanceDatum,
  GovernanceDatumSchema,
  ProposalFields,
  RosterFields,
  VoterRecordFields,
} from "./types.js";
import { GovernanceInstance } from "./validators.js";

/** Lovelace buffer locked in each governance UTxO (shared protocol convention). */
export const MIN_ADA_BUFFER = 2_000_000n;

/**
 * Reference-script UTxOs for this instance's two large validators. The
 * dispatcher (~7.5KB) and voting (~10KB) scripts no longer fit inline together
 * within the 16,384-byte tx limit, so every voting-coupled endpoint accepts
 * refs and falls back to inline attach only when they are omitted (which fits
 * only for single-script transactions). One dispatcher ref serves both its
 * mint and spend purposes (same hash). Deploy per instance after init.
 */
export type GovScriptRefs = {
  dispatcher?: UTxO;
  voting?: UTxO;
};

/** The dispatcher script address (anchor + proposal UTxOs) for a network. */
export const dispatcherAddress = (
  network: Network,
  instance: GovernanceInstance,
): string => validatorToAddress(network, instance.dispatcherValidator.spend);

/** The gate script address (decision UTxOs) for a network. */
export const gateAddress = (
  network: Network,
  instance: GovernanceInstance,
): string => validatorToAddress(network, instance.gateValidator);

/** The voting validator's reward address — the withdraw-zero trigger. */
export const votingRewardAddress = (
  network: Network,
  instance: GovernanceInstance,
): string => validatorToRewardAddress(network, instance.votingValidator);

/**
 * The Proposal State NFT name from its seed UTxO — full 32-byte blake2b_256 of
 * the CBOR-serialised OutputReference (matches the on-chain algorithm). This
 * value is the proposal_id.
 */
export const proposalStateTokenName = (seed: UTxO): Effect.Effect<string> =>
  Effect.sync(() => {
    const outputRefCbor = Data.to(
      new Constr(0, [seed.txHash, BigInt(seed.outputIndex)]),
    );
    return bytesToHex(blake2b(hexToBytes(outputRefCbor), { dkLen: 32 }));
  });

/**
 * The Voter Record token name: blake2b_256("voter" ++ member_id). Derived from
 * the member's eligibility-token name, so one member maps to exactly one record
 * name (matches the on-chain voter_record_name).
 */
export const voterRecordTokenName = (memberId: string): string =>
  bytesToHex(blake2b(hexToBytes(fromText("voter") + memberId), { dkLen: 32 }));

/**
 * The Decision token name: blake2b_256(proposal_id ++ "decision"). Distinct
 * from the Proposal State NFT (which is govPolicy + proposal_id) so the two
 * never collide into the same unit under the dispatcher policy.
 */
export const decisionTokenName = (proposalId: string): string =>
  bytesToHex(
    blake2b(hexToBytes(proposalId + fromText("decision")), { dkLen: 32 }),
  );

/**
 * The SORTED position of `target` among a transaction's reference inputs — the
 * ledger presents reference inputs to scripts as a set sorted by
 * (txHash, outputIndex). Never hardcode a reference-input index.
 */
export const sortedRefIndexOf = (target: UTxO, refs: UTxO[]): bigint => {
  const key = (u: UTxO) =>
    `${u.txHash}#${u.outputIndex.toString().padStart(8, "0")}`;
  const sorted = [...refs].sort((a, b) => (key(a) < key(b) ? -1 : 1));
  return BigInt(sorted.findIndex((u) => key(u) === key(target)));
};

/** Resolves the instance's anchor UTxO and parses its charter datum. */
export const resolveAnchor = (
  lucid: LucidEvolution,
  instance: GovernanceInstance,
): Effect.Effect<
  { utxo: UTxO; anchor: GovernanceAnchorFields },
  UtxoNotFoundError | LucidError | ConfigurationError,
  never
> =>
  Effect.gen(function* () {
    const utxoRaw = yield* resolveUtxoByUnit(lucid, instance.anchorUnit);
    const utxo = patchInlineDatum(utxoRaw);
    const datum = (yield* parseSafeDatum(
      utxo.datum,
      GovernanceDatumSchema,
    ).pipe(
      Effect.mapError(
        (e) =>
          new ConfigurationError({
            configKey: "anchorUnit",
            message: `anchor UTxO has no valid governance datum: ${String(e)}`,
          }),
      ),
    )) as unknown as GovernanceDatum;
    if (typeof datum === "string" || !("GovernanceAnchor" in datum)) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "anchorUnit",
          message: "the resolved UTxO is not a governance anchor",
        }),
      );
    }
    return { utxo, anchor: datum.GovernanceAnchor };
  });

/** Resolves the instance's roster UTxO (ever-registered member set). */
export const resolveRoster = (
  lucid: LucidEvolution,
  instance: GovernanceInstance,
): Effect.Effect<
  { utxo: UTxO; roster: RosterFields },
  UtxoNotFoundError | LucidError | ConfigurationError,
  never
> =>
  Effect.gen(function* () {
    const utxoRaw = yield* resolveUtxoByUnit(lucid, instance.rosterUnit);
    const utxo = patchInlineDatum(utxoRaw);
    const datum = (yield* parseSafeDatum(
      utxo.datum,
      GovernanceDatumSchema,
    ).pipe(
      Effect.mapError(
        (e) =>
          new ConfigurationError({
            configKey: "rosterUnit",
            message: `roster UTxO has no valid governance datum: ${String(e)}`,
          }),
      ),
    )) as unknown as GovernanceDatum;
    if (typeof datum === "string" || !("Roster" in datum)) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "rosterUnit",
          message: "the resolved UTxO is not the roster",
        }),
      );
    }
    return { utxo, roster: datum.Roster };
  });

/** Resolves a member's voter record UTxO by their eligibility-token name. */
export const resolveVoterRecord = (
  lucid: LucidEvolution,
  instance: GovernanceInstance,
  memberId: string,
): Effect.Effect<
  { utxo: UTxO; record: VoterRecordFields },
  UtxoNotFoundError | LucidError | ConfigurationError,
  never
> =>
  Effect.gen(function* () {
    const unit = instance.govPolicy + voterRecordTokenName(memberId);
    const utxoRaw = yield* resolveUtxoByUnit(lucid, unit);
    const utxo = patchInlineDatum(utxoRaw);
    const datum = (yield* parseSafeDatum(
      utxo.datum,
      GovernanceDatumSchema,
    ).pipe(
      Effect.mapError(
        (e) =>
          new ConfigurationError({
            configKey: "memberId",
            message: `voter record UTxO has no valid governance datum: ${String(e)}`,
          }),
      ),
    )) as unknown as GovernanceDatum;
    if (typeof datum === "string" || !("VoterRecord" in datum)) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "memberId",
          message: "the resolved UTxO is not a voter record",
        }),
      );
    }
    return { utxo, record: datum.VoterRecord };
  });

/** Resolves a live proposal UTxO by its id (state-token name) and parses it. */
export const resolveProposal = (
  lucid: LucidEvolution,
  instance: GovernanceInstance,
  proposalId: string,
): Effect.Effect<
  { utxo: UTxO; proposal: ProposalFields },
  UtxoNotFoundError | LucidError | ConfigurationError,
  never
> =>
  Effect.gen(function* () {
    const unit = instance.govPolicy + proposalId;
    const utxoRaw = yield* resolveUtxoByUnit(lucid, unit);
    const utxo = patchInlineDatum(utxoRaw);
    const datum = (yield* parseSafeDatum(
      utxo.datum,
      GovernanceDatumSchema,
    ).pipe(
      Effect.mapError(
        (e) =>
          new ConfigurationError({
            configKey: "proposalId",
            message: `UTxO holding ${unit} has no valid governance datum: ${String(e)}`,
          }),
      ),
    )) as unknown as GovernanceDatum;
    if (typeof datum === "string" || !("Proposal" in datum)) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "proposalId",
          message: "the resolved UTxO is not a proposal",
        }),
      );
    }
    return { utxo, proposal: datum.Proposal };
  });
