import {
  LucidEvolution,
  validatorToRewardAddress,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { Protocol, TreasuryFamily } from "../core/validators/constants.js";
import { DcuError, TransactionBuildError } from "../core/errors.js";
import { getWalletAddress } from "../core/utils/index.js";

export type FamilyRegistration = {
  /** Which treasury family stake validator this registration is for. */
  family: TreasuryFamily;
  /** The family stake validator's reward (stake) address. */
  rewardAddress: string;
  /** true when the credential was already registered on-chain. */
  alreadyRegistered: boolean;
  /** Hash of the registration transaction, or null when alreadyRegistered. */
  txHash: string | null;
};

export type RegisterTreasuryStakeResult = {
  /** One registration outcome per treasury family (rounds/lifecycle/recovery/reserve). */
  registrations: FamilyRegistration[];
  /** true when EVERY family credential was already registered (full re-run). */
  alreadyRegistered: boolean;
};

/**
 * Duplicate-registration rejections across environments:
 * - Emulator: "Stake key is already registered. Reward address: ..."
 * - Live node via Blockfrost submit: ledger predicate `StakeKeyRegisteredDELEG`.
 */
const ALREADY_REGISTERED =
  /already ?registered|StakeKeyRegistered|CredentialAlreadyRegistered/i;

const FAMILIES: TreasuryFamily[] = [
  "rounds",
  "lifecycle",
  "recovery",
  "reserve",
];

/**
 * Registers the four treasury family stake credentials (rounds / lifecycle /
 * recovery / reserve), tolerating credentials that are already registered.
 *
 * Since the treasury split (spec 2026-07-04) every treasury operation carries a
 * 0-ADA reward withdrawal from its family's stake validator — the once-per-tx
 * home of the heavy validation. The ledger rejects a withdrawal from an
 * unregistered stake credential, so these registrations must happen once per
 * deployment before ANY treasury endpoint is used.
 *
 * Idempotency: registration state cannot be read through the provider API
 * (`delegationAt` returns the same shape for unregistered and
 * registered-with-no-rewards credentials), so this submits one registration per
 * credential and treats a duplicate-registration rejection as success. A
 * rejected transaction never enters a block, so the probe costs nothing.
 *
 * @param protocol - The deployment's protocol context. Build with `buildProtocol`.
 * @param lucid - Lucid instance with a funded wallet selected (pays the 2 ADA
 *                key deposit per credential not yet registered).
 */
export const registerTreasuryStake = (
  protocol: Protocol,
  lucid: LucidEvolution,
): Effect.Effect<RegisterTreasuryStakeResult, DcuError, never> =>
  Effect.gen(function* () {
    const network = lucid.config().network!;
    const address = yield* getWalletAddress(lucid);

    const registrations: FamilyRegistration[] = [];
    for (const family of FAMILIES) {
      const rewardAddress = validatorToRewardAddress(
        network,
        protocol.treasuryStakeValidators[family],
      );

      const attempt = Effect.gen(function* () {
        const txBuilder = yield* lucid
          .newTx()
          .register.Stake(rewardAddress)
          .addSigner(address)
          .completeProgram()
          .pipe(
            Effect.mapError(
              (e) =>
                new TransactionBuildError({
                  operation: `registerTreasuryStake:${family}:build`,
                  error: String(e),
                }),
            ),
          );

        const signed = yield* Effect.tryPromise({
          try: () => txBuilder.sign.withWallet().complete(),
          catch: (e) =>
            new TransactionBuildError({
              operation: `registerTreasuryStake:${family}:sign`,
              error: String(e),
            }),
        });
        const txHash = yield* Effect.tryPromise({
          try: () => signed.submit(),
          catch: (e) =>
            new TransactionBuildError({
              operation: `registerTreasuryStake:${family}:submit`,
              error: String(e),
            }),
        });
        yield* Effect.tryPromise({
          try: () => lucid.awaitTx(txHash),
          catch: (e) =>
            new TransactionBuildError({
              operation: `registerTreasuryStake:${family}:confirm`,
              error: String(e),
            }),
        });

        return {
          family,
          rewardAddress,
          alreadyRegistered: false,
          txHash,
        } satisfies FamilyRegistration;
      });

      const result = yield* attempt.pipe(
        Effect.catchAll((e) =>
          e._tag === "TransactionBuildError" && ALREADY_REGISTERED.test(e.error)
            ? Effect.succeed({
                family,
                rewardAddress,
                alreadyRegistered: true,
                txHash: null,
              } satisfies FamilyRegistration)
            : Effect.fail(e),
        ),
      );
      registrations.push(result);
    }

    return {
      registrations,
      alreadyRegistered: registrations.every((r) => r.alreadyRegistered),
    };
  });
