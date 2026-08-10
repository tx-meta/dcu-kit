import {
  Constr,
  Data,
  getAddressDetails,
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
  AmbiguousUtxoError,
  UtxoNotFoundError,
} from "../core/errors.js";
import { CredentialSchema } from "../core/types.js";
import {
  getUtxosAt,
  parseSafeDatum,
  patchInlineDatum,
  resolveUtxoByUnit,
  sortUtxos,
} from "../core/utils/index.js";
import { assetNameLabels } from "../core/utils/assets.js";
import {
  type CredentialD,
  LoanAccountFields,
  MemberAccountFields,
  SavingsDatum,
  SavingsDatumSchema,
  SavingsFundFields,
  SavingsIntent,
  SavingsAddressSchema,
  type SavingsAddress,
} from "./types.js";
import { savingsPolicyId, savingsVaultValidator } from "./validators.js";

/** Lovelace buffer locked at create (shared protocol convention). */
export const MIN_ADA_BUFFER = 2_000_000n;

/** Converts bech32 into the ledger `Address` data used by savings intents. */
export const toSavingsAddress = (bech32: string): SavingsAddress => {
  const details = getAddressDetails(bech32);
  const payment = details.paymentCredential;
  if (!payment) throw new Error("address has no payment credential");
  const payment_credential =
    payment.type === "Key"
      ? ({ VerificationKey: [payment.hash] } as const)
      : ({ Script: [payment.hash] } as const);
  const stake = details.stakeCredential;
  const stake_credential = stake
    ? ({
        Inline: [
          stake.type === "Key"
            ? ({ VerificationKey: [stake.hash] } as const)
            : ({ Script: [stake.hash] } as const),
        ],
      } as const)
    : null;
  return { payment_credential, stake_credential } as SavingsAddress;
};

const SocialIntentTupleSchema = Data.Tuple([
  SavingsAddressSchema,
  Data.Integer(),
]);
type SocialIntentTuple = Data.Static<typeof SocialIntentTupleSchema>;
const SocialIntentTuple =
  SocialIntentTupleSchema as unknown as SocialIntentTuple;

const UpdateFundIntentTupleSchema = Data.Tuple([
  Data.Bytes(),
  CredentialSchema,
  Data.Integer(),
  Data.Integer(),
  Data.Integer(),
  Data.Integer(),
  Data.Nullable(Data.Integer()),
]);
type UpdateFundIntentTuple = Data.Static<typeof UpdateFundIntentTupleSchema>;
const UpdateFundIntentTuple =
  UpdateFundIntentTupleSchema as unknown as UpdateFundIntentTuple;

/**
 * blake2b_256 of the canonical economic payload. The Governance Gate binds
 * the target redeemer constructor separately, so the payload does not repeat
 * an action tag. UpdateFund binds only its amendable charter fields so normal
 * balance changes cannot stale a passed vote. CloseCycle has no discretionary
 * payload because its snapshot is derived from authenticated live state.
 */
export const computeSavingsIntentHash = (intent: SavingsIntent): string => {
  let encoded: string;
  if ("SocialPayoutIntent" in intent) {
    encoded = Data.to(
      [
        intent.SocialPayoutIntent.destination,
        intent.SocialPayoutIntent.amount,
      ] as SocialIntentTuple,
      SocialIntentTuple,
    );
  } else if ("UpdateFundIntent" in intent) {
    const update = intent.UpdateFundIntent;
    encoded = Data.to(
      [
        update.title,
        update.quorum,
        update.min_shares_per_deposit,
        update.max_shares_per_deposit,
        update.max_loan_multiple,
        update.loan_grace,
        update.cycle_end,
      ] as UpdateFundIntentTuple,
      UpdateFundIntentTuple,
    );
  } else if ("CloseCycleIntent" in intent) {
    return bytesToHex(blake2b(new Uint8Array(), { dkLen: 32 }));
  } else if ("DisburseLoanIntent" in intent) {
    encoded = Data.to(intent.DisburseLoanIntent.loan, SavingsDatum);
  } else if ("WriteOffLoanIntent" in intent) {
    encoded = intent.WriteOffLoanIntent.loan_id;
  } else {
    encoded = Data.to(
      intent.CloseFundIntent.destination,
      SavingsAddressSchema as unknown as SavingsAddress,
    );
  }
  return bytesToHex(blake2b(hexToBytes(encoded), { dkLen: 32 }));
};

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
  UtxoNotFoundError | AmbiguousUtxoError | LucidError | ConfigurationError,
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
  UtxoNotFoundError | AmbiguousUtxoError | LucidError | ConfigurationError,
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
  UtxoNotFoundError | AmbiguousUtxoError | LucidError | ConfigurationError,
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
  /**
   * Extends the endpoint's transaction with a spend at the quorum's script
   * credential — for script quorums whose spend needs a redeemer of its own,
   * which the dust path cannot express.
   *
   * It must ADD to the given builder rather than build a separate one: a
   * fragment composed in afterwards contributes its mint to the balance
   * without its input being counted, so the burn cannot balance.
   *
   * The governance gate is exactly this case — `gateWitnessProgram` returns an
   * extension that spends the decision UTxO with its binding redeemer and
   * burns the one-shot decision token. The caller is responsible for the
   * extension matching the datum's script hash: the SDK cannot inspect a
   * builder, so a mismatch surfaces as a validator failure at completion
   * rather than a configuration error.
   */
  extend?: (_tx: TxBuilder) => TxBuilder;
};

/**
 * Satisfies `credential_authorized` for the fund quorum.
 *
 * VK credential: adds the datum's key hash as a required signer.
 * Script credential: applies the caller's witness extension when given, else
 * spends a dust UTxO at the script address and pays it back (the on-chain rule
 * is "some spent input sits at that script"), attaching the provided script.
 * Either way the quorum's signer keys are added.
 */
export const applyQuorumWitness = (
  lucid: LucidEvolution,
  tx: TxBuilder,
  credential: CredentialD,
  witness: PartyWitness | undefined,
): Effect.Effect<TxBuilder, ConfigurationError | LucidError, never> =>
  Effect.gen(function* () {
    // Both paths satisfy the SAME credential; supplying both hides which one
    // ran, and silently skips `script`'s hash-equality guard.
    if (witness?.extend && witness?.script) {
      return yield* Effect.fail(
        new ConfigurationError({
          configKey: "quorumWitness",
          message:
            "pass either quorumWitness.script (the dust path) or quorumWitness.extend (a custom spend), not both",
        }),
      );
    }
    if ("VerificationKey" in credential) {
      // Dropping `extend` here would silently degrade a governed action into a
      // plain signature: the caller believes a decision was consumed, but it
      // stays live at the gate and is spendable again later.
      if (witness?.extend) {
        return yield* Effect.fail(
          new ConfigurationError({
            configKey: "quorumWitness.extend",
            message: `quorum is a key credential (${credential.VerificationKey[0]}), so quorumWitness.extend cannot authorize it — its spend would be built but prove nothing, and any one-shot token it consumes would be spent for no reason`,
          }),
        );
      }
      return tx.addSignerKey(credential.VerificationKey[0]);
    }
    const addSigners = (t: TxBuilder) =>
      (witness?.signerKeyHashes ?? []).reduce(
        (acc, kh) => acc.addSignerKey(kh),
        t,
      );
    // The extension carries its own spend at the script address, with the
    // redeemer (and any mint) that spend requires.
    if (witness?.extend) return addSigners(witness.extend(tx));
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
    return addSigners(
      tx
        .collectFrom([dust])
        .attach.SpendingValidator(witness.script)
        .pay.ToAddress(dust.address, dust.assets),
    );
  });
