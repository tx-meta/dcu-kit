use aiken/collection/list
use aiken/fuzz
use cardano/address.{VerificationKey}
use cardano/assets
use cardano/transaction.{Transaction, placeholder}
use escrow/escrow_validation.{
  milestones_total, validate_create_escrow, validate_reclaim, validate_release,
}
use escrow/types.{EscrowDatum}
use tests/common.{
  escrow_input, escrow_output, escrow_policy, funder_address, funder_pkh,
  range_after, range_before, seed_input, seed_token_name, user_output,
  verifier_pkh,
}
use tests/fuzzers.{gen_escrow_datum}

// Escrow UTxO value holding `amount` of the datum's asset (+ state token,
// + 2 ADA buffer when the asset is a native token or on top of an ADA balance).
fn held_value(datum: EscrowDatum, amount: Int) {
  if datum.asset_policy == assets.ada_policy_id {
    assets.from_lovelace(amount + 2_000_000)
      |> assets.add(escrow_policy(), seed_token_name(), 1)
  } else {
    assets.from_lovelace(2_000_000)
      |> assets.add(datum.asset_policy, datum.asset_name, amount)
      |> assets.add(escrow_policy(), seed_token_name(), 1)
  }
}

fn asset_only(datum: EscrowDatum, amount: Int) {
  if datum.asset_policy == assets.ada_policy_id {
    assets.from_lovelace(amount)
  } else {
    assets.from_lovelace(1_500_000)
      |> assets.add(datum.asset_policy, datum.asset_name, amount)
  }
}

fn remaining_total(datum: EscrowDatum) {
  milestones_total(list.drop(datum.milestones, datum.released_count))
}

// Any well-formed generated datum (fresh, count 0) funded at exactly the milestone
// total is accepted at create — and rejected when underfunded by a single unit.
test prop_create__exact_funding_boundary(datum0 via gen_escrow_datum()) {
  let datum = EscrowDatum { ..datum0, released_count: 0 }
  let total = milestones_total(datum.milestones)
  let funded =
    if datum.asset_policy == assets.ada_policy_id {
      assets.from_lovelace(total)
        |> assets.add(escrow_policy(), seed_token_name(), 1)
    } else {
      assets.from_lovelace(2_000_000)
        |> assets.add(datum.asset_policy, datum.asset_name, total)
        |> assets.add(escrow_policy(), seed_token_name(), 1)
    }
  let short =
    if datum.asset_policy == assets.ada_policy_id {
      assets.from_lovelace(total - 1)
        |> assets.add(escrow_policy(), seed_token_name(), 1)
    } else {
      assets.from_lovelace(2_000_000)
        |> assets.add(datum.asset_policy, datum.asset_name, total - 1)
        |> assets.add(escrow_policy(), seed_token_name(), 1)
    }
  let mint = assets.from_asset(escrow_policy(), seed_token_name(), 1)
  let accepts =
    fn(value) {
      validate_create_escrow(
        escrow_policy(),
        0,
        0,
        [seed_input()],
        [escrow_output(escrow_policy(), datum, value)],
        mint,
        range_before(datum.expiry - 1),
      )
    }
  accepts(funded) && !accepts(short)
}

// Non-final release fixture: len >= 2 tranches, released_count within 0..len-2,
// VK verifier (credential kinds are covered by direct tests and the create prop).
fn gen_release_case() -> Fuzzer<EscrowDatum> {
  let datum0 <- fuzz.and_then(gen_escrow_datum())
  let milestones =
    if list.length(datum0.milestones) < 2 {
      list.concat(datum0.milestones, datum0.milestones)
    } else {
      datum0.milestones
    }
  let released_count <-
    fuzz.and_then(fuzz.int_between(0, list.length(milestones) - 2))
  fuzz.constant(
    EscrowDatum {
      ..datum0,
      verifier: VerificationKey(verifier_pkh()),
      milestones,
      released_count,
    },
  )
}

fn release_tx(datum: EscrowDatum, outputs) -> Transaction {
  Transaction {
    ..placeholder,
    outputs: outputs,
    extra_signatories: [verifier_pkh()],
    validity_range: range_before(datum.expiry - 1),
  }
}

// Release moves exactly milestones[released_count]: the exact fixture is accepted;
// a payout OR continuation short by one unit is rejected.
test prop_release__exact_tranche_boundary(datum via gen_release_case()) {
  expect Some(tranche) = list.at(datum.milestones, datum.released_count)
  let remaining = remaining_total(datum)
  let own = escrow_input(0, escrow_output(escrow_policy(), datum, held_value(datum, remaining)))
  let next = EscrowDatum { ..datum, released_count: datum.released_count + 1 }
  let cont_good =
    escrow_output(escrow_policy(), next, held_value(datum, remaining - tranche))
  let cont_short =
    escrow_output(
      escrow_policy(),
      next,
      held_value(datum, remaining - tranche)
        |> assets.merge(
            if datum.asset_policy == assets.ada_policy_id {
              assets.from_lovelace(-1)
            } else {
              assets.from_asset(datum.asset_policy, datum.asset_name, -1)
            },
          ),
    )
  let payout_good = user_output(datum.beneficiary, asset_only(datum, tranche))
  let payout_short =
    user_output(datum.beneficiary, asset_only(datum, tranche - 1))
  let run =
    fn(cont, payout) {
      validate_release(
        escrow_policy(),
        datum,
        own,
        0,
        1,
        [cont, payout],
        assets.zero,
        release_tx(datum, [cont, payout]),
      )
    }
  and {
    run(cont_good, payout_good)?,
    !run(cont_good, payout_short)?,
    !run(cont_short, payout_good)?,
  }
}

fn gen_release_mutation_case() -> Fuzzer<(EscrowDatum, Int)> {
  fuzz.map2(gen_release_case(), fuzz.int_between(0, 4), fn(d, i) { (d, i) })
}

fn gen_reclaim_boundary_case() -> Fuzzer<(EscrowDatum, Int)> {
  fuzz.map2(gen_escrow_datum(), fuzz.int_between(-5, 5), fn(d, o) { (d, o) })
}

// released_count may only advance by exactly +1 per release.
test prop_release__count_only_advances_by_one(
  case via gen_release_mutation_case(),
) {
  let (datum, delta_ix) = case
  expect Some(delta) = list.at([-2, -1, 0, 2, 3], delta_ix)
  expect Some(tranche) = list.at(datum.milestones, datum.released_count)
  let remaining = remaining_total(datum)
  let own = escrow_input(0, escrow_output(escrow_policy(), datum, held_value(datum, remaining)))
  let mutated =
    EscrowDatum { ..datum, released_count: datum.released_count + delta }
  let cont =
    escrow_output(escrow_policy(), mutated, held_value(datum, remaining - tranche))
  let payout = user_output(datum.beneficiary, asset_only(datum, tranche))
  !validate_release(
    escrow_policy(),
    datum,
    own,
    0,
    1,
    [cont, payout],
    assets.zero,
    release_tx(datum, [cont, payout]),
  )
}

// Reclaim opens strictly after expiry: accepted iff the pinned lower bound
// exceeds it, at every offset around the boundary.
test prop_reclaim__expiry_boundary(case via gen_reclaim_boundary_case()) {
  let (datum0, offset) = case
  let datum = EscrowDatum { ..datum0, funder: funder_address() }
  let remaining = remaining_total(datum)
  let own = escrow_input(0, escrow_output(escrow_policy(), datum, held_value(datum, remaining)))
  let refund =
    user_output(
      datum.funder,
      if datum.asset_policy == assets.ada_policy_id {
        assets.from_lovelace(remaining + 2_000_000)
      } else {
        assets.from_lovelace(2_000_000)
          |> assets.add(datum.asset_policy, datum.asset_name, remaining)
      },
    )
  let burn = assets.from_asset(escrow_policy(), seed_token_name(), -1)
  let tx =
    Transaction {
      ..placeholder,
      extra_signatories: [funder_pkh()],
      validity_range: range_after(datum.expiry + offset),
      mint: burn,
    }
  validate_reclaim(escrow_policy(), datum, own, 0, [refund], burn, tx) == (
    offset > 0
  )
}
