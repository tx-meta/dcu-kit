// Fixtures for the ADR-0003 two-family split matrix. The tests themselves live
// in validators/split-tests.ak, because Aiken only lets a module under
// validators/ import a validator module.
use aiken/crypto.{ScriptHash}
use cardano/address.{Address, Credential, Script}
use cardano/assets.{Value}
use cardano/transaction.{
  Input, Output, OutputReference, Redeemer, ScriptPurpose, Spend, Transaction,
  Withdraw,
}
use cardano/transaction as tx
use savings/types.{
  Active, Current, Defaulted, Late, SavingsDatum, SavingsDirectAction,
  SavingsFund, SavingsGovernedAction, SavingsSpendRedeemer, SharingOut,
}
use savings/validation.{
  close_cycle_intent_hash, close_fund_intent_hash, datum_intent_hash,
  social_payout_intent_hash, update_fund_intent_hash, write_off_intent_hash,
}
use tests/common.{
  active_fund, anchor_value, fund_name, loan_name, loan_seed_ref, loan_value,
  make_fund, make_loan, make_member, make_member_borrowed, member_address,
  member_ref_value, policy, quorum_credential, quorum_pkh, range_after,
  range_between, ref_name, seed_input, user_name, user_token_input, vault_input,
  vault_output, wallet_output,
}

// The two family stake-validator hashes the vault is parameterized by. Any
// 28-byte value works: the vault only ever compares them against the purposes
// present in tx.redeemers.
pub fn governed_hash() -> ScriptHash {
  #"90ed90ed90ed90ed90ed90ed90ed90ed90ed90ed90ed90ed90ed90ed"
}

pub fn direct_hash() -> ScriptHash {
  #"d1ecd1ecd1ecd1ecd1ecd1ecd1ecd1ecd1ecd1ecd1ecd1ecd1ecd1ec"
}

/// A script credential that is neither family — the "foreign credential
/// resembling a family" of row R5.
pub fn foreign_hash() -> ScriptHash {
  #"f01ef01ef01ef01ef01ef01ef01ef01ef01ef01ef01ef01ef01ef01e"
}

pub fn governed_cred() -> Credential {
  Script(governed_hash())
}

pub fn direct_cred() -> Credential {
  Script(direct_hash())
}

pub fn spend_pair(
  input: Input,
  redeemer: SavingsSpendRedeemer,
) -> Pair<ScriptPurpose, Redeemer> {
  let d: Data = redeemer
  Pair(Spend(input.output_reference), d)
}

pub fn governed_pair(
  action: SavingsGovernedAction,
) -> Pair<ScriptPurpose, Redeemer> {
  let d: Data = action
  Pair(Withdraw(Script(governed_hash())), d)
}

pub fn direct_pair(action: SavingsDirectAction) -> Pair<ScriptPurpose, Redeemer> {
  let d: Data = action
  Pair(Withdraw(Script(direct_hash())), d)
}

/// A withdrawal redeemer published under a script credential that is neither
/// family (row R5).
pub fn foreign_pair(
  action: SavingsDirectAction,
) -> Pair<ScriptPurpose, Redeemer> {
  let d: Data = action
  Pair(Withdraw(Script(foreign_hash())), d)
}

/// Assembles a transaction. `withdrawals` is given explicitly so the matrix can
/// build the malformed cases (non-zero amount, duplicated credential).
pub fn make_tx(
  inputs: List<Input>,
  outputs: List<Output>,
  mint: Value,
  redeemers: Pairs<ScriptPurpose, Redeemer>,
  withdrawals: Pairs<Credential, Int>,
  signatories: List<ByteArray>,
) -> Transaction {
  Transaction {
    ..tx.placeholder,
    inputs,
    outputs,
    mint,
    redeemers,
    withdrawals,
    extra_signatories: signatories,
    validity_range: range_after(1_700_000_000_000),
  }
}

pub fn spend_purpose(input: Input) -> ScriptPurpose {
  Spend(input.output_reference)
}

/// The zeroed datums the deposit fixture spends, exposed for the vault's thin
/// spend handler (which takes the datum as an argument).
pub fn active_fund_zero() -> SavingsDatum {
  active_fund(0)
}

pub fn zero_member() -> SavingsDatum {
  make_member(0, 0)
}

pub fn with_redeemers(
  t: Transaction,
  redeemers: Pairs<ScriptPurpose, Redeemer>,
) -> Transaction {
  Transaction { ..t, redeemers }
}

pub fn with_withdrawals(
  t: Transaction,
  withdrawals: Pairs<Credential, Int>,
) -> Transaction {
  Transaction { ..t, withdrawals }
}

pub fn with_inputs(t: Transaction, inputs: List<Input>) -> Transaction {
  Transaction { ..t, inputs }
}

// ── the canonical DIRECT operation: a five-unit share deposit ───────────────

pub fn deposit_units() -> Int {
  5
}

pub fn deposit_delta() -> Int {
  deposit_units() * 1_000_000
}

pub fn dep_fund_input() -> Input {
  vault_input(0, vault_output(active_fund(0), anchor_value(2_000_000)))
}

pub fn dep_member_input() -> Input {
  vault_input(1, vault_output(make_member(0, 0), member_ref_value()))
}

pub fn dep_outputs() -> List<Output> {
  [
    vault_output(
      make_fund(0, deposit_units(), deposit_delta(), 0, Active),
      anchor_value(2_000_000 + deposit_delta()),
    ),
    vault_output(make_member(deposit_units(), 0), member_ref_value()),
  ]
}

/// The DepositAction with an explicit covered set, so coverage rows can vary it.
pub fn deposit_action(covered: List<Int>) -> SavingsDirectAction {
  SavingsDirectAction.DepositAction {
    covered_inputs: covered,
    fund_input_index: 0,
    member_input_index: 1,
    fund_output_index: 0,
    member_output_index: 1,
    fund_tag: 0,
  }
}

/// The happy-path deposit transaction: anchor + member spent under one direct
/// withdrawal of exactly 0.
pub fn deposit_tx() -> Transaction {
  make_tx(
    [dep_fund_input(), dep_member_input(), user_token_input()],
    dep_outputs(),
    assets.zero,
    [
      spend_pair(dep_fund_input(), SavingsSpendRedeemer.Deposit),
      spend_pair(dep_member_input(), SavingsSpendRedeemer.Deposit),
      direct_pair(deposit_action([0, 1])),
    ],
    [Pair(direct_cred(), 0)],
    [],
  )
}

// ── the canonical GOVERNED operation: a one-ADA welfare payout ──────────────

pub fn payout_amount() -> Int {
  1_000_000
}

pub fn sp_fund_datum() -> SavingsDatum {
  make_fund(0, 5, 5_000_000, 3_000_000, Active)
}

pub fn sp_fund_input() -> Input {
  vault_input(0, vault_output(sp_fund_datum(), anchor_value(10_000_000)))
}

pub fn sp_payout_address() -> Address {
  member_address()
}

pub fn sp_outputs() -> List<Output> {
  [
    vault_output(
      make_fund(0, 5, 5_000_000, 3_000_000 - payout_amount(), Active),
      anchor_value(10_000_000 - payout_amount()),
    ),
    wallet_output(assets.from_lovelace(payout_amount())),
  ]
}

pub fn sp_intent() -> ByteArray {
  social_payout_intent_hash(sp_payout_address(), payout_amount())
}

pub fn social_payout_action(covered: List<Int>) -> SavingsGovernedAction {
  SavingsGovernedAction.SocialPayoutAction {
    covered_inputs: covered,
    fund_input_index: 0,
    fund_output_index: 0,
    payout_output_index: 1,
  }
}

/// The happy-path welfare payout, with the intent commitment supplied so the
/// intent rows can substitute a wrong one.
pub fn social_payout_tx_with(intent: ByteArray) -> Transaction {
  make_tx(
    [sp_fund_input()],
    sp_outputs(),
    assets.zero,
    [
      spend_pair(
        sp_fund_input(),
        SavingsSpendRedeemer.SocialPayout { intent_hash: intent },
      ),
      governed_pair(social_payout_action([0])),
    ],
    [Pair(governed_cred(), 0)],
    [quorum_pkh()],
  )
}

pub fn social_payout_tx() -> Transaction {
  social_payout_tx_with(sp_intent())
}

/// Row I10: a well-formed commitment whose transition does not match it. The
/// payout output pays the committed amount while the fund releases twice that.
pub fn social_payout_tx_drained(intent: ByteArray) -> Transaction {
  make_tx(
    [sp_fund_input()],
    [
      vault_output(
        make_fund(0, 5, 5_000_000, 3_000_000 - 2 * payout_amount(), Active),
        anchor_value(10_000_000 - 2 * payout_amount()),
      ),
      wallet_output(assets.from_lovelace(payout_amount())),
    ],
    assets.zero,
    [
      spend_pair(
        sp_fund_input(),
        SavingsSpendRedeemer.SocialPayout { intent_hash: intent },
      ),
      governed_pair(social_payout_action([0])),
    ],
    [Pair(governed_cred(), 0)],
    [quorum_pkh()],
  )
}

// ── a second governed operation, for the wrong-constructor rows ─────────────

pub fn uf_fund_input() -> Input {
  vault_input(0, vault_output(active_fund(5), anchor_value(7_000_000)))
}

/// The amended charter: same fund, deposit band widened to 2..50.
pub fn uf_next_fund() -> SavingsDatum {
  expect  
      SavingsFund {
        title,
        group_type,
        quorum,
        asset_policy,
        asset_name,
        share_value,
        withdrawal_policy,
        max_loan_multiple,
        loan_grace,
        cycle_end,
        shares_total,
        savings_total,
        social_total,
        loans_outstanding,
        status,
        ..
      }
    = active_fund(5)
  SavingsFund {
    title,
    group_type,
    quorum,
    asset_policy,
    asset_name,
    share_value,
    min_shares_per_deposit: 2,
    max_shares_per_deposit: 50,
    withdrawal_policy,
    max_loan_multiple,
    loan_grace,
    cycle_end,
    shares_total,
    savings_total,
    social_total,
    loans_outstanding,
    status,
  }
}

pub fn uf_outputs() -> List<Output> {
  [vault_output(uf_next_fund(), anchor_value(7_000_000))]
}

pub fn uf_intent() -> ByteArray {
  expect  
      SavingsFund {
        title,
        quorum,
        min_shares_per_deposit,
        max_shares_per_deposit,
        max_loan_multiple,
        loan_grace,
        cycle_end,
        ..
      }
    = uf_next_fund()
  update_fund_intent_hash(
    title,
    quorum,
    min_shares_per_deposit,
    max_shares_per_deposit,
    max_loan_multiple,
    loan_grace,
    cycle_end,
  )
}

pub fn update_fund_action(covered: List<Int>) -> SavingsGovernedAction {
  SavingsGovernedAction.UpdateFundAction {
    covered_inputs: covered,
    fund_input_index: 0,
    fund_output_index: 0,
  }
}

pub fn update_fund_tx_with(spend: SavingsSpendRedeemer) -> Transaction {
  make_tx(
    [uf_fund_input()],
    uf_outputs(),
    assets.zero,
    [spend_pair(uf_fund_input(), spend), governed_pair(update_fund_action([0]))],
    [Pair(governed_cred(), 0)],
    [quorum_pkh()],
  )
}

pub fn update_fund_tx() -> Transaction {
  update_fund_tx_with(
    SavingsSpendRedeemer.UpdateFund { intent_hash: uf_intent() },
  )
}

// ── a foreign-script input, for the coverage rows ───────────────────────────

pub fn foreign_input(ix: Int) -> Input {
  Input {
    output_reference: OutputReference {
      transaction_id: #"f01e1c40f01e1c40f01e1c40f01e1c40f01e1c40f01e1c40f01e1c40f01e1c40",
      output_index: ix,
    },
    output: Output {
      ..vault_output(make_member(0, 0), member_ref_value()),
      address: address.from_script(foreign_hash()),
    },
  }
}

/// An extra vault UTxO that a transaction consumes but no action covers.
pub fn stray_vault_input(ix: Int) -> Input {
  vault_input(ix, vault_output(make_member(0, 0), member_ref_value()))
}

// ── the remaining ten operations, for the happy-path regression P1 ──────────

/// A flexible (ASCA) fund: withdrawals are permitted before share-out.
pub fn flex_fund(shares: Int) -> SavingsDatum {
  make_fund(1, shares, shares * 1_000_000, 0, Active)
}

pub fn withdraw_action() -> SavingsDirectAction {
  SavingsDirectAction.WithdrawAction {
    covered_inputs: [0, 1],
    fund_input_index: 0,
    member_input_index: 1,
    fund_output_index: 0,
    member_output_index: 1,
  }
}

pub fn withdraw_tx() -> Transaction {
  let anchor = vault_input(
    0,
    vault_output(flex_fund(5), anchor_value(7_000_000)),
  )
  let member = vault_input(
    1,
    vault_output(make_member(5, 0), member_ref_value()),
  )
  make_tx(
    [anchor, member, user_token_input()],
    [
      vault_output(flex_fund(3), anchor_value(5_000_000)),
      vault_output(make_member(3, 0), member_ref_value()),
    ],
    assets.zero,
    [
      spend_pair(anchor, SavingsSpendRedeemer.Withdraw),
      spend_pair(member, SavingsSpendRedeemer.Withdraw),
      direct_pair(
        SavingsDirectAction.WithdrawAction {
          covered_inputs: [0, 1],
          fund_input_index: 0,
          member_input_index: 1,
          fund_output_index: 0,
          member_output_index: 1,
        },
      ),
    ],
    [Pair(direct_cred(), 0)],
    [],
  )
}

/// A fund frozen at share-out: pot 5 ADA over 5 shares, none claimed yet.
pub fn sharing_fund(remaining: Int) -> SavingsDatum {
  make_fund(
    0,
    0,
    0,
    0,
    SharingOut { pot: 5_000_000, shares: 5, shares_remaining: remaining },
  )
}

pub fn claim_action() -> SavingsDirectAction {
  SavingsDirectAction.ClaimShareOutAction {
    covered_inputs: [0, 1],
    fund_input_index: 0,
    member_input_index: 1,
    fund_output_index: 0,
    member_output_index: 1,
  }
}

pub fn claim_share_out_tx() -> Transaction {
  let anchor = vault_input(
    0,
    vault_output(sharing_fund(5), anchor_value(7_000_000)),
  )
  let member = vault_input(
    1,
    vault_output(make_member(5, 0), member_ref_value()),
  )
  make_tx(
    [anchor, member, user_token_input()],
    [
      vault_output(sharing_fund(0), anchor_value(2_000_000)),
      vault_output(make_member(0, 0), member_ref_value()),
    ],
    assets.zero,
    [
      spend_pair(anchor, SavingsSpendRedeemer.ClaimShareOut),
      spend_pair(member, SavingsSpendRedeemer.ClaimShareOut),
      direct_pair(
        SavingsDirectAction.ClaimShareOutAction {
          covered_inputs: [0, 1],
          fund_input_index: 0,
          member_input_index: 1,
          fund_output_index: 0,
          member_output_index: 1,
        },
      ),
    ],
    [Pair(direct_cred(), 0)],
    [],
  )
}

pub fn remove_member_input() -> Input {
  vault_input(0, vault_output(make_member(0, 0), member_ref_value()))
}

pub fn remove_account_action() -> SavingsDirectAction {
  SavingsDirectAction.RemoveAccountAction {
    covered_inputs: [0],
    member_input_index: 0,
  }
}

pub fn remove_account_tx() -> Transaction {
  let member = remove_member_input()
  make_tx(
    [member, user_token_input()],
    [],
    burn_account_pair(),
    [
      spend_pair(member, SavingsSpendRedeemer.RemoveAccount),
      direct_pair(
        SavingsDirectAction.RemoveAccountAction {
          covered_inputs: [0],
          member_input_index: 0,
        },
      ),
    ],
    [Pair(direct_cred(), 0)],
    [],
  )
}

pub fn burn_account_pair() -> Value {
  assets.from_asset(policy(), ref_name(), -1)
    |> assets.merge(assets.from_asset(policy(), user_name(), -1))
}

pub fn mint_loan_nft() -> Value {
  assets.from_asset(policy(), loan_name(), 1)
}

pub fn burn_loan_nft() -> Value {
  assets.from_asset(policy(), loan_name(), -1)
}

pub fn burn_fund_nft() -> Value {
  assets.from_asset(policy(), fund_name(), -1)
}

pub fn mark_arrears_action() -> SavingsDirectAction {
  SavingsDirectAction.MarkArrearsAction {
    covered_inputs: [0],
    loan_input_index: 0,
    loan_output_index: 0,
  }
}

pub fn mark_arrears_tx() -> Transaction {
  let loan = vault_input(
    0,
    vault_output(make_loan(8_000_000, 0, Current), loan_value()),
  )
  Transaction {
    ..make_tx(
      [loan],
      [vault_output(make_loan(8_000_000, 0, Late), loan_value())],
      assets.zero,
      [
        spend_pair(loan, SavingsSpendRedeemer.MarkArrears),
        direct_pair(
          SavingsDirectAction.MarkArrearsAction {
            covered_inputs: [0],
            loan_input_index: 0,
            loan_output_index: 0,
          },
        ),
      ],
      [Pair(direct_cred(), 0)],
      [],
    ),
    validity_range: range_after(1_750_000_000_001),
  }
}

pub fn close_cycle_intent() -> ByteArray {
  close_cycle_intent_hash()
}

pub fn close_cycle_action() -> SavingsGovernedAction {
  SavingsGovernedAction.CloseCycleAction {
    covered_inputs: [0],
    fund_input_index: 0,
    fund_output_index: 0,
  }
}

pub fn close_cycle_tx() -> Transaction {
  let anchor = vault_input(
    0,
    vault_output(active_fund(5), anchor_value(7_000_000)),
  )
  make_tx(
    [anchor],
    [vault_output(sharing_fund(5), anchor_value(7_000_000))],
    assets.zero,
    [
      spend_pair(
        anchor,
        SavingsSpendRedeemer.CloseCycle { intent_hash: close_cycle_intent() },
      ),
      governed_pair(
        SavingsGovernedAction.CloseCycleAction {
          covered_inputs: [0],
          fund_input_index: 0,
          fund_output_index: 0,
        },
      ),
    ],
    [Pair(governed_cred(), 0)],
    [quorum_pkh()],
  )
}

pub fn cf_payout_address() -> Address {
  member_address()
}

pub fn close_fund_intent() -> ByteArray {
  close_fund_intent_hash(cf_payout_address())
}

pub fn close_fund_anchor() -> Input {
  vault_input(0, vault_output(sharing_fund(0), anchor_value(2_000_000)))
}

pub fn close_fund_action() -> SavingsGovernedAction {
  SavingsGovernedAction.CloseFundAction {
    covered_inputs: [0],
    fund_input_index: 0,
    payout_output_index: 0,
  }
}

pub fn close_fund_tx_with(intent: ByteArray) -> Transaction {
  let anchor = close_fund_anchor()
  make_tx(
    [anchor],
    [wallet_output(assets.from_lovelace(2_000_000))],
    burn_fund_nft(),
    [
      spend_pair(anchor, SavingsSpendRedeemer.CloseFund { intent_hash: intent }),
      governed_pair(
        SavingsGovernedAction.CloseFundAction {
          covered_inputs: [0],
          fund_input_index: 0,
          payout_output_index: 0,
        },
      ),
    ],
    [Pair(governed_cred(), 0)],
    [quorum_pkh()],
  )
}

pub fn close_fund_tx() -> Transaction {
  close_fund_tx_with(close_fund_intent())
}

// Loan fixtures mirror lib/tests/vault_loans: a 15-share ADA fund with a
// 3 ADA social balance, lending 8 ADA to a member holding 10 shares.
pub fn loan_fund(loans_outstanding: Int) -> SavingsDatum {
  expect SavingsFund { status, .. } = active_fund(0)
  SavingsFund {
    title: #"546573742046756e64",
    group_type: 0,
    quorum: quorum_credential(),
    asset_policy: "",
    asset_name: "",
    share_value: 1_000_000,
    min_shares_per_deposit: 1,
    max_shares_per_deposit: 100,
    withdrawal_policy: 0,
    max_loan_multiple: 1,
    loan_grace: 604_800_000,
    cycle_end: None,
    shares_total: 15,
    savings_total: 15_000_000,
    social_total: 3_000_000,
    loans_outstanding,
    status,
  }
}

pub fn disburse_intent() -> ByteArray {
  datum_intent_hash(make_loan(8_000_000, 0, Current))
}

pub fn disburse_anchor() -> Input {
  vault_input(0, vault_output(loan_fund(0), anchor_value(22_000_000)))
}

pub fn disburse_member() -> Input {
  vault_input(1, vault_output(make_member(10, 3_000_000), member_ref_value()))
}

pub fn disburse_member_datum() -> SavingsDatum {
  make_member(10, 3_000_000)
}

pub fn disburse_action() -> SavingsGovernedAction {
  SavingsGovernedAction.DisburseLoanAction {
    covered_inputs: [0, 1],
    fund_input_index: 0,
    member_input_index: 1,
    seed_input_index: 3,
    fund_output_index: 0,
    member_output_index: 1,
    loan_output_index: 2,
  }
}

pub fn disburse_tx_with(intent: ByteArray) -> Transaction {
  let anchor = disburse_anchor()
  let member = vault_input(
    1,
    vault_output(make_member(10, 3_000_000), member_ref_value()),
  )
  Transaction {
    ..make_tx(
      [anchor, member, user_token_input(), seed_input(loan_seed_ref())],
      [
        vault_output(loan_fund(8_000_000), anchor_value(14_000_000)),
        vault_output(
          make_member_borrowed(10, 3_000_000, 8_000_000),
          member_ref_value(),
        ),
        vault_output(make_loan(8_000_000, 0, Current), loan_value()),
      ],
      mint_loan_nft(),
      [
        spend_pair(
          anchor,
          SavingsSpendRedeemer.DisburseLoan { intent_hash: intent },
        ),
        spend_pair(
          member,
          SavingsSpendRedeemer.DisburseLoan { intent_hash: intent },
        ),
        governed_pair(
          SavingsGovernedAction.DisburseLoanAction {
            covered_inputs: [0, 1],
            fund_input_index: 0,
            member_input_index: 1,
            seed_input_index: 3,
            fund_output_index: 0,
            member_output_index: 1,
            loan_output_index: 2,
          },
        ),
      ],
      [Pair(governed_cred(), 0)],
      [quorum_pkh()],
    ),
    validity_range: range_between(1_700_000_000_000, 1_700_000_900_000),
  }
}

pub fn disburse_tx() -> Transaction {
  disburse_tx_with(disburse_intent())
}

pub fn repay_action() -> SavingsDirectAction {
  SavingsDirectAction.RepayLoanAction {
    covered_inputs: [0, 1, 2],
    fund_input_index: 0,
    member_input_index: 1,
    loan_input_index: 2,
    fund_output_index: 0,
    member_output_index: 1,
    loan_output_index: 2,
  }
}

pub fn repay_tx() -> Transaction {
  let anchor = vault_input(
    0,
    vault_output(loan_fund(8_000_000), anchor_value(14_000_000)),
  )
  let member = vault_input(
    1,
    vault_output(
      make_member_borrowed(10, 3_000_000, 8_000_000),
      member_ref_value(),
    ),
  )
  let loan = vault_input(
    2,
    vault_output(make_loan(8_000_000, 0, Current), loan_value()),
  )
  make_tx(
    [anchor, member, loan, user_token_input()],
    [
      vault_output(loan_fund(3_000_000), anchor_value(19_400_000)),
      vault_output(
        make_member_borrowed(10, 3_000_000, 3_000_000),
        member_ref_value(),
      ),
      vault_output(make_loan(3_000_000, 400_000, Current), loan_value()),
    ],
    assets.zero,
    [
      spend_pair(anchor, SavingsSpendRedeemer.RepayLoan),
      spend_pair(member, SavingsSpendRedeemer.RepayLoan),
      spend_pair(loan, SavingsSpendRedeemer.RepayLoan),
      direct_pair(
        SavingsDirectAction.RepayLoanAction {
          covered_inputs: [0, 1, 2],
          fund_input_index: 0,
          member_input_index: 1,
          loan_input_index: 2,
          fund_output_index: 0,
          member_output_index: 1,
          loan_output_index: 2,
        },
      ),
    ],
    [Pair(direct_cred(), 0)],
    [],
  )
}

pub fn write_off_intent() -> ByteArray {
  write_off_intent_hash(loan_name())
}

/// Write-off of a fully seizable 3 ADA loan: the member's shares cover it, so
/// nothing is socialized.
pub fn write_off_anchor() -> Input {
  vault_input(0, vault_output(loan_fund(3_000_000), anchor_value(19_400_000)))
}

pub fn write_off_action() -> SavingsGovernedAction {
  SavingsGovernedAction.WriteOffLoanAction {
    covered_inputs: [0, 1, 2],
    fund_input_index: 0,
    member_input_index: 1,
    loan_input_index: 2,
    fund_output_index: 0,
    member_output_index: 1,
  }
}

pub fn write_off_tx_with(intent: ByteArray) -> Transaction {
  let anchor = write_off_anchor()
  let member = vault_input(
    1,
    vault_output(
      make_member_borrowed(10, 3_000_000, 3_000_000),
      member_ref_value(),
    ),
  )
  let loan = vault_input(
    2,
    vault_output(make_loan(3_000_000, 400_000, Defaulted), loan_value()),
  )
  expect SavingsFund { status, .. } = loan_fund(0)
  let fund_after = SavingsFund {
    title: #"546573742046756e64",
    group_type: 0,
    quorum: quorum_credential(),
    asset_policy: "",
    asset_name: "",
    share_value: 1_000_000,
    min_shares_per_deposit: 1,
    max_shares_per_deposit: 100,
    withdrawal_policy: 0,
    max_loan_multiple: 1,
    loan_grace: 604_800_000,
    cycle_end: None,
    shares_total: 12,
    savings_total: 12_000_000,
    social_total: 3_000_000,
    loans_outstanding: 0,
    status,
  }
  make_tx(
    [anchor, member, loan],
    [
      vault_output(fund_after, anchor_value(19_400_000)),
      vault_output(make_member_borrowed(7, 3_000_000, 0), member_ref_value()),
    ],
    burn_loan_nft(),
    [
      spend_pair(
        anchor,
        SavingsSpendRedeemer.WriteOffLoan { intent_hash: intent },
      ),
      spend_pair(
        member,
        SavingsSpendRedeemer.WriteOffLoan { intent_hash: intent },
      ),
      spend_pair(
        loan,
        SavingsSpendRedeemer.WriteOffLoan { intent_hash: intent },
      ),
      governed_pair(
        SavingsGovernedAction.WriteOffLoanAction {
          covered_inputs: [0, 1, 2],
          fund_input_index: 0,
          member_input_index: 1,
          loan_input_index: 2,
          fund_output_index: 0,
          member_output_index: 1,
        },
      ),
    ],
    [Pair(governed_cred(), 0)],
    [quorum_pkh()],
  )
}

pub fn write_off_tx() -> Transaction {
  write_off_tx_with(write_off_intent())
}
