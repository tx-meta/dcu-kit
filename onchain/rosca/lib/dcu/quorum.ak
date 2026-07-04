use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use cardano/address.{VerificationKey}
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{Input}

// ─── Quorum helpers — generic M-of-N token-holder signature primitives ───────
//
// Consumed today by the lost-member recovery flow (Propose/Approve/Cancel/
// ExecuteRecovery in treasury_validation.ak); designed as PRODUCT-AGNOSTIC
// primitives — any validator that counts token-holder consent (e.g. the escrow
// family's investor-quorum verifier) imports from here. Every operation that
// counts toward a quorum must prove the SAME two facts about an input —
//   1. it holds exactly 1 token of a given name under account_policy_id
//      (the bearer Account-222 token identifies a real member), and
//   2. the input sits at a VerificationKey address whose PKH is in
//      tx.extra_signatories (the caller actually SIGNED — bearer presence
//      alone is not consent; see signed_account_token_name below).

// signed_account_token_name
// ─────────────────────────────────────────────────────────────────────────────
// Resolves the input at `input_index` and returns the Account-222 token name it
// holds under `account_policy_id` — but ONLY if that input also sits at a
// VerificationKey address whose payment credential (PKH) appears in
// `extra_signatories`. This is the "signature-based approval" primitive:
// reference-input presence of a token proves the token EXISTS in this tx, not
// that its holder CONSENTED — a caller could attach someone else's UTxO as a
// reference input without that person's signature. Requiring the PKH in
// extra_signatories proves the holder actually authorised this transaction.
//
// Crashes (via `expect`) if: the index is out of range, the input is at a
// script address (no PKH to check), the PKH is absent from extra_signatories,
// or the input does not hold exactly 1 token under account_policy_id.
// Crash-style is intentional — every caller of this helper is on a
// quorum-counting path where a malformed/unauthorised index must hard-fail the
// transaction, mirroring `member_has_user_token`'s `expect Some(...)`
// convention but extended with the signature requirement.
pub fn signed_account_token_name(
  inputs: List<Input>,
  input_index: Int,
  account_policy_id: PolicyId,
  extra_signatories: List<VerificationKeyHash>,
) -> AssetName {
  expect Some(input) = list.at(inputs, input_index)
  expect VerificationKey(pkh) = input.output.address.payment_credential
  expect list.has(extra_signatories, pkh)
  expect [Pair(token_name, 1)] = dict.to_pairs(
    assets.tokens(input.output.value, account_policy_id),
  )
  token_name
}

// collect_signed_approvals
// ─────────────────────────────────────────────────────────────────────────────
// Maps `approver_input_indices` to the Account-222 token name each signed
// input holds (via signed_account_token_name — crashes on any index that isn't
// a genuinely signed, single-token account input). Returns the raw list,
// duplicates and non-members included; callers (validate_propose_recovery) are
// responsible for checking registry membership, distinctness, and self-vouch.
pub fn collect_signed_approvals(
  inputs: List<Input>,
  approver_input_indices: List<Int>,
  account_policy_id: PolicyId,
  extra_signatories: List<VerificationKeyHash>,
) -> List<AssetName> {
  list.map(
    approver_input_indices,
    fn(idx) {
      signed_account_token_name(
        inputs,
        idx,
        account_policy_id,
        extra_signatories,
      )
    },
  )
}

// approvals_are_distinct
// True iff no approver token name appears more than once — blocks a single
// signer's account token from being counted twice toward quorum by repeating
// its index in approver_input_indices.
pub fn approvals_are_distinct(approvals: List<AssetName>) -> Bool {
  list.length(approvals) == list.length(list.unique(approvals))
}

// approvals_are_registry_members
// True iff every approval token name is a real member of the group's
// registry (`member_token_names`) — an account token that never joined this
// group cannot vouch for a recovery.
pub fn approvals_are_registry_members(
  approvals: List<AssetName>,
  member_token_names: List<AssetName>,
) -> Bool {
  list.all(approvals, fn(a) { list.has(member_token_names, a) })
}

// recoveree_signed_for_token
// ─────────────────────────────────────────────────────────────────────────────
// Returns Some(pkh) for the recoveree iff at least one of `inputs` (spending OR
// reference — the recoveree may simply prove control without spending anything)
// holds exactly 1 of `token_name` under `account_policy_id` at a VK address
// whose PKH is in `extra_signatories`; the returned pkh is that VK address's
// payment credential. None when no such input exists. This is the
// recoveree-control proof: the ProposeRecovery redeemer carries no dedicated
// index for this input, so it must be found by scanning rather than trusting a
// caller-supplied position — an attacker cannot redirect this check to an
// unrelated signed input because the token name itself must match N' (the
// proposed new identity), not just any account token.
//
// Returning the pkh (not just a Bool) lets validate_propose_recovery BIND the
// request's new_payment_credential to the recoveree's own signing key: holding
// N' and signing only proves control of N', not that the payout address written
// into the request is the recoveree's. Without this the quorum could route the
// recovered member's future payouts to an arbitrary address.
pub fn recoveree_signed_for_token(
  inputs: List<Input>,
  token_name: AssetName,
  account_policy_id: PolicyId,
  extra_signatories: List<VerificationKeyHash>,
) -> Option<VerificationKeyHash> {
  list.find_map(
    inputs,
    fn(input) {
      when input.output.address.payment_credential is {
        VerificationKey(pkh) ->
          if list.has(extra_signatories, pkh) && dict.to_pairs(
            assets.tokens(input.output.value, account_policy_id),
          ) == [Pair(token_name, 1)] {
            Some(pkh)
          } else {
            None
          }
        _ -> None
      }
    },
  )
}
