use aiken/collection/dict
use aiken/collection/list
use aiken/interval.{Finite}
use aiken/primitive/bytearray
use cardano/address.{Script, VerificationKey}
use cardano/address as address_mod
use cardano/assets.{AssetName, PolicyId, Value, ada_policy_id}
use cardano/transaction.{InlineDatum, Input, Output, Transaction, ValidityRange}
use savings/cip68
use savings/credential.{credential_authorized, state_token_name}
use savings/types.{Active, MemberAccount, SavingsDatum, SavingsFund, SharingOut}

/// The anchor's protocol lovelace buffer (shared SDK convention). For ADA
/// funds it is excluded from the share-out pot; enforcing it at creation keeps
/// the CloseCycle pot arithmetic non-negative.
pub const min_ada_buffer: Int = 2_000_000

// ── value helpers ───────────────────────────────────────────────────────────

/// The vault's balance in the fund asset ("" policy = ADA).
pub fn asset_amount(
  v: Value,
  asset_policy: PolicyId,
  asset_name: AssetName,
) -> Int {
  if asset_policy == "" {
    assets.lovelace_of(v)
  } else {
    assets.quantity_of(v, asset_policy, asset_name)
  }
}

/// `qty` of the fund asset as a Value (for exact-merge transition checks).
pub fn fund_asset_value(
  asset_policy: PolicyId,
  asset_name: AssetName,
  qty: Int,
) -> Value {
  if asset_policy == "" {
    assets.from_lovelace(qty)
  } else {
    assets.from_asset(asset_policy, asset_name, qty)
  }
}

/// The own-policy tokens of a value, as sorted pairs.
pub fn own_tokens(v: Value, policy_id: PolicyId) -> Pairs<AssetName, Int> {
  dict.to_pairs(assets.tokens(v, policy_id))
}

/// [security]: input discipline — the transaction spends exactly `n` inputs at
/// the own script, so no third vault UTxO rides along a paired transition
/// (double satisfaction) and single-UTxO actions cannot batch.
pub fn own_input_count_is(
  inputs: List<Input>,
  policy_id: PolicyId,
  n: Int,
) -> Bool {
  list.count(
    inputs,
    fn(i) { i.output.address.payment_credential == Script(policy_id) },
  ) == n
}

/// [security]: only the fund asset moved — the continuation value equals the
/// input value plus `delta` of the fund asset. ADA (or any foreign token)
/// cannot be drained or stuffed alongside a fund-asset transition.
pub fn only_fund_asset_moved(
  input_value: Value,
  output_value: Value,
  asset_policy: PolicyId,
  asset_name: AssetName,
  delta: Int,
) -> Bool {
  assets.merge(input_value, fund_asset_value(asset_policy, asset_name, delta)) == output_value
}

/// Parses the inline SavingsDatum of an output (fails on anything else).
pub fn output_datum(out: Output) -> SavingsDatum {
  expect InlineDatum(raw) = out.datum
  expect d: SavingsDatum = raw
  d
}

/// The member reference-token name carried by a member-account UTxO: exactly
/// one own-policy token, CIP-68 (100)-prefixed.
pub fn member_ref_name(v: Value, policy_id: PolicyId) -> AssetName {
  expect [Pair(name, 1)] = own_tokens(v, policy_id)
  expect bytearray.take(name, cip68.prefix_length) == cip68.prefix_100
  name
}

/// [spec 3.3 common]: caller authority — the (222) user token paired with the
/// member reference token is present in the transaction inputs. Ownership
/// lives in the token, never in an index.
pub fn user_token_present(
  inputs: List<Input>,
  policy_id: PolicyId,
  ref_name: AssetName,
) -> Bool {
  let user_name = cip68.convert_ref_to_user_token(ref_name)
  list.any(
    inputs,
    fn(i) { assets.quantity_of(i.output.value, policy_id, user_name) == 1 },
  )
}

/// [security]: no own-policy tokens minted or burned in a pure state
/// transition (must_mint_nothing, scoped to the own policy).
pub fn mints_nothing_own(mint: Value, policy_id: PolicyId) -> Bool {
  dict.is_empty(assets.tokens(mint, policy_id))
}

/// The member input at `ix`: at the own script, carrying a MemberAccount
/// datum for fund `fund_name`, plus its reference-token name.
fn member_input_for(
  inputs: List<Input>,
  ix: Int,
  policy_id: PolicyId,
  fund_name: AssetName,
) -> (Input, SavingsDatum, AssetName) {
  expect Some(member_input) = list.at(inputs, ix)
  // [spec 3.3 common]: the paired input really is a vault UTxO
  expect Script(mp) = member_input.output.address.payment_credential
  expect mp == policy_id
  let md = {
    expect InlineDatum(raw) = member_input.output.datum
    expect d: SavingsDatum = raw
    d
  }
  // [spec 3.3 Deposit]: the account belongs to THIS fund
  expect MemberAccount { fund_id, .. } = md
  expect fund_id == fund_name
  let ref_name = member_ref_name(member_input.output.value, policy_id)
  (member_input, md, ref_name)
}

/// A Fund State NFT name: 32 bytes AND not CIP-68 prefixed — member account
/// names are also 32 bytes (4-byte prefix + 28-byte suffix), so length alone
/// cannot tell the two token kinds apart.
pub fn is_fund_name(name: AssetName) -> Bool {
  and {
    bytearray.length(name) == 32,
    bytearray.take(name, cip68.prefix_length) != cip68.prefix_100,
    bytearray.take(name, cip68.prefix_length) != cip68.prefix_222,
  }
}

/// The anchor's own Fund State NFT name (exactly one own token).
pub fn fund_name_of(own_input: Input, policy_id: PolicyId) -> AssetName {
  expect [Pair(fund_name, 1)] = own_tokens(own_input.output.value, policy_id)
  expect is_fund_name(fund_name)
  fund_name
}

// ── mint: CreateFund ────────────────────────────────────────────────────────

pub fn validate_create_fund(
  policy_id: PolicyId,
  seed_input_index: Int,
  fund_output_index: Int,
  inputs: List<Input>,
  outputs: List<Output>,
  mint: Value,
) -> Bool {
  // [spec 3.3 CreateFund]: one-shot — the seed input is consumed and names
  // the Fund State NFT
  expect Some(seed) = list.at(inputs, seed_input_index)
  let fund_name = state_token_name(seed.output_reference)
  // [spec 3.3 CreateFund]: exactly one own-policy token minted, +1
  let mint_exact = own_tokens(mint, policy_id) == [Pair(fund_name, 1)]
  // [spec 3.3 CreateFund]: the anchor lands at the canonical own script
  // address (no stake credential — rewards can never be redirected)
  expect Some(out) = list.at(outputs, fund_output_index)
  let at_script = out.address == address_mod.from_script(policy_id)
  // [spec 3.3 CreateFund]: anchor value is EXACTLY min-ADA + the NFT — no
  // foreign tokens smuggled in at creation (unbounded-value guard)
  let token_exact = own_tokens(out.value, policy_id) == [Pair(fund_name, 1)]
  let policies_exact = assets.policies(out.value) == [ada_policy_id, policy_id]
  // [spec 3.3 CreateFund]: the protocol buffer is locked from the start so
  // the CloseCycle pot arithmetic never goes negative
  let buffer_locked = assets.lovelace_of(out.value) >= min_ada_buffer
  // [spec 3.3 CreateFund]: charter sanity + zero start
  expect  
      SavingsFund {
        title,
        asset_policy,
        asset_name,
        share_value,
        min_shares_per_deposit,
        max_shares_per_deposit,
        withdrawal_policy,
        shares_total,
        savings_total,
        social_total,
        status,
        ..
      }
    = output_datum(out)
  let charter_sane = and {
    bytearray.length(title) <= 64,
    share_value > 0,
    min_shares_per_deposit > 0,
    min_shares_per_deposit <= max_shares_per_deposit,
    withdrawal_policy == 0 || withdrawal_policy == 1,
    // "" = ADA (with empty name); otherwise a real 28-byte policy that is
    // NOT this validator (own tokens are identity, never the savings asset)
    if asset_policy == "" {
      asset_name == ""
    } else {
      bytearray.length(asset_policy) == 28 && asset_policy != policy_id
    },
  }
  let zero_start = and {
    shares_total == 0,
    savings_total == 0,
    social_total == 0,
    status == Active,
  }
  and {
    mint_exact?,
    at_script?,
    token_exact?,
    policies_exact?,
    buffer_locked?,
    charter_sane?,
    zero_start?,
  }
}

// ── mint: MintAccount (join) ────────────────────────────────────────────────

pub fn validate_mint_account(
  policy_id: PolicyId,
  seed_input_index: Int,
  fund_ref_index: Int,
  ref_output_index: Int,
  user_output_index: Int,
  inputs: List<Input>,
  reference_inputs: List<Input>,
  outputs: List<Output>,
  mint: Value,
  validity_range: ValidityRange,
) -> Bool {
  // [spec 3.3 MintAccount]: suffix uniqueness from the consumed seed
  expect Some(seed) = list.at(inputs, seed_input_index)
  let ref_name = cip68.unique_token_name(
    seed.output_reference,
    cip68.prefix_100,
  )
  let user_name = cip68.unique_token_name(
    seed.output_reference,
    cip68.prefix_222,
  )
  // [spec 3.3 MintAccount]: exactly the CIP-68 pair minted, +1 each
  // (prefix 000643b0 sorts before 000de140)
  let mint_exact = own_tokens(mint, policy_id) == [
    Pair(ref_name, 1), Pair(user_name, 1),
  ]
  // [spec 3.3 MintAccount]: the referenced fund anchor is live and Active
  expect Some(fund_ref) = list.at(reference_inputs, fund_ref_index)
  expect Script(fp) = fund_ref.output.address.payment_credential
  let fund_at_script = fp == policy_id
  let fund_name = fund_name_of(fund_ref, policy_id)
  expect SavingsFund { status: fund_status, .. } = {
    expect InlineDatum(raw) = fund_ref.output.datum
    expect d: SavingsDatum = raw
    d
  }
  let fund_active = fund_status == Active
  // [spec 3.3 MintAccount]: the account UTxO lands at the own script with a
  // zeroed datum bound to THIS fund
  expect Some(ref_out) = list.at(outputs, ref_output_index)
  // [security]: canonical no-stake script address, as at fund creation
  let ref_at_script = ref_out.address == address_mod.from_script(policy_id)
  let ref_token_exact = own_tokens(ref_out.value, policy_id) == [
    Pair(ref_name, 1),
  ]
  let ref_policies_exact = assets.policies(ref_out.value) == [
    ada_policy_id, policy_id,
  ]
  let ref_buffer = assets.lovelace_of(ref_out.value) >= min_ada_buffer
  expect MemberAccount { fund_id, share_units, social_paid, joined_at, .. } = output_datum(
    ref_out,
  )
  // [spec 3.3 MintAccount]: joined_at sits inside the tx validity window
  expect Finite(lo) = validity_range.lower_bound.bound_type
  expect Finite(hi) = validity_range.upper_bound.bound_type
  let account_zeroed = and {
    fund_id == fund_name,
    share_units == 0,
    social_paid == 0,
    joined_at >= lo,
    joined_at <= hi,
  }
  // [spec 3.3 MintAccount]: the user token pays to a VerificationKey address
  // (the only soul-bound enforcement possible at mint)
  expect Some(user_out) = list.at(outputs, user_output_index)
  let user_to_key = when user_out.address.payment_credential is {
    VerificationKey(_) -> True
    _ -> False
  }
  let user_token_paid = assets.quantity_of(user_out.value, policy_id, user_name) == 1
  and {
    mint_exact?,
    fund_at_script?,
    fund_active?,
    ref_at_script?,
    ref_token_exact?,
    ref_policies_exact?,
    ref_buffer?,
    account_zeroed?,
    user_to_key?,
    user_token_paid?,
  }
}

// ── mint: burns ─────────────────────────────────────────────────────────────

/// [spec 3.3 BurnAccount]: exactly one CIP-68 pair burns, -1 each, sharing a
/// suffix. The ref token can only leave the vault through a RemoveAccount
/// spend, which authorizes the exit; this policy enforces the paired burn.
pub fn validate_burn_account(policy_id: PolicyId, mint: Value) -> Bool {
  expect [Pair(n1, -1), Pair(n2, -1)] = own_tokens(mint, policy_id)
  and {
    (bytearray.take(n1, cip68.prefix_length) == cip68.prefix_100)?,
    (bytearray.take(n2, cip68.prefix_length) == cip68.prefix_222)?,
    (bytearray.drop(n1, cip68.prefix_length) == bytearray.drop(
      n2,
      cip68.prefix_length,
    ))?,
  }
}

/// [spec 3.3 BurnFund]: exactly one Fund State NFT burns (32-byte name, not
/// CIP-68 prefixed — this path can never burn a member's account tokens).
/// The anchor spend (CloseFund) authorizes the closure.
pub fn validate_burn_fund(policy_id: PolicyId, mint: Value) -> Bool {
  expect [Pair(name, -1)] = own_tokens(mint, policy_id)
  is_fund_name(name)?
}

// ── spend: paired transitions (anchor side carries the full validation) ────

/// [spec 3.3 Deposit]: a member pays in. Tag 0 buys shares, tag 1 feeds the
/// social fund, tag 2 is an untagged top-up.
pub fn validate_deposit(
  policy_id: PolicyId,
  datum: SavingsDatum,
  own_input: Input,
  member_input_index: Int,
  fund_output_index: Int,
  member_output_index: Int,
  fund_tag: Int,
  inputs: List<Input>,
  outputs: List<Output>,
  mint: Value,
) -> Bool {
  expect  
      SavingsFund {
        title,
        quorum,
        asset_policy,
        asset_name,
        share_value,
        min_shares_per_deposit,
        max_shares_per_deposit,
        withdrawal_policy,
        cycle_end,
        shares_total,
        savings_total,
        social_total,
        status,
      }
    = datum
  // [spec 3.3 Deposit]: deposits only while Active
  expect Active = status
  let fund_name = fund_name_of(own_input, policy_id)
  let (member_input, md, ref_name) = member_input_for(
    inputs,
    member_input_index,
    policy_id,
    fund_name,
  )
  expect MemberAccount { share_units, social_paid, consent, joined_at, .. } = md
  // [spec 3.3 Deposit]: caller authority — the paired user token is spent
  let authorized = user_token_present(inputs, policy_id, ref_name)
  expect Some(fund_out) = list.at(outputs, fund_output_index)
  expect Some(member_out) = list.at(outputs, member_output_index)
  // [security]: continuations keep the FULL input address (stake credential
  // included) — a spender cannot re-stake the vault
  let fund_out_at_script = fund_out.address == own_input.output.address
  let member_out_at_script = member_out.address == member_input.output.address
  // [spec 3.3 Deposit]: delta = the vault's fund-asset increase; positive,
  // and the ONLY change to the vault value
  let delta = asset_amount(fund_out.value, asset_policy, asset_name) - asset_amount(
    own_input.output.value,
    asset_policy,
    asset_name,
  )
  let vault_transition_exact = only_fund_asset_moved(
    own_input.output.value,
    fund_out.value,
    asset_policy,
    asset_name,
    delta,
  )
  // [spec 3.3 Deposit]: the member UTxO's value never changes
  let member_value_unchanged = member_out.value == member_input.output.value
  // [spec 3.3 Deposit]: expected continuations per tag — full-datum equality
  // so no field can drift unnoticed
  let (expected_fund, expected_member, amounts_ok) = if fund_tag == 0 {
    // tag 0: shares — delta must be an exact multiple inside the band
    let units = delta / share_value
    (
      SavingsFund {
        title,
        quorum,
        asset_policy,
        asset_name,
        share_value,
        min_shares_per_deposit,
        max_shares_per_deposit,
        withdrawal_policy,
        cycle_end,
        shares_total: shares_total + units,
        savings_total: savings_total + delta,
        social_total,
        status: Active,
      },
      MemberAccount {
        fund_id: fund_name,
        share_units: share_units + units,
        social_paid,
        consent,
        joined_at,
      },
      and {
        delta == units * share_value,
        units >= min_shares_per_deposit,
        units <= max_shares_per_deposit,
      },
    )
  } else if fund_tag == 1 {
    // tag 1: social fund
    (
      SavingsFund {
        title,
        quorum,
        asset_policy,
        asset_name,
        share_value,
        min_shares_per_deposit,
        max_shares_per_deposit,
        withdrawal_policy,
        cycle_end,
        shares_total,
        savings_total,
        social_total: social_total + delta,
        status: Active,
      },
      MemberAccount {
        fund_id: fund_name,
        share_units,
        social_paid: social_paid + delta,
        consent,
        joined_at,
      },
      delta > 0,
    )
  } else {
    // tag 2: untagged top-up — value in, no datum change
    (
      SavingsFund {
        title,
        quorum,
        asset_policy,
        asset_name,
        share_value,
        min_shares_per_deposit,
        max_shares_per_deposit,
        withdrawal_policy,
        cycle_end,
        shares_total,
        savings_total,
        social_total,
        status: Active,
      },
      MemberAccount {
        fund_id: fund_name,
        share_units,
        social_paid,
        consent,
        joined_at,
      },
      fund_tag == 2 && delta > 0,
    )
  }
  and {
    authorized?,
    fund_out_at_script?,
    member_out_at_script?,
    vault_transition_exact?,
    member_value_unchanged?,
    amounts_ok?,
    (output_datum(fund_out) == expected_fund)?,
    (output_datum(member_out) == expected_member)?,
    mints_nothing_own(mint, policy_id)?,
  }
}

/// [spec 3.3 Withdraw]: a member sells units back (ASCA flexible funds only).
pub fn validate_withdraw(
  policy_id: PolicyId,
  datum: SavingsDatum,
  own_input: Input,
  member_input_index: Int,
  fund_output_index: Int,
  member_output_index: Int,
  inputs: List<Input>,
  outputs: List<Output>,
  mint: Value,
) -> Bool {
  expect  
      SavingsFund {
        title,
        quorum,
        asset_policy,
        asset_name,
        share_value,
        min_shares_per_deposit,
        max_shares_per_deposit,
        withdrawal_policy,
        cycle_end,
        shares_total,
        savings_total,
        social_total,
        status,
      }
    = datum
  // [spec 3.3 Withdraw]: withdrawals only while Active
  expect Active = status
  let fund_name = fund_name_of(own_input, policy_id)
  let (member_input, md, ref_name) = member_input_for(
    inputs,
    member_input_index,
    policy_id,
    fund_name,
  )
  expect MemberAccount { share_units, social_paid, consent, joined_at, .. } = md
  let authorized = user_token_present(inputs, policy_id, ref_name)
  expect Some(fund_out) = list.at(outputs, fund_output_index)
  expect Some(member_out) = list.at(outputs, member_output_index)
  // [spec 3.3 Withdraw]: units sold = the member balance decrease, bounded by
  // the balance; the vault releases EXACTLY units * share_value
  expect MemberAccount { share_units: new_units, .. } = output_datum(member_out)
  let units = share_units - new_units
  let released = units * share_value
  let expected_fund = SavingsFund {
    title,
    quorum,
    asset_policy,
    asset_name,
    share_value,
    min_shares_per_deposit,
    max_shares_per_deposit,
    withdrawal_policy,
    cycle_end,
    shares_total: shares_total - units,
    savings_total: savings_total - released,
    social_total,
    status: Active,
  }
  let expected_member = MemberAccount {
    fund_id: fund_name,
    share_units: new_units,
    social_paid,
    consent,
    joined_at,
  }
  and {
    // [spec 3.3 Withdraw]: policy gate — VSLA preset locks until share-out
    (withdrawal_policy == 1)?,
    authorized?,
    (fund_out.address == own_input.output.address)?,
    (member_out.address == member_input.output.address)?,
    (units > 0)?,
    (units <= share_units)?,
    // [spec 3.3 Withdraw]: output value = input value - released, exactly
    only_fund_asset_moved(
      own_input.output.value,
      fund_out.value,
      asset_policy,
      asset_name,
      -released,
    )?,
    (member_out.value == member_input.output.value)?,
    (output_datum(fund_out) == expected_fund)?,
    (output_datum(member_out) == expected_member)?,
    mints_nothing_own(mint, policy_id)?,
  }
}

/// [spec 3.3 ClaimShareOut]: a member claims pot * units / shares (floor).
pub fn validate_claim_share_out(
  policy_id: PolicyId,
  datum: SavingsDatum,
  own_input: Input,
  member_input_index: Int,
  fund_output_index: Int,
  member_output_index: Int,
  inputs: List<Input>,
  outputs: List<Output>,
  mint: Value,
) -> Bool {
  expect  
      SavingsFund {
        title,
        quorum,
        asset_policy,
        asset_name,
        share_value,
        min_shares_per_deposit,
        max_shares_per_deposit,
        withdrawal_policy,
        cycle_end,
        shares_total,
        savings_total,
        social_total,
        status,
      }
    = datum
  // [spec 3.3 ClaimShareOut]: only during share-out
  expect SharingOut { pot, shares, shares_remaining } = status
  let fund_name = fund_name_of(own_input, policy_id)
  let (member_input, md, ref_name) = member_input_for(
    inputs,
    member_input_index,
    policy_id,
    fund_name,
  )
  expect MemberAccount { share_units, social_paid, consent, joined_at, .. } = md
  let authorized = user_token_present(inputs, policy_id, ref_name)
  // [spec 3.3 ClaimShareOut]: floor division; dust stays for CloseFund
  let paid = pot * share_units / shares
  expect Some(fund_out) = list.at(outputs, fund_output_index)
  expect Some(member_out) = list.at(outputs, member_output_index)
  let expected_fund = SavingsFund {
    title,
    quorum,
    asset_policy,
    asset_name,
    share_value,
    min_shares_per_deposit,
    max_shares_per_deposit,
    withdrawal_policy,
    cycle_end,
    shares_total,
    savings_total,
    social_total,
    // [spec 3.3 ClaimShareOut]: pot and shares immutable; only the
    // remaining counter moves
    status: SharingOut {
      pot,
      shares,
      shares_remaining: shares_remaining - share_units,
    },
  }
  let expected_member = MemberAccount {
    fund_id: fund_name,
    share_units: 0,
    social_paid,
    consent,
    joined_at,
  }
  and {
    authorized?,
    (share_units > 0)?,
    (fund_out.address == own_input.output.address)?,
    (member_out.address == member_input.output.address)?,
    // [spec 3.3 ClaimShareOut]: the vault releases EXACTLY the floor payout
    only_fund_asset_moved(
      own_input.output.value,
      fund_out.value,
      asset_policy,
      asset_name,
      -paid,
    )?,
    (member_out.value == member_input.output.value)?,
    (output_datum(fund_out) == expected_fund)?,
    (output_datum(member_out) == expected_member)?,
    mints_nothing_own(mint, policy_id)?,
  }
}

/// [spec 3.3 common]: the light member-side branch of a paired transition.
/// The anchor of THIS account's fund must be a spending input — its validator
/// carries the full transition check, so the work runs once, not twice.
pub fn validate_paired_member(
  policy_id: PolicyId,
  datum: SavingsDatum,
  fund_input_index: Int,
  inputs: List<Input>,
) -> Bool {
  expect MemberAccount { fund_id, .. } = datum
  expect Some(fund_input) = list.at(inputs, fund_input_index)
  (assets.quantity_of(fund_input.output.value, policy_id, fund_id) == 1)?
}

// ── spend: anchor-only transitions ──────────────────────────────────────────

/// [spec 3.3 SocialPayout]: the quorum pays a welfare claim from the social
/// fund. Valid in Active AND SharingOut.
pub fn validate_social_payout(
  policy_id: PolicyId,
  datum: SavingsDatum,
  own_input: Input,
  fund_output_index: Int,
  outputs: List<Output>,
  mint: Value,
  tx: Transaction,
) -> Bool {
  expect  
      SavingsFund {
        title,
        quorum,
        asset_policy,
        asset_name,
        share_value,
        min_shares_per_deposit,
        max_shares_per_deposit,
        withdrawal_policy,
        cycle_end,
        shares_total,
        savings_total,
        social_total,
        status,
      }
    = datum
  expect Some(fund_out) = list.at(outputs, fund_output_index)
  // [spec 3.3 SocialPayout]: paid = the vault's fund-asset decrease
  let paid = asset_amount(own_input.output.value, asset_policy, asset_name) - asset_amount(
    fund_out.value,
    asset_policy,
    asset_name,
  )
  let expected_fund = SavingsFund {
    title,
    quorum,
    asset_policy,
    asset_name,
    share_value,
    min_shares_per_deposit,
    max_shares_per_deposit,
    withdrawal_policy,
    cycle_end,
    shares_total,
    savings_total,
    social_total: social_total - paid,
    status,
  }
  and {
    // [spec 3.3 SocialPayout]: quorum ratification
    credential_authorized(quorum, tx)?,
    (fund_out.address == own_input.output.address)?,
    (paid > 0)?,
    // [spec 3.3 SocialPayout]: bounded by the social fund — member savings
    // and the share-out pot are out of the quorum's reach
    (paid <= social_total)?,
    only_fund_asset_moved(
      own_input.output.value,
      fund_out.value,
      asset_policy,
      asset_name,
      -paid,
    )?,
    (output_datum(fund_out) == expected_fund)?,
    mints_nothing_own(mint, policy_id)?,
  }
}

/// [spec 3.3 UpdateFund]: quorum amends mutable charter fields / rotates the
/// quorum. Asset, share_value, totals, and status are immutable.
pub fn validate_update_fund(
  policy_id: PolicyId,
  datum: SavingsDatum,
  own_input: Input,
  fund_output_index: Int,
  outputs: List<Output>,
  mint: Value,
  tx: Transaction,
) -> Bool {
  expect  
      SavingsFund {
        quorum,
        asset_policy,
        asset_name,
        share_value,
        shares_total,
        savings_total,
        social_total,
        status,
        ..
      }
    = datum
  // [spec 3.3 UpdateFund]: only while Active
  expect Active = status
  expect Some(fund_out) = list.at(outputs, fund_output_index)
  expect  
      SavingsFund {
        title: new_title,
        quorum: _new_quorum,
        asset_policy: out_asset_policy,
        asset_name: out_asset_name,
        share_value: out_share_value,
        min_shares_per_deposit: new_min,
        max_shares_per_deposit: new_max,
        withdrawal_policy: new_wp,
        cycle_end: _new_cycle_end,
        shares_total: out_shares_total,
        savings_total: out_savings_total,
        social_total: out_social_total,
        status: out_status,
      }
    = output_datum(fund_out)
  and {
    credential_authorized(quorum, tx)?,
    (fund_out.address == own_input.output.address)?,
    // [spec 3.3 UpdateFund]: immutable forever — changing share_value would
    // corrupt the share invariant; changing the asset would strand custody
    (out_asset_policy == asset_policy)?,
    (out_asset_name == asset_name)?,
    (out_share_value == share_value)?,
    (out_shares_total == shares_total)?,
    (out_savings_total == savings_total)?,
    (out_social_total == social_total)?,
    (out_status == Active)?,
    // [spec 3.3 UpdateFund]: post-update charter sanity
    (bytearray.length(new_title) <= 64)?,
    (new_min > 0)?,
    (new_min <= new_max)?,
    (new_wp == 0 || new_wp == 1)?,
    // [spec 3.3 UpdateFund]: amending moves no money
    (fund_out.value == own_input.output.value)?,
    mints_nothing_own(mint, policy_id)?,
  }
}

/// [spec 3.3 CloseCycle]: the quorum freezes the share-out snapshot, EXACTLY:
/// pot = vault - social - buffer(ADA funds). Freezing moves no value.
pub fn validate_close_cycle(
  policy_id: PolicyId,
  datum: SavingsDatum,
  own_input: Input,
  fund_output_index: Int,
  outputs: List<Output>,
  mint: Value,
  tx: Transaction,
) -> Bool {
  expect  
      SavingsFund {
        title,
        quorum,
        asset_policy,
        asset_name,
        share_value,
        min_shares_per_deposit,
        max_shares_per_deposit,
        withdrawal_policy,
        cycle_end,
        shares_total,
        savings_total: _savings_total,
        social_total,
        status,
      }
    = datum
  expect Active = status
  // [spec 3.3 CloseCycle]: not before the charter's cycle end
  let after_cycle_end = when cycle_end is {
    None -> True
    Some(t) -> {
      expect Finite(lo) = tx.validity_range.lower_bound.bound_type
      lo >= t
    }
  }
  // [spec 3.3 CloseCycle]: the anchor's protocol buffer is not a deposit —
  // excluded for ADA funds so the last claims never break on min-ADA
  let buffer = if asset_policy == "" {
    min_ada_buffer
  } else {
    0
  }
  let vault = asset_amount(own_input.output.value, asset_policy, asset_name)
  let pot = vault - social_total - buffer
  expect Some(fund_out) = list.at(outputs, fund_output_index)
  let expected_fund = SavingsFund {
    title,
    quorum,
    asset_policy,
    asset_name,
    share_value,
    min_shares_per_deposit,
    max_shares_per_deposit,
    withdrawal_policy,
    cycle_end,
    // superseded by the frozen snapshot
    shares_total: 0,
    savings_total: 0,
    social_total,
    status: SharingOut {
      pot,
      shares: shares_total,
      shares_remaining: shares_total,
    },
  }
  and {
    credential_authorized(quorum, tx)?,
    after_cycle_end?,
    (fund_out.address == own_input.output.address)?,
    (pot > 0)?,
    (shares_total > 0)?,
    // [spec 3.3 CloseCycle]: freezing moves no money
    (fund_out.value == own_input.output.value)?,
    (output_datum(fund_out) == expected_fund)?,
    mints_nothing_own(mint, policy_id)?,
  }
}

/// [spec 3.3 RemoveAccount]: a zero-balance member exits; the paired burn is
/// enforced here (spend authorizes, mint enforces the pair). Standalone — no
/// live anchor required, so fund closure can never strand accounts.
pub fn validate_remove_account(
  policy_id: PolicyId,
  datum: SavingsDatum,
  own_input: Input,
  inputs: List<Input>,
  mint: Value,
) -> Bool {
  expect MemberAccount { share_units, .. } = datum
  let ref_name = member_ref_name(own_input.output.value, policy_id)
  let user_name = cip68.convert_ref_to_user_token(ref_name)
  and {
    // [spec 3.3 RemoveAccount]: exits can never strand savings
    (share_units == 0)?,
    user_token_present(inputs, policy_id, ref_name)?,
    // [spec 3.3 RemoveAccount]: both tokens of THIS suffix burn
    (own_tokens(mint, policy_id) == [Pair(ref_name, -1), Pair(user_name, -1)])?,
  }
}

/// [spec 3.3 CloseFund]: after every share is claimed, the quorum burns the
/// anchor and releases the residual (dust + unclaimed social) as it directs.
pub fn validate_close_fund(
  policy_id: PolicyId,
  datum: SavingsDatum,
  own_input: Input,
  mint: Value,
  tx: Transaction,
) -> Bool {
  expect SavingsFund { quorum, status, .. } = datum
  // [spec 3.3 CloseFund]: closure only after the share-out completes
  expect SharingOut { shares_remaining, .. } = status
  let fund_name = fund_name_of(own_input, policy_id)
  and {
    credential_authorized(quorum, tx)?,
    (shares_remaining == 0)?,
    // [spec 3.3 CloseFund]: the Fund State NFT burns — no half-closed funds
    (own_tokens(mint, policy_id) == [Pair(fund_name, -1)])?,
  }
}
