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
} from "../core/utils/index.js";
import {
  accountValidator,
  accountPolicyId,
} from "../core/validators/constants.js";
import { fromText } from "@lucid-evolution/lucid";

// --- Configuration ---

export type CreateAccountConfig = {
  selected_out_ref: OutRef;
  // Raw UTF-8 display name (username, ADA Handle, Discord handle, etc.).
  // Defaults to wallet address when omitted.
  display_name?: string;
  // Raw UTF-8 secondary contact identifier.
  // Defaults to wallet address when omitted.
  contact?: string;
};

// --- Endpoint ---

/**
 * Creates an unsigned transaction for creating a DCU Account.
 *
 * **Functionality:**
 * - Mints a unique pair of CIP-68 tokens (Reference + User Auth).
 * - Locks the Reference NFT in the Account Script with the provided datum.
 * - Sends the User Auth NFT to the user's wallet.
 * - Initializes the Account Datum (display_name, contact) on-chain as raw UTF-8.
 *   Both fields default to the wallet address when omitted.
 *
 * @param lucid - Lucid instance with wallet selected.
 * @param config - CreateAccountConfig (UTxO + optional identity fields).
 * @returns Effect yielding TxSignBuilder.
 *
 * @example
 * ```ts
import { createAccount } from "@tx-meta/dcu-sdk";

// Minimal — both fields default to wallet address
const program = createAccount(lucid, { selected_out_ref: utxo });

// With explicit identity
const program = createAccount(lucid, {
  selected_out_ref: utxo,
  display_name: "@alice",
  contact: "alice@dcu.io",
});
```
 */
export const unsignedCreateAccountTxProgram = (
  lucid: LucidEvolution,
  config: CreateAccountConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
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

    const accountDatum: AccountDatum = {
      display_name: fromText(config.display_name ?? address),
      contact: fromText(config.contact ?? address),
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
    return tx;
  });
