import { LucidEvolution, validatorToRewardAddress } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { Protocol } from "../core/validators/constants.js";
import { DcuError, TransactionBuildError } from "../core/errors.js";
import { getWalletAddress } from "../core/utils/index.js";

export type RegisterTreasuryStakeResult = {
  /** The treasury validator's reward (stake) address. */
  treasuryRewardAddress: string;
  /** true when the credential was already registered on-chain. */
  alreadyRegistered: boolean;
  /** Hash of the registration transaction, or null when alreadyRegistered. */
  txHash: string | null;
};

/**
 * Duplicate-registration rejections across environments:
 * - Emulator: "Stake key is already registered. Reward address: ..."
 * - Live node via Blockfrost submit: ledger predicate `StakeKeyRegisteredDELEG`.
 */
const ALREADY_REGISTERED =
  /already ?registered|StakeKeyRegistered|CredentialAlreadyRegistered/i;

/**
 * Registers the treasury validator's stake credential, tolerating the case
 * where it is already registered.
 *
 * The treasury validator is self-coupled (staking hash == spending hash ==
 * policy id). Its withdraw handler runs the heavy round logic once per tx,
 * triggered by a 0-ADA reward withdrawal that each treasury spend asserts is
 * present. The ledger rejects a withdrawal from an unregistered stake
 * credential, so this registration must happen once per deployment before any
 * DistributeRound.
 *
 * Idempotency: registration state cannot be read through the provider API
 * (`delegationAt` returns the same shape for unregistered and
 * registered-with-no-rewards credentials), so this submits the registration
 * and treats a duplicate-registration rejection as success. The rejected
 * transaction never enters a block, so the probe costs nothing.
 *
 * @param protocol - The deployment's protocol context. Build with `buildProtocol`.
 * @param lucid - Lucid instance with a funded wallet selected (pays the 2 ADA
 *                key deposit when the credential is not yet registered).
 */
export const registerTreasuryStake = (
  protocol: Protocol,
  lucid: LucidEvolution,
): Effect.Effect<RegisterTreasuryStakeResult, DcuError, never> =>
  Effect.gen(function* () {
    const network = lucid.config().network!;
    const address = yield* getWalletAddress(lucid);
    const treasuryRewardAddress = validatorToRewardAddress(
      network,
      protocol.treasuryValidator.spendTreasury,
    );

    const attempt = Effect.gen(function* () {
      const txBuilder = yield* lucid
        .newTx()
        .register.Stake(treasuryRewardAddress)
        .addSigner(address)
        .completeProgram()
        .pipe(
          Effect.mapError(
            (e) =>
              new TransactionBuildError({
                operation: "registerTreasuryStake:build",
                error: String(e),
              }),
          ),
        );

      const signed = yield* Effect.tryPromise({
        try: () => txBuilder.sign.withWallet().complete(),
        catch: (e) =>
          new TransactionBuildError({
            operation: "registerTreasuryStake:sign",
            error: String(e),
          }),
      });
      const txHash = yield* Effect.tryPromise({
        try: () => signed.submit(),
        catch: (e) =>
          new TransactionBuildError({
            operation: "registerTreasuryStake:submit",
            error: String(e),
          }),
      });
      yield* Effect.tryPromise({
        try: () => lucid.awaitTx(txHash),
        catch: (e) =>
          new TransactionBuildError({
            operation: "registerTreasuryStake:confirm",
            error: String(e),
          }),
      });

      return { treasuryRewardAddress, alreadyRegistered: false, txHash };
    });

    return yield* attempt.pipe(
      Effect.catchAll((e) =>
        e._tag === "TransactionBuildError" && ALREADY_REGISTERED.test(e.error)
          ? Effect.succeed({
              treasuryRewardAddress,
              alreadyRegistered: true,
              txHash: null,
            })
          : Effect.fail(e),
      ),
    );
  });
