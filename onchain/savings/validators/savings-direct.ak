use cardano/address.{Credential}
use cardano/transaction.{Transaction}
use savings/family.{input_datum, open}
use savings/types.{
  ClaimShareOutAction, DepositAction, MarkArrearsAction, RemoveAccountAction,
  RepayLoanAction, SavingsDirectAction, WithdrawAction,
}
use savings/validation.{
  validate_claim_share_out, validate_deposit, validate_mark_arrears,
  validate_remove_account, validate_repay_loan, validate_withdraw,
}

// savings_direct — the withdraw-zero home of the six DIRECTLY authorized
// savings operations (ADR-0003).
// ─────────────────────────────────────────────────────────────────────────────
// Deposit, Withdraw, ClaimShareOut, RepayLoan, MarkArrears, RemoveAccount.
//
// "Direct" is not "unguarded": these operations still enforce member, borrower,
// timing and state authorization, all inside the `validate_*` functions below.
// The split axis is WHO authorizes — the member holding the (222) user token, a
// borrower, or truthful elapsed time — rather than how much is checked. None of
// them is intent-bound, so no arm here reads a commitment.
//
// The heavy validation runs ONCE per transaction here, triggered by a 0-ADA
// withdrawal from this script's stake credential; the vault's thin spend
// handler runs per input and only proves this action covers that input.
validator savings_direct {
  withdraw(
    redeemer: SavingsDirectAction,
    credential: Credential,
    self: Transaction,
  ) {
    when redeemer is {
      DepositAction {
        covered_inputs,
        fund_input_index,
        member_input_index,
        fund_output_index,
        member_output_index,
        fund_tag,
      } -> {
        let (own_input, policy_id, _spend_rdata) = open(
          self,
          credential,
          covered_inputs,
          fund_input_index,
          2,
          0,
        )
        validate_deposit(
          policy_id,
          input_datum(own_input),
          own_input,
          member_input_index,
          fund_output_index,
          member_output_index,
          fund_tag,
          self.inputs,
          self.outputs,
          self.mint,
        )
      }

      WithdrawAction {
        covered_inputs,
        fund_input_index,
        member_input_index,
        fund_output_index,
        member_output_index,
      } -> {
        let (own_input, policy_id, _spend_rdata) = open(
          self,
          credential,
          covered_inputs,
          fund_input_index,
          2,
          1,
        )
        validate_withdraw(
          policy_id,
          input_datum(own_input),
          own_input,
          member_input_index,
          fund_output_index,
          member_output_index,
          self.inputs,
          self.outputs,
          self.mint,
        )
      }

      ClaimShareOutAction {
        covered_inputs,
        fund_input_index,
        member_input_index,
        fund_output_index,
        member_output_index,
      } -> {
        let (own_input, policy_id, _spend_rdata) = open(
          self,
          credential,
          covered_inputs,
          fund_input_index,
          2,
          5,
        )
        validate_claim_share_out(
          policy_id,
          input_datum(own_input),
          own_input,
          member_input_index,
          fund_output_index,
          member_output_index,
          self.inputs,
          self.outputs,
          self.mint,
        )
      }

      RepayLoanAction {
        covered_inputs,
        fund_input_index,
        member_input_index,
        loan_input_index,
        fund_output_index,
        member_output_index,
        loan_output_index,
      } -> {
        let (own_input, policy_id, _spend_rdata) = open(
          self,
          credential,
          covered_inputs,
          fund_input_index,
          3,
          7,
        )
        validate_repay_loan(
          policy_id,
          input_datum(own_input),
          own_input,
          member_input_index,
          loan_input_index,
          fund_output_index,
          member_output_index,
          loan_output_index,
          self.inputs,
          self.outputs,
          self.mint,
        )
      }

      MarkArrearsAction { covered_inputs, loan_input_index, loan_output_index } -> {
        let (own_input, policy_id, _spend_rdata) = open(
          self,
          credential,
          covered_inputs,
          loan_input_index,
          1,
          8,
        )
        validate_mark_arrears(
          policy_id,
          input_datum(own_input),
          own_input,
          loan_output_index,
          self.outputs,
          self.mint,
          self,
        )
      }

      RemoveAccountAction { covered_inputs, member_input_index } -> {
        let (own_input, policy_id, _spend_rdata) = open(
          self,
          credential,
          covered_inputs,
          member_input_index,
          1,
          10,
        )
        validate_remove_account(
          policy_id,
          input_datum(own_input),
          own_input,
          self.inputs,
          self.mint,
        )
      }
    }
  }

  // [security]: else must fail — blocks deregistration certificates (a
  // deregistered credential would brick every direct savings operation until
  // re-registered), governance votes, and proposals from this credential.
  else(_) {
    fail
  }
}
