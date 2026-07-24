use cardano/address.{VerificationKey}
use cardano/address as addr
use cardano/assets
use cardano/transaction.{Output, Transaction, placeholder}
use escrow/escrow_v2_validation.{
  validate_abort_v2, validate_amend_milestones, validate_contribute,
  validate_rotate_party, validate_submit_evidence,
}
use escrow/types_v2.{
  ArbiterParty, BeneficiaryParty, EscrowDatumV2, FunderParty, Milestone,
  PerMilestone, VerifierParty,
}
use tests/common.{
  beneficiary_address, beneficiary_pkh, escrow_input, funder_address, funder_pkh,
  range_before, seed_token_name, user_output, verifier_pkh,
}
use tests/common_v2.{
  arbiter_pkh, day, escrow_v2_output, escrow_v2_policy, t0, test_v2_datum,
  v2_utxo_value,
}

fn escrow_in(datum: EscrowDatumV2, lovelace: Int) {
  escrow_input(
    0,
    escrow_v2_output(
      escrow_v2_policy(),
      datum,
      v2_utxo_value(escrow_v2_policy(), lovelace),
    ),
  )
}

fn cont_out(datum: EscrowDatumV2, lovelace: Int) -> Output {
  escrow_v2_output(
    escrow_v2_policy(),
    datum,
    v2_utxo_value(escrow_v2_policy(), lovelace),
  )
}

fn tx_signed(signers: List<ByteArray>, outputs: List<Output>) -> Transaction {
  Transaction {
    ..placeholder,
    outputs,
    extra_signatories: signers,
    validity_range: range_before(t0),
  }
}

fn burn_one() {
  assets.from_asset(escrow_v2_policy(), seed_token_name(), -1)
}

// ── Abort ────────────────────────────────────────────────────────────────────

test abort_v2__accepts_co_signed() {
  let datum = test_v2_datum()
  let own = escrow_in(datum, 102_000_000)
  let tx = Transaction {
    ..placeholder,
    mint: burn_one(),
    extra_signatories: [funder_pkh(), beneficiary_pkh()],
  }
  validate_abort_v2(escrow_v2_policy(), datum, own, burn_one(), tx)
}

test abort_v2__rejects_missing_beneficiary_signature() {
  let datum = test_v2_datum()
  let own = escrow_in(datum, 102_000_000)
  let tx = Transaction {
    ..placeholder,
    mint: burn_one(),
    extra_signatories: [funder_pkh()],
  }
  !validate_abort_v2(escrow_v2_policy(), datum, own, burn_one(), tx)
}

// ── Contribute ───────────────────────────────────────────────────────────────

test contribute__accepts_funder_top_up() {
  let datum = EscrowDatumV2 { ..test_v2_datum(), funding_mode: PerMilestone }
  let own = escrow_in(datum, 2_000_000)
  let cont = cont_out(datum, 42_000_000)
  validate_contribute(
    escrow_v2_policy(),
    datum,
    own,
    0,
    [cont],
    tx_signed([funder_pkh()], [cont]),
  )
}

test contribute__rejects_on_upfront() {
  let datum = test_v2_datum()
  let own = escrow_in(datum, 102_000_000)
  let cont = cont_out(datum, 142_000_000)
  !validate_contribute(
    escrow_v2_policy(),
    datum,
    own,
    0,
    [cont],
    tx_signed([funder_pkh()], [cont]),
  )
}

test contribute__rejects_missing_funder_auth() {
  let datum = EscrowDatumV2 { ..test_v2_datum(), funding_mode: PerMilestone }
  let own = escrow_in(datum, 2_000_000)
  let cont = cont_out(datum, 42_000_000)
  !validate_contribute(
    escrow_v2_policy(),
    datum,
    own,
    0,
    [cont],
    tx_signed([beneficiary_pkh()], [cont]),
  )
}

test contribute__rejects_datum_change() {
  let datum = EscrowDatumV2 { ..test_v2_datum(), funding_mode: PerMilestone }
  let own = escrow_in(datum, 2_000_000)
  let cont = cont_out(EscrowDatumV2 { ..datum, released_count: 1 }, 42_000_000)
  !validate_contribute(
    escrow_v2_policy(),
    datum,
    own,
    0,
    [cont],
    tx_signed([funder_pkh()], [cont]),
  )
}

test contribute__rejects_value_decrease() {
  let datum = EscrowDatumV2 { ..test_v2_datum(), funding_mode: PerMilestone }
  let own = escrow_in(datum, 42_000_000)
  let cont = cont_out(datum, 2_000_000)
  !validate_contribute(
    escrow_v2_policy(),
    datum,
    own,
    0,
    [cont],
    tx_signed([funder_pkh()], [cont]),
  )
}

// ── SubmitEvidence ───────────────────────────────────────────────────────────

test evidence__accepts_beneficiary_write() {
  let datum = test_v2_datum()
  let own = escrow_in(datum, 102_000_000)
  let cont = cont_out(
    EscrowDatumV2 { ..datum, evidence: [Some("cid-1"), None, None] },
    102_000_000,
  )
  validate_submit_evidence(
    escrow_v2_policy(),
    datum,
    own,
    0,
    0,
    "cid-1",
    [cont],
    tx_signed([beneficiary_pkh()], [cont]),
  )
}

test evidence__accepts_overwrite_until_released() {
  let datum = EscrowDatumV2 {
    ..test_v2_datum(),
    evidence: [Some("old"), None, None],
  }
  let own = escrow_in(datum, 102_000_000)
  let cont = cont_out(
    EscrowDatumV2 { ..datum, evidence: [Some("new"), None, None] },
    102_000_000,
  )
  validate_submit_evidence(
    escrow_v2_policy(),
    datum,
    own,
    0,
    0,
    "new",
    [cont],
    tx_signed([beneficiary_pkh()], [cont]),
  )
}

test evidence__rejects_released_milestone() {
  let datum = EscrowDatumV2 { ..test_v2_datum(), released_count: 1 }
  let own = escrow_in(datum, 62_000_000)
  let cont = cont_out(
    EscrowDatumV2 { ..datum, evidence: [Some("late"), None, None] },
    62_000_000,
  )
  !validate_submit_evidence(
    escrow_v2_policy(),
    datum,
    own,
    0,
    0,
    "late",
    [cont],
    tx_signed([beneficiary_pkh()], [cont]),
  )
}

test evidence__rejects_non_beneficiary_writer() {
  let datum = test_v2_datum()
  let own = escrow_in(datum, 102_000_000)
  let cont = cont_out(
    EscrowDatumV2 { ..datum, evidence: [Some("cid-1"), None, None] },
    102_000_000,
  )
  !validate_submit_evidence(
    escrow_v2_policy(),
    datum,
    own,
    0,
    0,
    "cid-1",
    [cont],
    tx_signed([funder_pkh()], [cont]),
  )
}

test evidence__rejects_value_change() {
  let datum = test_v2_datum()
  let own = escrow_in(datum, 102_000_000)
  let cont = cont_out(
    EscrowDatumV2 { ..datum, evidence: [Some("cid-1"), None, None] },
    100_000_000,
  )
  !validate_submit_evidence(
    escrow_v2_policy(),
    datum,
    own,
    0,
    0,
    "cid-1",
    [cont],
    tx_signed([beneficiary_pkh()], [cont]),
  )
}

test evidence__rejects_touching_second_slot() {
  let datum = test_v2_datum()
  let own = escrow_in(datum, 102_000_000)
  let cont = cont_out(
    EscrowDatumV2 { ..datum, evidence: [Some("cid-1"), Some("cid-2"), None] },
    102_000_000,
  )
  !validate_submit_evidence(
    escrow_v2_policy(),
    datum,
    own,
    0,
    0,
    "cid-1",
    [cont],
    tx_signed([beneficiary_pkh()], [cont]),
  )
}

// ── RotateParty ──────────────────────────────────────────────────────────────

fn new_key() {
  #"11111111111111111111111111111111111111111111111111111111"
}

test rotate__accepts_funder_self_rotation() {
  let datum = test_v2_datum()
  let own = escrow_in(datum, 102_000_000)
  let new_funder = addr.from_verification_key(new_key())
  let cont = cont_out(
    EscrowDatumV2 { ..datum, funder: new_funder },
    102_000_000,
  )
  validate_rotate_party(
    escrow_v2_policy(),
    datum,
    own,
    0,
    FunderParty,
    [cont],
    tx_signed([funder_pkh()], [cont]),
  )
}

test rotate__accepts_beneficiary_assignment() {
  // Assigning the receivable: the beneficiary rotates itself to the assignee.
  let datum = test_v2_datum()
  let own = escrow_in(datum, 102_000_000)
  let assignee = addr.from_verification_key(new_key())
  let cont = cont_out(
    EscrowDatumV2 { ..datum, beneficiary: assignee },
    102_000_000,
  )
  validate_rotate_party(
    escrow_v2_policy(),
    datum,
    own,
    0,
    BeneficiaryParty,
    [cont],
    tx_signed([beneficiary_pkh()], [cont]),
  )
}

test rotate__accepts_verifier_self_rotation() {
  let datum = test_v2_datum()
  let own = escrow_in(datum, 102_000_000)
  let cont = cont_out(
    EscrowDatumV2 { ..datum, verifier: VerificationKey(new_key()) },
    102_000_000,
  )
  validate_rotate_party(
    escrow_v2_policy(),
    datum,
    own,
    0,
    VerifierParty,
    [cont],
    tx_signed([verifier_pkh()], [cont]),
  )
}

test rotate__accepts_arbiter_self_rotation() {
  let datum = EscrowDatumV2 {
    ..test_v2_datum(),
    arbiter: Some(VerificationKey(arbiter_pkh())),
  }
  let own = escrow_in(datum, 102_000_000)
  let cont = cont_out(
    EscrowDatumV2 { ..datum, arbiter: Some(VerificationKey(new_key())) },
    102_000_000,
  )
  validate_rotate_party(
    escrow_v2_policy(),
    datum,
    own,
    0,
    ArbiterParty,
    [cont],
    tx_signed([arbiter_pkh()], [cont]),
  )
}

test rotate__rejects_cross_party_signature() {
  // Beneficiary signs a FUNDER rotation.
  let datum = test_v2_datum()
  let own = escrow_in(datum, 102_000_000)
  let new_funder = addr.from_verification_key(new_key())
  let cont = cont_out(
    EscrowDatumV2 { ..datum, funder: new_funder },
    102_000_000,
  )
  !validate_rotate_party(
    escrow_v2_policy(),
    datum,
    own,
    0,
    FunderParty,
    [cont],
    tx_signed([beneficiary_pkh()], [cont]),
  )
}

test rotate__rejects_verifier_becoming_beneficiary() {
  let datum = test_v2_datum()
  let own = escrow_in(datum, 102_000_000)
  let cont = cont_out(
    EscrowDatumV2 { ..datum, verifier: VerificationKey(beneficiary_pkh()) },
    102_000_000,
  )
  !validate_rotate_party(
    escrow_v2_policy(),
    datum,
    own,
    0,
    VerifierParty,
    [cont],
    tx_signed([verifier_pkh()], [cont]),
  )
}

test rotate__rejects_arbiter_removal() {
  let datum = EscrowDatumV2 {
    ..test_v2_datum(),
    arbiter: Some(VerificationKey(arbiter_pkh())),
  }
  let own = escrow_in(datum, 102_000_000)
  let cont = cont_out(EscrowDatumV2 { ..datum, arbiter: None }, 102_000_000)
  !validate_rotate_party(
    escrow_v2_policy(),
    datum,
    own,
    0,
    ArbiterParty,
    [cont],
    tx_signed([arbiter_pkh()], [cont]),
  )
}

test rotate__rejects_two_field_change() {
  // A "funder rotation" that also bumps released_count.
  let datum = test_v2_datum()
  let own = escrow_in(datum, 102_000_000)
  let new_funder = addr.from_verification_key(new_key())
  let cont = cont_out(
    EscrowDatumV2 { ..datum, funder: new_funder, released_count: 1 },
    102_000_000,
  )
  !validate_rotate_party(
    escrow_v2_policy(),
    datum,
    own,
    0,
    FunderParty,
    [cont],
    tx_signed([funder_pkh()], [cont]),
  )
}

test rotate__rejects_value_change() {
  let datum = test_v2_datum()
  let own = escrow_in(datum, 102_000_000)
  let new_funder = addr.from_verification_key(new_key())
  let cont = cont_out(
    EscrowDatumV2 { ..datum, funder: new_funder },
    100_000_000,
  )
  !validate_rotate_party(
    escrow_v2_policy(),
    datum,
    own,
    0,
    FunderParty,
    [cont],
    tx_signed([funder_pkh()], [cont]),
  )
}

// ── AmendMilestones ──────────────────────────────────────────────────────────

fn co_signed(outputs: List<Output>) -> Transaction {
  tx_signed([funder_pkh(), beneficiary_pkh()], outputs)
}

test amend__accepts_deadline_push() {
  let datum = test_v2_datum()
  let own = escrow_in(datum, 102_000_000)
  let pushed = [
    Milestone { amount: 40_000_000, deadline: t0 + 2 * day },
    Milestone { amount: 40_000_000, deadline: t0 + 3 * day },
    Milestone { amount: 20_000_000, deadline: t0 + 4 * day },
  ]
  let cont = cont_out(
    EscrowDatumV2 { ..datum, milestones: pushed },
    102_000_000,
  )
  validate_amend_milestones(
    escrow_v2_policy(),
    datum,
    own,
    0,
    99,
    [cont],
    co_signed([cont]),
  )
}

test amend__accepts_shrink_with_excess_to_funder() {
  let datum = test_v2_datum()
  let own = escrow_in(datum, 102_000_000)
  let shrunk = [
    Milestone { amount: 40_000_000, deadline: t0 + day },
    Milestone { amount: 20_000_000, deadline: t0 + 2 * day },
  ]
  let cont = cont_out(
    EscrowDatumV2 { ..datum, milestones: shrunk, evidence: [None, None] },
    62_000_000,
  )
  let excess = user_output(funder_address(), assets.from_lovelace(40_000_000))
  validate_amend_milestones(
    escrow_v2_policy(),
    datum,
    own,
    0,
    1,
    [cont, excess],
    co_signed([cont, excess]),
  )
}

test amend__accepts_growth_with_top_up() {
  let datum = test_v2_datum()
  let own = escrow_in(datum, 102_000_000)
  let grown = [
    Milestone { amount: 40_000_000, deadline: t0 + day },
    Milestone { amount: 40_000_000, deadline: t0 + 2 * day },
    Milestone { amount: 70_000_000, deadline: t0 + 3 * day },
  ]
  let cont = cont_out(EscrowDatumV2 { ..datum, milestones: grown }, 152_000_000)
  validate_amend_milestones(
    escrow_v2_policy(),
    datum,
    own,
    0,
    99,
    [cont],
    co_signed([cont]),
  )
}

test amend__accepts_content_hash_update() {
  let datum = test_v2_datum()
  let own = escrow_in(datum, 102_000_000)
  let cont = cont_out(
    EscrowDatumV2 { ..datum, content_hash: Some("new-terms") },
    102_000_000,
  )
  validate_amend_milestones(
    escrow_v2_policy(),
    datum,
    own,
    0,
    99,
    [cont],
    co_signed([cont]),
  )
}

test amend__rejects_released_prefix_change() {
  let datum = EscrowDatumV2 { ..test_v2_datum(), released_count: 1 }
  let own = escrow_in(datum, 62_000_000)
  let rewritten = [
    Milestone { amount: 10_000_000, deadline: t0 + day },
    Milestone { amount: 40_000_000, deadline: t0 + 2 * day },
    Milestone { amount: 20_000_000, deadline: t0 + 3 * day },
  ]
  let cont = cont_out(
    EscrowDatumV2 { ..datum, milestones: rewritten },
    62_000_000,
  )
  !validate_amend_milestones(
    escrow_v2_policy(),
    datum,
    own,
    0,
    99,
    [cont],
    co_signed([cont]),
  )
}

test amend__rejects_missing_co_signature() {
  let datum = test_v2_datum()
  let own = escrow_in(datum, 102_000_000)
  let pushed = [
    Milestone { amount: 40_000_000, deadline: t0 + 2 * day },
    Milestone { amount: 40_000_000, deadline: t0 + 3 * day },
    Milestone { amount: 20_000_000, deadline: t0 + 4 * day },
  ]
  let cont = cont_out(
    EscrowDatumV2 { ..datum, milestones: pushed },
    102_000_000,
  )
  !validate_amend_milestones(
    escrow_v2_policy(),
    datum,
    own,
    0,
    99,
    [cont],
    tx_signed([funder_pkh()], [cont]),
  )
}

test amend__rejects_non_monotonic_deadlines() {
  let datum = test_v2_datum()
  let own = escrow_in(datum, 102_000_000)
  let broken = [
    Milestone { amount: 40_000_000, deadline: t0 + 3 * day },
    Milestone { amount: 40_000_000, deadline: t0 + 2 * day },
    Milestone { amount: 20_000_000, deadline: t0 + 4 * day },
  ]
  let cont = cont_out(
    EscrowDatumV2 { ..datum, milestones: broken },
    102_000_000,
  )
  !validate_amend_milestones(
    escrow_v2_policy(),
    datum,
    own,
    0,
    99,
    [cont],
    co_signed([cont]),
  )
}

test amend__rejects_upfront_underfunded_growth() {
  let datum = test_v2_datum()
  let own = escrow_in(datum, 102_000_000)
  let grown = [
    Milestone { amount: 40_000_000, deadline: t0 + day },
    Milestone { amount: 40_000_000, deadline: t0 + 2 * day },
    Milestone { amount: 70_000_000, deadline: t0 + 3 * day },
  ]
  // No top-up: still 102 ADA against a 150 ADA schedule.
  let cont = cont_out(EscrowDatumV2 { ..datum, milestones: grown }, 102_000_000)
  !validate_amend_milestones(
    escrow_v2_policy(),
    datum,
    own,
    0,
    99,
    [cont],
    co_signed([cont]),
  )
}

test amend__rejects_shrink_excess_to_non_funder() {
  let datum = test_v2_datum()
  let own = escrow_in(datum, 102_000_000)
  let shrunk = [
    Milestone { amount: 40_000_000, deadline: t0 + day },
    Milestone { amount: 20_000_000, deadline: t0 + 2 * day },
  ]
  let cont = cont_out(
    EscrowDatumV2 { ..datum, milestones: shrunk, evidence: [None, None] },
    62_000_000,
  )
  let excess = user_output(
    beneficiary_address(),
    assets.from_lovelace(40_000_000),
  )
  !validate_amend_milestones(
    escrow_v2_policy(),
    datum,
    own,
    0,
    1,
    [cont, excess],
    co_signed([cont, excess]),
  )
}

test amend__rejects_evidence_length_mismatch() {
  let datum = test_v2_datum()
  let own = escrow_in(datum, 102_000_000)
  let shrunk = [
    Milestone { amount: 40_000_000, deadline: t0 + day },
    Milestone { amount: 20_000_000, deadline: t0 + 2 * day },
  ]
  // Evidence list not re-aligned to the two-milestone schedule.
  let cont = cont_out(EscrowDatumV2 { ..datum, milestones: shrunk }, 62_000_000)
  let excess = user_output(funder_address(), assets.from_lovelace(40_000_000))
  !validate_amend_milestones(
    escrow_v2_policy(),
    datum,
    own,
    0,
    1,
    [cont, excess],
    co_signed([cont, excess]),
  )
}

test amend__rejects_oversized_title() {
  let datum = test_v2_datum()
  let own = escrow_in(datum, 102_000_000)
  let cont = cont_out(
    EscrowDatumV2 {
      ..datum,
      title: "this escrow title is deliberately far longer than the sixty-four byte cap",
    },
    102_000_000,
  )
  !validate_amend_milestones(
    escrow_v2_policy(),
    datum,
    own,
    0,
    99,
    [cont],
    co_signed([cont]),
  )
}

test amend__rejects_funding_mode_change() {
  let datum = test_v2_datum()
  let own = escrow_in(datum, 102_000_000)
  let cont = cont_out(
    EscrowDatumV2 { ..datum, funding_mode: PerMilestone },
    102_000_000,
  )
  !validate_amend_milestones(
    escrow_v2_policy(),
    datum,
    own,
    0,
    99,
    [cont],
    co_signed([cont]),
  )
}
