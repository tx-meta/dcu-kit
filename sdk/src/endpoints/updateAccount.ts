
import { LucidEvolution, Data, UTxO, TxSignBuilder, RedeemerBuilder, Assets, toUnit } from "@lucid-evolution/lucid";
import { AccountRedeemer, AccountDatum } from "../core/types.js";
import { Effect } from "effect";
import { DcuError, TransactionBuildError } from "../core/errors.js";
import { getScriptAddress, findCip68TokenPair, getWalletAddress } from "../core/utils/index.js";
import { accountValidator, accountPolicyId } from "../core/validators/constants.js";

// --- Configuration ---

export type UpdateAccountConfig = {
    account_utxo: UTxO;
    user_utxo: UTxO;
    account_datum: AccountDatum;
};

// --- Endpoint ---

/**
 * Creates an unsigned transaction for updating a DCU Account.
 *
 * **Functionality:**
 * - Updates the Identity Datum (e.g. Email/Phone hashes) on-chain.
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
    const { account_utxo, user_utxo, account_datum } = config;

    const address = yield* getWalletAddress(lucid);
    const { userTokenName, refTokenName } = yield* findCip68TokenPair([user_utxo, account_utxo], accountPolicyId);
    const accountScriptAddress = yield* getScriptAddress(lucid, accountValidator.spendAccount);
    const datum = Data.to(account_datum, AccountDatum);

    const refToken = toUnit(accountPolicyId, refTokenName);
    const userToken = toUnit(accountPolicyId, userTokenName);

    const scriptAssets: Assets = { [refToken]: 1n };
    const walletAssets: Assets = { [userToken]: 1n };

    const redeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) => Data.to(
        { UpdateAccount: {
            reference_token_name: refTokenName,
            user_input_index: inputIndices[0],
            account_input_index: inputIndices[1],
            account_output_index: 0n,
        }},
        AccountRedeemer
      ),
      inputs: [user_utxo, account_utxo],
    };

    const tx = yield* lucid
      .newTx()
      .collectFrom([user_utxo])
      .collectFrom([account_utxo], redeemer)
      .pay.ToAddressWithData(accountScriptAddress, { kind: "inline", value: datum }, scriptAssets)
      .pay.ToAddress(address, walletAssets)
      .addSigner(address)
      .attach.SpendingValidator(accountValidator.spendAccount)
      .completeProgram()
      .pipe(Effect.mapError(e => new TransactionBuildError({ operation: "updateAccount", error: String(e) })));
    return tx;
  });
