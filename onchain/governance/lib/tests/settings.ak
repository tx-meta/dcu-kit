use cardano/assets.{PolicyId, Value}
use cardano/transaction.{InlineDatum, Input, NoDatum, Output}
use governance/types.{OneMemberOneVote}
use governance/validation.{anchor_name, validate_mint_anchor}
use tests/common.{
  anchor_output, charter_hashes, default_charter, dispatcher_address, seed_ref,
  settings_policy, with_ada,
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

fn one_anchor(policy: PolicyId) -> Value {
  assets.from_asset(policy, anchor_name, 1)
}

test settings__accepts_valid_mint() {
  validate_mint_anchor(
    seed_ref(),
    settings_policy(),
    0,
    [seed_input()],
    [anchor_output(default_charter())],
    one_anchor(settings_policy()),
  )
}

test settings__rejects_seed_not_spent() {
  !validate_mint_anchor(
    seed_ref(),
    settings_policy(),
    0,
    [],
    [anchor_output(default_charter())],
    one_anchor(settings_policy()),
  )
}

test settings__rejects_double_mint() {
  !validate_mint_anchor(
    seed_ref(),
    settings_policy(),
    0,
    [seed_input()],
    [anchor_output(default_charter())],
    assets.from_asset(settings_policy(), anchor_name, 2),
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
    [seed_input()],
    [out],
    one_anchor(settings_policy()),
  )
}

test settings__rejects_empty_hashes() {
  let bad = charter_hashes(OneMemberOneVote, 1, 5000, #"", #"")
  let out = Output {
    address: dispatcher_address(),
    value: with_ada(one_anchor(settings_policy())),
    datum: InlineDatum(bad),
    reference_script: None,
  }
  !validate_mint_anchor(
    seed_ref(),
    settings_policy(),
    0,
    [seed_input()],
    [out],
    one_anchor(settings_policy()),
  )
}
