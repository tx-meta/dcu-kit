import {
  Data,
  LucidEvolution,
  RedeemerBuilder,
  TxSignBuilder,
  UTxO,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import {
  DcuError,
  InsufficientUtxosError,
  TransactionBuildError,
} from "../../core/errors.js";
import {
  getWalletUtxos,
  makeReturn,
  sortUtxos,
} from "../../core/utils/index.js";
import {
  GovAction,
  GovernanceDatum,
  GovMintRedeemer,
  VotingAction,
} from "../types.js";
import { GovernanceInstance } from "../validators.js";
import {
  dispatcherAddress,
  MIN_ADA_BUFFER,
  proposalStateTokenName,
  resolveAnchor,
  votingRewardAddress,
} from "../utils.js";

/**
 * Creates an unsigned transaction opening a proposal: mints the one-shot
 * Proposal State NFT and locks it at the dispatcher address with a fresh
 * `Open` proposal datum. The charter (voting mode, quorum, threshold) is read
 * from the anchor as a reference input and frozen into the proposal.
 *
 * Couples to the voting validator via a 0-ADA withdrawal (withdraw-zero): the
 * heavy open-time validation runs once in that validator's handler.
 *
 * @param lucid - Lucid instance with the opener's wallet selected.
 * @param config - OpenProposalConfig.
 * @returns Effect yielding `{ tx, proposalId }` — persist the id.
 */
export type OpenProposalConfig = {
  /** The governance instance (from buildGovernance / initGovernance). */
  instance: GovernanceInstance;
  /** The vault this proposal governs (a member of the charter's governed_targets). */
  targetId: string;
  /** The typed, parameterized action to authorize. */
  action: GovAction;
  /** POSIX ms; voting closes at this bound. */
  deadline: bigint;
  /** POSIX ms by which a passed proposal must execute (omit for no expiry). */
  execDeadline?: bigint;
  /** The opener's eligibility token unit (a token of the charter's
   *  member_policy). Its wallet UTxO is spent as the seed and proves opener
   *  authority (AnyMember) — omit only when the opener policy is CreatorOnly. */
  openerTokenUnit?: string;
  /** The seed UTxO for the one-shot proposal NFT. Defaults to the opener-token
   *  UTxO, or any wallet UTxO. */
  seed?: UTxO;
};

export const unsignedOpenProposalTxProgram = (
  lucid: LucidEvolution,
  config: OpenProposalConfig,
): Effect.Effect<{ tx: TxSignBuilder; proposalId: string }, DcuError, never> =>
  Effect.gen(function* () {
    const { instance } = config;
    const network = lucid.config().network ?? "Preprod";

    const walletUtxos = sortUtxos(yield* getWalletUtxos(lucid)).filter(
      (u) => !u.scriptRef,
    );
    // The opener's eligibility-token UTxO doubles as the one-shot seed, so the
    // proposal seed and the opener authority resolve to the same input index.
    const seed =
      config.seed ??
      (config.openerTokenUnit
        ? walletUtxos.find(
            (u) => (u.assets[config.openerTokenUnit!] ?? 0n) > 0n,
          )
        : walletUtxos[0]);
    if (!seed) {
      return yield* Effect.fail(
        new InsufficientUtxosError({ required: 1, available: 0 }),
      );
    }

    // Read the charter (reference input) and freeze its rules into the proposal.
    const { utxo: anchorUtxo, anchor } = yield* resolveAnchor(lucid, instance);

    const proposalId = yield* proposalStateTokenName(seed);
    const proposalUnit = instance.govPolicy + proposalId;

    const datum: GovernanceDatum = {
      Proposal: {
        proposal_id: proposalId,
        target_id: config.targetId,
        action: config.action,
        voting_mode: anchor.voting_mode,
        quorum: anchor.default_quorum,
        threshold: anchor.default_threshold,
        deadline: config.deadline,
        exec_deadline: config.execDeadline ?? null,
        timelock_until: null,
        tally_yes: 0n,
        tally_no: 0n,
        votes_cast: 0n,
        status: "Open",
      },
    };

    // Mint the proposal NFT — seed index resolved at build time; single
    // withdrawal sits at index 0.
    const mintRedeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (idx: bigint[]) =>
        Data.to(
          {
            OpenProposal: {
              seed_input_index: idx[0],
              proposal_output_index: 0n,
              withdrawal_index: 0n,
            },
          },
          GovMintRedeemer,
        ),
      inputs: [seed],
    };

    // The seed input is also the opener's eligibility-token input, so
    // opener_index resolves to the same tracked input as the mint's seed index.
    const votingRedeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (idx: bigint[]) =>
        Data.to(
          { OpenAction: { proposal_output_index: 0n, opener_index: idx[0] } },
          VotingAction,
        ),
      inputs: [seed],
    };

    const tx = yield* lucid
      .newTx()
      .collectFrom([seed])
      .readFrom([anchorUtxo])
      .mintAssets({ [proposalUnit]: 1n }, mintRedeemer)
      .attach.MintingPolicy(instance.dispatcherValidator.mint)
      .withdraw(votingRewardAddress(network, instance), 0n, votingRedeemer)
      .attach.WithdrawalValidator(instance.votingValidator)
      .pay.ToContract(
        dispatcherAddress(network, instance),
        { kind: "inline", value: Data.to(datum, GovernanceDatum) },
        { lovelace: MIN_ADA_BUFFER, [proposalUnit]: 1n },
      )
      .completeProgram()
      .pipe(
        Effect.mapError(
          (e) =>
            new TransactionBuildError({
              operation: "openProposal",
              error: String(e),
            }),
        ),
      );

    return { tx, proposalId };
  });

export const openProposal = (
  lucid: LucidEvolution,
  config: OpenProposalConfig,
) => makeReturn(unsignedOpenProposalTxProgram(lucid, config));
