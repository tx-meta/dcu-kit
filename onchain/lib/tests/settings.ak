use cardano/address.{Address, Script}
use cardano/assets
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction,
}
use dcu/settings.{
  ProtocolSettings, read_settings, settings_token_name, validate_settings_mint,
}
use tests/common

// Settings NFT policy used across these tests.
fn settings_policy() -> assets.PolicyId {
  common.test_hash_01()
}

// The published trusted policy IDs (account / group / treasury).
fn sample_settings() -> ProtocolSettings {
  ProtocolSettings {
    account_policy: common.test_hash_01(),
    group_policy: common.test_hash_02(),
    treasury_policy: common.test_hash_03(),
  }
}

// A reference input holding the singleton settings NFT + the ProtocolSettings datum,
// locked at an arbitrary script address (in production: the always-fails address).
fn settings_ref_input(datum: ProtocolSettings, nft_qty: Int) -> Input {
  let value = assets.from_lovelace(2_000_000)
    |> assets.merge(
        assets.from_asset(settings_policy(), settings_token_name, nft_qty),
      )
  Input {
    output_reference: OutputReference {
      transaction_id: #"5555555555555555555555555555555555555555555555555555555555555555",
      output_index: 0,
    },
    output: Output {
      address: Address(Script(common.test_hash_03()), None),
      value,
      datum: InlineDatum(datum),
      reference_script: None,
    },
  }
}

// The seed UTxO consumed by the one-shot mint.
fn seed_ref() -> OutputReference {
  OutputReference {
    transaction_id: #"7777777777777777777777777777777777777777777777777777777777777777",
    output_index: 1,
  }
}

// ─── read_settings ────────────────────────────────────────────────────────────

// Happy path: the settings UTxO is found by its singleton NFT and its datum returned.
test read_settings__returns_published_policies() {
  let expected = sample_settings()
  let reference_inputs = [settings_ref_input(expected, 1)]
  read_settings(reference_inputs, settings_policy()) == expected
}

// No settings NFT among the reference inputs → read_settings fails (expect Some).
test read_settings__rejects_missing_nft() fail {
  let reference_inputs = []
  read_settings(reference_inputs, settings_policy()) == sample_settings()
}

// A token under the settings policy that is NOT a clean singleton (qty 2) must not
// satisfy the quantity_of == 1 lookup, so the NFT is treated as absent → fails.
test read_settings__rejects_non_singleton() fail {
  let reference_inputs = [settings_ref_input(sample_settings(), 2)]
  read_settings(reference_inputs, settings_policy()) == sample_settings()
}

// ─── validate_settings_mint (one-shot) ─────────────────────────────────────────

// Accept: the seed UTxO is spent and exactly one settings NFT is minted.
test settings_mint__accepts_one_shot() {
  let seed = seed_ref()
  let seed_input = Input {
    output_reference: seed,
    output: common.placeholder_output,
  }
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [seed_input],
    mint: assets.from_asset(settings_policy(), settings_token_name, 1),
  }
  validate_settings_mint(seed, settings_policy(), tx)
}

// Reject: the seed UTxO is not spent → not a genuine one-shot.
test settings_mint__rejects_without_seed() {
  let seed = seed_ref()
  let tx = Transaction {
    ..transaction.placeholder,
    inputs: [],
    mint: assets.from_asset(settings_policy(), settings_token_name, 1),
  }
  !validate_settings_mint(seed, settings_policy(), tx)
}

// Reject: more than one token minted under the policy (extra token piggy-backed).
test settings_mint__rejects_extra_token() {
  let seed = seed_ref()
  let seed_input = Input {
    output_reference: seed,
    output: common.placeholder_output,
  }
  let mint = assets.from_asset(settings_policy(), settings_token_name, 1)
    |> assets.merge(assets.from_asset(settings_policy(), #"6666", 1))
  let tx = Transaction { ..transaction.placeholder, inputs: [seed_input], mint }
  !validate_settings_mint(seed, settings_policy(), tx)
}
