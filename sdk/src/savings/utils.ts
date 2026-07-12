import {
  Constr,
  Data,
  LucidEvolution,
  Network,
  Script,
  TxBuilder,
  UTxO,
  validatorToAddress,
  validatorToScriptHash,
} from "@lucid-evolution/lucid";
import { blake2b } from "@noble/hashes/blake2";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { Effect } from "effect";
import {
  ConfigurationError,
  LucidError,
  UtxoNotFoundError,
} from "../core/errors.js";
import {
  getUtxosAt,
  parseSafeDatum,
  patchInlineDatum,
  resolveUtxoByUnit,
  sortUtxos,
} from "../core/utils/index.js";
import { assetNameLabels } from "../core/utils/assets.js";
import {
  CredentialD,
  LoanAccountFields,
  MemberAccountFields,
  SavingsDatum,
  SavingsDatumSchema,
  SavingsFundFields,
} from "./types.js";
import { savingsPolicyId, savingsVaultValidator } from "./validators.js";

/** Lovelace buffer locked at create (shared protocol convention). */
export const MIN_ADA_BUFFER = 2_000_000n;

/** The savings-vault script address for a network. */
export const savingsVaultAddress = (network: Network): string =>
  validatorToAddress(network, savingsVaultValidator.spendVault);

/**
 * Derives the Fund State NFT name from its seed UTxO.
 *
 * Matches the on-chain algorithm: full 32-byte blake2b_256 of the
 * CBOR-serialised OutputReference — no CIP-68 prefix (a single state token,
 * not a ref/user pair).
 */
export const fundStateTokenName = (seed: UTxO): Effect.Effect<string> =>
  Effect.sync(() => {
    const outputRefCbor = Data.to(
      new Constr(0, [seed.txHash, BigInt(seed.outputIndex)]),
    );
    return bytesToHex(blake2b(hexToBytes(outputRefCbor), { dkLen: 32 }));
  });

/** The fund asset's Lucid unit ("lovelace" for ADA). */
export const fundAssetUnit = (fund: SavingsFundFields): string =>
  fund.asset_policy === "" ? "lovelace" : fund.asset_policy + fund.asset_name;

/**
 * A copy of `assets` with `delta` applied to `unit`. A key whose balance
 * reaches zero is REMOVED — a zero-quantity asset entry is invalid CBOR
 * ("decoding 0 as PositiveCoin").
 */
export const withAssetDelta = (
  assets: Record<string, bigint>,
  unit: string,
  delta: bigint,
): Record<string, bigint> => {
  const next = { ...assets, [unit]: (assets[unit] ?? 0n) + delta };
  if (next[unit] === 0n) delete next[unit];
  return next;
};

/**
 * The SORTED position of `target` among a transaction's reference inputs.
 * The ledger presents reference inputs to scripts as a set sorted by
 * (txHash, outputIndex) — never hardcode a reference-input index.
 */
export const sortedRefIndexOf = (target: UTxO, refs: UTxO[]): bigint => {
  const key = (u: UTxO) =>
    `${u.txHash}#${u.outputIndex.toString().padStart(8, "0")}`;
  const sorted = [...refs].sort((a, b) => (key(a) < key(b) ? -1 : 1));
  return BigInt(sorted.findIndex((u) => key(u) === key(target)));
};

/** The member account's CIP-68 units for a token suffix. */
export const memberUnits = (memberTokenSuffix: string) => ({
  refUnit: savingsPolicyId + assetNameLabels.prefix100 + memberTokenSuffix,
  userUnit: savingsPolicyId + assetNameLabels.prefix222 + memberTokenSuffix,
});

/** Resolves a live fund anchor by its state-token name and parses its datum. */
export const resolveFund = (
  lucid: LucidEvolution,
  fundTokenName: string,
): Effect.Effect<
  { utxo: UTxO; fund: SavingsFundFields },
  UtxoNotFoundError | LucidError | ConfigurationError,
  never
> =>
  Effect.gen(function* () {
    const unit = savingsPolicyId + fundTokenName;
    const utxoRaw = yield* resolveUtxoByUnit(lucid, unit);
    const utxo = patchInlineDatum(utxoRaw);
    const datum = (yield* parseSafeDatum(utxo.datum, SavingsDatumSchema).pipe(
      Effect.mapError(
        (e) =>
          new ConfigurationError({
            configKey: "fundTokenName",
            message: `UTxO holding ${unit} has no valid savings datum: ${String(e)}`,
          }),
      ),
    )) as unknown as SavingsDatum;
    if (typeof datum === "string" || !("SavingsFund" in datum)) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "fundTokenName",
          message: "the resolved UTxO is a member account, not a fund anchor",
        }),
      );
    }
    return { utxo, fund: datum.SavingsFund };
  });

/** Resolves a member account (100 ref UTxO + wallet-held user unit). */
export const resolveMemberAccount = (
  lucid: LucidEvolution,
  memberTokenSuffix: string,
): Effect.Effect<
  { refUtxo: UTxO; account: MemberAccountFields; userUnit: string },
  UtxoNotFoundError | LucidError | ConfigurationError,
  never
> =>
  Effect.gen(function* () {
    const { refUnit, userUnit } = memberUnits(memberTokenSuffix);
    const refRaw = yield* resolveUtxoByUnit(lucid, refUnit);
    const refUtxo = patchInlineDatum(refRaw);
    const datum = (yield* parseSafeDatum(
      refUtxo.datum,
      SavingsDatumSchema,
    ).pipe(
      Effect.mapError(
        (e) =>
          new ConfigurationError({
            configKey: "memberTokenSuffix",
            message: `UTxO holding ${refUnit} has no valid savings datum: ${String(e)}`,
          }),
      ),
    )) as unknown as SavingsDatum;
    if (typeof datum === "string" || !("MemberAccount" in datum)) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "memberTokenSuffix",
          message: "the resolved UTxO is a fund anchor, not a member account",
        }),
      );
    }
    return { refUtxo, account: datum.MemberAccount, userUnit };
  });

/** Resolves a live loan record by its state-token name. */
export const resolveLoan = (
  lucid: LucidEvolution,
  loanTokenName: string,
): Effect.Effect<
  { utxo: UTxO; loan: LoanAccountFields },
  UtxoNotFoundError | LucidError | ConfigurationError,
  never
> =>
  Effect.gen(function* () {
    const unit = savingsPolicyId + loanTokenName;
    const utxoRaw = yield* resolveUtxoByUnit(lucid, unit);
    const utxo = patchInlineDatum(utxoRaw);
    const datum = (yield* parseSafeDatum(utxo.datum, SavingsDatumSchema).pipe(
      Effect.mapError(
        (e) =>
          new ConfigurationError({
            configKey: "loanTokenName",
            message: `UTxO holding ${unit} has no valid savings datum: ${String(e)}`,
          }),
      ),
    )) as unknown as SavingsDatum;
    if (typeof datum === "string" || !("LoanAccount" in datum)) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "loanTokenName",
          message: "the resolved UTxO is not a loan record",
        }),
      );
    }
    return { utxo, loan: datum.LoanAccount };
  });

/** The member's user-token UTxO from the connected wallet. */
export const findUserTokenUtxo = (
  lucid: LucidEvolution,
  userUnit: string,
): Effect.Effect<UTxO, UtxoNotFoundError | LucidError, never> =>
  Effect.gen(function* () {
    const walletUtxos = yield* Effect.tryPromise({
      try: () => lucid.wallet().getUtxos(),
      catch: (e) =>
        new LucidError({ message: `cannot read wallet UTxOs: ${String(e)}` }),
    });
    const found = walletUtxos.find((u) => (u.assets[userUnit] ?? 0n) > 0n);
    if (!found) {
      return yield* Effect.fail(
        new UtxoNotFoundError({
          tokenName: userUnit,
          address: "wallet",
          message:
            "the connected wallet does not hold this member account's user token",
        }),
      );
    }
    return found;
  });

export type PartyWitness = {
  /** The script preimage when the party credential is a script hash. */
  script?: Script;
  /** Key hashes that will sign (native `atLeast` members, or extra signers). */
  signerKeyHashes?: string[];
};

/**
 * Satisfies `credential_authorized` for the fund quorum.
 *
 * VK credential: adds the datum's key hash as a required signer.
 * Script credential: spends a dust UTxO at the script address and pays it
 * back (the on-chain rule is "some spent input sits at that script"),
 * attaches the provided script, and adds the quorum's signer keys.
 */
export const applyQuorumWitness = (
  lucid: LucidEvolution,
  tx: TxBuilder,
  credential: CredentialD,
  witness: PartyWitness | undefined,
): Effect.Effect<TxBuilder, ConfigurationError | LucidError, never> =>
  Effect.gen(function* () {
    if ("VerificationKey" in credential) {
      return tx.addSignerKey(credential.VerificationKey[0]);
    }
    const scriptHash = credential.Script[0];
    if (!witness?.script) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "quorumWitness.script",
          message: `quorum is a script credential (${scriptHash}); pass its script preimage`,
        }),
      );
    }
    if (validatorToScriptHash(witness.script) !== scriptHash) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "quorumWitness.script",
          message: `provided script hashes to ${validatorToScriptHash(witness.script)}, datum expects ${scriptHash}`,
        }),
      );
    }
    const network = lucid.config().network ?? "Preprod";
    const scriptAddr = validatorToAddress(network, witness.script);
    const dustCandidates = sortUtxos(yield* getUtxosAt(lucid, scriptAddr));
    const dust = dustCandidates[0];
    if (!dust) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "quorumWitness",
          message: `no UTxO at ${scriptAddr} to prove the quorum script — fund a small (dust) UTxO at the script address first`,
        }),
      );
    }
    const withDust = tx
      .collectFrom([dust])
      .attach.SpendingValidator(witness.script)
      .pay.ToAddress(dust.address, dust.assets);
    return (witness.signerKeyHashes ?? []).reduce(
      (t, kh) => t.addSignerKey(kh),
      withDust,
    );
  });
