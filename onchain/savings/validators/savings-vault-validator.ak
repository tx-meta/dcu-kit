use aiken/collection/list
use cardano/address.{Script}
use cardano/assets.{PolicyId}
use cardano/transaction.{Input, OutputReference, Transaction}
use savings/types.{
  BurnAccount, BurnFund, BurnLoan, ClaimShareOut, CloseCycle, CloseFund,
  CreateFund, Deposit, DisburseLoan, LoanAccount, MarkArrears, MemberAccount,
  MintAccount, MintLoan, RemoveAccount, RepayLoan, SavingsDatum, SavingsFund,
  SavingsMintRedeemer, SavingsSpendRedeemer, SocialPayout, UpdateFund, Withdraw,
  WriteOffLoan,
}
use savings/validation.{
  own_input_count_is, validate_burn_account, validate_burn_fund,
  validate_burn_loan, validate_claim_share_out, validate_close_cycle,
  validate_close_fund, validate_create_fund, validate_deposit,
  validate_disburse_loan, validate_mark_arrears, validate_mint_account,
  validate_mint_loan, validate_paired_member, validate_remove_account,
  validate_repay_loan, validate_social_payout, validate_update_fund,
  validate_withdraw, validate_write_off_loan,
}

// MLabs security checklist (2026-07-12, re-run for the loan paths — all 11):
// LOANS — 1 Other Redeemer: loan branches self-validating; the satellite
//   branch handles member AND loan variants; Deposit/Withdraw/Claim reject
//   LoanAccount datums; every non-Disburse spend forbids own-policy mints so
//   MintLoan couples transitively to DisburseLoan. 7 Multiple Satisfaction:
//   triple transitions use count==3 + constructor-distinct expected datums.
//   8 Authentication: loan records carry the shape-checked Loan State NFT.
//   10 Cheap Spam: MarkArrears is permissionless but only advances truthful,
//   time-proven state one step; repayment stays open in every status.
//   Value flow: disburse/repay move EXACTLY principal/repayment; write-off
//   moves nothing (accounting + burn). Input discipline is now 1, 2, or 3
//   own inputs per redeemer.
// Original checklist (2026-07-12, savings paths):
// 1 Other Redeemer — each branch fully self-validating; paired-member light
//   branch is safe because every anchor redeemer that admits two own inputs
//   enforces the full member continuation. 2 Other Token Name — all mints are
//   exact-shape allowlists from seed derivations. 3 Arbitrary Datum — every
//   continuation compared against a fully-constructed expected datum.
// 4 Unbounded Datum — no growing fields; title capped at 64 bytes.
// 5 Unbounded Value — creation pins policies to [ada, own]; transitions move
//   ONLY the fund asset (exact merge). 6 Unbounded Inputs — n/a: no handler
//   iterates unbounded inputs (count discipline: 1 or 2). 7 Multiple
//   Satisfaction — own-input count + constructor-distinct expected datums
//   force distinct continuations. 8 UTxO Authentication — anchor = Fund State
//   NFT (shape-checked), member = CIP-68 (100) token. 9 UTxO Contention —
//   single vault UTxO serializes deposits/claims; ACCEPTED v1 limit
//   (meeting-cadence groups), documented in the spec; joins use a reference
//   input. 10 Cheap Spam — all state paths need the member user token or the
//   quorum; accounts carry min-ADA. 11 Staking Key Control — creations pinned
//   to the canonical no-stake script address; continuations must keep the
//   full input address.

// [security]: self-reference — the indexed input must be the UTxO being spent,
// preventing cross-UTxO attacks that bypass per-UTxO guards.
fn own(inputs: List<Input>, ix: Int, utxo: OutputReference) -> (Input, PolicyId) {
  expect Some(own_input) = list.at(inputs, ix)
  expect own_input.output_reference == utxo
  expect Script(policy_id) = own_input.output.address.payment_credential
  (own_input, policy_id)
}

validator savings_vault {
  mint(redeemer: SavingsMintRedeemer, policy_id: PolicyId, tx: Transaction) {
    let Transaction { inputs, reference_inputs, outputs, mint, .. } = tx

    when redeemer is {
      CreateFund { seed_input_index, fund_output_index } ->
        validate_create_fund(
          policy_id,
          seed_input_index,
          fund_output_index,
          inputs,
          outputs,
          mint,
        )
      MintAccount {
        seed_input_index,
        fund_ref_index,
        ref_output_index,
        user_output_index,
      } ->
        validate_mint_account(
          policy_id,
          seed_input_index,
          fund_ref_index,
          ref_output_index,
          user_output_index,
          inputs,
          reference_inputs,
          outputs,
          mint,
          tx.validity_range,
        )
      MintLoan { seed_input_index } ->
        validate_mint_loan(policy_id, seed_input_index, inputs, mint)
      BurnLoan -> validate_burn_loan(policy_id, mint)
      BurnAccount -> validate_burn_account(policy_id, mint)
      BurnFund -> validate_burn_fund(policy_id, mint)
    }
  }

  spend(
    datum: Option<SavingsDatum>,
    redeemer: SavingsSpendRedeemer,
    utxo: OutputReference,
    self: Transaction,
  ) {
    let Transaction { inputs, outputs, mint, .. } = self

    // [security]: datum must be present — guards against datum-less injection.
    expect Some(savings_datum) = datum

    when redeemer is {
      Deposit {
        fund_input_index,
        member_input_index,
        fund_output_index,
        member_output_index,
        fund_tag,
      } ->
        when savings_datum is {
          SavingsFund { .. } -> {
            let (own_input, policy_id) = own(inputs, fund_input_index, utxo)
            and {
              own_input_count_is(inputs, policy_id, 2),
              validate_deposit(
                policy_id,
                savings_datum,
                own_input,
                member_input_index,
                fund_output_index,
                member_output_index,
                fund_tag,
                inputs,
                outputs,
                mint,
              ),
            }
          }
          MemberAccount { .. } -> {
            let (_own_input, policy_id) = own(inputs, member_input_index, utxo)
            and {
              own_input_count_is(inputs, policy_id, 2),
              validate_paired_member(
                policy_id,
                savings_datum,
                fund_input_index,
                inputs,
              ),
            }
          }
          LoanAccount { .. } -> False
        }

      Withdraw {
        fund_input_index,
        member_input_index,
        fund_output_index,
        member_output_index,
      } ->
        when savings_datum is {
          SavingsFund { .. } -> {
            let (own_input, policy_id) = own(inputs, fund_input_index, utxo)
            and {
              own_input_count_is(inputs, policy_id, 2),
              validate_withdraw(
                policy_id,
                savings_datum,
                own_input,
                member_input_index,
                fund_output_index,
                member_output_index,
                inputs,
                outputs,
                mint,
              ),
            }
          }
          MemberAccount { .. } -> {
            let (_own_input, policy_id) = own(inputs, member_input_index, utxo)
            and {
              own_input_count_is(inputs, policy_id, 2),
              validate_paired_member(
                policy_id,
                savings_datum,
                fund_input_index,
                inputs,
              ),
            }
          }
          LoanAccount { .. } -> False
        }

      ClaimShareOut {
        fund_input_index,
        member_input_index,
        fund_output_index,
        member_output_index,
      } ->
        when savings_datum is {
          SavingsFund { .. } -> {
            let (own_input, policy_id) = own(inputs, fund_input_index, utxo)
            and {
              own_input_count_is(inputs, policy_id, 2),
              validate_claim_share_out(
                policy_id,
                savings_datum,
                own_input,
                member_input_index,
                fund_output_index,
                member_output_index,
                inputs,
                outputs,
                mint,
              ),
            }
          }
          MemberAccount { .. } -> {
            let (_own_input, policy_id) = own(inputs, member_input_index, utxo)
            and {
              own_input_count_is(inputs, policy_id, 2),
              validate_paired_member(
                policy_id,
                savings_datum,
                fund_input_index,
                inputs,
              ),
            }
          }
          LoanAccount { .. } -> False
        }

      SocialPayout { fund_input_index, fund_output_index } -> {
        let (own_input, policy_id) = own(inputs, fund_input_index, utxo)
        and {
          own_input_count_is(inputs, policy_id, 1),
          validate_social_payout(
            policy_id,
            savings_datum,
            own_input,
            fund_output_index,
            outputs,
            mint,
            self,
          ),
        }
      }

      UpdateFund { fund_input_index, fund_output_index } -> {
        let (own_input, policy_id) = own(inputs, fund_input_index, utxo)
        and {
          own_input_count_is(inputs, policy_id, 1),
          validate_update_fund(
            policy_id,
            savings_datum,
            own_input,
            fund_output_index,
            outputs,
            mint,
            self,
          ),
        }
      }

      CloseCycle { fund_input_index, fund_output_index } -> {
        let (own_input, policy_id) = own(inputs, fund_input_index, utxo)
        and {
          own_input_count_is(inputs, policy_id, 1),
          validate_close_cycle(
            policy_id,
            savings_datum,
            own_input,
            fund_output_index,
            outputs,
            mint,
            self,
          ),
        }
      }

      DisburseLoan {
        fund_input_index,
        member_input_index,
        seed_input_index,
        fund_output_index,
        member_output_index,
        loan_output_index,
      } ->
        when savings_datum is {
          SavingsFund { .. } -> {
            let (own_input, policy_id) = own(inputs, fund_input_index, utxo)
            and {
              own_input_count_is(inputs, policy_id, 2),
              validate_disburse_loan(
                policy_id,
                savings_datum,
                own_input,
                member_input_index,
                seed_input_index,
                fund_output_index,
                member_output_index,
                loan_output_index,
                inputs,
                outputs,
                mint,
                self,
              ),
            }
          }
          MemberAccount { .. } -> {
            let (_own_input, policy_id) = own(inputs, member_input_index, utxo)
            and {
              own_input_count_is(inputs, policy_id, 2),
              validate_paired_member(
                policy_id,
                savings_datum,
                fund_input_index,
                inputs,
              ),
            }
          }
          LoanAccount { .. } -> False
        }

      RepayLoan {
        fund_input_index,
        member_input_index,
        loan_input_index,
        fund_output_index,
        member_output_index,
        loan_output_index,
      } ->
        when savings_datum is {
          SavingsFund { .. } -> {
            let (own_input, policy_id) = own(inputs, fund_input_index, utxo)
            and {
              own_input_count_is(inputs, policy_id, 3),
              validate_repay_loan(
                policy_id,
                savings_datum,
                own_input,
                member_input_index,
                loan_input_index,
                fund_output_index,
                member_output_index,
                loan_output_index,
                inputs,
                outputs,
                mint,
              ),
            }
          }
          MemberAccount { .. } -> {
            let (_own_input, policy_id) = own(inputs, member_input_index, utxo)
            and {
              own_input_count_is(inputs, policy_id, 3),
              validate_paired_member(
                policy_id,
                savings_datum,
                fund_input_index,
                inputs,
              ),
            }
          }
          LoanAccount { .. } -> {
            let (_own_input, policy_id) = own(inputs, loan_input_index, utxo)
            and {
              own_input_count_is(inputs, policy_id, 3),
              validate_paired_member(
                policy_id,
                savings_datum,
                fund_input_index,
                inputs,
              ),
            }
          }
        }

      MarkArrears { loan_input_index, loan_output_index } -> {
        let (own_input, policy_id) = own(inputs, loan_input_index, utxo)
        and {
          own_input_count_is(inputs, policy_id, 1),
          validate_mark_arrears(
            policy_id,
            savings_datum,
            own_input,
            loan_output_index,
            outputs,
            mint,
            self,
          ),
        }
      }

      WriteOffLoan {
        fund_input_index,
        member_input_index,
        loan_input_index,
        fund_output_index,
        member_output_index,
      } ->
        when savings_datum is {
          SavingsFund { .. } -> {
            let (own_input, policy_id) = own(inputs, fund_input_index, utxo)
            and {
              own_input_count_is(inputs, policy_id, 3),
              validate_write_off_loan(
                policy_id,
                savings_datum,
                own_input,
                member_input_index,
                loan_input_index,
                fund_output_index,
                member_output_index,
                inputs,
                outputs,
                mint,
                self,
              ),
            }
          }
          MemberAccount { .. } -> {
            let (_own_input, policy_id) = own(inputs, member_input_index, utxo)
            and {
              own_input_count_is(inputs, policy_id, 3),
              validate_paired_member(
                policy_id,
                savings_datum,
                fund_input_index,
                inputs,
              ),
            }
          }
          LoanAccount { .. } -> {
            let (_own_input, policy_id) = own(inputs, loan_input_index, utxo)
            and {
              own_input_count_is(inputs, policy_id, 3),
              validate_paired_member(
                policy_id,
                savings_datum,
                fund_input_index,
                inputs,
              ),
            }
          }
        }

      RemoveAccount { member_input_index } -> {
        let (own_input, policy_id) = own(inputs, member_input_index, utxo)
        and {
          own_input_count_is(inputs, policy_id, 1),
          validate_remove_account(
            policy_id,
            savings_datum,
            own_input,
            inputs,
            mint,
          ),
        }
      }

      CloseFund { fund_input_index } -> {
        let (own_input, policy_id) = own(inputs, fund_input_index, utxo)
        and {
          own_input_count_is(inputs, policy_id, 1),
          validate_close_fund(policy_id, savings_datum, own_input, mint, self),
        }
      }
    }
  }

  // [security]: else branch must fail — no staking withdrawals, certificates,
  // or governance actions from the vault script.
  else(_) {
    fail
  }
}
