import {
  Data,
  LucidEvolution,
  RedeemerBuilder,
  TxSignBuilder,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { DcuError, TransactionBuildError } from "../../core/errors.js";
import { getWalletAddress, makeReturn } from "../../core/utils/index.js";
import {
  GovernanceDatum,
  GovSpendRedeemer,
  OpenerPolicy,
  VotingMode,
} from "../types.js";
import { GovernanceInstance } from "../validators.js";
import { dispatcherAddress, resolveAnchor } from "../utils.js";

/**
 * Creates an unsigned transaction amending the mutable charter fields. The
 * published validator hashes, the creator, and `member_policy` are immutable;
 * only voting mode, quorum/threshold defaults, opener policy, timelock,
 * governed targets, and title may change. Authorized by the creator here
 * (a passed ParamChange decision is the on-chain governance path in Stage 5).
 *
 * @param lucid - Lucid instance with the creator's wallet selected.
 * @param config - UpdateCharterConfig.
 */
export type UpdateCharterConfig = {
  instance: GovernanceInstance;
  title?: string;
  votingMode?: VotingMode;
  quorum?: bigint;
  threshold?: bigint;
  timelock?: bigint;
  governedTargets?: string[];
  openerPolicy?: [bigint, OpenerPolicy][];
};

export const unsignedUpdateCharterTxProgram = (
  lucid: LucidEvolution,
  config: UpdateCharterConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { instance } = config;
    const network = lucid.config().network ?? "Preprod";
    const address = yield* getWalletAddress(lucid);

    const { utxo: anchorUtxo, anchor } = yield* resolveAnchor(lucid, instance);

    // Only mutable fields change; hashes / creator / member_policy are preserved.
    const updated: GovernanceDatum = {
      GovernanceAnchor: {
        ...anchor,
        title: config.title !== undefined ? config.title : anchor.title,
        voting_mode: config.votingMode ?? anchor.voting_mode,
        default_quorum: config.quorum ?? anchor.default_quorum,
        default_threshold: config.threshold ?? anchor.default_threshold,
        timelock: config.timelock ?? anchor.timelock,
        governed_targets: config.governedTargets ?? anchor.governed_targets,
        opener_policy: config.openerPolicy
          ? new Map(config.openerPolicy)
          : anchor.opener_policy,
      },
    };

    const spendRedeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (idx: bigint[]) =>
        Data.to(
          {
            UpdateCharter: {
              anchor_input_index: idx[0],
              anchor_output_index: 0n,
            },
          },
          GovSpendRedeemer,
        ),
      inputs: [anchorUtxo],
    };

    const tx = yield* lucid
      .newTx()
      .collectFrom([anchorUtxo], spendRedeemer)
      .attach.SpendingValidator(instance.dispatcherValidator.spend)
      .pay.ToContract(
        dispatcherAddress(network, instance),
        { kind: "inline", value: Data.to(updated, GovernanceDatum) },
        anchorUtxo.assets,
      )
      .addSigner(address)
      .completeProgram()
      .pipe(
        Effect.mapError(
          (e) =>
            new TransactionBuildError({
              operation: "updateCharter",
              error: String(e),
            }),
        ),
      );

    return tx;
  });

export const updateCharter = (
  lucid: LucidEvolution,
  config: UpdateCharterConfig,
) => makeReturn(unsignedUpdateCharterTxProgram(lucid, config));
