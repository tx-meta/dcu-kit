use aiken/collection/list
use aiken/fuzz
use cardano/address.{Address, Credential, Inline, Script, VerificationKey}
use cardano/assets
use escrow/types.{EscrowDatum}
use tests/common.{token_policy}

// Escrow rules depend on credential KIND (VK signature vs script spent-input);
// fuzz both kinds so kind-dependent branches are exercised on each run.
pub fn gen_credential() -> Fuzzer<Credential> {
  let hash <- fuzz.and_then(fuzz.bytearray_fixed(28))
  let is_script <- fuzz.and_then(fuzz.bool())
  fuzz.constant(
    if is_script {
      Script(hash)
    } else {
      VerificationKey(hash)
    },
  )
}

// Full address: payment credential of either kind, stake credential absent or inline.
pub fn gen_address() -> Fuzzer<Address> {
  let payment <- fuzz.and_then(gen_credential())
  let has_stake <- fuzz.and_then(fuzz.bool())
  let stake <- fuzz.and_then(gen_credential())
  fuzz.constant(
    Address {
      payment_credential: payment,
      stake_credential: if has_stake {
        Some(Inline(stake))
      } else {
        None
      },
    },
  )
}

// 1-10 tranches, each strictly positive.
pub fn gen_milestones() -> Fuzzer<List<Int>> {
  fuzz.list_between(fuzz.int_between(1, 100_000_000), 1, 10)
}

// ADA or a fixed native token — the two asset modes the validator branches on.
pub fn gen_asset() -> Fuzzer<(ByteArray, ByteArray)> {
  let is_ada <- fuzz.and_then(fuzz.bool())
  fuzz.constant(
    if is_ada {
      (assets.ada_policy_id, assets.ada_asset_name)
    } else {
      (token_policy(), "USDM")
    },
  )
}

// Well-formed datum: released_count within schedule, positive expiry.
pub fn gen_escrow_datum() -> Fuzzer<EscrowDatum> {
  let funder <- fuzz.and_then(gen_address())
  let beneficiary <- fuzz.and_then(gen_address())
  let verifier <- fuzz.and_then(gen_credential())
  let (asset_policy, asset_name) <- fuzz.and_then(gen_asset())
  let milestones <- fuzz.and_then(gen_milestones())
  let released_count <- fuzz.and_then(
    fuzz.int_between(0, list.length(milestones) - 1),
  )
  let expiry <- fuzz.and_then(fuzz.int_between(1, 4_000_000_000_000))
  fuzz.constant(
    EscrowDatum {
      funder,
      beneficiary,
      verifier,
      asset_policy,
      asset_name,
      milestones,
      released_count,
      expiry,
    },
  )
}
