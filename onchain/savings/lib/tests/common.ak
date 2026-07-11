use aiken/interval.{Finite, Interval, IntervalBound, PositiveInfinity}
use cardano/address.{Address}
use cardano/address as addr
use cardano/assets.{PolicyId, Value}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction,
}
use cardano/transaction as tx
use savings/cip68
use savings/credential.{state_token_name}
use savings/types.{Active, FundStatus, MemberAccount, SavingsDatum, SavingsFund}

pub fn policy() -> PolicyId {
  #"5a715a715a715a715a715a715a715a715a715a715a715a715a715a71"
}

pub fn quorum_pkh() {
  #"c0c1c2c3c4c5c6c7c8c9cacbcccdcecfc0c1c2c3c4c5c6c7c8c9cacb"
}

pub fn member_pkh() {
  #"1e1d1e1d1e1d1e1d1e1d1e1d1e1d1e1d1e1d1e1d1e1d1e1d1e1d1e1d"
}

pub fn token_policy() -> PolicyId {
  #"70cec70cec70cec70cec70cec70cec70cec70cec70cec70cec70cec7"
}

pub fn token_name() {
  #"544b4e"
}

pub fn member_address() -> Address {
  addr.from_verification_key(member_pkh())
}

pub fn quorum_credential() {
  addr.VerificationKey(quorum_pkh())
}

pub fn key_credential(pkh: ByteArray) {
  addr.VerificationKey(pkh)
}

pub fn cip68_name_100(outref: OutputReference) {
  cip68.unique_token_name(outref, cip68.prefix_100)
}

pub fn cip68_name_222(outref: OutputReference) {
  cip68.unique_token_name(outref, cip68.prefix_222)
}

pub fn vault_address() -> Address {
  addr.from_script(policy())
}

pub fn fund_seed_ref() -> OutputReference {
  OutputReference {
    transaction_id: #"5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed",
    output_index: 0,
  }
}

pub fn fund_name() {
  state_token_name(fund_seed_ref())
}

pub fn member_seed_ref() -> OutputReference {
  OutputReference {
    transaction_id: #"3eed3eed3eed3eed3eed3eed3eed3eed3eed3eed3eed3eed3eed3eed3eed3eed",
    output_index: 1,
  }
}

pub fn ref_name() {
  cip68.unique_token_name(member_seed_ref(), cip68.prefix_100)
}

pub fn user_name() {
  cip68.unique_token_name(member_seed_ref(), cip68.prefix_222)
}

pub fn seed_input(outref: OutputReference) -> Input {
  Input {
    output_reference: outref,
    output: Output {
      address: member_address(),
      value: assets.from_lovelace(200_000_000),
      datum: NoDatum,
      reference_script: None,
    },
  }
}

/// Default charter: ADA fund, share 1_000_000, band 1..100, VSLA-locked.
pub fn make_fund(
  withdrawal_policy: Int,
  shares_total: Int,
  savings_total: Int,
  social_total: Int,
  status: FundStatus,
) -> SavingsDatum {
  SavingsFund {
    title: #"546573742046756e64",
    quorum: addr.VerificationKey(quorum_pkh()),
    asset_policy: "",
    asset_name: "",
    share_value: 1_000_000,
    min_shares_per_deposit: 1,
    max_shares_per_deposit: 100,
    withdrawal_policy,
    cycle_end: None,
    shares_total,
    savings_total,
    social_total,
    status,
  }
}

/// Same charter but the fund asset is a native token.
pub fn make_token_fund(
  shares_total: Int,
  savings_total: Int,
  social_total: Int,
  status: FundStatus,
) -> SavingsDatum {
  SavingsFund {
    title: #"546f6b656e2046756e64",
    quorum: addr.VerificationKey(quorum_pkh()),
    asset_policy: token_policy(),
    asset_name: token_name(),
    share_value: 1_000,
    min_shares_per_deposit: 1,
    max_shares_per_deposit: 1_000,
    withdrawal_policy: 0,
    cycle_end: None,
    shares_total,
    savings_total,
    social_total,
    status,
  }
}

pub fn make_member(share_units: Int, social_paid: Int) -> SavingsDatum {
  MemberAccount {
    fund_id: fund_name(),
    share_units,
    social_paid,
    consent: True,
    joined_at: 1_700_000_000_000,
  }
}

/// Anchor value for an ADA fund: buffer + deposits are ALL lovelace.
pub fn anchor_value(lovelace: Int) -> Value {
  assets.from_lovelace(lovelace)
    |> assets.add(policy(), fund_name(), 1)
}

/// Anchor value for a token fund: 2 ADA buffer + `qty` fund tokens.
pub fn token_anchor_value(qty: Int) -> Value {
  assets.from_lovelace(2_000_000)
    |> assets.add(policy(), fund_name(), 1)
    |> assets.add(token_policy(), token_name(), qty)
}

pub fn member_ref_value() -> Value {
  assets.from_lovelace(2_000_000)
    |> assets.add(policy(), ref_name(), 1)
}

pub fn vault_output(datum: SavingsDatum, value: Value) -> Output {
  let data: Data = datum
  Output {
    address: vault_address(),
    value,
    datum: InlineDatum(data),
    reference_script: None,
  }
}

pub fn wallet_output(value: Value) -> Output {
  Output {
    address: member_address(),
    value,
    datum: NoDatum,
    reference_script: None,
  }
}

pub fn vault_input(ix: Int, output: Output) -> Input {
  Input {
    output_reference: OutputReference {
      transaction_id: #"ab1eab1eab1eab1eab1eab1eab1eab1eab1eab1eab1eab1eab1eab1eab1eab1e",
      output_index: ix,
    },
    output,
  }
}

/// A wallet input carrying the member's (222) user token.
pub fn user_token_input() -> Input {
  Input {
    output_reference: OutputReference {
      transaction_id: #"05e105e105e105e105e105e105e105e105e105e105e105e105e105e105e105e1",
      output_index: 0,
    },
    output: Output {
      address: member_address(),
      value: assets.from_lovelace(5_000_000)
        |> assets.add(policy(), user_name(), 1),
      datum: NoDatum,
      reference_script: None,
    },
  }
}

pub fn range_after(t: Int) -> Interval {
  Interval {
    lower_bound: IntervalBound { bound_type: Finite(t), is_inclusive: True },
    upper_bound: IntervalBound {
      bound_type: PositiveInfinity,
      is_inclusive: True,
    },
  }
}

pub fn range_between(lo: Int, hi: Int) -> Interval {
  Interval {
    lower_bound: IntervalBound { bound_type: Finite(lo), is_inclusive: True },
    upper_bound: IntervalBound { bound_type: Finite(hi), is_inclusive: True },
  }
}

/// A transaction signed by the quorum key, with a bounded validity range.
pub fn quorum_tx() -> Transaction {
  Transaction {
    ..tx.placeholder,
    extra_signatories: [quorum_pkh()],
    validity_range: range_after(1_700_000_000_000),
  }
}

pub fn unsigned_tx() -> Transaction {
  Transaction {
    ..tx.placeholder,
    validity_range: range_after(1_700_000_000_000),
  }
}

/// Default Active ADA fund with `n` deposited shares (+ buffer in value).
pub fn active_fund(shares: Int) -> SavingsDatum {
  make_fund(0, shares, shares * 1_000_000, 0, Active)
}
