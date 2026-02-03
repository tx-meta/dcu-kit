
import { LucidEvolution, Data, UTxO, fromText, TxSignBuilder } from "@lucid-evolution/lucid";
import { AccountRedeemer, TreasuryDatumSchema, TreasuryDatum } from "../core/types.js";
import { Effect } from "effect";
import { DcuError, TransactionBuildError, UtxoNotFoundError } from "../core/errors.js";
import { tryBuildTx, getScriptAddress, assetNameLabels, findCip68TokenPair } from "../core/utils/index.js";
import { accountValidator, accountPolicyId, treasuryValidator, treasuryPolicyId } from "../core/validators/constants.js";

// --- Configuration ---

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

    // Derive explicit token names from the provided UTxOs
    const { userTokenName, refTokenName } = yield* findCip68TokenPair([user_utxo, account_utxo], accountPolicyId);

    const treasuryAddress = yield* getScriptAddress(lucid, treasuryValidator.spendTreasury);
    const treasuryUtxos = yield* Effect.tryPromise({
        try: () => lucid.utxosAt(treasuryAddress),
        catch: (error) => new TransactionBuildError({ operation: "queryTreasury", error: String(error) })
    });

    const hasActiveMembership = treasuryUtxos.some(u => {
        try {
            if (!u.datum) return false;
            const datum = Data.from(u.datum, TreasuryDatumSchema) as unknown as TreasuryDatum;
            const state = 'TreasuryState' in datum ? datum.TreasuryState : ('PenaltyState' in datum ? datum.PenaltyState : undefined);
            
            // Rejects if the account has an active seat in a Treasury
            return state && (
                state.member_reference_tokenname === refTokenName || 
                state.member_reference_tokenname === userTokenName
            );
        } catch {
            return false;
        }
    });

    if (hasActiveMembership) {
        return yield* Effect.fail(new TransactionBuildError({ 
            operation: "deleteAccountCheck", 
            error: `Cannot delete account (${userTokenName}) with active membership. Exit all groups first.` 
        }));
    }

    const redeemer = Data.to(
      { DeleteAccount: { 
          reference_token_name: refTokenName
      }},
      AccountRedeemer
    );

    return yield* tryBuildTx("deleteAccount", async () => lucid
      .newTx()
      .collectFrom([account_utxo], redeemer)
      .collectFrom([user_utxo])
      .attach.SpendingValidator(accountValidator.spendAccount)
      .attach.MintingPolicy(accountValidator.mintAccount)
      .mintAssets(
          {
              [accountPolicyId + refTokenName]: -1n,
              [accountPolicyId + userTokenName]: -1n,
          },
          redeemer
      )
      .addSigner(await lucid.wallet().address()) // Add signer for User Auth
      .complete()
    );
  });
