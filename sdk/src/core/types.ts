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

/**
 * Payout delivery mode, fixed at group creation and frozen once members join.
 * - `Push` — DistributeRound pays the borrower a direct wallet output (default, backwards compatible).
 * - `Pull` — DistributeRound earmarks the pot into the borrower's own treasury
 *   (`claimable_balance`); the borrower withdraws it to any address via ClaimPayout.
 *   Solves the lost-wallet problem. Serialises as Constr(0, []) / Constr(1, []).
 */
export const PayoutModeSchema = Data.Enum([
  Data.Literal("Push"),
  Data.Literal("Pull"),
]);
export type PayoutMode = Data.Static<typeof PayoutModeSchema>;
export const PayoutMode = PayoutModeSchema as unknown as PayoutMode;

// --- Protocol Settings (P5 trusted binding) ---
// Datum of the immutable settings UTxO. Holds the trusted policy IDs of the three
// DCU validators, read by the treasury validator (via the singleton settings NFT)
// to authenticate cross-validator inputs. Field order MUST mirror the Aiken
// ProtocolSettings type (account, group, treasury).
export const ProtocolSettingsSchema = Data.Object({
  account_policy: Data.Bytes(),
  group_policy: Data.Bytes(),
  treasury_policy: Data.Bytes(),
});
export type ProtocolSettings = Data.Static<typeof ProtocolSettingsSchema>;
export const ProtocolSettings =
  ProtocolSettingsSchema as unknown as ProtocolSettings;

// --- Credential (mirrors Aiken's cardano/address.Credential) ---
// VerificationKey(hash) = Constr(0, [bytes]) — a wallet payment key hash.
// Script(hash)          = Constr(1, [bytes]) — a native/Plutus script hash (e.g. multisig).
export const CredentialSchema = Data.Enum([
  Data.Object({ VerificationKey: Data.Tuple([Data.Bytes()]) }),
  Data.Object({ Script: Data.Tuple([Data.Bytes()]) }),
]);
export type CredentialD = Data.Static<typeof CredentialSchema>;
export const CredentialD = CredentialSchema as unknown as CredentialD;

export const GroupDatumSchema = Data.Object({
  /** Policy ID of the contribution asset. Empty string (`""`) means ADA (lovelace). */
  contribution_fee_policyid: Data.Bytes(),
  /** Asset name of the contribution asset. Empty string (`""`) means ADA (lovelace). */
  contribution_fee_assetname: Data.Bytes(),
  /** Amount due per round in the contribution asset's smallest unit (lovelace for ADA). */
  contribution_fee: Data.Integer(),
  /** Policy ID of the one-time joining fee asset. Empty string = ADA. */
  joining_fee_policyid: Data.Bytes(),
  /** Asset name of the one-time joining fee asset. Empty string = ADA. */
  joining_fee_assetname: Data.Bytes(),
  /** One-time joining fee in the asset's smallest unit. 0 = no joining fee. */
  joining_fee: Data.Integer(),
  /** Policy ID of the early-exit penalty asset. Empty string = ADA. */
  penalty_fee_policyid: Data.Bytes(),
  /** Asset name of the early-exit penalty asset. Empty string = ADA. */
  penalty_fee_assetname: Data.Bytes(),
  /** Early-exit penalty amount in the asset's smallest unit. */
  penalty_fee: Data.Integer(),
  /** Grace window duration in **POSIX milliseconds**. 0 = immediate DefaultState on shortfall. */
  grace_period_length: Data.Integer(),
  /** ADA locked in the group UTxO at creation (lovelace). Returned on `deleteGroup`. */
  creator_bond: Data.Integer(),
  /**
   * Duration of each rotation slot in **POSIX milliseconds**.
   * @example 300_000n // 5 minutes
   * @example 3_600_000n // 1 hour
   */
  interval_length: Data.Integer(),
  /**
   * Total number of rotation rounds in the current cycle. 0 until `startGroup` seals
   * membership, at which point it is set to `member_count` and frozen for the cycle.
   */
  num_rounds: Data.Integer(),
  /** Maximum number of members allowed. Recommended ≤ 30 to stay within tx execution limits. */
  max_members: Data.Integer(),
  /** Total members in the group (the membership registry size). +1 join, -1 exit/terminate. */
  member_count: Data.Integer(),
  /**
   * Cached count of members currently in `TreasuryState` (contributing). Distribute reads it
   * in O(1) for the pro-rata pot. 0 at creation; set to `member_count` by `startGroup`; +1 on
   * join and contribute-recovery; -1 on exit and per ICS transition in distribute (terminate
   * of a defaulter leaves it unchanged — they already left the active set at ICS).
   */
  active_member_count: Data.Integer(),
  /** False once deactivated by `updateGroup`. Deactivation is one-way — cannot be reversed. */
  is_active: Data.Boolean(),
  /**
   * False at creation; set to true by `startGroup`. One-way latch — no further joins
   * are accepted and `num_rounds` / `start_time` are frozen once true.
   */
  is_started: Data.Boolean(),
  /**
   * ROSCA rotation anchor in **POSIX milliseconds**. 0 until `startGroup` sets it to
   * the transaction's validity lower bound.
   * Round N opens at: `start_time + N * interval_length`
   */
  start_time: Data.Integer(),
  /**
   * Index of the last completed distribution round. -1 before the first distribute;
   * incremented atomically with each `distributeRound` call.
   */
  last_distributed_round: Data.Integer(),
  /**
   * Payment credential of the group creator — `{ VerificationKey: [pkh] }` for a wallet
   * or `{ Script: [hash] }` for a multisig/contract. Joining fees are routed here, so a
   * multisig-governed group can receive fees at the multisig itself.
   */
  creator_payment_credential: CredentialSchema,
  /** On-chain membership registry — one CIP-68 token name per active member. */
  member_token_names: Data.Array(Data.Bytes()),
  /**
   * Rounds' worth of contribution_fee a member must lock at join.
   * 1 = PerRound (traditional, default); max_members = FullUpfront; k = partial.
   * Join floor = contribution_fee × collateral_rounds. Deposits are never capped.
   */
  collateral_rounds: Data.Integer(),
  /**
   * Payout delivery mode (`Push` | `Pull`). Fixed at creation, frozen once members join.
   * See {@link PayoutModeSchema}.
   */
  payout_mode: PayoutModeSchema,
  /** M-of-N member approvals required to authorize a lost-member recovery (absolute count). */
  recovery_threshold: Data.Integer(),
  /** Recovery veto window in **POSIX milliseconds** (propose→execute delay). e.g. 259_200_000n = 3 days. */
  recovery_timelock: Data.Integer(),
  /** Authoritative slot map, parallel to member_token_names ([] whenever !is_started). */
  member_slots: Data.Array(Data.Integer()),
  /** round_number at which the current era's rotation began (re-based at each re-seal). */
  era_start_round: Data.Integer(),
  /** Min POSIX-ms between BeginRecommit and the re-sealing startGroup (opt-out window). */
  recommit_window: Data.Integer(),
  /**
   * One-time amount (in the CONTRIBUTION asset) each joiner pays into the group's
   * mutual reserve at join. 0n = off. Distinct from joining_fee (creator-routed).
   */
  reserve_join_levy: Data.Integer(),
  /**
   * Per contributing member per round (in the CONTRIBUTION asset) routed to the
   * mutual reserve at distribute; the round's pot shrinks by the same total. 0n = off.
   */
  reserve_round_levy: Data.Integer(),
});

/**
 * Group protocol state stored in the CIP-68 (100) reference token datum.
 *
 * ⚠️ This type is wrapped in {@link GroupCip68Datum} on-chain — always decode with
 * `Data.from(datum, GroupCip68Datum)` and access `.extra` for the `GroupDatum`.
 * Decoding directly as `GroupDatum` will throw "Fields do not match".
 */
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
    // Re-admits a recovering member to the active set (active_member_count + 1). Spent
    // atomically with the treasury Contribute recovery (DefaultState -> TreasuryState).
    Recover: Data.Object({
      group_ref_token_name: Data.Bytes(),
      group_input_index: Data.Integer(),
      group_output_index: Data.Integer(),
      treasury_input_index: Data.Integer(),
      treasury_output_index: Data.Integer(),
    }),
  }),
  Data.Object({
    // Lost-member recovery: swaps the membership registry entry old (N) -> new (N')
    // when a member's identity is rotated by treasury ExecuteRecovery in the same tx.
    // member_count and active_member_count frozen. The treasury indices couple this
    // registry edit to a genuine rotation: the named treasury input must hold N and
    // the named treasury output must hold N'.
    RecoverMember: Data.Object({
      group_ref_token_name: Data.Bytes(),
      group_input_index: Data.Integer(),
      group_output_index: Data.Integer(),
      old_member_token_name: Data.Bytes(),
      new_member_token_name: Data.Bytes(),
      treasury_input_index: Data.Integer(),
      treasury_output_index: Data.Integer(),
    }),
  }),
  Data.Object({
    // Opens the opt-out reset window (Recommit): blocks distribute, re-opens joining,
    // makes every exit free; startGroup re-seals after recommit_window elapses.
    BeginRecommit: Data.Object({
      group_ref_token_name: Data.Bytes(),
      admin_input_index: Data.Integer(),
      group_input_index: Data.Integer(),
      group_output_index: Data.Integer(),
      /**
       * The group's reserve UTxO as a REFERENCE input — the clean gate requires
       * standin_rounds == 0n (owed default cover must finish before a reset).
       */
      reserve_ref_input_index: Data.Integer(),
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
      rounds_paid: Data.Integer(),
      member_payment_credential: Data.Bytes(),
      /**
       * Pull mode: pot earmarked for this member to withdraw via ClaimPayout.
       * 0 at join and under Push. Durable until claimed or returned at exit.
       */
      claimable_balance: Data.Integer(),
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
      member_payment_credential: Data.Bytes(),
      /**
       * Pull mode: unclaimed earmark carried in from TreasuryState when the member
       * defaulted. Preserved through the grace window and reconstructed on recovery so
       * the member can still ClaimPayout it. 0 under Push.
       */
      claimable_balance: Data.Integer(),
    }),
  }),
  Data.Object({
    // Pending lost-member recovery. Authenticated by holding exactly the freshly-minted
    // treasury-side token `new_member_tokenname` (N') — same pattern as a treasury UTxO
    // holding its membership token. Consumed by ApproveRecovery (re-created with one more
    // approval), CancelRecovery (veto), or ExecuteRecovery (rotates the lost member's position).
    RecoveryRequest: Data.Object({
      group_reference_tokenname: Data.Bytes(),
      target_token: Data.Bytes(),
      new_member_tokenname: Data.Bytes(),
      new_payment_credential: Data.Bytes(),
      earliest_execution_slot: Data.Integer(),
      approvals: Data.Array(Data.Bytes()),
    }),
  }),
  Data.Object({
    // Mutual reserve pot — exactly one per group, created in the createGroup tx.
    // Identity: holds the reserve token (prefix "RSVE" + the group ref token's
    // unique part) under the treasury policy. Appended LAST (Constr index 4).
    ReserveState: Data.Object({
      group_reference_tokenname: Data.Bytes(),
      /**
       * Remaining fee-units the reserve stands in for terminated defaulters —
       * one unit drawn per distribute round while > 0n (decrements even when the
       * pot is dry). Flat pool: overlapping defaults extend duration, not depth.
       */
      standin_rounds: Data.Integer(),
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
      group_ref_input_index: Data.Integer(),
      admin_input_index: Data.Integer(),
    }),
  }),
  Data.Object({
    // Withdraw-zero coupling: the heavy round validation runs once in the treasury
    // `withdraw` handler (DistributeWithdraw). Each spend only asserts that withdrawal is
    // present, found by its index in the tx redeemer list.
    DistributeRound: Data.Object({
      withdrawal_index: Data.Integer(),
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
      group_ref_input_index: Data.Integer(),
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
    // Pull mode: member withdraws their earmarked payout (claimable_balance).
    ClaimPayout: Data.Object({
      group_ref_input_index: Data.Integer(),
      member_input_index: Data.Integer(),
      treasury_output_index: Data.Integer(),
    }),
  }),
  Data.Object({
    // Admin terminates a defaulter (DefaultState) after grace expires: burns the
    // membership token, decrements member_count (group spent with Exit), forfeits the
    // collateral to the admin. Appended LAST to keep existing Constr indices stable.
    TerminateDefault: Data.Object({
      group_ref_input_index: Data.Integer(),
      group_output_index: Data.Integer(),
      admin_input_index: Data.Integer(),
      treasury_input_index: Data.Integer(),
    }),
  }),
  Data.Object({
    ProposeRecovery: Data.Object({
      group_ref_input_index: Data.Integer(),
      request_output_index: Data.Integer(),
      approver_input_indices: Data.Array(Data.Integer()),
    }),
  }),
  Data.Object({
    ApproveRecovery: Data.Object({
      group_ref_input_index: Data.Integer(),
      request_input_index: Data.Integer(),
      request_output_index: Data.Integer(),
      approver_input_index: Data.Integer(),
    }),
  }),
  Data.Object({
    CancelRecovery: Data.Object({
      request_input_index: Data.Integer(),
    }),
  }),
  Data.Object({
    ExecuteRecovery: Data.Object({
      group_ref_input_index: Data.Integer(),
      group_output_index: Data.Integer(),
      request_input_index: Data.Integer(),
      member_treasury_input_index: Data.Integer(),
      member_treasury_output_index: Data.Integer(),
    }),
  }),
  Data.Object({
    // Mints the group's reserve token + creates the ReserveState UTxO. Valid only
    // in the same tx as the group-creation mint (one-shot coupling). Mint-only.
    CreateReserve: Data.Object({
      group_output_index: Data.Integer(),
      reserve_output_index: Data.Integer(),
    }),
  }),
  Data.Object({
    // Increase-only reserve spend: the join levy leg and voluntary top-ups.
    ReserveTopUp: Data.Object({
      reserve_input_index: Data.Integer(),
      reserve_output_index: Data.Integer(),
    }),
  }),
  Data.Object({
    // Reserve leg of a terminateDefault: forfeit flows in, standin_rounds grows
    // by the defaulter's remaining rounds this lap.
    ReserveCover: Data.Object({
      group_ref_input_index: Data.Integer(),
      group_output_index: Data.Integer(),
      defaulter_input_index: Data.Integer(),
      reserve_input_index: Data.Integer(),
      reserve_output_index: Data.Integer(),
    }),
  }),
  Data.Object({
    // Wind-down refund riding a member exit: at most floor(balance / pre-exit
    // member_count) leaves the pot.
    ReserveRefund: Data.Object({
      group_ref_input_index: Data.Integer(),
      group_output_index: Data.Integer(),
      exiting_treasury_input_index: Data.Integer(),
      reserve_input_index: Data.Integer(),
      reserve_output_index: Data.Integer(),
    }),
  }),
  Data.Object({
    // Closes the reserve in the deleteGroup tx (group ref + reserve tokens burn together).
    ReserveClose: Data.Object({
      group_input_index: Data.Integer(),
    }),
  }),
]);

export type TreasuryRedeemer = Data.Static<typeof TreasuryRedeemerSchema>;
export const TreasuryRedeemer =
  TreasuryRedeemerSchema as unknown as TreasuryRedeemer;

/**
 * Treasury withdraw-validator redeemer (the withdraw-zero coupling). Carried by the 0-ADA
 * reward withdrawal from the treasury's own stake credential; the heavy round validation
 * runs once here instead of per spend input. DistributeWithdraw is the only constructor
 * (NextCycleWithdraw was removed with the continuous-round model), so this is a single-
 * constructor type — encoded as `Constr(0, fields)`, i.e. `Data.Object` (NOT a `Data.Enum`,
 * which Lucid Evolution cannot cast when it has only one variant). Field order must match the
 * Aiken `DistributeWithdraw` constructor exactly.
 */
export const TreasuryWithdrawRedeemerSchema = Data.Object({
  round_number: Data.Integer(),
  group_ref_input_index: Data.Integer(),
  group_output_index: Data.Integer(),
  treasury_input_indices: Data.Array(Data.Integer()),
  treasury_output_indices: Data.Array(Data.Integer()),
  borrower_output_index: Data.Integer(),
});

export type TreasuryWithdrawRedeemer = Data.Static<
  typeof TreasuryWithdrawRedeemerSchema
>;
export const TreasuryWithdrawRedeemer =
  TreasuryWithdrawRedeemerSchema as unknown as TreasuryWithdrawRedeemer;
