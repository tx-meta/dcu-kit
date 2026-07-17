use cardano/address.{Address, Credential}
use cardano/assets.{AssetName, PolicyId}

// [spec 3.5]: the pool anchor — charter, ratification authority, and the
// enforced allocation destination. `quorum` is the governance socket: a native
// multisig today, a vote-tally script (primitive #9) later, by rotation.
pub type PoolDatum {
  title: ByteArray,
  content_hash: Option<ByteArray>,
  quorum: Credential,
  // Script hash allocations MUST land at (the escrow generation of choice).
  escrow_target: ByteArray,
  // The pool's asset ("" = ADA); deposits and allocations are measured in it.
  asset_policy: PolicyId,
  asset_name: AssetName,
  // Allocations close after this; exits never close.
  funding_deadline: Option<Int>,
  // 0 = Active, 1 = Closed.
  status: Int,
}

pub type VaultDatum {
  PoolAnchor { pool: PoolDatum }
  // An individually-owned commitment: the contributor can exit until the
  // quorum allocates it. `locked_until` = optional commitment window.
  PoolDeposit {
    pool_id: AssetName,
    contributor: Address,
    locked_until: Option<Int>,
  }
}

pub type PoolSpendRedeemer {
  UpdatePool { pool_input_index: Int, continuation_index: Int }
  ClosePool { pool_input_index: Int }
  ExitDeposit { deposit_input_index: Int }
  AllocateToEscrow {
    deposit_input_index: Int,
    pool_ref_index: Int,
    escrow_output_index: Int,
    // 99 = seeding a NEW escrow (no escrow input in the tx).
    escrow_input_index: Int,
    // 99 = full allocation (no deposit remainder continues).
    continuation_index: Int,
  }
}

pub type PoolMintRedeemer {
  CreatePool { seed_input_index: Int, pool_output_index: Int }
  BurnPool
}
