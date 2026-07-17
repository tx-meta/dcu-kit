use cardano/transaction.{Transaction}
use governance/dispatch.{validate_spend}
use governance/types.{
  AnyMember, CreatorOnly, GovernanceAnchor, GovernanceDatum, UpdateCharter,
}
use tests/common.{
  anchor_input, anchor_output, creator_pkh, default_charter, empty_tx,
  settings_policy,
}

// UpdateCharter is the one dispatcher spend that carries its whole check
// itself (no voting coupling) — the charter amendment invariants live here.

fn amend_tx(new_charter: GovernanceDatum, signed: Bool) -> Transaction {
  Transaction {
    ..empty_tx(),
    inputs: [anchor_input(default_charter())],
    outputs: [anchor_output(new_charter)],
    extra_signatories: if signed {
      [creator_pkh()]
    } else {
      []
    },
  }
}

fn amend(new_charter: GovernanceDatum, signed: Bool) -> Bool {
  validate_spend(
    settings_policy(),
    default_charter(),
    UpdateCharter { anchor_input_index: 0, anchor_output_index: 0 },
    anchor_input(default_charter()).output_reference,
    amend_tx(new_charter, signed),
  )
}

// A charter equal to the default except the given quorum/threshold/opener.
fn charter_with(quorum: Int, threshold: Int) -> GovernanceDatum {
  expect  
      GovernanceAnchor {
        title,
        member_policy,
        governed_targets,
        voting_mode,
        opener_policy: _,
        timelock,
        creator,
        voting_stake_hash,
        gate_hash,
        ..
      }
    = default_charter()
  GovernanceAnchor {
    title,
    member_policy,
    governed_targets,
    voting_mode,
    default_quorum: quorum,
    default_threshold: threshold,
    opener_policy: [Pair(0, CreatorOnly)],
    timelock,
    creator,
    voting_stake_hash,
    gate_hash,
  }
}

test update_charter__accepts_valid_amendment() {
  amend(charter_with(2, 6000), True)
}

test update_charter__rejects_unsigned() {
  !amend(charter_with(2, 6000), False)
}

test update_charter__rejects_zero_quorum() {
  // The envelope holds on amendment, not just at mint.
  !amend(charter_with(0, 6000), True)
}

test update_charter__rejects_gate_hash_change() {
  // The published gate hash is the instance's identity — immutable.
  expect  
      GovernanceAnchor {
        title,
        member_policy,
        governed_targets,
        voting_mode,
        default_quorum,
        default_threshold,
        opener_policy,
        timelock,
        creator,
        voting_stake_hash,
        ..
      }
    = default_charter()
  let hijacked = GovernanceAnchor {
    title,
    member_policy,
    governed_targets,
    voting_mode,
    default_quorum,
    default_threshold,
    opener_policy,
    timelock,
    creator,
    voting_stake_hash,
    gate_hash: #"9999999999999999999999999999999999999999999999999999999999",
  }
  !amend(hijacked, True)
}

test update_charter__rejects_member_policy_change() {
  expect  
      GovernanceAnchor {
        title,
        governed_targets,
        voting_mode,
        default_quorum,
        default_threshold,
        opener_policy,
        timelock,
        creator,
        voting_stake_hash,
        gate_hash,
        ..
      }
    = default_charter()
  let hijacked = GovernanceAnchor {
    title,
    member_policy: #"9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b",
    governed_targets,
    voting_mode,
    default_quorum,
    default_threshold,
    opener_policy,
    timelock,
    creator,
    voting_stake_hash,
    gate_hash,
  }
  !amend(hijacked, True)
}

// Silence the unused-import warning — AnyMember appears in default_charter's
// opener policy and is matched here to keep the import meaningful.
test update_charter__default_opener_is_any_member() {
  expect GovernanceAnchor { opener_policy, .. } = default_charter()
  opener_policy == [Pair(0, AnyMember)]
}
