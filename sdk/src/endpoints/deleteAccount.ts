
import { LucidEvolution, Data, UTxO, TxSignBuilder, RedeemerBuilder, Assets, toUnit } from "@lucid-evolution/lucid";
import { AccountRedeemer, TreasuryDatumSchema, TreasuryDatum } from "../core/types.js";
import { Effect } from "effect";
import { DcuError, TransactionBuildError } from "../core/errors.js";
import { getScriptAddress, findCip68TokenPair, getWalletAddress, parseSafeDatum } from "../core/utils/index.js";
import { accountValidator, accountPolicyId, treasuryValidator } from "../core/validators/constants.js";

// --- Configuration ---

export type DeleteAccountConfig = {
    user_utxo: UTxO;
    account_utxo: UTxO;
};

// --- Endpoint ---

/**
 * Creates an unsigned transaction for deleting a DCU Account.
 *
 * **Functionality:**
 * - Burns the Reference NFT and User Auth token.
 * - Integrity Check: Rejects if the account has active memberships in any groups.
 *
 * @param lucid - Lucid instance with wallet selected.
 * @param config - DeleteAccountConfig containing the specific UTxOs to burn.
 * @returns Effect yielding TxSignBuilder.
 */
export const unsignedDeleteAccountTxProgram = (
  lucid: LucidEvolution,
  config: DeleteAccountConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const { user_utxo, account_utxo } = config;

    const address = yield* getWalletAddress(lucid);
    const { userTokenName, refTokenName } = yield* findCip68TokenPair([user_utxo, account_utxo], accountPolicyId);

    const treasuryAddress = yield* getScriptAddress(lucid, treasuryValidator.spendTreasury);
    const treasuryUtxos = yield* Effect.tryPromise({
        try: () => lucid.utxosAt(treasuryAddress),
        catch: (error) => new TransactionBuildError({ operation: "queryTreasury", error: String(error) })
    });

    const membershipChecks = yield* Effect.all(
        treasuryUtxos.map(u =>
            parseSafeDatum(u.datum, TreasuryDatumSchema).pipe(
                Effect.map(datum => {
                    const d = datum as unknown as TreasuryDatum;
                    const state = 'TreasuryState' in d
                        ? d.TreasuryState
                        : ('PenaltyState' in d ? d.PenaltyState : undefined);
                    return !!state && (
                        state.member_reference_tokenname === refTokenName ||
                        state.member_reference_tokenname === userTokenName
                    );
                }),
                Effect.orElse(() => Effect.succeed(false))
            )
        ),
        { concurrency: "unbounded" }
    );

    if (membershipChecks.some(Boolean)) {
        return yield* Effect.fail(new TransactionBuildError({
            operation: "deleteAccountCheck",
            error: `Cannot delete account (${userTokenName}) with active membership. Exit all groups first.`
        }));
    }

    const refToken = toUnit(accountPolicyId, refTokenName);
    const userToken = toUnit(accountPolicyId, userTokenName);

    const burnAssets: Assets = { [refToken]: -1n, [userToken]: -1n };

    const spendRedeemer: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) => Data.to(
        { RemoveAccount: {
            reference_token_name: refTokenName,
            user_input_index: inputIndices[0],
            account_input_index: inputIndices[1],
        }},
        AccountRedeemer
      ),
      inputs: [user_utxo, account_utxo],
    };

    const mintRedeemer = Data.to(
      { DeleteAccount: { reference_token_name: refTokenName } },
      AccountRedeemer
    );

    const tx = yield* lucid
      .newTx()
      .collectFrom([user_utxo])
      .collectFrom([account_utxo], spendRedeemer)
      .mintAssets(burnAssets, mintRedeemer)
      .addSigner(address)
      .attach.SpendingValidator(accountValidator.spendAccount)
      .attach.MintingPolicy(accountValidator.mintAccount)
      .completeProgram()
      .pipe(Effect.mapError(e => new TransactionBuildError({ operation: "deleteAccount", error: String(e) })));
    return tx;
  });
