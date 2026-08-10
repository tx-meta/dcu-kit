use cardano/address.{Credential}
use cardano/transaction.{Transaction}
use savings/dispatch.{intent_of}
use savings/family.{input_datum, open}
use savings/types.{
  CloseCycleAction, CloseFundAction, DisburseLoanAction, SavingsGovernedAction,
  SocialPayoutAction, UpdateFundAction, WriteOffLoanAction,
}
use savings/validation.{
  validate_close_cycle_bound, validate_close_fund_bound,
  validate_disburse_loan_bound, validate_social_payout_bound,
  validate_update_fund_bound, validate_write_off_loan_bound,
}

// savings_governed — the withdraw-zero home of the six QUORUM-authorized
// savings operations (ADR-0003).
// ─────────────────────────────────────────────────────────────────────────────
// SocialPayout, UpdateFund, CloseCycle, DisburseLoan, WriteOffLoan, CloseFund.
// These are exactly the ADR-0002 intent-bound set, which is why they share one
// validator: intent verification has a single enforcement path.
//
// The heavy validation runs ONCE per transaction here, triggered by a 0-ADA
// withdrawal from this script's stake credential. The vault's thin spend
// handler runs per input and only proves this action covers that input.
//
// [security]: `family.open` carries the whole coupling — coverage, family
// membership by spend-redeemer constructor tag, and the 0-ADA withdrawal
// discipline. The intent commitment is read from FIELD 0 of the primary's
// SPENDING redeemer (never from this withdrawal redeemer), so the Governance
// Gate's `BoundIntent` arm keeps reading the same bytes it read before the
// split, with no knowledge of the family layout.
validator savings_governed {
  withdraw(
    redeemer: SavingsGovernedAction,
    credential: Credential,
    self: Transaction,
  ) {
    when redeemer is {
      SocialPayoutAction {
        covered_inputs,
        fund_input_index,
        fund_output_index,
        payout_output_index,
      } -> {
        let (own_input, policy_id, spend_rdata) = open(
          self,
          credential,
          covered_inputs,
          fund_input_index,
          1,
          2,
        )
        validate_social_payout_bound(
          policy_id,
          input_datum(own_input),
          own_input,
          intent_of(spend_rdata),
          fund_output_index,
          payout_output_index,
          self.outputs,
          self.mint,
          self,
        )
      }

      UpdateFundAction { covered_inputs, fund_input_index, fund_output_index } -> {
        let (own_input, policy_id, spend_rdata) = open(
          self,
          credential,
          covered_inputs,
          fund_input_index,
          1,
          3,
        )
        validate_update_fund_bound(
          policy_id,
          input_datum(own_input),
          own_input,
          intent_of(spend_rdata),
          fund_output_index,
          self.outputs,
          self.mint,
          self,
        )
      }

      CloseCycleAction { covered_inputs, fund_input_index, fund_output_index } -> {
        let (own_input, policy_id, spend_rdata) = open(
          self,
          credential,
          covered_inputs,
          fund_input_index,
          1,
          4,
        )
        validate_close_cycle_bound(
          policy_id,
          input_datum(own_input),
          own_input,
          intent_of(spend_rdata),
          fund_output_index,
          self.outputs,
          self.mint,
          self,
        )
      }

      DisburseLoanAction {
        covered_inputs,
        fund_input_index,
        member_input_index,
        seed_input_index,
        fund_output_index,
        member_output_index,
        loan_output_index,
      } -> {
        let (own_input, policy_id, spend_rdata) = open(
          self,
          credential,
          covered_inputs,
          fund_input_index,
          2,
          6,
        )
        validate_disburse_loan_bound(
          policy_id,
          input_datum(own_input),
          own_input,
          intent_of(spend_rdata),
          member_input_index,
          seed_input_index,
          fund_output_index,
          member_output_index,
          loan_output_index,
          self.inputs,
          self.outputs,
          self.mint,
          self,
        )
      }

      WriteOffLoanAction {
        covered_inputs,
        fund_input_index,
        member_input_index,
        loan_input_index,
        fund_output_index,
        member_output_index,
      } -> {
        let (own_input, policy_id, spend_rdata) = open(
          self,
          credential,
          covered_inputs,
          fund_input_index,
          3,
          9,
        )
        validate_write_off_loan_bound(
          policy_id,
          input_datum(own_input),
          own_input,
          intent_of(spend_rdata),
          member_input_index,
          loan_input_index,
          fund_output_index,
          member_output_index,
          self.inputs,
          self.outputs,
          self.mint,
          self,
        )
      }

      CloseFundAction { covered_inputs, fund_input_index, payout_output_index } -> {
        let (own_input, policy_id, spend_rdata) = open(
          self,
          credential,
          covered_inputs,
          fund_input_index,
          1,
          11,
        )
        validate_close_fund_bound(
          policy_id,
          input_datum(own_input),
          own_input,
          intent_of(spend_rdata),
          payout_output_index,
          self.outputs,
          self.mint,
          self,
        )
      }
    }
  }

  // [security]: else must fail — blocks deregistration certificates (a
  // deregistered credential would brick every governed savings operation until
  // re-registered), governance votes, and proposals from this credential.
  // Registration itself needs no script witness.
  else(_) {
    fail
  }
}
