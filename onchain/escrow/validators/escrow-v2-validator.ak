use aiken/collection/list
use cardano/address.{Script}
use cardano/assets.{PolicyId}
use cardano/transaction.{Input, OutputReference, Transaction}
use escrow/escrow_v2_validation.{
  only_own_input, validate_abort_v2, validate_amend_milestones,
  validate_burn_escrow_v2, validate_contribute, validate_create_escrow_v2,
  validate_raise_dispute, validate_reclaim_v2, validate_release_v2,
  validate_resolve_dispute, validate_rotate_party, validate_submit_evidence,
  validate_timeout_release,
}
use escrow/types_v2.{
  AbortV2, AmendMilestones, BurnEscrowV2, Contribute, CreateEscrowV2,
  EscrowDatumV2, EscrowV2MintRedeemer, EscrowV2SpendRedeemer, RaiseDispute,
  ReclaimV2, ReleaseV2, ResolveDispute, RotateParty, SubmitEvidence,
  TimeoutReleaseV2,
}

// [security]: self-reference — the indexed input must be the UTxO being spent,
// preventing cross-UTxO attacks that bypass per-UTxO guards.
fn own(
  inputs: List<Input>,
  ix: Int,
  utxo: OutputReference,
) -> (Input, PolicyId) {
  expect Some(own_input) = list.at(inputs, ix)
  expect own_input.output_reference == utxo
  expect Script(policy_id) = own_input.output.address.payment_credential
  (own_input, policy_id)
}

validator escrow_v2_validator {
  mint(redeemer: EscrowV2MintRedeemer, policy_id: PolicyId, tx: Transaction) {
    let Transaction { inputs, outputs, mint, validity_range, .. } = tx

    when redeemer is {
      CreateEscrowV2 { seed_input_index, escrow_output_index } ->
        validate_create_escrow_v2(
          policy_id,
          seed_input_index,
          escrow_output_index,
          inputs,
          outputs,
          mint,
          validity_range,
        )
      BurnEscrowV2 -> validate_burn_escrow_v2(policy_id, mint)
    }
  }

  spend(
    datum: Option<EscrowDatumV2>,
    redeemer: EscrowV2SpendRedeemer,
    utxo: OutputReference,
    self: Transaction,
  ) {
    let Transaction { inputs, outputs, mint, .. } = self

    // [security]: datum must be present — guards against datum-less injection.
    expect Some(escrow_datum) = datum

    when redeemer is {
      ReleaseV2 {
        escrow_input_index,
        continuation_index,
        payout_index,
        funder_index,
      } -> {
        let (own_input, policy_id) = own(inputs, escrow_input_index, utxo)
        only_own_input(policy_id, inputs) && validate_release_v2(
          policy_id,
          escrow_datum,
          own_input,
          continuation_index,
          payout_index,
          funder_index,
          outputs,
          mint,
          self,
        )
      }

      TimeoutReleaseV2 {
        escrow_input_index,
        continuation_index,
        payout_index,
        funder_index,
      } -> {
        let (own_input, policy_id) = own(inputs, escrow_input_index, utxo)
        only_own_input(policy_id, inputs) && validate_timeout_release(
          policy_id,
          escrow_datum,
          own_input,
          continuation_index,
          payout_index,
          funder_index,
          outputs,
          mint,
          self,
        )
      }

      ReclaimV2 { escrow_input_index, refund_index } -> {
        let (own_input, policy_id) = own(inputs, escrow_input_index, utxo)
        only_own_input(policy_id, inputs) && validate_reclaim_v2(
          policy_id,
          escrow_datum,
          own_input,
          refund_index,
          outputs,
          mint,
          self,
        )
      }

      AbortV2 { escrow_input_index } -> {
        let (own_input, policy_id) = own(inputs, escrow_input_index, utxo)
        only_own_input(policy_id, inputs) && validate_abort_v2(
          policy_id,
          escrow_datum,
          own_input,
          mint,
          self,
        )
      }

      Contribute { escrow_input_index, continuation_index } -> {
        let (own_input, policy_id) = own(inputs, escrow_input_index, utxo)
        only_own_input(policy_id, inputs) && validate_contribute(
          policy_id,
          escrow_datum,
          own_input,
          continuation_index,
          outputs,
          self,
        )
      }

      SubmitEvidence {
        escrow_input_index,
        continuation_index,
        milestone_index,
        evidence_hash,
      } -> {
        let (own_input, policy_id) = own(inputs, escrow_input_index, utxo)
        only_own_input(policy_id, inputs) && validate_submit_evidence(
          policy_id,
          escrow_datum,
          own_input,
          continuation_index,
          milestone_index,
          evidence_hash,
          outputs,
          self,
        )
      }

      RotateParty { escrow_input_index, continuation_index, party } -> {
        let (own_input, policy_id) = own(inputs, escrow_input_index, utxo)
        only_own_input(policy_id, inputs) && validate_rotate_party(
          policy_id,
          escrow_datum,
          own_input,
          continuation_index,
          party,
          outputs,
          self,
        )
      }

      AmendMilestones {
        escrow_input_index,
        continuation_index,
        funder_index,
      } -> {
        let (own_input, policy_id) = own(inputs, escrow_input_index, utxo)
        only_own_input(policy_id, inputs) && validate_amend_milestones(
          policy_id,
          escrow_datum,
          own_input,
          continuation_index,
          funder_index,
          outputs,
          self,
        )
      }

      RaiseDispute { escrow_input_index, continuation_index } -> {
        let (own_input, policy_id) = own(inputs, escrow_input_index, utxo)
        only_own_input(policy_id, inputs) && validate_raise_dispute(
          policy_id,
          escrow_datum,
          own_input,
          continuation_index,
          outputs,
          self,
        )
      }

      ResolveDispute { escrow_input_index } -> {
        let (own_input, policy_id) = own(inputs, escrow_input_index, utxo)
        only_own_input(policy_id, inputs) && validate_resolve_dispute(
          policy_id,
          escrow_datum,
          own_input,
          outputs,
          mint,
          self,
        )
      }
    }
  }

  // [security]: else branch must fail — no staking withdrawals, certificates,
  // or governance actions from the escrow script.
  else(_) {
    fail
  }
}
