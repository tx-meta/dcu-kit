import {
  Data,
  LucidEvolution,
  TxSignBuilder,
  UTxO,
  validatorToAddress,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import {
  buildSettingsNft,
  buildProtocol,
  settingsTokenName,
  alwaysFailsValidator,
} from "../core/validators/constants.js";
import { ProtocolSettings } from "../core/types.js";
import { DcuError, TransactionBuildError, SetupError } from "../core/errors.js";
import { getWalletAddress, makeReturn } from "../core/utils/index.js";

export type InitializeSettingsResult = {
  settingsPolicy: string;
  settingsUnit: string;
  accountPolicy: string;
  groupPolicy: string;
  treasuryPolicy: string;
  /** The four treasury family stake-validator hashes recorded in the datum. */
  treasuryStakeHashes: {
    rounds: string;
    lifecycle: string;
    recovery: string;
    reserve: string;
  };
};

/**
 * Initialize the protocol settings (P5 trusted binding) — a ONE-TIME deploy step.
 *
 * Picks a seed UTxO from the admin wallet, derives the one-shot settings-NFT policy
 * from it, computes the deployment's account/group/treasury policy IDs (treasury is
 * parameterized by the settings policy), then mints the singleton settings NFT and
 * locks it — together with a ProtocolSettings datum recording those three policy IDs —
 * in an immutable UTxO at the always-fails address. Every later treasury transaction
 * references this UTxO to authenticate the trusted group policy.
 *
 * Must be run once before deploy-scripts / any treasury operation on a fresh deployment.
 *
 * Pass an explicit `seed` UTxO to make the resulting settings policy deterministic —
 * the caller can `deriveSettings(seed)` up front to learn the policy before submitting.
 * When omitted, the first wallet UTxO is used.
 */
export const unsignedInitializeSettingsProgram = (
  lucid: LucidEvolution,
  seedUtxo?: UTxO,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const address = yield* getWalletAddress(lucid);
    const network = lucid.config().network!;

    const walletUtxos = yield* Effect.tryPromise({
      try: () => lucid.wallet().getUtxos(),
      catch: (e) => new SetupError({ message: String(e) }),
    });
    if (walletUtxos.length === 0)
      return yield* Effect.fail(
        new SetupError({
          message: "No wallet UTxOs available to seed the settings NFT",
        }),
      );

    // Any wallet UTxO works as the one-shot seed — it is consumed by this tx.
    const seed = seedUtxo ?? walletUtxos[0];
    const { validator, policyId: settingsPolicy } = buildSettingsNft({
      txHash: seed.txHash,
      outputIndex: seed.outputIndex,
    });
    const protocol = buildProtocol(settingsPolicy);
    const settingsUnit = settingsPolicy + settingsTokenName;
    const settingsAddress = validatorToAddress(
      network,
      alwaysFailsValidator.elseAlwaysFails,
    );

    const settingsDatum = Data.to(
      {
        account_policy: protocol.accountPolicyId,
        group_policy: protocol.groupPolicyId,
        treasury_policy: protocol.treasuryPolicyId,
        treasury_rounds_stake: protocol.treasuryStakeHashes.rounds,
        treasury_lifecycle_stake: protocol.treasuryStakeHashes.lifecycle,
        treasury_recovery_stake: protocol.treasuryStakeHashes.recovery,
        treasury_reserve_stake: protocol.treasuryStakeHashes.reserve,
      },
      ProtocolSettings,
    );

    const tx = yield* lucid
      .newTx()
      .collectFrom([seed])
      .mintAssets({ [settingsUnit]: 1n }, Data.void())
      .attach.MintingPolicy(validator)
      .pay.ToContract(
        settingsAddress,
        { kind: "inline", value: settingsDatum },
        { [settingsUnit]: 1n },
      )
      .addSigner(address)
      .completeProgram()
      .pipe(
        Effect.mapError(
          (e) =>
            new TransactionBuildError({
              operation: "initializeSettings",
              error: String(e),
            }),
        ),
      );

    return tx;
  });

export const initializeSettings = (lucid: LucidEvolution, seedUtxo?: UTxO) =>
  makeReturn(unsignedInitializeSettingsProgram(lucid, seedUtxo));

/**
 * Pure helper: derive the settings policy + the deployment's policy IDs from a seed
 * OutRef, WITHOUT building a transaction. Useful for configuring buildProtocol once the
 * settings NFT has been deployed (the seed OutRef is recorded at deploy time).
 */
export const deriveSettings = (seed: {
  txHash: string;
  outputIndex: number;
}): InitializeSettingsResult => {
  const { policyId: settingsPolicy } = buildSettingsNft(seed);
  const protocol = buildProtocol(settingsPolicy);
  return {
    settingsPolicy,
    settingsUnit: settingsPolicy + settingsTokenName,
    accountPolicy: protocol.accountPolicyId,
    groupPolicy: protocol.groupPolicyId,
    treasuryPolicy: protocol.treasuryPolicyId,
    treasuryStakeHashes: protocol.treasuryStakeHashes,
  };
};
