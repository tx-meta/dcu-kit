import {
  Assets,
  Data,
  fromText,
  LucidEvolution,
  RedeemerBuilder,
  TxSignBuilder,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import {
  ConfigurationError,
  DcuError,
  TransactionBuildError,
} from "../../../core/errors.js";
import { makeReturn } from "../../../core/utils/index.js";
import {
  EscrowDatumV2,
  EscrowV2SpendRedeemer,
  fromOnchainAddress,
} from "../types.js";
import { escrowV2Validator } from "../validators.js";
import {
  applyPartyWitness,
  escrowV2AssetUnit,
  MIN_ADA_BUFFER,
  PartyWitness,
  resolveEscrowV2,
} from "../utils.js";

/**
 * Creates an unsigned transaction amending an escrow's unreleased milestones
 * by mutual consent (funder AND beneficiary co-sign). Deadlines, amounts, and
 * milestone count may change; the terms document (`contentHash`) and `title`
 * may be updated in the same amendment — that is where off-chain milestone
 * titles live.
 *
 * Value rules (validator-enforced): an Upfront escrow stays fully funded
 * through the amendment — a larger schedule tops up from the wallet in the
 * same tx; a smaller one pays the excess back to the funder. PerMilestone
 * escrows keep their balance unchanged.
 *
 * @param lucid - Lucid instance (either party's wallet; both must sign).
 * @param config - AmendMilestonesConfig.
 * @returns Effect yielding TxSignBuilder (needs both signatures).
 */
export type AmendMilestonesConfig = {
  /** The escrow's permanent identity (returned by createEscrow). */
  stateTokenName: string;
  /** The FULL new schedule, including the released prefix unchanged. */
  milestones: { amount: bigint; deadline: bigint }[];
  /** New evidence per milestone; defaults to preserving by index. */
  evidence?: (string | null)[];
  /** New short title (max 64 UTF-8 bytes). Defaults to unchanged. */
  title?: string;
  /** New terms-document hash. Defaults to unchanged. */
  contentHash?: string | null;
  /** Required when the funder credential is a script hash. */
  funderWitness?: PartyWitness;
  /** Required when the beneficiary credential is a script hash. */
  beneficiaryWitness?: PartyWitness;
};

export const unsignedAmendMilestonesTxProgram = (
  lucid: LucidEvolution,
  config: AmendMilestonesConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { utxo: escrowUtxo, datum } = yield* resolveEscrowV2(
      lucid,
      config.stateTokenName,
    );
    const rc = Number(datum.released_count);
    const next = config.milestones;

    if (next.length === 0 || next.length > 100) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "milestones",
          message: "the amended schedule must have 1-100 entries",
        }),
      );
    }
    if (next.length < rc) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "milestones",
          message: `released milestones are history — the schedule cannot shrink below ${rc}`,
        }),
      );
    }
    for (let i = 0; i < rc; i++) {
      const a = datum.milestones[i]!;
      const b = next[i]!;
      if (a.amount !== b.amount || a.deadline !== b.deadline) {
        return yield* Effect.fail(
          new ConfigurationError({
            configKey: "milestones",
            message: `milestone ${i} is already released and cannot change`,
          }),
        );
      }
    }
    for (let i = 0; i < next.length; i++) {
      if (next[i]!.amount <= 0n) {
        return yield* Effect.fail(
          new ConfigurationError({
            configKey: "milestones",
            message: "every milestone amount must be > 0",
          }),
        );
      }
      if (i > 0 && next[i]!.deadline <= next[i - 1]!.deadline) {
        return yield* Effect.fail(
          new ConfigurationError({
            configKey: "milestones",
            message: "milestone deadlines must be strictly increasing",
          }),
        );
      }
    }

    const evidence =
      config.evidence ??
      next.map((_, i) =>
        i < datum.evidence.length ? datum.evidence[i]! : null,
      );
    if (evidence.length !== next.length) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "evidence",
          message: "evidence must have one entry per milestone",
        }),
      );
    }

    const titleHex =
      config.title === undefined ? datum.title : fromText(config.title);
    if (titleHex.length > 128) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "title",
          message: "title must be at most 64 UTF-8 bytes",
        }),
      );
    }

    const updatedDatum: EscrowDatumV2 = {
      ...datum,
      milestones: next.map((m) => ({ amount: m.amount, deadline: m.deadline })),
      evidence,
      title: titleHex,
      content_hash:
        config.contentHash === undefined
          ? datum.content_hash
          : config.contentHash,
    };

    // Continuation value: Upfront tracks the new remaining total; PerMilestone
    // keeps the balance byte-identical.
    const assetUnit = escrowV2AssetUnit(datum);
    const isAda = assetUnit === "lovelace";
    const continuationAssets: Assets = { ...escrowUtxo.assets };
    let funderExcess: Assets | null = null;
    if (datum.funding_mode === "Upfront") {
      const remaining = next.slice(rc).reduce((a, m) => a + m.amount, 0n);
      const required = isAda ? remaining + MIN_ADA_BUFFER : remaining;
      const current = continuationAssets[assetUnit] ?? 0n;
      if (current > required) {
        const excess = current - required;
        continuationAssets[assetUnit] = required;
        funderExcess = isAda
          ? { lovelace: excess }
          : { lovelace: MIN_ADA_BUFFER, [assetUnit]: excess };
      } else if (current < required) {
        // Top-up pulled from the building wallet by balancing.
        continuationAssets[assetUnit] = required;
      }
    }

    const network = lucid.config().network ?? "Preprod";
    const funderAddress = yield* fromOnchainAddress(network, datum.funder);

    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            AmendMilestones: {
              escrow_input_index: inputIndices[0],
              continuation_index: 0n,
              funder_index: funderExcess ? 1n : 99n,
            },
          },
          EscrowV2SpendRedeemer,
        ),
      inputs: [escrowUtxo],
    };

    const baseTx = lucid
      .newTx()
      .collectFrom([escrowUtxo], redeemer)
      .attach.SpendingValidator(escrowV2Validator.spendEscrow)
      .pay.ToContract(
        escrowUtxo.address,
        { kind: "inline", value: Data.to(updatedDatum, EscrowDatumV2) },
        continuationAssets,
      );

    const withExcess = funderExcess
      ? baseTx.pay.ToAddress(funderAddress, funderExcess)
      : baseTx;

    const withFunder = yield* applyPartyWitness(
      lucid,
      withExcess,
      datum.funder.payment_credential,
      config.funderWitness,
      "funder",
    );
    const withBoth = yield* applyPartyWitness(
      lucid,
      withFunder,
      datum.beneficiary.payment_credential,
      config.beneficiaryWitness,
      "beneficiary",
    );

    return yield* withBoth.completeProgram().pipe(
      Effect.mapError(
        (e) =>
          new TransactionBuildError({
            operation: "amendMilestones",
            error: String(e),
          }),
      ),
    );
  });

export const amendMilestones = (
  lucid: LucidEvolution,
  config: AmendMilestonesConfig,
) => makeReturn(unsignedAmendMilestonesTxProgram(lucid, config));
