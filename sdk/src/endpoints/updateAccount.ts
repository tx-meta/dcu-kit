import {
  LucidEvolution,
  Data,
  TxSignBuilder,
  RedeemerBuilder,
  Assets,
  toUnit,
} from "@lucid-evolution/lucid";
import { AccountRedeemer, AccountDatum } from "../core/types.js";
import { Effect } from "effect";
import { DcuError, TransactionBuildError } from "../core/errors.js";
import {
  getScriptAddress,
  findCip68TokenPair,
  getWalletAddress,
  patchInlineDatum,
  assetNameLabels,
  resolveUtxoByUnit,
  parseSafeDatum,
} from "../core/utils/index.js";
import {
  accountValidator,
  accountPolicyId,
} from "../core/validators/constants.js";

// --- Configuration ---

export type UpdateAccountConfig = {
  accountTokenSuffix: string;
  /** Salted profile commitment — 64 hex chars from `computeProfileCommitment`.
   *  OMITTED = preserve the current on-chain value; explicit `""` = clear it.
   *  An omitted update never silently destroys an existing commitment. */
  profileCommitment?: string;
};

// --- Endpoint ---

/**
 * Creates an unsigned transaction for updating a DCU Account.
 *
 * **Functionality:**
 * - Updates the AccountDatum (`profile_commitment`) on-chain: omitted config
 *   preserves the current commitment, explicit `""` clears it.
 * - Requires the User Auth NFT in the wallet for authorization.
 *
 * @param lucid - Lucid instance with wallet selected.
 * @param config - UpdateAccountConfig (token suffix + optional commitment).
 * @returns Effect yielding TxSignBuilder.
 *
 * @example
 * ```typescript
 * // Rotate the commitment
 * const program = unsignedUpdateAccountTxProgram(lucid, {
 *   accountTokenSuffix,
 *   profileCommitment: computeProfileCommitment(profileJson, newSalt),
 * });
 * // Clear it
 * const program = unsignedUpdateAccountTxProgram(lucid, {
 *   accountTokenSuffix,
 *   profileCommitment: "",
 * });
 * ```
 */
export const unsignedUpdateAccountTxProgram = (
  lucid: LucidEvolution,
  config: UpdateAccountConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { accountTokenSuffix, profileCommitment } = config;
    const address = yield* getWalletAddress(lucid);

    const refUnit =
      accountPolicyId + assetNameLabels.prefix100 + accountTokenSuffix;
    const userUnit =
      accountPolicyId + assetNameLabels.prefix222 + accountTokenSuffix;

    const account_utxo_raw = yield* resolveUtxoByUnit(lucid, refUnit);
    const user_utxo = yield* resolveUtxoByUnit(lucid, userUnit);
    const account_utxo = patchInlineDatum(account_utxo_raw);

    const { userTokenName, refTokenName } = yield* findCip68TokenPair(
      [user_utxo, account_utxo],
      accountPolicyId,
    );
    const accountScriptAddress = yield* getScriptAddress(
      lucid,
      accountValidator.spendAccount,
    );

    if (
      profileCommitment !== undefined &&
      profileCommitment !== "" &&
      !/^[0-9a-fA-F]{64}$/.test(profileCommitment)
    ) {
      return yield* Effect.fail(
        new TransactionBuildError({
          operation: "updateAccount",
          error:
            'profileCommitment must be 64 hex characters, "" to clear, or omitted to preserve',
        }),
      );
    }
    // Omitted = preserve the current on-chain commitment.
    const currentDatum = yield* parseSafeDatum<AccountDatum>(
      account_utxo.datum,
      AccountDatum,
    );
    const accountDatum: AccountDatum = {
      profile_commitment:
        profileCommitment !== undefined
          ? profileCommitment.toLowerCase()
          : currentDatum.profile_commitment,
    };
    const datum = Data.to(accountDatum, AccountDatum);

    const refToken = toUnit(accountPolicyId, refTokenName);
    const userToken = toUnit(accountPolicyId, userTokenName);

    const scriptAssets: Assets = { [refToken]: 1n };
    const walletAssets: Assets = { [userToken]: 1n };

    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            UpdateAccount: {
              reference_token_name: refTokenName,
              user_input_index: inputIndices[0],
              account_input_index: inputIndices[1],
              account_output_index: 0n,
            },
          },
          AccountRedeemer,
        ),
      inputs: [user_utxo, account_utxo],
    };

    const tx = yield* lucid
      .newTx()
      .collectFrom([user_utxo])
      .collectFrom([account_utxo], redeemer)
      .pay.ToAddressWithData(
        accountScriptAddress,
        { kind: "inline", value: datum },
        scriptAssets,
      )
      .pay.ToAddress(address, walletAssets)
      .addSigner(address)
      .attach.SpendingValidator(accountValidator.spendAccount)
      .completeProgram()
      .pipe(
        Effect.mapError(
          (e) =>
            new TransactionBuildError({
              operation: "updateAccount",
              error: String(e),
            }),
        ),
      );
    return tx;
  });
