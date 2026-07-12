import {
  Data,
  fromText,
  LucidEvolution,
  RedeemerBuilder,
  TxSignBuilder,
  UTxO,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import {
  ConfigurationError,
  DcuError,
  InsufficientUtxosError,
  TransactionBuildError,
} from "../../core/errors.js";
import {
  getWalletAddress,
  getWalletUtxos,
  makeReturn,
  sortUtxos,
} from "../../core/utils/index.js";
import {
  GovernanceDatum,
  OpenerPolicy,
  PartyRef,
  partyToCredential,
  SettingsRedeemer,
  VotingMode,
} from "../types.js";
import { buildGovernance, GovernanceInstance } from "../validators.js";
import { dispatcherAddress, MIN_ADA_BUFFER } from "../utils.js";

/**
 * Creates an unsigned transaction that instantiates a governance instance:
 * consumes a seed UTxO, mints the one-shot anchor NFT under the seeded settings
 * policy, and locks it at the dispatcher address with the charter datum — which
 * publishes this instance's voting and gate hashes.
 *
 * The seed makes every downstream hash unique, so a target vault's quorum can
 * commit to exactly this instance's gate. Persist the returned `instance`
 * (its `settingsPolicy`, `govPolicy`, `gateHash`, `votingStakeHash`).
 *
 * @param lucid - Lucid instance with the paying wallet selected.
 * @param config - InitGovernanceConfig.
 * @returns Effect yielding `{ tx, instance }`.
 */
export type InitGovernanceConfig = {
  /** The UTxO to consume as the one-shot seed. Defaults to the first
   *  non-reference-script wallet UTxO. */
  seed?: UTxO;
  /** Short human-readable instance name, max 64 UTF-8 bytes. Never PII. */
  title: string;
  /** Eligibility token policy — holding a token of this policy makes a voter. */
  memberPolicy: string;
  /** Target ids (vault anchor names / policies, hex) this instance may govern. */
  governedTargets: string[];
  /** Default weight rule. Defaults to one-member-one-vote. */
  votingMode?: VotingMode;
  /** Minimum total weight cast for a proposal to be decidable. */
  quorum: bigint;
  /** Minimum yes weight in basis points (0..10000) of weight cast, to pass. */
  threshold: bigint;
  /** Per-action-class opener rule, keyed by GovAction constructor tag.
   *  Defaults to AnyMember for every action class. */
  openerPolicy?: [bigint, OpenerPolicy][];
  /** Ms between Passed and the earliest Executed. Default 0 (no delay). */
  timelock?: bigint;
  /** The charter amender / CreatorOnly authority. Defaults to the wallet. */
  creator?: PartyRef;
};

const DEFAULT_OPENER_POLICY: [bigint, OpenerPolicy][] = [
  [0n, "AnyMember"],
  [1n, "AnyMember"],
  [2n, "AnyMember"],
  [3n, "AnyMember"],
  [4n, "AnyMember"],
];

export const unsignedInitGovernanceTxProgram = (
  lucid: LucidEvolution,
  config: InitGovernanceConfig,
): Effect.Effect<
  { tx: TxSignBuilder; instance: GovernanceInstance },
  DcuError,
  never
> =>
  Effect.gen(function* () {
    const titleHex = fromText(config.title);
    if (titleHex.length > 128) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "title",
          message: "title must be at most 64 UTF-8 bytes",
        }),
      );
    }
    if (
      config.quorum < 0n ||
      config.threshold < 0n ||
      config.threshold > 10000n
    ) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "threshold",
          message:
            "quorum must be >= 0 and threshold in basis points (0..10000)",
        }),
      );
    }

    const walletAddress = yield* getWalletAddress(lucid);
    // A reference-script UTxO must never be the seed — consuming it destroys the
    // deployed script for everyone.
    const seed =
      config.seed ??
      sortUtxos(yield* getWalletUtxos(lucid)).filter((u) => !u.scriptRef)[0];
    if (!seed) {
      return yield* Effect.fail(
        new InsufficientUtxosError({ required: 1, available: 0 }),
      );
    }

    const instance = buildGovernance({
      txHash: seed.txHash,
      outputIndex: seed.outputIndex,
    });
    const creator = yield* partyToCredential(
      config.creator ?? walletAddress,
      "creator",
    );

    const openerPolicy = new Map<bigint, OpenerPolicy>(
      config.openerPolicy ?? DEFAULT_OPENER_POLICY,
    );

    const datum: GovernanceDatum = {
      GovernanceAnchor: {
        title: titleHex,
        member_policy: config.memberPolicy,
        governed_targets: config.governedTargets,
        voting_mode: config.votingMode ?? "OneMemberOneVote",
        default_quorum: config.quorum,
        default_threshold: config.threshold,
        opener_policy: openerPolicy,
        timelock: config.timelock ?? 0n,
        creator,
        voting_stake_hash: instance.votingStakeHash,
        gate_hash: instance.gateHash,
      },
    };

    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: () =>
        Data.to({ anchor_output_index: 0n }, SettingsRedeemer),
      inputs: [seed],
    };

    const network = lucid.config().network ?? "Preprod";
    const tx = yield* lucid
      .newTx()
      .collectFrom([seed])
      .mintAssets({ [instance.anchorUnit]: 1n }, redeemer)
      .attach.MintingPolicy(instance.settingsValidator)
      .pay.ToContract(
        dispatcherAddress(network, instance),
        { kind: "inline", value: Data.to(datum, GovernanceDatum) },
        { lovelace: MIN_ADA_BUFFER, [instance.anchorUnit]: 1n },
      )
      .completeProgram()
      .pipe(
        Effect.mapError(
          (e) =>
            new TransactionBuildError({
              operation: "initGovernance",
              error: String(e),
            }),
        ),
      );

    return { tx, instance };
  });

export const initGovernance = (
  lucid: LucidEvolution,
  config: InitGovernanceConfig,
) => makeReturn(unsignedInitGovernanceTxProgram(lucid, config));
