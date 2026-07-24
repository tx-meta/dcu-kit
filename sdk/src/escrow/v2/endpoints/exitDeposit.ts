import {
  Data,
  LucidEvolution,
  paymentCredentialOf,
  RedeemerBuilder,
  TxSignBuilder,
  UTxO,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import {
  ConfigurationError,
  DcuError,
  LucidError,
  TransactionBuildError,
} from "../../../core/errors.js";
import {
  getWalletAddress,
  makeReturn,
  patchInlineDatum,
} from "../../../core/utils/index.js";
import { PoolSpendRedeemer, VaultDatum } from "../types.js";
import { poolVaultValidator } from "../validators.js";
import { applyPartyWitness, PartyWitness, poolVaultAddress } from "../utils.js";

/**
 * Creates an unsigned transaction recovering ONE of the wallet's unallocated
 * deposits from a pool — the contributor's unilateral exit. Past any
 * commitment window; no quorum involvement. Repeat to exit further deposits
 * (one vault input per transaction).
 *
 * @param lucid - Lucid instance with the contributor's wallet selected.
 * @param config - ExitDepositConfig.
 * @returns Effect yielding TxSignBuilder.
 */
export type ExitDepositConfig = {
  /** The pool's permanent identity (returned by createPool). */
  poolTokenName: string;
  /** Required when the contributor credential is a script hash. */
  contributorWitness?: PartyWitness;
  /** Clock override (POSIX ms) — pass `emulator.now()` in emulator tests. */
  currentTime?: bigint;
};

export const unsignedExitDepositTxProgram = (
  lucid: LucidEvolution,
  config: ExitDepositConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const network = lucid.config().network ?? "Preprod";
    const walletAddress = yield* getWalletAddress(lucid);
    const myCredential = paymentCredentialOf(walletAddress).hash;
    const now = config.currentTime ?? BigInt(Date.now());

    const utxos: UTxO[] = yield* Effect.tryPromise({
      try: () => lucid.utxosAt(poolVaultAddress(network)),
      catch: (e) =>
        new LucidError({ message: `utxosAt(poolVault) failed: ${String(e)}` }),
    });
    let deposit: UTxO | undefined;
    let depositDatum:
      Extract<VaultDatum, { PoolDeposit: unknown }>["PoolDeposit"] | undefined;
    for (const raw of utxos) {
      const utxo = patchInlineDatum(raw);
      if (!utxo.datum) continue;
      let parsed: VaultDatum;
      try {
        parsed = Data.from(utxo.datum, VaultDatum);
      } catch {
        continue;
      }
      if (typeof parsed === "string" || !("PoolDeposit" in parsed)) continue;
      const d = parsed.PoolDeposit;
      if (d.pool_id !== config.poolTokenName) continue;
      const pc = d.contributor.payment_credential;
      const hash =
        "VerificationKey" in pc ? pc.VerificationKey[0] : pc.Script[0];
      if (hash !== myCredential) continue;
      deposit = utxo;
      depositDatum = d;
      break;
    }
    if (!deposit || !depositDatum) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "poolTokenName",
          message: "no unallocated deposit of yours in this pool",
        }),
      );
    }
    if (
      depositDatum.locked_until !== null &&
      now <= depositDatum.locked_until
    ) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "poolTokenName",
          message: `this deposit is committed until ${depositDatum.locked_until}`,
        }),
      );
    }

    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          { ExitDeposit: { deposit_input_index: inputIndices[0] } },
          PoolSpendRedeemer,
        ),
      inputs: [deposit],
    };

    let baseTx = lucid
      .newTx()
      .collectFrom([deposit], redeemer)
      .attach.SpendingValidator(poolVaultValidator.spendPool)
      .pay.ToAddress(walletAddress, deposit.assets);
    if (depositDatum.locked_until !== null) {
      baseTx = baseTx.validFrom(Number(depositDatum.locked_until + 1_000n));
    }

    const withWitness = yield* applyPartyWitness(
      lucid,
      baseTx,
      depositDatum.contributor.payment_credential,
      config.contributorWitness,
      "contributor",
    );

    return yield* withWitness.completeProgram().pipe(
      Effect.mapError(
        (e) =>
          new TransactionBuildError({
            operation: "exitDeposit",
            error: String(e),
          }),
      ),
    );
  });

export const exitDeposit = (lucid: LucidEvolution, config: ExitDepositConfig) =>
  makeReturn(unsignedExitDepositTxProgram(lucid, config));
