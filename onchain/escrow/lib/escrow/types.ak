use cardano/address.{Address, Credential}
use cardano/assets.{AssetName, PolicyId}

pub type EscrowDatum {
  // Full addresses: payouts/refunds pin payment AND stake credential.
  // Authorization uses address.payment_credential via credential_authorized.
  funder: Address,
  beneficiary: Address,
  // Authority only — never receives funds, so a bare credential suffices.
  verifier: Credential,
  asset_policy: PolicyId,
  asset_name: AssetName,
  milestones: List<Int>,
  released_count: Int,
  expiry: Int,
}

pub type EscrowSpendRedeemer {
  Release {
    escrow_input_index: Int,
    continuation_index: Int,
    payout_index: Int,
  }
  Reclaim { escrow_input_index: Int, refund_index: Int }
  Abort { escrow_input_index: Int }
}

pub type EscrowMintRedeemer {
  CreateEscrow { seed_input_index: Int, escrow_output_index: Int }
  BurnEscrow
}
