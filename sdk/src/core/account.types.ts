import { Data } from "@lucid-evolution/lucid";

export const AccountDatumSchema = Data.Object({
  email_hash: Data.Bytes(),
  phone_hash: Data.Bytes(),
});
export type AccountDatum = Data.Static<typeof AccountDatumSchema>;
export const AccountDatum = AccountDatumSchema as unknown as AccountDatum;

export const AccountRedeemerSchema = Data.Enum([
  Data.Object({
    CreateAccount: Data.Object({
      input_index: Data.Integer(),
      output_index: Data.Integer(),
    }),
  }),
  Data.Object({
    UpdateAccount: Data.Object({
      reference_token_name: Data.Bytes(),
      user_input_index: Data.Integer(),
      account_input_index: Data.Integer(),
      account_output_index: Data.Integer(),
    }),
  }),
  Data.Object({
    RemoveAccount: Data.Object({
      reference_token_name: Data.Bytes(),
      user_input_index: Data.Integer(),
      account_input_index: Data.Integer(),
    }),
  }),
  Data.Object({
    DeleteAccount: Data.Object({
      reference_token_name: Data.Bytes(),
    }),
  }),
]);
export type AccountRedeemer = Data.Static<typeof AccountRedeemerSchema>;
export const AccountRedeemer = AccountRedeemerSchema as unknown as AccountRedeemer;
