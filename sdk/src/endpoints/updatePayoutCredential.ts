import {
  Data,
  LucidEvolution,
  TxSignBuilder,
  RedeemerBuilder,
  paymentCredentialOf,
  toUnit,
} from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { effectiveScriptRefs, ScriptRefs } from "../core/scripts.js";
import { attachFamilyWithdrawal } from "../core/familyWithdraw.js";
import {
  TreasuryDatum,
  TreasuryDatumSchema,
  TreasuryRedeemer,
  LifecycleAction,
} from "../core/types.js";
import { Protocol } from "../core/validators/constants.js";
import {
  DcuError,
  InvalidDatumError,
  TransactionBuildError,
} from "../core/errors.js";
import {
  getWalletAddress,
  parseSafeDatum,
  patchInlineDatum,
  assetNameLabels,
  resolveUtxoByUnit,
} from "../core/utils/index.js";

/**
 * Creates an unsigned transaction for updating the member's payout destination.
 *
 * **Functionality:**
 * - Updates `member_payment_credential` in the treasury UTxO datum.
 * - The new credential is derived from the member's current wallet address (the
 *   account token input's payment key hash), proving wallet control.
 * - All other datum fields are preserved unchanged.
 * - Requires the Account NFT in the wallet for authorization.
 *
 * @param lucid - Lucid instance with wallet selected.
 * @param config - UpdatePayoutCredentialConfig.
 * @returns Effect yielding TxSignBuilder.
 */
export type UpdatePayoutCredentialConfig = {
  accountTokenSuffix: string;
  /** Deployed treasury reference scripts — the treasury no longer fits inline. */
  scriptRefs?: ScriptRefs;
};

export const unsignedUpdatePayoutCredentialTxProgram = (
  protocol: Protocol,
  lucid: LucidEvolution,
  config: UpdatePayoutCredentialConfig,
): Effect.Effect<TxSignBuilder, DcuError, never> =>
  Effect.gen(function* () {
    const {
      treasuryValidator,
      treasuryPolicyId,
      accountPolicyId,
      settingsUnit,
    } = protocol;
    const settingsUtxo = yield* resolveUtxoByUnit(lucid, settingsUnit);
    const { accountTokenSuffix } = config;

    const memberRefName = assetNameLabels.prefix222 + accountTokenSuffix;
    const accountUnit = accountPolicyId + memberRefName;
    const treasuryUnit = treasuryPolicyId + memberRefName;

    const accountUtxoRaw = yield* resolveUtxoByUnit(lucid, accountUnit);
    const treasuryUtxoRaw = yield* resolveUtxoByUnit(lucid, treasuryUnit);
    const accountUtxo = patchInlineDatum(accountUtxoRaw);
    const treasuryUtxo = patchInlineDatum(treasuryUtxoRaw);

    const treasuryDatum = (yield* parseSafeDatum(
      treasuryUtxo.datum,
      TreasuryDatumSchema,
    )) as unknown as TreasuryDatum;
    if (!("TreasuryState" in treasuryDatum)) {
      return yield* Effect.fail(
        new InvalidDatumError({
          field: "treasuryDatum",
          reason: "Expected TreasuryState for UpdatePayoutCredential",
        }),
      );
    }

    const ts = treasuryDatum.TreasuryState;

    // New credential is derived from the current wallet's payment key — the Aiken
    // validator re-derives it from member_input_utxo.address.payment_credential,
    // so the SDK value must match the key that signs the transaction.
    const address = yield* getWalletAddress(lucid);
    const newPkh = paymentCredentialOf(address).hash;
    const memberToken = toUnit(treasuryPolicyId, memberRefName);

    const updatedDatum: TreasuryDatum = {
      TreasuryState: { ...ts, member_payment_credential: newPkh },
    };

    // Treasury split: field-less spend literal; the LIFECYCLE UpdatePayoutAction
    // covers the treasury UTxO being spent.
    const updatePayoutAction: RedeemerBuilder = {
      kind: "selected",
      makeRedeemer: (inputIndices: bigint[]) =>
        Data.to(
          {
            UpdatePayoutAction: {
              covered_inputs: [inputIndices[1]],
              member_input_index: inputIndices[0],
              treasury_output_index: 0n,
            },
          },
          LifecycleAction,
        ),
      inputs: [accountUtxo, treasuryUtxo],
    };

    const baseTx = lucid
      .newTx()
      .collectFrom([accountUtxo])
      .collectFrom([treasuryUtxo], Data.to("UpdatePayout", TreasuryRedeemer))
      .addSigner(address)
      .pay.ToContract(
        treasuryUtxo.address,
        { kind: "inline", value: Data.to(updatedDatum, TreasuryDatum) },
        { lovelace: treasuryUtxo.assets.lovelace, [memberToken]: 1n },
      )
      // Explicitly return the account token to the member rather than letting it
      // dangle into change. The account UTxO carries only min-ADA, so relying on
      // change leaves too little to satisfy the token output's min-ADA once fees are
      // paid; an explicit output forces coin selection to fund it from the wallet.
      .pay.ToAddress(address, { [accountUnit]: 1n })
      .readFrom([settingsUtxo]);

    const scriptRefs = effectiveScriptRefs(config.scriptRefs);
    const network = lucid.config().network!;
    const withValidator = attachFamilyWithdrawal(
      scriptRefs.treasury
        ? baseTx.readFrom([scriptRefs.treasury])
        : baseTx.attach.SpendingValidator(treasuryValidator.spendTreasury),
      protocol,
      network,
      "lifecycle",
      updatePayoutAction,
      scriptRefs,
    );

    const tx = yield* withValidator.completeProgram().pipe(
      Effect.mapError(
        (e) =>
          new TransactionBuildError({
            operation: "updatePayout",
            error: String(e),
          }),
      ),
    );

    return tx;
  });
