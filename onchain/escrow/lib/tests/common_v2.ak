use aiken/interval.{Finite, Interval, IntervalBound}
use cardano/address.{Address, VerificationKey}
use cardano/address as addr
use cardano/assets.{PolicyId, Value}
use cardano/transaction.{InlineDatum, Output}
use escrow/types_v2.{
  EscrowDatumV2, Milestone, ProjectDatum, RefundToFunder, Upfront,
}
use tests/common.{
  beneficiary_address, funder_address, seed_token_name, verifier_pkh,
}

pub fn escrow_v2_policy() -> PolicyId {
  #"e20e20e20e20e20e20e20e20e20e20e20e20e20e20e20e20e20e20e2"
}

pub fn project_policy() -> PolicyId {
  #"90090090090090090090090090090090090090090090090090090090"
}

pub fn arbiter_pkh() {
  #"c0c1c2c3c4c5c6c7c8c9cacbcccdcecfc0c1c2c3c4c5c6c7c8c9cacb"
}

pub fn owner_pkh() {
  #"d0d1d2d3d4d5d6d7d8d9dadbdcdddedfd0d1d2d3d4d5d6d7d8d9dadb"
}

// One hour and one day in ms — readable deadline arithmetic in tests.
pub const hour: Int = 3_600_000

pub const day: Int = 86_400_000

// Base schedule: 40/40/20 ADA with deadlines on consecutive days from t0.
pub const t0: Int = 1_800_000_000_000

pub fn test_milestones() -> List<Milestone> {
  [
    Milestone { amount: 40_000_000, deadline: t0 + 1 * day },
    Milestone { amount: 40_000_000, deadline: t0 + 2 * day },
    Milestone { amount: 20_000_000, deadline: t0 + 3 * day },
  ]
}

// Default v2 datum: ADA, Upfront, RefundToFunder, no arbiter, 1h grace,
// 1h dispute window.
pub fn test_v2_datum() -> EscrowDatumV2 {
  EscrowDatumV2 {
    funder: funder_address(),
    beneficiary: beneficiary_address(),
    verifier: VerificationKey(verifier_pkh()),
    arbiter: None,
    asset_policy: assets.ada_policy_id,
    asset_name: assets.ada_asset_name,
    milestones: test_milestones(),
    grace: hour,
    dispute_window: hour,
    released_count: 0,
    funding_mode: Upfront,
    timeout_policy: RefundToFunder,
    dispute: None,
    title: "well drilling",
    content_hash: None,
    evidence: [None, None, None],
    project_id: None,
  }
}

pub fn escrow_v2_address(policy_id: PolicyId) -> Address {
  addr.from_script(policy_id)
}

pub fn escrow_v2_output(
  policy_id: PolicyId,
  datum: EscrowDatumV2,
  value: Value,
) -> Output {
  let data: Data = datum
  Output {
    address: escrow_v2_address(policy_id),
    value,
    datum: InlineDatum(data),
    reference_script: None,
  }
}

// Escrow UTxO value: lovelace + the v2 state token (name from the shared seed).
pub fn v2_utxo_value(policy_id: PolicyId, lovelace: Int) -> Value {
  assets.from_lovelace(lovelace)
    |> assets.add(policy_id, seed_token_name(), 1)
}

// Validity range with BOTH bounds finite — dispute-aware paths often need a
// proven lower bound and a pinned upper bound in the same tx.
pub fn range_between(lo: Int, hi: Int) -> Interval {
  Interval {
    lower_bound: IntervalBound { bound_type: Finite(lo), is_inclusive: True },
    upper_bound: IntervalBound { bound_type: Finite(hi), is_inclusive: True },
  }
}

pub fn test_project_datum() -> ProjectDatum {
  ProjectDatum {
    title: "borehole program",
    content_hash: None,
    status: 0,
    owner: VerificationKey(owner_pkh()),
  }
}

pub fn project_output(
  policy_id: PolicyId,
  datum: ProjectDatum,
  value: Value,
) -> Output {
  let data: Data = datum
  Output {
    address: addr.from_script(policy_id),
    value,
    datum: InlineDatum(data),
    reference_script: None,
  }
}
