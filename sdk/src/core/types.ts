import { Data } from "@lucid-evolution/lucid";

// --- Account Validator Types ---

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
  interval_length: Data.Integer(),
  num_intervals: Data.Integer(),
  member_count: Data.Integer(),
  is_active: Data.Boolean(),
  start_time: Data.Integer(),
});

export type GroupDatum = Data.Static<typeof GroupDatumSchema>;
export const GroupDatum = GroupDatumSchema as unknown as GroupDatum;

export const GroupMintRedeemerSchema = Data.Enum([
  Data.Object({
    CreateGroup: Data.Object({
      input_index: Data.Integer(),
      output_index: Data.Integer(),
    }),
  }),
]);

export type GroupMintRedeemer = Data.Static<typeof GroupMintRedeemerSchema>;
export const GroupMintRedeemer = GroupMintRedeemerSchema as unknown as GroupMintRedeemer;

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
    RemoveGroup: Data.Object({
      group_ref_token_name: Data.Bytes(),
      admin_input_index: Data.Integer(),
      group_input_index: Data.Integer(),
      group_output_index: Data.Integer(),
    }),
  }),
  Data.Object({
    MemberJoin: Data.Object({
      group_ref_token_name: Data.Bytes(),
      group_input_index: Data.Integer(),
      group_output_index: Data.Integer(),
    }),
  }),
  Data.Object({
    MemberExit: Data.Object({
      group_ref_token_name: Data.Bytes(),
      group_input_index: Data.Integer(),
      group_output_index: Data.Integer(),
    }),
  }),
]);

export type GroupSpendRedeemer = Data.Static<typeof GroupSpendRedeemerSchema>;
export const GroupSpendRedeemer = GroupSpendRedeemerSchema as unknown as GroupSpendRedeemer;

// --- Treasury Validator Types ---

export const ContributionSchema = Data.Object({
  claimable_at: Data.Integer(),
  claimable_amount: Data.Integer(),
});
export type Contribution = Data.Static<typeof ContributionSchema>;

export const TreasuryDatumSchema = Data.Enum([
    Data.Object({
        TreasuryState: Data.Object({
            group_reference_tokenname: Data.Bytes(),
            member_reference_tokenname: Data.Bytes(),
            membership_start: Data.Integer(),
            assigned_slot: Data.Integer(),
            contribution_list: Data.Array(ContributionSchema),
            member_payment_credential: Data.Bytes(),
        })
    }),
    Data.Object({
        PenaltyState: Data.Object({
            group_reference_tokenname: Data.Bytes(),
            member_reference_tokenname: Data.Bytes(),
        })
    })
])

export type TreasuryDatum = Data.Static<typeof TreasuryDatumSchema>;
export const TreasuryDatum = TreasuryDatumSchema as unknown as TreasuryDatum;

export const TreasuryRedeemerSchema = Data.Enum([
    Data.Object({
        JoinGroup: Data.Object({
            group_ref_input_index: Data.Integer(),
            group_output_index: Data.Integer(),
            member_input_index: Data.Integer(),
            treasury_output_index: Data.Integer(),
        })
    }),
    Data.Object({
        TerminateGroup: Data.Object({
            group_input_index: Data.Integer(),
            admin_input_index: Data.Integer(),
        })
    }),
    Data.Object({
        DistributePayout: Data.Object({
            group_ref_input_index: Data.Integer(),
            treasury_input_indices: Data.Array(Data.Integer()),
            treasury_output_indices: Data.Array(Data.Integer()),
            borrower_output_index: Data.Integer(),
        })
    }),
    Data.Object({
        ExitGroup: Data.Object({
            group_ref_input_index: Data.Integer(),
            group_output_index: Data.Integer(),
            member_input_index: Data.Integer(),
            treasury_input_index: Data.Integer(),
            penalty_output_index: Data.Integer(),
        })
    }),
    Data.Object({
        MemberWithdraw: Data.Object({
            group_ref_input_index: Data.Integer(),
            member_input_index: Data.Integer(),
            treasury_input_index: Data.Integer(),
            treasury_output_index: Data.Integer(),
            withdrawal_amount: Data.Integer(),
        })
    })
]);

export type TreasuryRedeemer = Data.Static<typeof TreasuryRedeemerSchema>;
export const TreasuryRedeemer = TreasuryRedeemerSchema as unknown as TreasuryRedeemer;
