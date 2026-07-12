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
  /** The seed UTxO for the one-shot proposal NFT. Defaults to a wallet UTxO. */
  seed?: UTxO;
};

export const unsignedOpenProposalTxProgram = (
  lucid: LucidEvolution,
  config: OpenProposalConfig,
): Effect.Effect<{ tx: TxSignBuilder; proposalId: string }, DcuError, never> =>
  Effect.gen(function* () {
    const { instance } = config;
    const network = lucid.config().network ?? "Preprod";

    const seed =
      config.seed ??
      sortUtxos(yield* getWalletUtxos(lucid)).filter((u) => !u.scriptRef)[0];
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

    const votingRedeemer = Data.to(
      { OpenAction: { proposal_output_index: 0n, opener_index: 0n } },
      VotingAction,
    );

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
