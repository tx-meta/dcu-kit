use aiken/collection/list
use cardano/address.{Script}
use cardano/transaction.{InlineDatum, Input, Transaction}
use dcu/group.{GroupCip68Datum}
use dcu/reserve.{
  validate_create_reserve, validate_reserve_close, validate_reserve_cover,
  validate_reserve_refund, validate_reserve_topup,
}
use dcu/settings.{ProtocolSettings}
use dcu/treasury.{TreasuryDatum}
use dcu/treasury_validation.{
  validate_approve_recovery, validate_cancel_recovery, validate_claim_payout,
  validate_claim_penalty, validate_contribute, validate_execute_recovery,
  validate_exit_treasury, validate_extend_grace, validate_join_treasury,
  validate_propose_recovery, validate_terminate_default, validate_update_payout,
}

// treasury_actions — the withdraw redeemers of the treasury family stake
// validators, and the runners that execute them.
// ─────────────────────────────────────────────────────────────────────────────
// CONVENTION (decoded field-blind by the dispatcher — see dcu/dispatch):
//   1. the FIRST field of every variant is `covered_inputs: List<Int>` — the
//      treasury spending inputs this action validates. Each runner branch
//      re-binds the list to the exact arity and roles its validation covers
//      (`expect [..] = covered_inputs`), so an action can never claim to cover
//      more or fewer inputs than it actually validates.
//   2. the mint-triggering variant of each type is the FIRST constructor
//      (constr tag 0): JoinAction / ProposeAction / CreateAction. The dispatcher
//      mint handler checks the tag.
//
// The heavy validation functions in treasury_validation.ak / reserve.ak are
// UNCHANGED — the runners resolve the covered inputs to the datum / output
// reference / address arguments those functions already take.

/// Lifecycle family — membership and round-cycle operations.
pub type LifecycleAction {
  // Mint-triggering (constr tag 0). Covers no treasury spend (the join tx
  // CREATES the treasury UTxO; a join levy rides as a separate reserve action).
  JoinAction {
    covered_inputs: List<Int>,
    group_ref_input_index: Int,
    group_output_index: Int,
    member_input_index: Int,
    treasury_output_index: Int,
  }
  ExitAction {
    covered_inputs: List<Int>,
    group_ref_input_index: Int,
    group_output_index: Int,
    member_input_index: Int,
    penalty_output_index: Int,
  }
  ContributeAction {
    covered_inputs: List<Int>,
    group_ref_input_index: Int,
    member_input_index: Int,
    treasury_output_index: Int,
  }
  UpdatePayoutAction {
    covered_inputs: List<Int>,
    member_input_index: Int,
    treasury_output_index: Int,
  }
  ExtendGraceAction {
    covered_inputs: List<Int>,
    group_ref_input_index: Int,
    admin_input_index: Int,
    treasury_output_index: Int,
  }
  ClaimPayoutAction {
    covered_inputs: List<Int>,
    group_ref_input_index: Int,
    member_input_index: Int,
    treasury_output_index: Int,
  }
  ClaimPenaltyAction { covered_inputs: List<Int>, admin_input_index: Int }
  TerminateDefaultAction {
    covered_inputs: List<Int>,
    group_ref_input_index: Int,
    group_output_index: Int,
    admin_input_index: Int,
  }
}

/// Recovery family — lost-member identity rotation (quorum + timelock + veto).
pub type RecoveryAction {
  // Mint-triggering (constr tag 0): mints N' for the request UTxO.
  ProposeAction {
    covered_inputs: List<Int>,
    group_ref_input_index: Int,
    request_output_index: Int,
    approver_input_indices: List<Int>,
  }
  ApproveAction {
    covered_inputs: List<Int>,
    group_ref_input_index: Int,
    request_output_index: Int,
    approver_input_index: Int,
  }
  CancelAction { covered_inputs: List<Int> }
  ExecuteAction {
    covered_inputs: List<Int>,
    group_ref_input_index: Int,
    group_output_index: Int,
    member_treasury_output_index: Int,
  }
}

/// Reserve family — the group's mutual reserve pot.
pub type ReserveAction {
  // Mint-triggering (constr tag 0): mints the reserve token in the createGroup tx.
  CreateAction {
    covered_inputs: List<Int>,
    group_output_index: Int,
    reserve_output_index: Int,
  }
  TopUpAction { covered_inputs: List<Int>, reserve_output_index: Int }
  CoverAction {
    covered_inputs: List<Int>,
    group_ref_input_index: Int,
    group_output_index: Int,
    defaulter_input_index: Int,
    reserve_output_index: Int,
  }
  RefundAction {
    covered_inputs: List<Int>,
    group_ref_input_index: Int,
    group_output_index: Int,
    exiting_treasury_input_index: Int,
    reserve_output_index: Int,
  }
  CloseAction { covered_inputs: List<Int>, group_input_index: Int }
}

/// Resolve a covered treasury input: the index must exist and the input must sit
/// at the treasury script.
///
/// [security]: the dispatcher's pin rule already guarantees every SPENT treasury
/// UTxO is covered by its family action; this address assertion closes the
/// converse — an action cannot point its covered_inputs at a non-treasury input
/// (e.g. an attacker-script UTxO with a forged ReserveState datum) and run the
/// family validation against foreign state.
fn covered_treasury_input(
  inputs: List<Input>,
  index: Int,
  settings: ProtocolSettings,
) -> Input {
  expect Some(covered_input) = list.at(inputs, index)
  expect
    covered_input.output.address.payment_credential == Script(
      settings.treasury_policy,
    )
  covered_input
}

fn treasury_datum_of(input: Input) -> TreasuryDatum {
  expect InlineDatum(datum_data) = input.output.datum
  expect treasury_datum: TreasuryDatum = datum_data
  treasury_datum
}

/// Execute a lifecycle action ONCE per tx (withdraw-zero).
pub fn run_lifecycle_action(
  action: LifecycleAction,
  settings: ProtocolSettings,
  self: Transaction,
) -> Bool {
  when action is {
    JoinAction {
      covered_inputs,
      group_ref_input_index,
      group_output_index,
      member_input_index,
      treasury_output_index,
    } -> {
      // [security]: join spends no treasury input — an action claiming coverage
      // here would exempt an unrelated treasury spend from validation.
      expect [] = covered_inputs
      validate_join_treasury(
        settings.treasury_policy,
        settings.account_policy,
        settings.group_policy,
        group_ref_input_index,
        group_output_index,
        member_input_index,
        treasury_output_index,
        self,
      )
    }
    ExitAction {
      covered_inputs,
      group_ref_input_index,
      group_output_index,
      member_input_index,
      penalty_output_index,
    } -> {
      // [security]: exactly the exiting member's treasury UTxO is covered.
      expect [treasury_input_index] = covered_inputs
      let treasury_input = covered_treasury_input(
        self.inputs,
        treasury_input_index,
        settings,
      )
      validate_exit_treasury(
        settings.treasury_policy,
        settings.account_policy,
        settings.group_policy,
        group_ref_input_index,
        group_output_index,
        member_input_index,
        penalty_output_index,
        treasury_input.output.address,
        treasury_datum_of(treasury_input),
        self,
      )
    }
    ContributeAction {
      covered_inputs,
      group_ref_input_index,
      member_input_index,
      treasury_output_index,
    } -> {
      expect [treasury_input_index] = covered_inputs
      let treasury_input = covered_treasury_input(
        self.inputs,
        treasury_input_index,
        settings,
      )
      validate_contribute(
        settings.treasury_policy,
        settings.account_policy,
        settings.group_policy,
        group_ref_input_index,
        member_input_index,
        treasury_output_index,
        treasury_datum_of(treasury_input),
        treasury_input.output_reference,
        self,
      )
    }
    UpdatePayoutAction {
      covered_inputs,
      member_input_index,
      treasury_output_index,
    } -> {
      expect [treasury_input_index] = covered_inputs
      let treasury_input = covered_treasury_input(
        self.inputs,
        treasury_input_index,
        settings,
      )
      validate_update_payout(
        settings.treasury_policy,
        settings.account_policy,
        member_input_index,
        treasury_output_index,
        treasury_datum_of(treasury_input),
        treasury_input.output_reference,
        self,
      )
    }
    ExtendGraceAction {
      covered_inputs,
      group_ref_input_index,
      admin_input_index,
      treasury_output_index,
    } -> {
      expect [treasury_input_index] = covered_inputs
      let treasury_input = covered_treasury_input(
        self.inputs,
        treasury_input_index,
        settings,
      )
      // Read grace_period_length from the group reference input. [security m1]:
      // the ref input must sit at the trusted group script, so a forged "group"
      // cannot supply a bogus grace window length.
      expect Some(group_ref_input) = list.at(
        self.reference_inputs,
        group_ref_input_index,
      )
      expect
        group_ref_input.output.address.payment_credential == Script(
          settings.group_policy,
        )
      expect InlineDatum(gd) = group_ref_input.output.datum
      expect GroupCip68Datum { extra: gd_typed, .. } = gd
      validate_extend_grace(
        settings.treasury_policy,
        settings.group_policy,
        gd_typed.grace_period_length,
        admin_input_index,
        treasury_output_index,
        treasury_datum_of(treasury_input),
        treasury_input.output_reference,
        self,
      )
    }
    ClaimPayoutAction {
      covered_inputs,
      group_ref_input_index,
      member_input_index,
      treasury_output_index,
    } -> {
      expect [treasury_input_index] = covered_inputs
      let treasury_input = covered_treasury_input(
        self.inputs,
        treasury_input_index,
        settings,
      )
      validate_claim_payout(
        settings.treasury_policy,
        settings.account_policy,
        settings.group_policy,
        group_ref_input_index,
        member_input_index,
        treasury_output_index,
        treasury_datum_of(treasury_input),
        treasury_input.output_reference,
        self,
      )
    }
    ClaimPenaltyAction { covered_inputs, admin_input_index } -> {
      expect [treasury_input_index] = covered_inputs
      let treasury_input = covered_treasury_input(
        self.inputs,
        treasury_input_index,
        settings,
      )
      validate_claim_penalty(
        settings.treasury_policy,
        treasury_datum_of(treasury_input),
        settings.group_policy,
        admin_input_index,
        self.inputs,
        self.mint,
      )
    }
    TerminateDefaultAction {
      covered_inputs,
      group_ref_input_index,
      group_output_index,
      admin_input_index,
    } -> {
      expect [treasury_input_index] = covered_inputs
      let treasury_input = covered_treasury_input(
        self.inputs,
        treasury_input_index,
        settings,
      )
      validate_terminate_default(
        settings.treasury_policy,
        settings.group_policy,
        group_ref_input_index,
        group_output_index,
        admin_input_index,
        treasury_input_index,
        treasury_datum_of(treasury_input),
        self,
      )
    }
  }
}

/// Execute a recovery action ONCE per tx (withdraw-zero).
pub fn run_recovery_action(
  action: RecoveryAction,
  settings: ProtocolSettings,
  self: Transaction,
) -> Bool {
  when action is {
    ProposeAction {
      covered_inputs,
      group_ref_input_index,
      request_output_index,
      approver_input_indices,
    } -> {
      // [security]: propose spends no treasury input (it CREATES the request UTxO).
      expect [] = covered_inputs
      validate_propose_recovery(
        settings.treasury_policy,
        settings.account_policy,
        settings.group_policy,
        group_ref_input_index,
        request_output_index,
        approver_input_indices,
        self,
      )
    }
    ApproveAction {
      covered_inputs,
      group_ref_input_index,
      request_output_index,
      approver_input_index,
    } -> {
      // [security]: exactly the RecoveryRequest UTxO is covered.
      expect [request_input_index] = covered_inputs
      let request_input = covered_treasury_input(
        self.inputs,
        request_input_index,
        settings,
      )
      validate_approve_recovery(
        settings.treasury_policy,
        settings.account_policy,
        settings.group_policy,
        group_ref_input_index,
        request_input_index,
        request_output_index,
        approver_input_index,
        request_input.output_reference,
        self,
      )
    }
    CancelAction { covered_inputs } -> {
      expect [request_input_index] = covered_inputs
      let request_input = covered_treasury_input(
        self.inputs,
        request_input_index,
        settings,
      )
      validate_cancel_recovery(
        settings.treasury_policy,
        settings.account_policy,
        request_input_index,
        request_input.output_reference,
        self,
      )
    }
    ExecuteAction {
      covered_inputs,
      group_ref_input_index,
      group_output_index,
      member_treasury_output_index,
    } -> {
      // [security]: BOTH spent treasury UTxOs (request + lost member) are covered.
      expect [request_input_index, member_treasury_input_index] = covered_inputs
      let request_input = covered_treasury_input(
        self.inputs,
        request_input_index,
        settings,
      )
      let member_input = covered_treasury_input(
        self.inputs,
        member_treasury_input_index,
        settings,
      )
      validate_execute_recovery(
        settings.treasury_policy,
        settings.group_policy,
        group_ref_input_index,
        group_output_index,
        request_input_index,
        member_treasury_input_index,
        member_treasury_output_index,
        request_input.output_reference,
        member_input.output_reference,
        self,
      )
    }
  }
}

/// Execute a reserve action ONCE per tx (withdraw-zero).
pub fn run_reserve_action(
  action: ReserveAction,
  settings: ProtocolSettings,
  self: Transaction,
) -> Bool {
  when action is {
    CreateAction { covered_inputs, group_output_index, reserve_output_index } -> {
      // [security]: create spends no treasury input (one-shot with the group mint).
      expect [] = covered_inputs
      validate_create_reserve(
        settings.treasury_policy,
        settings.group_policy,
        group_output_index,
        reserve_output_index,
        self,
      )
    }
    TopUpAction { covered_inputs, reserve_output_index } -> {
      // [security]: exactly the ReserveState UTxO is covered.
      expect [reserve_input_index] = covered_inputs
      let reserve_input = covered_treasury_input(
        self.inputs,
        reserve_input_index,
        settings,
      )
      validate_reserve_topup(
        settings.treasury_policy,
        settings.group_policy,
        reserve_input_index,
        reserve_output_index,
        treasury_datum_of(reserve_input),
        reserve_input.output_reference,
        self,
      )
    }
    CoverAction {
      covered_inputs,
      group_ref_input_index,
      group_output_index,
      defaulter_input_index,
      reserve_output_index,
    } -> {
      // The defaulter's DefaultState input is covered by the lifecycle
      // TerminateDefault action in the same tx — this action covers only the
      // reserve leg.
      expect [reserve_input_index] = covered_inputs
      let reserve_input = covered_treasury_input(
        self.inputs,
        reserve_input_index,
        settings,
      )
      validate_reserve_cover(
        settings.treasury_policy,
        settings.group_policy,
        group_ref_input_index,
        group_output_index,
        defaulter_input_index,
        reserve_input_index,
        reserve_output_index,
        reserve_input.output_reference,
        self,
      )
    }
    RefundAction {
      covered_inputs,
      group_ref_input_index,
      group_output_index,
      exiting_treasury_input_index,
      reserve_output_index,
    } -> {
      // The exiting member's treasury input is covered by the lifecycle Exit
      // action in the same tx — this action covers only the reserve leg.
      expect [reserve_input_index] = covered_inputs
      let reserve_input = covered_treasury_input(
        self.inputs,
        reserve_input_index,
        settings,
      )
      validate_reserve_refund(
        settings.treasury_policy,
        settings.group_policy,
        group_ref_input_index,
        group_output_index,
        exiting_treasury_input_index,
        reserve_input_index,
        reserve_output_index,
        reserve_input.output_reference,
        self,
      )
    }
    CloseAction { covered_inputs, group_input_index } -> {
      expect [reserve_input_index] = covered_inputs
      let reserve_input = covered_treasury_input(
        self.inputs,
        reserve_input_index,
        settings,
      )
      validate_reserve_close(
        settings.treasury_policy,
        settings.group_policy,
        group_input_index,
        reserve_input.output_reference,
        self,
      )
    }
  }
}
