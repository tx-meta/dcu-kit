use cardano/address as addr
use cardano/assets.{PolicyId, Value}
use cardano/transaction.{InlineDatum, Input, NoDatum, Output}
use governance/types.{AnyMember, GovernanceAnchor, OneMemberOneVote}
use governance/validation.{anchor_name, roster_name, validate_mint_anchor}
use tests/common.{
  anchor_output, charter_hashes, creator_pkh, default_charter,
  dispatcher_address, gate_hash, member_policy, roster_output, seed_ref,
  settings_policy, target_id, voting_hash, with_ada,
}

// A wallet input that consumes the seed OutputReference.
fn seed_input() -> Input {
  Input {
    output_reference: seed_ref(),
    output: Output {
      address: dispatcher_address(),
      value: assets.from_lovelace(10_000_000),
      datum: NoDatum,
      reference_script: None,
    },
  }
}

// The one-shot init mints exactly the anchor + roster NFT pair.
fn init_mint(policy: PolicyId) -> Value {
  assets.merge(
    assets.from_asset(policy, anchor_name, 1),
    assets.from_asset(policy, roster_name, 1),
  )
}

fn valid_outputs() -> List<Output> {
  [anchor_output(default_charter()), roster_output([])]
}

test settings__accepts_valid_mint() {
  validate_mint_anchor(
    seed_ref(),
    settings_policy(),
    0,
    1,
    [seed_input()],
    valid_outputs(),
    init_mint(settings_policy()),
  )
}

test settings__rejects_seed_not_spent() {
  !validate_mint_anchor(
    seed_ref(),
    settings_policy(),
    0,
    1,
    [],
    valid_outputs(),
    init_mint(settings_policy()),
  )
}

test settings__rejects_double_anchor_mint() {
  !validate_mint_anchor(
    seed_ref(),
    settings_policy(),
    0,
    1,
    [seed_input()],
    valid_outputs(),
    assets.merge(
      assets.from_asset(settings_policy(), anchor_name, 2),
      assets.from_asset(settings_policy(), roster_name, 1),
    ),
  )
}

test settings__rejects_missing_roster_mint() {
  !validate_mint_anchor(
    seed_ref(),
    settings_policy(),
    0,
    1,
    [seed_input()],
    valid_outputs(),
    assets.from_asset(settings_policy(), anchor_name, 1),
  )
}

test settings__rejects_anchor_missing_nft() {
  let out = Output {
    address: dispatcher_address(),
    value: assets.from_lovelace(2_000_000),
    datum: InlineDatum(default_charter()),
    reference_script: None,
  }
  !validate_mint_anchor(
    seed_ref(),
    settings_policy(),
    0,
    1,
    [seed_input()],
    [out, roster_output([])],
    init_mint(settings_policy()),
  )
}

test settings__rejects_empty_hashes() {
  let bad = charter_hashes(OneMemberOneVote, 1, 5000, #"", #"")
  let out = Output {
    address: dispatcher_address(),
    value: with_ada(assets.from_asset(settings_policy(), anchor_name, 1)),
    datum: InlineDatum(bad),
    reference_script: None,
  }
  !validate_mint_anchor(
    seed_ref(),
    settings_policy(),
    0,
    1,
    [seed_input()],
    [out, roster_output([])],
    init_mint(settings_policy()),
  )
}

test settings__rejects_nonempty_roster() {
  // The roster must be born as the EMPTY set — a preloaded member would block
  // (or fake) that member's registration.
  !validate_mint_anchor(
    seed_ref(),
    settings_policy(),
    0,
    1,
    [seed_input()],
    [anchor_output(default_charter()), roster_output(["member"])],
    init_mint(settings_policy()),
  )
}

// ── charter invariants (config-safety envelope) ─────────────────────────────

fn mint_with_charter(charter) -> Bool {
  validate_mint_anchor(
    seed_ref(),
    settings_policy(),
    0,
    1,
    [seed_input()],
    [anchor_output(charter), roster_output([])],
    init_mint(settings_policy()),
  )
}

test settings__rejects_zero_quorum() {
  // Quorum 0 would let a proposal pass with zero votes cast.
  !mint_with_charter(
    charter_hashes(OneMemberOneVote, 0, 5000, voting_hash(), gate_hash()),
  )
}

test settings__rejects_threshold_over_10000() {
  !mint_with_charter(
    charter_hashes(OneMemberOneVote, 1, 10001, voting_hash(), gate_hash()),
  )
}

test settings__accepts_generic_opener_tag() {
  // Tag 5 = the Generic forward-compatibility arm — a valid opener key.
  let ok = GovernanceAnchor {
    title: "Chama",
    member_policy: member_policy(),
    governed_targets: [
      Pair(
        #"7a707a707a707a707a707a707a707a707a707a707a707a707a707a70",
        target_id(),
      ),
    ],
    voting_mode: OneMemberOneVote,
    default_quorum: 1,
    default_threshold: 5000,
    opener_policy: [Pair(5, AnyMember)],
    timelock: 0,
    creator: addr.VerificationKey(creator_pkh()),
    voting_stake_hash: voting_hash(),
    gate_hash: gate_hash(),
  }
  mint_with_charter(ok)
}

test settings__rejects_opener_tag_beyond_enum() {
  // 6 names no GovAction constructor — a rule that can never match is a
  // misconfiguration, not a policy.
  let bad = GovernanceAnchor {
    title: "Chama",
    member_policy: member_policy(),
    governed_targets: [
      Pair(
        #"7a707a707a707a707a707a707a707a707a707a707a707a707a707a70",
        target_id(),
      ),
    ],
    voting_mode: OneMemberOneVote,
    default_quorum: 1,
    default_threshold: 5000,
    opener_policy: [Pair(6, AnyMember)],
    timelock: 0,
    creator: addr.VerificationKey(creator_pkh()),
    voting_stake_hash: voting_hash(),
    gate_hash: gate_hash(),
  }
  !mint_with_charter(bad)
}

test settings__rejects_negative_timelock() {
  let bad = GovernanceAnchor {
    title: "Chama",
    member_policy: member_policy(),
    governed_targets: [
      Pair(
        #"7a707a707a707a707a707a707a707a707a707a707a707a707a707a70",
        target_id(),
      ),
    ],
    voting_mode: OneMemberOneVote,
    default_quorum: 1,
    default_threshold: 5000,
    opener_policy: [Pair(0, AnyMember)],
    timelock: -1,
    creator: addr.VerificationKey(creator_pkh()),
    voting_stake_hash: voting_hash(),
    gate_hash: gate_hash(),
  }
  !mint_with_charter(bad)
}

test settings__rejects_malformed_target_policy() {
  // A governed-target "policy" that is not 28 bytes can never be a real
  // minting policy — the pair could never be matched on-chain.
  let bad = GovernanceAnchor {
    title: "Chama",
    member_policy: member_policy(),
    governed_targets: [Pair(#"aabb", target_id())],
    voting_mode: OneMemberOneVote,
    default_quorum: 1,
    default_threshold: 5000,
    opener_policy: [Pair(0, AnyMember)],
    timelock: 0,
    creator: addr.VerificationKey(creator_pkh()),
    voting_stake_hash: voting_hash(),
    gate_hash: gate_hash(),
  }
  !mint_with_charter(bad)
}
