use aiken/collection/dict
use aiken/collection/list
use aiken/interval.{Finite}
use aiken/primitive/bytearray
use cardano/address.{Address, Credential, Script, VerificationKey}
use cardano/assets.{PolicyId, Value}
use cardano/transaction.{InlineDatum, Input, Output, Transaction}
use escrow/credential.{credential_authorized, state_token_name}
use escrow/types_pool.{PoolAnchor, PoolDatum, PoolDeposit, VaultDatum}

fn credential_ok(cred: Credential, policy_id: PolicyId) -> Bool {
  let hash_ok = when cred is {
    VerificationKey(h) -> bytearray.length(h) == 28
    Script(h) -> bytearray.length(h) == 28
  }
  // [security]: an own-script quorum would make quorum-authorization vacuous.
  hash_ok && cred != Script(policy_id)
}

fn pool_datum_valid(pool: PoolDatum, policy_id: PolicyId) -> Bool {
  and {
    (pool.status == 0 || pool.status == 1)?,
    (bytearray.length(pool.title) <= 64)?,
    credential_ok(pool.quorum, policy_id)?,
    (bytearray.length(pool.escrow_target) == 28)?,
    // [security]: allocations must leave the vault — never point back at it.
    (pool.escrow_target != policy_id)?,
    when pool.funding_deadline is {
      None -> True
      Some(d) -> d > 0
    },
  }
}

// [spec 3.5 CreatePool]: one-shot pool NFT from a seed input; anchor output at
// the vault's own address with the token and a valid Active datum.
pub fn validate_create_pool(
  policy_id: PolicyId,
  seed_input_index: Int,
  pool_output_index: Int,
  inputs: List<Input>,
  outputs: List<Output>,
  mint: Value,
) -> Bool {
  expect Some(seed) = list.at(inputs, seed_input_index)
  let name = state_token_name(seed.output_reference)
  expect [Pair(minted_name, 1)] = dict.to_pairs(assets.tokens(mint, policy_id))
  expect Some(out) = list.at(outputs, pool_output_index)
  expect InlineDatum(raw) = out.datum
  expect PoolAnchor { pool }: VaultDatum = raw
  and {
    (minted_name == name)?,
    (out.address.payment_credential == Script(policy_id))?,
    (dict.to_pairs(assets.tokens(out.value, policy_id)) == [Pair(name, 1)])?,
    (assets.policies(out.value) == [assets.ada_policy_id, policy_id])?,
    (pool.status == 0)?,
    pool_datum_valid(pool, policy_id)?,
  }
}

// [spec 3.5 UpdatePool]: quorum-authorized; charter, status, and quorum
// rotation (the governance handoff — including the future upgrade to a
// vote-script quorum). The NFT stays; lovelace never decreases.
pub fn validate_update_pool(
  policy_id: PolicyId,
  pool: PoolDatum,
  own_input: Input,
  continuation_index: Int,
  outputs: List<Output>,
  tx: Transaction,
) -> Bool {
  expect [Pair(state_name, 1)] = dict.to_pairs(
    assets.tokens(own_input.output.value, policy_id),
  )
  expect Some(cont) = list.at(outputs, continuation_index)
  expect InlineDatum(raw) = cont.datum
  expect PoolAnchor { pool: cont_pool }: VaultDatum = raw
  and {
    credential_authorized(pool.quorum, tx)?,
    (cont.address == own_input.output.address)?,
    (dict.to_pairs(assets.tokens(cont.value, policy_id)) == [
      Pair(state_name, 1),
    ])?,
    (assets.policies(cont.value) == [assets.ada_policy_id, policy_id])?,
    pool_datum_valid(cont_pool, policy_id)?,
    // The pool's asset and target are its identity — immutable.
    (cont_pool.escrow_target == pool.escrow_target)?,
    (cont_pool.asset_policy == pool.asset_policy)?,
    (cont_pool.asset_name == pool.asset_name)?,
    (assets.lovelace_of(cont.value) >= assets.lovelace_of(
      own_input.output.value,
    ))?,
  }
}

// [spec 3.5 ClosePool]: quorum-authorized burn. Deposits are unaffected —
// individually owned and exitable; only allocations die with the anchor.
pub fn validate_close_pool(
  policy_id: PolicyId,
  pool: PoolDatum,
  own_input: Input,
  mint: Value,
  tx: Transaction,
) -> Bool {
  expect [Pair(state_name, 1)] = dict.to_pairs(
    assets.tokens(own_input.output.value, policy_id),
  )
  and {
    credential_authorized(pool.quorum, tx)?,
    (assets.quantity_of(mint, policy_id, state_name) == -1)?,
  }
}

// [spec 3.5 ExitDeposit]: the protection a Safe cannot give — the contributor
// unilaterally recovers an unallocated deposit (past any commitment window).
pub fn validate_exit_deposit(
  contributor: Address,
  locked_until: Option<Int>,
  tx: Transaction,
) -> Bool {
  let lock_ok = when locked_until is {
    None -> True
    Some(t) -> {
      expect Finite(lower) = tx.validity_range.lower_bound.bound_type
      lower > t
    }
  }
  and {
    credential_authorized(contributor.payment_credential, tx)?,
    lock_ok?,
  }
}

// [spec 3.5 AllocateToEscrow]: quorum-ratified, destination-enforced. The
// deposit's allocated value must ARRIVE at the pool's escrow_target script in
// an output carrying exactly one of that script's state tokens — seeding a new
// escrow or contributing to an existing one; the escrow's own validator
// enforces its side. Partial allocations continue the remainder as an
// identical deposit.
pub fn validate_allocate(
  policy_id: PolicyId,
  own_datum_raw: Data,
  pool_id: ByteArray,
  own_input: Input,
  pool_ref_index: Int,
  escrow_output_index: Int,
  escrow_input_index: Int,
  continuation_index: Int,
  inputs: List<Input>,
  reference_inputs: List<Input>,
  outputs: List<Output>,
  tx: Transaction,
) -> Bool {
  // The live pool anchor, by reference — quorum, target, deadline, status.
  expect Some(pool_ref) = list.at(reference_inputs, pool_ref_index)
  expect InlineDatum(pool_raw) = pool_ref.output.datum
  expect PoolAnchor { pool }: VaultDatum = pool_raw
  expect Some(esc_out) = list.at(outputs, escrow_output_index)
  // [spec 3.5]: exactly one state token of the target script in the output.
  expect [Pair(_, 1)] = dict.to_pairs(
    assets.tokens(esc_out.value, pool.escrow_target),
  )
  let in_value = own_input.output.value
  let deadline_ok = when pool.funding_deadline is {
    None -> True
    Some(d) -> {
      expect Finite(upper) = tx.validity_range.upper_bound.bound_type
      upper <= d
    }
  }
  // Allocated = deposit minus (optional) continuation, in the pool's asset
  // AND in lovelace.
  let (cont_l, cont_a, cont_ok) = if continuation_index == 99 {
    (0, 0, True)
  } else {
    expect Some(cont) = list.at(outputs, continuation_index)
    expect InlineDatum(cont_raw) = cont.datum
    (
      assets.lovelace_of(cont.value),
      assets.quantity_of(cont.value, pool.asset_policy, pool.asset_name),
      and {
        cont.address == own_input.output.address,
        // The remainder stays the SAME contributor's deposit.
        cont_raw == own_datum_raw,
      },
    )
  }
  let alloc_l = assets.lovelace_of(in_value) - cont_l
  let alloc_a = assets.quantity_of(in_value, pool.asset_policy, pool.asset_name) - cont_a
  // Escrow-side gain must cover the allocation — value cannot leak to anyone.
  let (esc_in_l, esc_in_a) = if escrow_input_index == 99 {
    (0, 0)
  } else {
    expect Some(esc_in) = list.at(inputs, escrow_input_index)
    expect
      esc_in.output.address.payment_credential == Script(pool.escrow_target)
    (
      assets.lovelace_of(esc_in.output.value),
      assets.quantity_of(
        esc_in.output.value,
        pool.asset_policy,
        pool.asset_name,
      ),
    )
  }
  and {
    (pool_ref.output.address.payment_credential == Script(policy_id))?,
    (assets.quantity_of(pool_ref.output.value, policy_id, pool_id) == 1)?,
    (pool.status == 0)?,
    deadline_ok?,
    credential_authorized(pool.quorum, tx)?,
    (esc_out.address.payment_credential == Script(pool.escrow_target))?,
    cont_ok?,
    (alloc_a > 0 || alloc_l > 0)?,
    (alloc_a >= 0 && alloc_l >= 0)?,
    (assets.quantity_of(esc_out.value, pool.asset_policy, pool.asset_name) - esc_in_a >= alloc_a)?,
    (assets.lovelace_of(esc_out.value) - esc_in_l >= alloc_l)?,
  }
}

// [security]: burn-only — nothing minted under this policy.
pub fn validate_burn_pool(policy_id: PolicyId, mint: Value) -> Bool {
  let burned = dict.to_pairs(assets.tokens(mint, policy_id))
  burned != [] && list.all(
    burned,
    fn(pair) {
      let Pair(_, qty) = pair
      qty < 0
    },
  )
}

// Re-exported deposit datum accessor kept close to its rules.
pub fn deposit_fields(datum: VaultDatum) -> (ByteArray, Address, Option<Int>) {
  expect PoolDeposit { pool_id, contributor, locked_until } = datum
  (pool_id, contributor, locked_until)
}
