import {
  Data,
  LucidEvolution,
  Script,
  UTxO,
  validatorToAddress,
} from "@lucid-evolution/lucid";
import { Effect, Schedule } from "effect";
import { alwaysFailsValidator } from "../core/validators/constants.js";
import { DcuError, SetupError, TransactionBuildError } from "../core/errors.js";
import { getWalletUtxos } from "../core/utils/index.js";

/**
 * The hard ceiling for a deployable reference script: a deployment tx must carry
 * the full script, so it can never exceed maxTxSize (16,384) minus the deploy-tx
 * envelope. Scripts above this line can NEVER go on-chain — the treasury split
 * (spec 2026-07-04) exists because the monolith crossed it.
 *
 * The envelope is only small because {@link inputsCovering} keeps it small: one
 * ADA-only input and a bare change output measured ~178 bytes on Preprod for a
 * 15.8 KB script. An unbounded wallet selection measured ~822 bytes for the same
 * script, which is enough to push a validator under this ceiling over the ledger
 * limit — so this constant is a statement about the script AND about how the
 * deploy transaction is built.
 */
export const MAX_REF_SCRIPT_BYTES = 16_128;

/**
 * Headroom over a reference deposit for fees and the change output's min-ADA.
 * An operational approximation, not a protocol guarantee.
 */
const FEE_HEADROOM = 5_000_000n;

/** A reference-script UTxO's permanent on-chain location. */
export type ScriptRefOutRef = { txHash: string; outputIndex: number };

/** Compiled size of a validator in bytes (script hex is CBOR-wrapped bytes). */
export const scriptBytes = (script: Script): number => script.script.length / 2;

/**
 * Min-UTxO deposit for a reference-script UTxO, from the actual script size:
 * coinsPerUTxOByte (4,310) × (160-byte ledger overhead + output serialization
 * ≈ script + 300 B for address/value/datum), plus a 2-ADA cushion. The deposit
 * is locked permanently at the alwaysFails address, so it is computed tight
 * rather than over-provisioned.
 */
export const refDepositLovelace = (script: Script): bigint =>
  BigInt((scriptBytes(script) + 460) * 4_310) + 2_000_000n;

/**
 * The permanent deployment address for every reference script: the alwaysFails
 * validator's own address. UTxOs there can never be spent, so a reference input
 * parked there is available for the lifetime of the deployment.
 */
export const refScriptDeployAddress = (lucid: LucidEvolution): string =>
  validatorToAddress(
    lucid.config().network!,
    alwaysFailsValidator.elseAlwaysFails,
  );

/**
 * Fails before any funds move if a script cannot physically be deployed as a
 * reference script. An oversized validator is a build regression that can never
 * go on-chain, so it fails here with a clear message rather than as a ledger
 * size error mid-deployment.
 */
export const assertDeployableSizes = (
  scripts: Array<[string, Script]>,
): Effect.Effect<void, SetupError, never> =>
  Effect.gen(function* () {
    for (const [key, script] of scripts) {
      const bytes = scriptBytes(script);
      if (bytes > MAX_REF_SCRIPT_BYTES) {
        return yield* Effect.fail(
          new SetupError({
            message: `${key} validator is ${bytes} bytes — exceeds the ${MAX_REF_SCRIPT_BYTES}-byte deployable-reference-script ceiling and can never go on-chain`,
          }),
        );
      }
    }
  });

/**
 * Polls the wallet address until the given txHash appears in the UTxO set.
 *
 * Blockfrost's wallet UTxO endpoint can lag behind chain state even after
 * awaitTx returns. Once this poll succeeds, completeProgram() for the next tx
 * will also see fresh UTxOs because both hit the same Blockfrost endpoint.
 *
 * Retries every 3 seconds for up to 30 seconds before failing.
 */
export const awaitWalletIndexed = (
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
          message: `Timed out waiting for tx ${txHash.slice(0, 8)}... to appear in wallet UTxOs`,
        }),
    }),
    Schedule.spaced(3_000).pipe(Schedule.upTo(30_000)),
  );

/**
 * The wallet's spendable UTxOs, with every reference-script UTxO removed, and
 * ordered so a deploy needs as few of them as possible.
 *
 * Two separate concerns:
 *
 * Lucid excludes a reference-script UTxO from coin selection only when it was
 * passed via `readFrom`; one sitting in the wallet is an ordinary spendable
 * input and can be selected to fund an unrelated transaction, which destroys
 * the deployed script. Passing this set as `presetWalletInputs` bounds coin
 * selection to inputs that are safe to spend.
 *
 * A deploy transaction is also size-critical: it carries the whole script, so
 * the remaining room for inputs and change is small. A token-carrying input
 * costs twice, because the change output has to carry those tokens back. So
 * ADA-only UTxOs come first, largest first — the transaction then needs one
 * input and a bare change output. Without this a wallet whose largest balance
 * happens to sit in a multi-asset UTxO can push an otherwise deployable script
 * over the 16,384-byte limit.
 */
export const spendableWalletUtxos = (
  lucid: LucidEvolution,
): Effect.Effect<UTxO[], DcuError, never> =>
  getWalletUtxos(lucid).pipe(
    Effect.map((utxos) =>
      utxos
        .filter((u) => !u.scriptRef)
        .sort((a, b) => {
          const assetCount = (u: UTxO) => Object.keys(u.assets).length;
          const aPure = assetCount(a) === 1;
          const bPure = assetCount(b) === 1;
          if (aPure !== bPure) return aPure ? -1 : 1;
          const diff = (b.assets.lovelace ?? 0n) - (a.assets.lovelace ?? 0n);
          return diff > 0n ? 1 : diff < 0n ? -1 : 0;
        }),
    ),
  );

/**
 * The fewest spendable inputs that cover `needed`, preferring ADA-only ones.
 *
 * A deploy transaction carries the whole script, so what is left for inputs and
 * change is measured in hundreds of bytes. Handing Lucid the entire wallet lets
 * it select more inputs than the deploy needs, and each extra input plus the
 * tokens it forces back into the change output can push an otherwise deployable
 * script past 16,384 bytes. Measured on Preprod: the same 15.8 KB script built a
 * 16,645-byte transaction from an unbounded wallet and a 16,001-byte one from a
 * single ADA-only input.
 *
 * Falls back to the full set when the ADA-only UTxOs cannot cover the deposit —
 * a larger transaction beats a build that cannot balance at all.
 */
const inputsCovering = (utxos: UTxO[], needed: bigint): UTxO[] => {
  const picked: UTxO[] = [];
  let total = 0n;
  for (const u of utxos) {
    if (Object.keys(u.assets).length !== 1) continue;
    picked.push(u);
    total += u.assets.lovelace ?? 0n;
    if (total >= needed) return picked;
  }
  return utxos;
};

/**
 * Publishes one script as a reference-script UTxO at the alwaysFails address,
 * then waits until the wallet UTxO set reflects the spend.
 *
 * Coin selection is bounded to `presetWalletInputs` so a deploy can never
 * consume a reference script the wallet already holds.
 *
 * @param lucid - Lucid instance with the paying wallet selected.
 * @param params.key - Label used in error messages (the ref-script key).
 * @param params.script - The validator to publish.
 * @param params.deployAddress - Destination (see {@link refScriptDeployAddress}).
 * @param params.walletAddress - The paying wallet's address.
 * @param params.presetWalletInputs - Inputs coin selection may spend.
 * @param params.operation - Prefix for the operation field of build errors.
 * @param params.awaitSettled - Overrides how the deploy waits for the chain to
 *   catch up before the next transaction is built. The default polls the
 *   provider's wallet UTxO endpoint, which never advances on the Lucid
 *   emulator — an emulator caller passes a block-advancing wait instead.
 * @returns Effect yielding the confirmed OutRef of the new reference script.
 */
export const publishRefScript = (
  lucid: LucidEvolution,
  params: {
    key: string;
    script: Script;
    deployAddress: string;
    walletAddress: string;
    presetWalletInputs: UTxO[];
    operation: string;
    awaitSettled?: (txHash: string) => Effect.Effect<void, DcuError, never>;
  },
): Effect.Effect<ScriptRefOutRef, DcuError, never> =>
  Effect.gen(function* () {
    const { key, script, deployAddress, walletAddress, operation } = params;

    const txBuilder = yield* lucid
      .newTx()
      .pay.ToAddressWithData(
        deployAddress,
        { kind: "inline", value: Data.void() },
        { lovelace: refDepositLovelace(script) },
        { type: "PlutusV3", script: script.script },
      )
      .addSigner(walletAddress)
      .completeProgram({
        presetWalletInputs: inputsCovering(
          params.presetWalletInputs,
          refDepositLovelace(script) + FEE_HEADROOM,
        ),
      })
      .pipe(
        Effect.mapError(
          (e) =>
            new TransactionBuildError({
              operation: `${operation}:${key}:build`,
              error: String(e),
            }),
        ),
      );

    const signed = yield* Effect.tryPromise({
      try: () => txBuilder.sign.withWallet().complete(),
      catch: (e) =>
        new TransactionBuildError({
          operation: `${operation}:${key}:sign`,
          error: String(e),
        }),
    });
    const txHash = yield* Effect.tryPromise({
      try: () => signed.submit(),
      catch: (e) =>
        new TransactionBuildError({
          operation: `${operation}:${key}:submit`,
          error: String(e),
        }),
    });
    yield* Effect.tryPromise({
      try: () => lucid.awaitTx(txHash),
      catch: (e) =>
        new TransactionBuildError({
          operation: `${operation}:${key}:confirm`,
          error: String(e),
        }),
    });

    // Guarantees the next completeProgram() sees fresh wallet UTxOs.
    yield* params.awaitSettled
      ? params.awaitSettled(txHash)
      : awaitWalletIndexed(lucid, walletAddress, txHash);

    return { txHash, outputIndex: 0 };
  });
