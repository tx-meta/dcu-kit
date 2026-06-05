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
} from "../core/utils/index.js";
import {
  accountValidator,
  accountPolicyId,
} from "../core/validators/constants.js";
import { fromText } from "@lucid-evolution/lucid";

// --- Configuration ---

export type UpdateAccountConfig = {
  accountTokenSuffix: string;
  // Raw UTF-8 display name. Defaults to wallet address when omitted.
  display_name?: string;
  // Raw UTF-8 secondary contact identifier. Defaults to wallet address when omitted.
  contact?: string;
};

// --- Endpoint ---

/**
 * Creates an unsigned transaction for updating a DCU Account.
 *
 * **Functionality:**
 * - Updates the AccountDatum (`display_name`, `contact`) on-chain.
 * - Requires the User Auth NFT in the wallet for authorization.
 *
 * @param lucid - Lucid instance with wallet selected.
 * @param config - UpdateAccountConfig containing UTxOs and updated datum.
 * @returns Effect yielding TxSignBuilder.
 *
 * @example
 * ```typescript
 * const program = unsignedUpdateAccountTxProgram(lucid, {
 *   account_utxo,
 *   user_utxo,
 *   account_datum: { ... }
 * });
 * ```
 */
export const unsignedUpdateAccountTxProgram = (
  lucid: LucidEvolution,
  config: UpdateAccountConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { accountTokenSuffix, display_name, contact } = config;
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

    const accountDatum: AccountDatum = {
      display_name: fromText(display_name ?? address),
      contact: fromText(contact ?? address),
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
