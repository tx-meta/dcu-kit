import {
  Data,
  LucidEvolution,
  RedeemerBuilder,
  TxSignBuilder,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import {
  ConfigurationError,
  DcuError,
  TransactionBuildError,
} from "../../core/errors.js";
import { getWalletUtxos, makeReturn } from "../../core/utils/index.js";
import {
  GovernanceDatum,
  GovMintRedeemer,
  GovSpendRedeemer,
  VotingAction,
} from "../types.js";
import { GovernanceInstance } from "../validators.js";
import {
  dispatcherAddress,
  GovScriptRefs,
  MIN_ADA_BUFFER,
  resolveAnchor,
  resolveRoster,
  voterRecordTokenName,
  votingRewardAddress,
} from "../utils.js";

/**
 * Creates an unsigned transaction registering a member as a voter: appends the
 * member to the instance roster (the ever-registered set) and mints their
 * voter-record token into a fresh record UTxO with an empty `voted` list.
 *
 * One registration per member, ever — the roster is what makes the voter
 * record one-shot, which is what makes the record a sound double-vote
 * nullifier at cast time. The record's min-ADA stays locked for the life of
 * the instance (there is no deregistration).
 *
 * @param lucid - Lucid instance with the member's wallet selected.
 * @param config - RegisterVoterConfig.
 */
export type RegisterVoterConfig = {
  instance: GovernanceInstance;
  /** The member's eligibility token unit (a token of the charter's
   *  member_policy). Its wallet UTxO is spent to prove eligibility, and its
   *  token name becomes the registered member id. */
  voterTokenUnit: string;
  /** Reference-script UTxOs — required in practice: dispatcher + voting no
   *  longer fit inline together under the 16,384-byte tx limit. */
  scriptRefs?: GovScriptRefs;
};

export const unsignedRegisterVoterTxProgram = (
  lucid: LucidEvolution,
  config: RegisterVoterConfig,
): Effect.Effect<{ tx: TxSignBuilder; recordName: string }, DcuError, never> =>
  Effect.gen(function* () {
    const { instance } = config;
    const network = lucid.config().network ?? "Preprod";

    const { utxo: anchorUtxo } = yield* resolveAnchor(lucid, instance);
    const { utxo: rosterUtxo, roster } = yield* resolveRoster(lucid, instance);

    const memberId = config.voterTokenUnit.slice(56);
    if (roster.members.includes(memberId)) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "voterTokenUnit",
          message: "this member is already registered as a voter",
        }),
      );
    }

    const voterUtxo = (yield* getWalletUtxos(lucid)).find(
      (u) => (u.assets[config.voterTokenUnit] ?? 0n) > 0n,
    );
    if (!voterUtxo) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "voterTokenUnit",
          message: "the wallet holds no UTxO with the eligibility token",
        }),
      );
    }

    const recordName = voterRecordTokenName(memberId);
    const recordUnit = instance.govPolicy + recordName;

    // Roster continuation: the member is appended to the ever-registered set.
    const updatedRoster: GovernanceDatum = {
      Roster: { members: [memberId, ...roster.members] },
    };
    // The fresh record: bound to this member, empty nullifier set.
    const recordDatum: GovernanceDatum = {
      VoterRecord: { member_id: memberId, voted: [] },
    };

    // Tracked spending inputs: roster (0), voter token (1).
    // Outputs: roster continuation (0), record (1).
    const trackedInputs = [rosterUtxo, voterUtxo];

    const mintRedeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (idx: bigint[]) =>
        Data.to(
          {
            RegisterVoter: {
              roster_input_index: idx[0],
              record_output_index: 1n,
              member_index: idx[1],
              withdrawal_index: 0n,
            },
          },
          GovMintRedeemer,
        ),
      inputs: trackedInputs,
    };

    // The roster input runs the dispatcher spend validator — its thin redeemer
    // just asserts the coupling to this RegisterAction.
    const rosterRedeemer = Data.to(
      { RosterSpend: { withdrawal_index: 0n } },
      GovSpendRedeemer,
    );

    const votingRedeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (idx: bigint[]) =>
        Data.to(
          {
            RegisterAction: {
              roster_input_index: idx[0],
              roster_output_index: 0n,
              record_output_index: 1n,
              member_index: idx[1],
            },
          },
          VotingAction,
        ),
      inputs: trackedInputs,
    };

    const tx = yield* lucid
      .newTx()
      .collectFrom([rosterUtxo], rosterRedeemer)
      .collectFrom([voterUtxo])
      .readFrom([anchorUtxo])
      .mintAssets({ [recordUnit]: 1n }, mintRedeemer)
      .compose(
        config.scriptRefs?.dispatcher
          ? lucid.newTx().readFrom([config.scriptRefs.dispatcher])
          : lucid
              .newTx()
              .attach.SpendingValidator(instance.dispatcherValidator.spend)
              .attach.MintingPolicy(instance.dispatcherValidator.mint),
      )
      .withdraw(votingRewardAddress(network, instance), 0n, votingRedeemer)
      .compose(
        config.scriptRefs?.voting
          ? lucid.newTx().readFrom([config.scriptRefs.voting])
          : lucid.newTx().attach.WithdrawalValidator(instance.votingValidator),
      )
      .pay.ToContract(
        dispatcherAddress(network, instance),
        { kind: "inline", value: Data.to(updatedRoster, GovernanceDatum) },
        rosterUtxo.assets,
      )
      .pay.ToContract(
        dispatcherAddress(network, instance),
        { kind: "inline", value: Data.to(recordDatum, GovernanceDatum) },
        { lovelace: MIN_ADA_BUFFER, [recordUnit]: 1n },
      )
      .completeProgram()
      .pipe(
        Effect.mapError(
          (e) =>
            new TransactionBuildError({
              operation: "registerVoter",
              error: String(e),
            }),
        ),
      );

    return { tx, recordName };
  });

export const registerVoter = (
  lucid: LucidEvolution,
  config: RegisterVoterConfig,
) => makeReturn(unsignedRegisterVoterTxProgram(lucid, config));
