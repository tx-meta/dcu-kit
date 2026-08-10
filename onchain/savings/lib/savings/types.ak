use cardano/address.{Credential}
use cardano/assets.{AssetName, PolicyId}

// [spec 3.3]: the fund's cycle state. `SharingOut` freezes the share-out
// snapshot at cycle close: `pot` and `shares` are the immutable claim basis;
// `shares_remaining` counts down to fund closure.
pub type FundStatus {
  Active
  SharingOut { pot: Int, shares: Int, shares_remaining: Int }
}

// [spec 3.3]: arrears ladder — permissionless one-step transitions past
// `due` and `due + grace`; the Defaulted record is the standing signal.
pub type LoanStatus {
  Current
  Late
  Defaulted
}

pub type SavingsDatum {
  // [spec 3.3]: the fund anchor — charter, quorum socket, pooled-custody
  // totals. One UTxO per fund; it custodies ALL deposited value.
  SavingsFund {
    title: ByteArray,
    // Fund taxonomy, fixed at creation: 0 ASCA, 1 VSLA, 2 Welfare, 3 Pool.
    // Immutable — a fund cannot change what kind of fund it is, so the audited
    // configuration a member joined under is the one that governs it for life.
    group_type: Int,
    // Ratification authority: native multisig or key today, a vote-tally
    // script (primitive #9) later, by rotation.
    quorum: Credential,
    // The fund's asset ("" policy = ADA); immutable after creation.
    asset_policy: PolicyId,
    asset_name: AssetName,
    // Price of one share unit in base units of the asset; immutable.
    share_value: Int,
    // VSLA-style per-transaction purchase band.
    min_shares_per_deposit: Int,
    max_shares_per_deposit: Int,
    // 0 = locked until share-out (VSLA preset), 1 = flexible (ASCA preset).
    withdrawal_policy: Int,
    // Loan eligibility cap: borrow up to this multiple of own share value.
    // 0 disables lending; 1 (SDK default) = fully self-collateralized.
    max_loan_multiple: Int,
    // Ms after a loan's `due` before Late can become Defaulted (copied into
    // each loan at disbursement — arrears terms are fixed like the charge).
    loan_grace: Int,
    // CloseCycle is invalid before this bound (None = quorum decides).
    cycle_end: Option<Int>,
    // The load-bearing aggregate: sum of all members' share units.
    shares_total: Int,
    // Always shares_total * share_value — tracked for cheap invariants.
    savings_total: Int,
    // The welfare fund; never part of the share-out pot.
    social_total: Int,
    // Total principal currently lent out; always equals the sum of live
    // loans' `outstanding` and of member `borrowed` fields.
    loans_outstanding: Int,
    status: FundStatus,
  }
  // [spec 3.3]: one CIP-68 reference UTxO per member. No PII, ever —
  // balances, flags, and identifiers only.
  MemberAccount {
    // The Fund State NFT token name this account belongs to.
    fund_id: AssetName,
    // The member's current share units (the balance module #8 will read).
    share_units: Int,
    // Cumulative social-fund contributions (history; never redeemable).
    social_paid: Int,
    // Outstanding loan principal (0 = no active loan). Locks the shares
    // backing it: withdrawals must leave borrowed <= multiple * share value.
    borrowed: Int,
    // Standing-layer event-capture consent (credentials, not scores).
    consent: Bool,
    joined_at: Int,
  }
  // [spec 3.3]: one record per active loan — the loan book entry. Holds
  // only min-ADA + the Loan State NFT; principal lives in the borrower's
  // wallet, the claim in this datum.
  LoanAccount {
    // The Fund State NFT token name this loan belongs to.
    fund_id: AssetName,
    // The borrower's member (100) reference-token name.
    borrower_ref: AssetName,
    principal: Int,
    // Remaining principal; repayments reduce it.
    outstanding: Int,
    // Flat charge fixed at disbursement (never compounds).
    service_charge: Int,
    // Charge repaid so far (income — flows to the pot).
    charge_paid: Int,
    // POSIX ms repayment deadline.
    due: Int,
    // Ms after `due` before Late -> Defaulted; fixed at disbursement.
    grace: Int,
    status: LoanStatus,
  }
}

/// The vault's SPENDING redeemer (ADR-0003 two-family split).
///
/// Every vault UTxO consumed by an operation is spent with this operation's
/// constructor; the heavy validation runs once, in the family withdrawal.
///
/// [security]: the ABI the Governance Gate depends on (ADR-0002). Constructor
/// tags are frozen, and every quorum-controlled operation carries
/// `intent_hash` at FIELD 0. The Gate's `BoundIntent` arm reads exactly that:
/// the target's spend-redeemer constructor and its field 0. Moving the
/// commitment to the family withdrawal, or dropping fields so field 0 no
/// longer exists, would silently void intent binding for all six governed
/// operations. Indices and routing data live on the family withdrawal instead.
pub type SavingsSpendRedeemer {
  // 0 — paired (anchor + member account), direct family.
  Deposit
  // 1 — paired, direct family.
  Withdraw
  // 2 — anchor only, governed family: welfare payment from social_total.
  SocialPayout { intent_hash: ByteArray }
  // 3 — anchor only, governed family: charter fields + quorum rotation.
  UpdateFund { intent_hash: ByteArray }
  // 4 — anchor only, governed family: freeze the share-out snapshot.
  CloseCycle { intent_hash: ByteArray }
  // 5 — paired, direct family: member claims their share of the pot.
  ClaimShareOut
  // 6 — triple (anchor + member + loan creation), governed family.
  DisburseLoan { intent_hash: ByteArray }
  // 7 — triple (anchor + member + loan), direct family.
  RepayLoan
  // 8 — loan only, direct family: advance an overdue loan one status step.
  MarkArrears
  // 9 — triple (anchor + member + loan consumed), governed family.
  WriteOffLoan { intent_hash: ByteArray }
  // 10 — member account only, direct family.
  RemoveAccount
  // 11 — anchor only, governed family: burn the fund, release the residual.
  CloseFund { intent_hash: ByteArray }
}

/// `savings_governed` withdraw-zero family action — the six quorum-authorized
/// operations. Field 0 of every variant is `covered_inputs`: the vault inputs
/// this action validates (the coverage invariant, ADR-0003).
pub type SavingsGovernedAction {
  // 0 — spend tag 2
  SocialPayoutAction {
    covered_inputs: List<Int>,
    fund_input_index: Int,
    fund_output_index: Int,
    payout_output_index: Int,
  }
  // 1 — spend tag 3
  UpdateFundAction {
    covered_inputs: List<Int>,
    fund_input_index: Int,
    fund_output_index: Int,
  }
  // 2 — spend tag 4
  CloseCycleAction {
    covered_inputs: List<Int>,
    fund_input_index: Int,
    fund_output_index: Int,
  }
  // 3 — spend tag 6; also licenses the MintLoan mint.
  DisburseLoanAction {
    covered_inputs: List<Int>,
    fund_input_index: Int,
    member_input_index: Int,
    seed_input_index: Int,
    fund_output_index: Int,
    member_output_index: Int,
    loan_output_index: Int,
  }
  // 4 — spend tag 9; also licenses the BurnLoan mint.
  WriteOffLoanAction {
    covered_inputs: List<Int>,
    fund_input_index: Int,
    member_input_index: Int,
    loan_input_index: Int,
    fund_output_index: Int,
    member_output_index: Int,
  }
  // 5 — spend tag 11; also licenses the BurnFund mint.
  CloseFundAction {
    covered_inputs: List<Int>,
    fund_input_index: Int,
    payout_output_index: Int,
  }
}

/// `savings_direct` withdraw-zero family action — the six operations a member,
/// borrower or anyone with truthful state authorizes directly. Field 0 of every
/// variant is `covered_inputs`.
pub type SavingsDirectAction {
  // 0 — spend tag 0. fund_tag: 0 buys shares, 1 social fund, 2 top-up.
  DepositAction {
    covered_inputs: List<Int>,
    fund_input_index: Int,
    member_input_index: Int,
    fund_output_index: Int,
    member_output_index: Int,
    fund_tag: Int,
  }
  // 1 — spend tag 1
  WithdrawAction {
    covered_inputs: List<Int>,
    fund_input_index: Int,
    member_input_index: Int,
    fund_output_index: Int,
    member_output_index: Int,
  }
  // 2 — spend tag 5
  ClaimShareOutAction {
    covered_inputs: List<Int>,
    fund_input_index: Int,
    member_input_index: Int,
    fund_output_index: Int,
    member_output_index: Int,
  }
  // 3 — spend tag 7; loan_output_index == 99 closes the loan (BurnLoan pairs).
  RepayLoanAction {
    covered_inputs: List<Int>,
    fund_input_index: Int,
    member_input_index: Int,
    loan_input_index: Int,
    fund_output_index: Int,
    member_output_index: Int,
    loan_output_index: Int,
  }
  // 4 — spend tag 8
  MarkArrearsAction {
    covered_inputs: List<Int>,
    loan_input_index: Int,
    loan_output_index: Int,
  }
  // 5 — spend tag 10; also licenses the BurnAccount mint.
  RemoveAccountAction { covered_inputs: List<Int>, member_input_index: Int }
}

pub type SavingsMintRedeemer {
  // One-shot Fund State NFT from the consumed seed input.
  CreateFund { seed_input_index: Int, fund_output_index: Int }
  // Join: CIP-68 pair against a live fund taken as a REFERENCE input.
  // NOTE: fund_ref_index indexes the ledger's SORTED reference-input set.
  MintAccount {
    seed_input_index: Int,
    fund_ref_index: Int,
    ref_output_index: Int,
    user_output_index: Int,
  }
  // One-shot Loan State NFT; runs only with the DisburseLoan anchor spend.
  MintLoan { seed_input_index: Int }
  // Loan NFT burn; authorized by the closing RepayLoan or WriteOffLoan spend.
  BurnLoan
  // Pair burn; authorized by the spend of the member ref UTxO (RemoveAccount).
  BurnAccount
  // Fund State NFT burn; authorized by the spend of the anchor (CloseFund).
  BurnFund
}
