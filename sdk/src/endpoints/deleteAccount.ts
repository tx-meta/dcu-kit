
import { LucidEvolution, Data, UTxO, fromText, TxSignBuilder } from "@lucid-evolution/lucid";
import { AccountRedeemer, TreasuryDatumSchema, TreasuryDatum } from "../core/types.js";
import { Effect } from "effect";
import { DcuError, TransactionBuildError, UtxoNotFoundError } from "../core/errors.js";
import { tryBuildTx, getScriptAddress, assetNameLabels, findCip68TokenPair } from "../core/utils/index.js";
import { accountValidator, accountPolicyId, treasuryValidator, treasuryPolicyId } from "../core/validators/constants.js";

// --- Configuration ---

export type DeleteAccountConfig = {
    // Empty config as no specific params are needed beyond context/authorization
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
 * @param config - DeleteAccountConfig (currently placeholder).
 * @returns Effect yielding TxSignBuilder.
 * 
 * @example
 * ```typescript
 * const program = unsignedDeleteAccountTxProgram(lucid, {});
 * ```
 */
export const unsignedDeleteAccountTxProgram = (
  lucid: LucidEvolution,
  _config: DeleteAccountConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const walletUtxos = yield* Effect.tryPromise({
        try: () => lucid.wallet().getUtxos(),
        catch: (e) => new TransactionBuildError({ operation: "getWalletUtxos", error: String(e) })
    });
    
    const accountAddress = yield* getScriptAddress(lucid, accountValidator.spendAccount);
    const scriptUtxos = yield* Effect.tryPromise({
        try: () => lucid.utxosAt(accountAddress),
        catch: (e) => new TransactionBuildError({ operation: "getAccountUtxos", error: String(e) })
    });

    const { userUtxo, userTokenName, refUtxo: accountUtxo, refTokenName } = yield* findCip68TokenPair([...walletUtxos, ...scriptUtxos], accountPolicyId);

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
            
            // Rejects if the account has an active seat in a Treasury (regardless of Ref/User label usage in datum)
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
      .collectFrom([accountUtxo], redeemer)
      .collectFrom([userUtxo])
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
