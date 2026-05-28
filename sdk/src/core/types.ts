import { Data } from "@lucid-evolution/lucid";

// --- Account Validator Types ---

export const AccountDatumSchema = Data.Object({
  display_name: Data.Bytes(),
  contact: Data.Bytes(),
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
    CloseAccount: Data.Object({
      reference_token_name: Data.Bytes(),
      user_input_index: Data.Integer(),
      account_input_index: Data.Integer(),
    }),
  }),
  Data.Object({
    BurnAccount: Data.Object({
      reference_token_name: Data.Bytes(),
    }),
  }),
]);
export type AccountRedeemer = Data.Static<typeof AccountRedeemerSchema>;
export const AccountRedeemer =
  AccountRedeemerSchema as unknown as AccountRedeemer;

// --- Group Validator Types ---

export const GroupDatumSchema = Data.Object({
  contribution_fee_policyid: Data.Bytes(),
  contribution_fee_assetname: Data.Bytes(),
  contribution_fee: Data.Integer(),
  joining_fee_policyid: Data.Bytes(),
  joining_fee_assetname: Data.Bytes(),
  joining_fee: Data.Integer(),
  penalty_fee_policyid: Data.Bytes(),
  penalty_fee_assetname: Data.Bytes(),
  penalty_fee: Data.Integer(),
  grace_period_length: Data.Integer(),
  creator_bond: Data.Integer(),
  interval_length: Data.Integer(),
  num_rounds: Data.Integer(),
  max_members: Data.Integer(),
  member_count: Data.Integer(),
  is_active: Data.Boolean(),
  is_started: Data.Boolean(),
  start_time: Data.Integer(),
  last_distributed_round: Data.Integer(),
  creator_payment_credential: Data.Bytes(),
  member_token_names: Data.Array(Data.Bytes()),
});

export type GroupDatum = Data.Static<typeof GroupDatumSchema>;
export const GroupDatum = GroupDatumSchema as unknown as GroupDatum;

// CIP-68 wrapper for the group (100) reference token datum.
// metadata["name"] (key = fromText("name")) is displayed by wallets as the group name.
// Serialises as Constr(0, [map, int, GroupDatum]) per the CIP-68 spec.
export const GroupCip68DatumSchema = Data.Object({
  metadata: Data.Map(Data.Bytes(), Data.Bytes()),
  version: Data.Integer(),
  extra: GroupDatumSchema,
});
export type GroupCip68Datum = Data.Static<typeof GroupCip68DatumSchema>;
export const GroupCip68Datum =
  GroupCip68DatumSchema as unknown as GroupCip68Datum;

export const GroupMintRedeemerSchema = Data.Enum([
  Data.Object({
    CreateGroup: Data.Object({
      input_index: Data.Integer(),
      output_index: Data.Integer(),
    }),
  }),
  Data.Literal("BurnGroup"),
]);

export type GroupMintRedeemer = Data.Static<typeof GroupMintRedeemerSchema>;
export const GroupMintRedeemer =
  GroupMintRedeemerSchema as unknown as GroupMintRedeemer;

export const GroupSpendRedeemerSchema = Data.Enum([
  Data.Object({
    UpdateGroup: Data.Object({
      group_ref_token_name: Data.Bytes(),
      admin_input_index: Data.Integer(),
      group_input_index: Data.Integer(),
      group_output_index: Data.Integer(),
    }),
  }),
  Data.Object({
    CloseGroup: Data.Object({
      group_ref_token_name: Data.Bytes(),
      admin_input_index: Data.Integer(),
      group_input_index: Data.Integer(),
    }),
  }),
  Data.Object({
    Join: Data.Object({
      group_ref_token_name: Data.Bytes(),
      member_token_name: Data.Bytes(),
      group_input_index: Data.Integer(),
      group_output_index: Data.Integer(),
    }),
  }),
  Data.Object({
    Exit: Data.Object({
      group_ref_token_name: Data.Bytes(),
      member_token_name: Data.Bytes(),
      group_input_index: Data.Integer(),
      group_output_index: Data.Integer(),
    }),
  }),
  Data.Object({
    StartGroup: Data.Object({
      group_ref_token_name: Data.Bytes(),
      admin_input_index: Data.Integer(),
      group_input_index: Data.Integer(),
      group_output_index: Data.Integer(),
    }),
  }),
  Data.Object({
    Distribute: Data.Object({
      group_ref_token_name: Data.Bytes(),
      group_input_index: Data.Integer(),
      group_output_index: Data.Integer(),
      round_number: Data.Integer(),
    }),
  }),
  Data.Object({
    NextCycle: Data.Object({
      group_ref_token_name: Data.Bytes(),
      admin_input_index: Data.Integer(),
      group_input_index: Data.Integer(),
      group_output_index: Data.Integer(),
    }),
  }),
]);

export type GroupSpendRedeemer = Data.Static<typeof GroupSpendRedeemerSchema>;
export const GroupSpendRedeemer =
  GroupSpendRedeemerSchema as unknown as GroupSpendRedeemer;

// --- Treasury Validator Types ---

export const TreasuryDatumSchema = Data.Enum([
  Data.Object({
    TreasuryState: Data.Object({
      group_reference_tokenname: Data.Bytes(),
      member_reference_tokenname: Data.Bytes(),
      assigned_slot: Data.Integer(),
      rounds_paid: Data.Integer(),
      is_deferred: Data.Boolean(),
      member_payment_credential: Data.Bytes(),
    }),
  }),
  Data.Object({
    PenaltyState: Data.Object({
      group_reference_tokenname: Data.Bytes(),
      member_reference_tokenname: Data.Bytes(),
    }),
  }),
  Data.Object({
    DefaultState: Data.Object({
      group_reference_tokenname: Data.Bytes(),
      member_reference_tokenname: Data.Bytes(),
      grace_expires_at: Data.Integer(),
      grace_extensions_used: Data.Integer(),
      rounds_paid: Data.Integer(),
    }),
  }),
]);

export type TreasuryDatum = Data.Static<typeof TreasuryDatumSchema>;
export const TreasuryDatum = TreasuryDatumSchema as unknown as TreasuryDatum;

export const TreasuryRedeemerSchema = Data.Enum([
  Data.Object({
    JoinGroup: Data.Object({
      group_ref_input_index: Data.Integer(),
      group_output_index: Data.Integer(),
      member_input_index: Data.Integer(),
      treasury_output_index: Data.Integer(),
    }),
  }),
  Data.Object({
    ClaimPenalty: Data.Object({
      group_input_index: Data.Integer(),
      admin_input_index: Data.Integer(),
    }),
  }),
  Data.Object({
    DistributeRound: Data.Object({
      round_number: Data.Integer(),
      group_ref_input_index: Data.Integer(),
      group_output_index: Data.Integer(),
      treasury_input_indices: Data.Array(Data.Integer()),
      treasury_output_indices: Data.Array(Data.Integer()),
      borrower_output_index: Data.Integer(),
    }),
  }),
  Data.Object({
    ExitGroup: Data.Object({
      group_ref_input_index: Data.Integer(),
      group_output_index: Data.Integer(),
      member_input_index: Data.Integer(),
      treasury_input_index: Data.Integer(),
      penalty_output_index: Data.Integer(),
    }),
  }),
  Data.Object({
    Contribute: Data.Object({
      member_input_index: Data.Integer(),
      treasury_input_index: Data.Integer(),
      treasury_output_index: Data.Integer(),
    }),
  }),
  Data.Object({
    DeferRound: Data.Object({
      round_number: Data.Integer(),
      member_input_index: Data.Integer(),
      treasury_input_index: Data.Integer(),
      treasury_output_index: Data.Integer(),
    }),
  }),
  Data.Object({
    UpdatePayout: Data.Object({
      member_input_index: Data.Integer(),
      treasury_input_index: Data.Integer(),
      treasury_output_index: Data.Integer(),
    }),
  }),
  Data.Object({
    ExtendGrace: Data.Object({
      group_ref_input_index: Data.Integer(),
      admin_input_index: Data.Integer(),
      treasury_input_index: Data.Integer(),
      treasury_output_index: Data.Integer(),
    }),
  }),
  Data.Object({
    NextCycle: Data.Object({
      group_input_index: Data.Integer(),
      group_output_index: Data.Integer(),
      treasury_input_indices: Data.Array(Data.Integer()),
      treasury_output_indices: Data.Array(Data.Integer()),
    }),
  }),
]);

export type TreasuryRedeemer = Data.Static<typeof TreasuryRedeemerSchema>;
export const TreasuryRedeemer =
  TreasuryRedeemerSchema as unknown as TreasuryRedeemer;
