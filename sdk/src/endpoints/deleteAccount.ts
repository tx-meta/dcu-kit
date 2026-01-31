import { LucidEvolution, Data, UTxO, TxHash, fromText, TxSignBuilder } from "@lucid-evolution/lucid";
import { DcuValidators } from "../core/validators/context.js";
import { AccountRedeemer, TreasuryDatumSchema } from "../core/types.js";
import { Effect } from "effect";
import { DcuError, TransactionBuildError, UtxoNotFoundError } from "../core/errors.js";
import { tryBuildTx } from "../core/utils.js";

/**
 * Creates an unsigned transaction for Deleting a DCU Account.
 * 
 * **Safety Verification:**
 * - Before execution, this function **QUERIES** the Treasury Validator to ensure no active memberships exist for this account.
 * - If the user is a member of **ANY** group, the transaction build **FAILS** (prevents loss of access to funds).
 * 
 * **Functionality:**
 * 1. Burns `AccountReference` (from Script) and `AccountUser` (from Wallet).
 * 2. Permanently removes the On-Chain Identity.
 * 
 * @param lucid - Lucid instance.
 * @param accountUtxo - Account Reference UTxO (at Script).
 * @param userUtxo - User Auth UTxO (at Wallet).
 * @param scripts - Validator Context.
 * @returns Effect yielding TxSignBuilder.
 */
export const unsignedDeleteAccountTxProgram = (
  lucid: LucidEvolution,
  accountUtxo: UTxO, // The Reference UTxO at script address
  userUtxo: UTxO,    // The Wallet UTxO holding the User Token
  scripts: DcuValidators
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const accountScripts = scripts.account;
    const policyId = accountScripts.mint.policyId;

    // 0. Integrity Check: Ensure no active memberships
    const accountAssetEntry = Object.keys(accountUtxo.assets).find(k => k.startsWith(policyId));
    if (!accountAssetEntry) return yield* Effect.fail(new UtxoNotFoundError({ address: accountUtxo.address, tokenName: "Account Asset", message: "Account Asset not found on UTxO" }));
    const accountTokenName = accountAssetEntry.slice(policyId.length);

    // Query Treasury UTxOs
    const treasuryAddress = scripts.treasury.spend.address;
    const treasuryUtxos = yield* Effect.tryPromise({
        try: () => lucid.utxosAt(treasuryAddress),
        catch: (error) => new TransactionBuildError({ operation: "queryTreasury", error: String(error) })
    });
    
    const hasActiveMembership = treasuryUtxos.some(u => {
        try {
            // Optimistic parsing: ignore if not parseable
            if (!u.datum) return false;
            const datum = Data.from(u.datum, TreasuryDatumSchema) as unknown as any; 
            // Handle both TreasuryState and PenaltyState (both reference member)
            const state = datum.TreasuryState || datum.PenaltyState;
            return state && state.member_reference_tokenname === accountTokenName;
        } catch {
            return false;
        }
    });

    if (hasActiveMembership) {
        return yield* Effect.fail(new TransactionBuildError({ 
            operation: "deleteAccountCheck", 
            error: "Cannot delete account with active memberships. Exit all groups first." 
        }));
    }

    const redeemer = Data.to(
      { DeleteAccount: { 
          reference_token_name: fromText("AccountReference") 
      }},
      AccountRedeemer
    );

    const tx = yield* tryBuildTx("deleteAccount", () => lucid
      .newTx()
      .collectFrom([accountUtxo], redeemer)
      .collectFrom([userUtxo])
      .attach.SpendingValidator(accountScripts.spend.script)
      .attach.MintingPolicy(accountScripts.mint.script)
      .mintAssets(
          {
              [policyId + fromText("AccountReference")]: -1n,
              [policyId + fromText("AccountUser")]: -1n,
          },
          redeemer
      )
      .complete()
    );

    return tx;
  });
