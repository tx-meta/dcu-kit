use aiken/collection/dict
use aiken/collection/list
use cardano/address.{Script}
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{InlineDatum, Input}
use dcu/treasury.{DefaultState, PenaltyState, TreasuryDatum, TreasuryState}

// ─── Treasury Helpers ─────────────────────────────────────────────────────────

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
      let holds =
        fn(i: Input) {
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
