use aiken/collection/dict
use aiken/collection/list
use cardano/address.{Script}
use cardano/assets.{AssetName, PolicyId, Value, ada_policy_id}
use cardano/transaction.{InlineDatum, Input, Output}
use dcu/treasury.{DefaultState, PenaltyState, TreasuryDatum, TreasuryState}
use dcu/utils.{only_allowed_policies}

// ─── Min-ADA reserve ──────────────────────────────────────────────────────────

// min_ada_reserve
// Lovelace permanently retained in any live treasury/penalty UTxO to satisfy the
// ledger min-ADA requirement of the membership token it carries. 2 ADA sits safely
// above the real min-ADA (~1.2–1.4 ADA for a single-token UTxO with an inline
// TreasuryDatum), so a treasury can always cover its own existence.
pub const min_ada_reserve: Int = 2_000_000

// contributable_in
// The *spendable* amount of `policy`/`name` held in `value`. For an ADA-denominated
// asset (policy == ada_policy_id) the min-ADA reserve is excluded, so the conservation
// math never drives a live, token-bearing UTxO's lovelace below min-ADA: on the final
// round a member's contributable balance reaches 0 while `min_ada_reserve` lovelace
// remains to carry the token. For native tokens the reserve is 0 — the token balance is
// independent of the UTxO's lovelace — so token-denominated groups are unaffected.
pub fn contributable_in(value: Value, policy: PolicyId, name: AssetName) -> Int {
  let raw = assets.quantity_of(value, policy, name)
  if policy == ada_policy_id {
    raw - min_ada_reserve
  } else {
    raw
  }
}

// ─── Treasury Helpers ─────────────────────────────────────────────────────────

// treasury_output_clean
// The standard treasury-output guard, shared by handlers that produce a treasury
// UTxO: it sits at the treasury script address, holds EXACTLY the one membership
// token (exact check — blocks account-merge attacks), and carries no value beyond
// ADA + own policy + the group's contribution asset.
pub fn treasury_output_clean(
  own_output: Output,
  own_policy_id: PolicyId,
  member_reference_tokenname: AssetName,
  contribution_fee_policyid: PolicyId,
) -> Bool {
  and {
    own_output.address.payment_credential == Script(own_policy_id),
    dict.to_pairs(assets.tokens(own_output.value, own_policy_id)) == [
      Pair(member_reference_tokenname, 1),
    ],
    only_allowed_policies(
      own_output.value,
      [ada_policy_id, own_policy_id, contribution_fee_policyid],
    ),
  }
}

// member_has_user_token
// Verifies the input at member_input_index holds exactly 1 token of
// member_reference_tokenname under the account_policy_id.
pub fn member_has_user_token(
  inputs: List<Input>,
  member_input_index: Int,
  member_reference_tokenname: AssetName,
  account_policy_id: PolicyId,
) -> Bool {
  expect Some(member_input) = list.at(inputs, member_input_index)
  assets.quantity_of(
    member_input.output.value,
    account_policy_id,
    member_reference_tokenname,
  ) == 1
}

// find_group_token_name
// Extracts the group reference token name from a group UTxO's value.
pub fn find_group_token_name(group_input: Input) -> AssetName {
  expect Script(group_policy_id) = group_input.output.address.payment_credential
  expect [Pair(group_token_name, 1)] = dict.to_pairs(
    assets.tokens(group_input.output.value, group_policy_id),
  )
  group_token_name
}

// indices_in_ascending_order
// Verifies that a list of integer indices is strictly ascending.
// Prevents duplicate-index attacks where the same UTxO is listed twice.
pub fn indices_in_ascending_order(indices: List<Int>) -> Bool {
  when indices is {
    [] -> True
    [_] -> True
    [a, b, ..rest] -> a < b && indices_in_ascending_order([b, ..rest])
  }
}

// count_active_members
// Enforces the COMPLETE member set for a distribution round and returns the number of
// contributors. Every name in `member_token_names` must be held by exactly one of:
//   - a SPENDING input whose datum is TreasuryState           → contributing (counted)
//   - a REFERENCE input whose datum is DefaultState/PenaltyState → defaulter (not counted)
// Any member that is missing, or mis-classified (e.g. a healthy TreasuryState parked as a
// reference input to dodge contributing), fails via `expect`/`fail`. This closes the
// partial-set attack: a caller cannot advance a round while silently excluding healthy
// members. The pro-rata pot for the round is `contribution_fee * active_members`.
pub fn count_active_members(
  member_token_names: List<AssetName>,
  treasury_policy_id: PolicyId,
  inputs: List<Input>,
  reference_inputs: List<Input>,
) -> Int {
  list.foldl(
    member_token_names,
    0,
    fn(name, acc) {
      let holds = fn(i: Input) {
        assets.quantity_of(i.output.value, treasury_policy_id, name) == 1
      }
      when list.find(inputs, holds) is {
        // Member is a spending input → must be TreasuryState (contributing this round).
        Some(member_input) -> {
          expect InlineDatum(d) = member_input.output.datum
          expect member_datum: TreasuryDatum = d
          when member_datum is {
            TreasuryState { .. } -> acc + 1
            _ -> fail @"spent member treasury must be TreasuryState in a round"
          }
        }
        // Not spent → must be referenced as a genuine defaulter.
        None -> {
          expect Some(ref_input) = list.find(reference_inputs, holds)
          expect InlineDatum(d) = ref_input.output.datum
          expect ref_datum: TreasuryDatum = d
          when ref_datum is {
            DefaultState { .. } -> acc
            PenaltyState { .. } -> acc
            TreasuryState { .. } ->
              fail @"healthy member must contribute, not be referenced"
          }
        }
      }
    },
  )
}
