use aiken/crypto.{ScriptHash}
use cardano/assets.{PolicyId}
use cardano/transaction.{OutputReference, Transaction}
use savings/dispatch.{action_binds_own_input, action_tag_is}
use savings/types.{
  BurnAccount, BurnFund, BurnLoan, ClaimShareOut, CloseCycle, CloseFund,
  CreateFund, Deposit, DisburseLoan, MarkArrears, MintAccount, MintLoan,
  RemoveAccount, RepayLoan, SavingsDatum, SavingsMintRedeemer,
  SavingsSpendRedeemer, SocialPayout, UpdateFund, Withdraw, WriteOffLoan,
}
use savings/validation.{
  validate_burn_account, validate_burn_fund, validate_burn_loan,
  validate_create_fund, validate_mint_account, validate_mint_loan,
}

// savings_vault(governed_stake, direct_stake) — the DISPATCHER (ADR-0003)
// ─────────────────────────────────────────────────────────────────────────────
// The policy/payment identity of the savings module: fund, account and loan
// tokens are minted under this hash, and every vault UTxO sits at its script
// address. It validates NOTHING heavy — all state-transition logic lives in the
// two withdraw-zero family stake validators (`savings_governed`,
// `savings_direct`, whose hashes are compile-time parameters) and runs ONCE per
// transaction in their withdraw handlers.
//
// The split exists because the single validator reached 16,105 bytes against a
// 16,128-byte deployable-reference-script ceiling: it could not take a security
// fix without first being made smaller. See docs/adr/0003.
//
// spend — routes by redeemer constructor to the operation's family and requires
//         that family's action to COVER this UTxO (the pin rule, savings/
//         dispatch). The constructor tags and the field-0 `intent_hash` of the
//         six governed operations are unchanged from ADR-0002, so the
//         Governance Gate reads exactly the bytes it read before the split.
// mint  — every mint and burn proves the licensing family transition runs in
//         the same transaction, by family AND action tag. Without the family
//         check a burn could be attributed to the wrong family; without the tag
//         check any action of that family would license it.
//
// [security]: MLabs checklist entries 1 (Other Redeemer), 7 (Multiple
// Satisfaction) and 8 (UTxO Authentication) are now enforced centrally by
// `savings/family.open` — the covered set must be exactly the vault inputs the
// transaction consumes, duplicate-free, so no vault input is ever spent without
// a family action that validates it. The checklist notes for the individual
// operations remain with their `validate_*` functions in savings/validation.
validator savings_vault(governed_stake: ScriptHash, direct_stake: ScriptHash) {
  mint(redeemer: SavingsMintRedeemer, policy_id: PolicyId, tx: Transaction) {
    let Transaction { inputs, reference_inputs, outputs, mint, redeemers, .. } = tx

    when redeemer is {
      // Fund creation is one-shot and self-contained: the seed input names the
      // NFT and the anchor's zeroed charter is fully checked here.
      CreateFund { seed_input_index, fund_output_index } ->
        validate_create_fund(
          policy_id,
          seed_input_index,
          fund_output_index,
          inputs,
          outputs,
          mint,
        )

      // Joining reads the fund as a REFERENCE input, so it spends no vault
      // UTxO and needs no family transition.
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

      // [security]: the loan NFT exists only as part of an origination — the
      // governed family must be running DisburseLoanAction (tag 3), which
      // validates the loan record, the principal movement and the intent.
      MintLoan { seed_input_index } -> and {
          validate_mint_loan(policy_id, seed_input_index, inputs, mint),
          action_tag_is(governed_stake, redeemers, 3),
        }

      // [security]: a loan NFT burns only when the loan closes — either the
      // borrower repays it in full (direct RepayLoanAction, tag 3) or the
      // quorum writes it off (governed WriteOffLoanAction, tag 4). Those two
      // actions pin WHICH token burns.
      BurnLoan -> and {
          validate_burn_loan(policy_id, mint),
          or {
            action_tag_is(direct_stake, redeemers, 3),
            action_tag_is(governed_stake, redeemers, 4),
          },
        }

      // [security]: a member's CIP-68 pair burns only on RemoveAccountAction
      // (direct, tag 5), which proves the balance and loan are clear.
      BurnAccount -> and {
          validate_burn_account(policy_id, mint),
          action_tag_is(direct_stake, redeemers, 5),
        }

      // [security]: the Fund State NFT burns only on CloseFundAction
      // (governed, tag 5), which pays the whole residual to the committed
      // destination.
      BurnFund -> and {
          validate_burn_fund(policy_id, mint),
          action_tag_is(governed_stake, redeemers, 5),
        }
    }
  }

  spend(
    datum: Option<SavingsDatum>,
    redeemer: SavingsSpendRedeemer,
    utxo: OutputReference,
    self: Transaction,
  ) {
    // [security]: datum must be present — guards against datum-less injection.
    expect Some(_savings_datum) = datum

    // [security]: each vault input is bound to BOTH its family AND that
    // family's action variant. Coverage alone would let a satellite be spent
    // under any other constructor of the same family while the anchor's
    // transition still validated — the redeemer on that input would then not
    // describe the operation, which is the ABI the Governance Gate reads.
    let (family, action_tag) = when redeemer is {
      Deposit -> (direct_stake, 0)
      Withdraw -> (direct_stake, 1)
      ClaimShareOut -> (direct_stake, 2)
      RepayLoan -> (direct_stake, 3)
      MarkArrears -> (direct_stake, 4)
      RemoveAccount -> (direct_stake, 5)
      SocialPayout { .. } -> (governed_stake, 0)
      UpdateFund { .. } -> (governed_stake, 1)
      CloseCycle { .. } -> (governed_stake, 2)
      DisburseLoan { .. } -> (governed_stake, 3)
      WriteOffLoan { .. } -> (governed_stake, 4)
      CloseFund { .. } -> (governed_stake, 5)
    }
    action_binds_own_input(
      family,
      action_tag,
      self.redeemers,
      self.inputs,
      utxo,
    )
  }

  // [security]: else branch must fail — the dispatcher's stake credential is
  // never registered or withdrawn from (the two family validators carry the
  // withdraw-zero role); this blocks unauthorized withdrawals, certificate
  // publications, governance votes, and proposals from the vault credential.
  else(_) {
    fail
  }
}
