import {
  LucidEvolution,
  Data,
  OutRef,
  TxSignBuilder,
  RedeemerBuilder,
  Assets,
  toUnit,
} from "@lucid-evolution/lucid";
import { AccountDatum, AccountRedeemer } from "../core/types.js";
import { Effect } from "effect";
import { DcuError, TransactionBuildError } from "../core/errors.js";
import {
  getScriptAddress,
  createCip68TokenNames,
  getWalletAddress,
  resolveUtxoByOutRef,
  assetNameLabels,
} from "../core/utils/index.js";
import {
  accountValidator,
  accountPolicyId,
} from "../core/validators/constants.js";

// --- Configuration ---

export type CreateAccountConfig = {
  selected_out_ref: OutRef;
  /** Optional salted profile commitment — 64 hex chars from
   *  `computeProfileCommitment`. Omitted = no profile (`""`). The chain never
   *  stores raw identity data; the profile and salt stay with the caller. */
  profileCommitment?: string;
};

// --- Endpoint ---

/**
 * Creates an unsigned transaction for creating a DCU Account.
 *
 * **Functionality:**
 * - Mints a unique pair of CIP-68 tokens (Reference + User Auth).
 * - Locks the Reference NFT in the Account Script with the provided datum.
 * - Sends the User Auth NFT to the user's wallet.
 * - Initializes the Account Datum with an optional salted profile commitment
 *   (`profile_commitment`, blake2b-256). Omitted = no profile — the datum holds
 *   `""` and no identity data ever goes on-chain.
 *
 * @param lucid - Lucid instance with wallet selected.
 * @param config - CreateAccountConfig (UTxO + optional profile commitment).
 * @returns Effect yielding `{ tx, accountTokenSuffix }` — the `TxSignBuilder` to
 *   sign/submit, plus the permanent 28-byte CIP-68 token suffix (hex) derived from
 *   the spent UTxO. The suffix is the stable account identity used by all subsequent
 *   endpoints (`updateAccount`, `joinGroup`, …), so callers no longer need to re-fetch
 *   output 0 and string-slice the asset key to recover it.
 *
 * @example
 * ```ts
import { createAccount, computeProfileCommitment } from "@tx-meta/dcu-kit";
import { randomBytes } from "node:crypto";

// Minimal — no profile, nothing identifying on-chain
const program = createAccount(lucid, { selected_out_ref: utxo });

// With a salted profile commitment (store the salt + profile off-chain)
const salt = randomBytes(32).toString("hex");
const program = createAccount(lucid, {
  selected_out_ref: utxo,
  profileCommitment: computeProfileCommitment('{"name":"@alice"}', salt),
});
```
 */
export const unsignedCreateAccountTxProgram = (
  lucid: LucidEvolution,
  config: CreateAccountConfig,
): Effect.Effect<
  { tx: TxSignBuilder; accountTokenSuffix: string },
  DcuError,
  never
> =>
  Effect.gen(function* () {
    const address = yield* getWalletAddress(lucid);
    const accountScriptAddress = yield* getScriptAddress(
      lucid,
      accountValidator.spendAccount,
    );
    const selectedUtxo = yield* resolveUtxoByOutRef(
      lucid,
      config.selected_out_ref,
    );
    const { refTokenName, userTokenName } =
      yield* createCip68TokenNames(selectedUtxo);

    // The permanent CIP-68 suffix: the 28-byte hash tail shared by the ref (100) and
    // user (222) tokens, i.e. the asset name minus its label prefix. This is the stable
    // account identity consumers feed into every later endpoint.
    const accountTokenSuffix = refTokenName.slice(
      assetNameLabels.prefix100.length,
    );

    const commitment = config.profileCommitment ?? "";
    if (commitment !== "" && !/^[0-9a-fA-F]{64}$/.test(commitment)) {
      return yield* Effect.fail(
        new TransactionBuildError({
          operation: "createAccount",
          error:
            "profileCommitment must be 64 hex characters (a blake2b-256 commitment) or omitted",
        }),
      );
    }
    const accountDatum: AccountDatum = {
      profile_commitment: commitment.toLowerCase(),
    };
    const datum = Data.to(accountDatum, AccountDatum);

    const refToken = toUnit(accountPolicyId, refTokenName);
    const userToken = toUnit(accountPolicyId, userTokenName);

    const mintingAssets: Assets = { [refToken]: 1n, [userToken]: 1n };
    const scriptAssets: Assets = { [refToken]: 1n };
    const walletAssets: Assets = { [userToken]: 1n };

    // RedeemerBuilder resolves the actual sorted index of selected_out_ref at build time.
    // The validator uses input_index to re-derive the CIP-68 names — it must point to
    // the same UTxO the SDK used to compute refTokenName/userTokenName.
    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          { CreateAccount: { input_index: inputIndices[0], output_index: 0n } },
          AccountRedeemer,
        ),
      inputs: [selectedUtxo],
    };

    const tx = yield* lucid
      .newTx()
      .collectFrom([selectedUtxo])
      .mintAssets(mintingAssets, redeemer)
      .pay.ToAddressWithData(
        accountScriptAddress,
        { kind: "inline", value: datum },
        scriptAssets,
      )
      .pay.ToAddress(address, walletAssets)
      .addSigner(address)
      .attach.MintingPolicy(accountValidator.mintAccount)
      .completeProgram()
      .pipe(
        Effect.mapError(
          (e) =>
            new TransactionBuildError({
              operation: "createAccount",
              error: String(e),
            }),
        ),
      );
    return { tx, accountTokenSuffix };
  });
