use cardano/address.{Script, VerificationKey}
use cardano/assets
use cardano/transaction.{Transaction, placeholder}
use escrow/project_validation.{
  validate_burn_project, validate_close_project, validate_create_project,
  validate_update_project,
}
use escrow/types_v2.{ProjectDatum}
use tests/common.{escrow_input, funder_pkh, seed_input, seed_token_name}
use tests/common_v2.{
  owner_pkh, project_output, project_policy, test_project_datum,
}

fn mint_one() {
  assets.from_asset(project_policy(), seed_token_name(), 1)
}

fn burn_one() {
  assets.from_asset(project_policy(), seed_token_name(), -1)
}

fn project_value() {
  assets.from_lovelace(2_000_000)
    |> assets.add(project_policy(), seed_token_name(), 1)
}

fn owner_tx(signer: ByteArray) -> Transaction {
  Transaction { ..placeholder, extra_signatories: [signer] }
}

// ── Create ───────────────────────────────────────────────────────────────────

test project_create__accepts_valid() {
  validate_create_project(
    project_policy(),
    0,
    0,
    [seed_input()],
    [project_output(project_policy(), test_project_datum(), project_value())],
    mint_one(),
  )
}

test project_create__rejects_closed_status() {
  let datum = ProjectDatum { ..test_project_datum(), status: 1 }
  !validate_create_project(
    project_policy(),
    0,
    0,
    [seed_input()],
    [project_output(project_policy(), datum, project_value())],
    mint_one(),
  )
}

test project_create__rejects_wrong_token_name() fail {
  validate_create_project(
    project_policy(),
    0,
    0,
    [seed_input()],
    [project_output(project_policy(), test_project_datum(), project_value())],
    assets.from_asset(project_policy(), "bogus", 1),
  )
}

test project_create__rejects_own_script_owner() {
  let datum = ProjectDatum {
    ..test_project_datum(),
    owner: Script(project_policy()),
  }
  !validate_create_project(
    project_policy(),
    0,
    0,
    [seed_input()],
    [project_output(project_policy(), datum, project_value())],
    mint_one(),
  )
}

// ── Update ───────────────────────────────────────────────────────────────────

test project_update__accepts_owner_change_and_close() {
  let datum = test_project_datum()
  let own = escrow_input(
    0,
    project_output(project_policy(), datum, project_value()),
  )
  let updated = ProjectDatum {
    title: "borehole program phase 2",
    content_hash: Some("terms-v2"),
    status: 1,
    owner: VerificationKey(funder_pkh()),
  }
  let cont = project_output(project_policy(), updated, project_value())
  validate_update_project(
    project_policy(),
    datum,
    own,
    0,
    [cont],
    owner_tx(owner_pkh()),
  )
}

test project_update__rejects_non_owner() {
  let datum = test_project_datum()
  let own = escrow_input(
    0,
    project_output(project_policy(), datum, project_value()),
  )
  let cont = project_output(
    project_policy(),
    ProjectDatum { ..datum, title: "hijacked" },
    project_value(),
  )
  !validate_update_project(
    project_policy(),
    datum,
    own,
    0,
    [cont],
    owner_tx(funder_pkh()),
  )
}

test project_update__rejects_invalid_status() {
  let datum = test_project_datum()
  let own = escrow_input(
    0,
    project_output(project_policy(), datum, project_value()),
  )
  let cont = project_output(
    project_policy(),
    ProjectDatum { ..datum, status: 7 },
    project_value(),
  )
  !validate_update_project(
    project_policy(),
    datum,
    own,
    0,
    [cont],
    owner_tx(owner_pkh()),
  )
}

test project_update__rejects_oversized_title() {
  let datum = test_project_datum()
  let own = escrow_input(
    0,
    project_output(project_policy(), datum, project_value()),
  )
  let cont = project_output(
    project_policy(),
    ProjectDatum {
      ..datum,
      title: "this project title is deliberately far longer than the sixty-four byte cap",
    },
    project_value(),
  )
  !validate_update_project(
    project_policy(),
    datum,
    own,
    0,
    [cont],
    owner_tx(owner_pkh()),
  )
}

test project_update__rejects_lovelace_decrease() {
  let datum = test_project_datum()
  let own = escrow_input(
    0,
    project_output(project_policy(), datum, project_value()),
  )
  let cont = project_output(
    project_policy(),
    datum,
    assets.from_lovelace(1_000_000)
      |> assets.add(project_policy(), seed_token_name(), 1),
  )
  !validate_update_project(
    project_policy(),
    datum,
    own,
    0,
    [cont],
    owner_tx(owner_pkh()),
  )
}

// ── Close / burn ─────────────────────────────────────────────────────────────

test project_close__accepts_owner_burn() {
  let datum = test_project_datum()
  let own = escrow_input(
    0,
    project_output(project_policy(), datum, project_value()),
  )
  validate_close_project(
    project_policy(),
    datum,
    own,
    burn_one(),
    owner_tx(owner_pkh()),
  )
}

test project_close__rejects_non_owner() {
  let datum = test_project_datum()
  let own = escrow_input(
    0,
    project_output(project_policy(), datum, project_value()),
  )
  !validate_close_project(
    project_policy(),
    datum,
    own,
    burn_one(),
    owner_tx(funder_pkh()),
  )
}

test project_burn__rejects_mint_alongside() {
  !validate_burn_project(
    project_policy(),
    burn_one() |> assets.add(project_policy(), "extra", 1),
  )
}
