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

pub type SavingsSpendRedeemer {
  // Paired (anchor + member account): tag 0 = buy shares, 1 = social fund,
  // 2 = untagged top-up (penalties, donations, future #8 interest).
  Deposit {
    fund_input_index: Int,
    member_input_index: Int,
    fund_output_index: Int,
    member_output_index: Int,
    fund_tag: Int,
  }
  // Paired: sell units back pre-close (withdrawal_policy 1 only).
  Withdraw {
    fund_input_index: Int,
    member_input_index: Int,
    fund_output_index: Int,
    member_output_index: Int,
  }
  // Anchor only, quorum: welfare payment from social_total.
  SocialPayout { fund_input_index: Int, fund_output_index: Int }
  // Anchor only, quorum: mutable charter fields + quorum rotation.
  UpdateFund { fund_input_index: Int, fund_output_index: Int }
  // Anchor only, quorum: freeze the share-out snapshot; moves no value.
  CloseCycle { fund_input_index: Int, fund_output_index: Int }
  // Paired: member claims pot * share_units / shares (floor).
  ClaimShareOut {
    fund_input_index: Int,
    member_input_index: Int,
    fund_output_index: Int,
    member_output_index: Int,
  }
  // Triple (anchor + member + loan creation), quorum AND borrower: loan
  // origination. Principal to the borrower; the record to the vault.
  DisburseLoan {
    fund_input_index: Int,
    member_input_index: Int,
    seed_input_index: Int,
    fund_output_index: Int,
    member_output_index: Int,
    loan_output_index: Int,
  }
  // Triple (anchor + member + loan), borrower: repay principal + charge.
  // loan_output_index == 99 closes the loan (BurnLoan pairs).
  RepayLoan {
    fund_input_index: Int,
    member_input_index: Int,
    loan_input_index: Int,
    fund_output_index: Int,
    member_output_index: Int,
    loan_output_index: Int,
  }
  // Loan only, permissionless: advance an overdue loan one status step.
  MarkArrears { loan_input_index: Int, loan_output_index: Int }
  // Triple (anchor + member + loan consumed), quorum: close a Defaulted
  // loan — seize shares first, socialize the remainder. BurnLoan pairs.
  WriteOffLoan {
    fund_input_index: Int,
    member_input_index: Int,
    loan_input_index: Int,
    fund_output_index: Int,
    member_output_index: Int,
  }
  // Member account only, standalone (works after fund closure): exit with a
  // zero balance; paired with the BurnAccount mint.
  RemoveAccount { member_input_index: Int }
  // Anchor only, quorum, shares_remaining == 0: paired with BurnFund.
  CloseFund { fund_input_index: Int }
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
