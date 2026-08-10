import {
  LucidEvolution,
  validatorToRewardAddress,
} from "@lucid-evolution/lucid";
import { Effect, Schedule } from "effect";
import { Protocol, TreasuryFamily } from "../core/validators/constants.js";
import { DcuError, SetupError, TransactionBuildError } from "../core/errors.js";
import { getWalletAddress } from "../core/utils/index.js";

/** One credential's registration outcome, keyed by a caller-supplied label. */
export type StakeRegistration = {
  /** Which credential this is, for reporting (e.g. a family name). */
  label: string;
  /** The stake validator's reward (stake) address. */
  rewardAddress: string;
  /** true when the credential was already registered on-chain. */
  alreadyRegistered: boolean;
  /** Hash of the registration transaction, or null when alreadyRegistered. */
  txHash: string | null;
};

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
 * Polls the wallet address until `txHash` appears in its UTxO set.
 *
 * The four registrations submit back-to-back; a provider's wallet UTxO endpoint
 * (Blockfrost) can lag behind chain state even after awaitTx returns, so the
 * NEXT registration's coin selection may pick an input the previous tx already
 * spent ("All inputs are spent"). Waiting for the change UTxO to be indexed
 * keeps each registration's coin selection on a fresh set. No-op on the emulator
 * (the change is visible immediately). Retries every 3 s for up to 30 s.
 */
const awaitWalletIndexed = (
  lucid: LucidEvolution,
  address: string,
  txHash: string,
): Effect.Effect<void, SetupError, never> =>
  Effect.retry(
    Effect.tryPromise({
      try: async () => {
        const utxos = await lucid.utxosAt(address);
        if (!utxos.some((u) => u.txHash === txHash))
          throw new Error("not indexed yet");
      },
      catch: () =>
        new SetupError({
          message: `Timed out waiting for registration tx ${txHash.slice(0, 8)}... to appear in wallet UTxOs`,
        }),
    }),
    Schedule.spaced(3_000).pipe(Schedule.upTo(30_000)),
  );

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

    const results = yield* registerStakeCredentials(
      lucid,
      FAMILIES.map((family) => ({
        label: family,
        rewardAddress: validatorToRewardAddress(
          network,
          protocol.treasuryStakeValidators[family],
        ),
      })),
      "registerTreasuryStake",
    );
    const registrations: FamilyRegistration[] = results.map((r) => ({
      family: r.label as TreasuryFamily,
      rewardAddress: r.rewardAddress,
      alreadyRegistered: r.alreadyRegistered,
      txHash: r.txHash,
    }));

    return {
      registrations,
      alreadyRegistered: registrations.every((r) => r.alreadyRegistered),
    };
  });

/**
 * Registers a set of script stake credentials one at a time, tolerating any
 * that are already registered.
 *
 * Every withdraw-zero family — the four treasury ones, and since ADR-0003 the
 * two savings ones — needs its stake credential registered before the ledger
 * will accept the 0-ADA withdrawal that triggers its validator. This is the
 * shared mechanism; callers supply the labelled reward addresses.
 *
 * Idempotency: registration state cannot be read through the provider API
 * (`delegationAt` returns the same shape for unregistered and
 * registered-with-no-rewards credentials), so this submits one registration per
 * credential and treats a duplicate-registration rejection as success. A
 * rejected transaction never enters a block, so the probe costs nothing.
 *
 * @param lucid - Lucid instance with a funded wallet selected (pays the key
 *                deposit per credential not yet registered).
 * @param entries - The credentials to register, with a label for reporting.
 * @param operation - Prefix for the error taxonomy's `operation` field.
 */
export const registerStakeCredentials = (
  lucid: LucidEvolution,
  entries: ReadonlyArray<{ label: string; rewardAddress: string }>,
  operation: string,
): Effect.Effect<StakeRegistration[], DcuError, never> =>
  Effect.gen(function* () {
    const address = yield* getWalletAddress(lucid);
    const registrations: StakeRegistration[] = [];

    for (const { label, rewardAddress } of entries) {
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
                  operation: `${operation}:${label}:build`,
                  error: String(e),
                }),
            ),
          );

        const signed = yield* Effect.tryPromise({
          try: () => txBuilder.sign.withWallet().complete(),
          catch: (e) =>
            new TransactionBuildError({
              operation: `${operation}:${label}:sign`,
              error: String(e),
            }),
        });
        const txHash = yield* Effect.tryPromise({
          try: () => signed.submit(),
          catch: (e) =>
            new TransactionBuildError({
              operation: `${operation}:${label}:submit`,
              error: String(e),
            }),
        });
        yield* Effect.tryPromise({
          try: () => lucid.awaitTx(txHash),
          catch: (e) =>
            new TransactionBuildError({
              operation: `${operation}:${label}:confirm`,
              error: String(e),
            }),
        });
        // Wait for the change UTxO to be indexed so the next credential's coin
        // selection does not reuse an input this transaction just spent.
        yield* awaitWalletIndexed(lucid, address, txHash);

        return {
          label,
          rewardAddress,
          alreadyRegistered: false,
          txHash,
        } satisfies StakeRegistration;
      });

      registrations.push(
        yield* attempt.pipe(
          Effect.catchAll((e) =>
            e._tag === "TransactionBuildError" &&
            ALREADY_REGISTERED.test(e.error)
              ? Effect.succeed({
                  label,
                  rewardAddress,
                  alreadyRegistered: true,
                  txHash: null,
                } satisfies StakeRegistration)
              : Effect.fail(e),
          ),
        ),
      );
    }

    return registrations;
  });
