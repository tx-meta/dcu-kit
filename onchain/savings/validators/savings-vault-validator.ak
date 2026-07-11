use cardano/assets.{PolicyId}
use cardano/transaction.{OutputReference, Transaction}
use savings/types.{
  BurnAccount, BurnFund, ClaimShareOut, CloseCycle, CloseFund, CreateFund,
  Deposit, MintAccount, RemoveAccount, SavingsDatum, SavingsMintRedeemer,
  SavingsSpendRedeemer, SocialPayout, UpdateFund, Withdraw,
}

// ALWAYS-SUCCEEDS SCAFFOLD (pipeline Stage 3). Every TODO maps to one
// numbered validation item in docs/design-specs/savings-module.typ
// (spec 3.3 = Smart Contracts :: Savings Vault Validator :: Validation).
validator savings_vault {
  mint(redeemer: SavingsMintRedeemer, _policy_id: PolicyId, _tx: Transaction) {
    when redeemer is {
      CreateFund { .. } ->
        // TODO [spec 3.3 CreateFund]: seed input at seed_input_index is
        // consumed; token name == blake2b_256(serialise(seed outref)).
        // TODO [spec 3.3 CreateFund]: exactly one own-policy token minted, +1.
        // TODO [spec 3.3 CreateFund]: output at fund_output_index is at the
        // own script, carries the Fund State NFT, inline SavingsFund datum.
        // TODO [spec 3.3 CreateFund]: charter sanity — share_value > 0,
        // 0 < min <= max, withdrawal_policy in {0,1}, status Active.
        // TODO [spec 3.3 CreateFund]: zero start — all three totals == 0.
        // TODO [spec 3.3 CreateFund]: anchor non-ADA value is exactly the
        // Fund State NFT (no foreign tokens at creation).
        True
      MintAccount { .. } ->
        // TODO [spec 3.3 MintAccount]: reference input at fund_ref_index is at
        // the own script, holds an own-policy Fund State NFT, status Active.
        // TODO [spec 3.3 MintAccount]: seed input consumed; 28-byte suffix
        // derived from its output_reference (CIP-68 convention).
        // TODO [spec 3.3 MintAccount]: exactly two own-policy tokens minted,
        // +1 ref (000643b0+suffix) and +1 user (000de140+suffix).
        // TODO [spec 3.3 MintAccount]: output at ref_output_index at the own
        // script with inline MemberAccount datum — fund_id == referenced Fund
        // State NFT name, share_units == 0, social_paid == 0, joined_at
        // inside the tx validity window.
        // TODO [spec 3.3 MintAccount]: user token at user_output_index pays to
        // a VerificationKey payment credential (never a script).
        True
      BurnAccount ->
        // TODO [spec 3.3 BurnAccount]: exactly two own-policy tokens minted at
        // -1 each — one ref token and one user token sharing a suffix.
        // TODO [spec 3.3 BurnAccount]: runs only with the RemoveAccount spend
        // (two-phase deregistration; spend authorizes, mint enforces the pair).
        True
      BurnFund ->
        // TODO [spec 3.3 BurnFund]: exactly one own-policy token minted at -1
        // and it is a Fund State NFT (32-byte name, no CIP-68 prefix).
        // TODO [spec 3.3 BurnFund]: runs only with the CloseFund spend.
        True
    }
  }

  spend(
    datum: Option<SavingsDatum>,
    redeemer: SavingsSpendRedeemer,
    _own_ref: OutputReference,
    _self: Transaction,
  ) {
    // TODO [spec 3.3 common]: datum must be present (fail before any branch).
    expect Some(_savings_datum) = datum

    when redeemer is {
      Deposit { .. } ->
        // TODO [spec 3.3 common]: self-reference — inputs[i].output_reference
        // == own_ref; payment credential yields the own policy id.
        // TODO [spec 3.3 common]: input discipline — exactly two own-script
        // inputs (anchor + member account), no third rides along.
        // TODO [spec 3.3 Deposit]: member user token (222, matching suffix)
        // present in inputs; account fund_id == anchor Fund State NFT name.
        // TODO [spec 3.3 Deposit]: anchor status == Active.
        // TODO [spec 3.3 Deposit]: delta = fund-asset increase in the anchor
        // continuation; delta > 0.
        // TODO [spec 3.3 Deposit]: tag 0 — delta exact multiple of
        // share_value; units within [min, max] band; anchor shares_total and
        // savings_total increase exactly; member share_units += units.
        // TODO [spec 3.3 Deposit]: tag 1 — social_total += delta; member
        // social_paid += delta; share fields unchanged.
        // TODO [spec 3.3 Deposit]: tag 2 — no datum change on either side.
        // TODO [spec 3.3 Deposit]: no other datum field changes; no own-policy
        // mints in the transaction.
        True
      Withdraw { .. } ->
        // TODO [spec 3.3 common]: self-reference + two-input discipline.
        // TODO [spec 3.3 Withdraw]: member user token present; fund_id match;
        // anchor status == Active.
        // TODO [spec 3.3 Withdraw]: policy gate — withdrawal_policy == 1.
        // TODO [spec 3.3 Withdraw]: units = member share_units decrease;
        // 0 < units <= share_units.
        // TODO [spec 3.3 Withdraw]: anchor fund-asset value decreases by
        // exactly units * share_value; shares_total and savings_total
        // decrease exactly.
        // TODO [spec 3.3 Withdraw]: social fields and charter unchanged.
        True
      SocialPayout { .. } ->
        // TODO [spec 3.3 common]: self-reference + single-own-input discipline.
        // TODO [spec 3.3 SocialPayout]: credential_authorized(quorum, tx).
        // TODO [spec 3.3 SocialPayout]: valid in Active AND SharingOut.
        // TODO [spec 3.3 SocialPayout]: paid = fund-asset decrease;
        // 0 < paid <= social_total; social_total -= paid.
        // TODO [spec 3.3 SocialPayout]: share fields, charter, status
        // unchanged.
        True
      UpdateFund { .. } ->
        // TODO [spec 3.3 common]: self-reference + single-own-input discipline.
        // TODO [spec 3.3 UpdateFund]: credential_authorized(quorum, tx);
        // status == Active.
        // TODO [spec 3.3 UpdateFund]: mutable fields only — title, quorum,
        // min/max band, withdrawal_policy, cycle_end.
        // TODO [spec 3.3 UpdateFund]: immutable — asset, share_value, all
        // totals, status.
        // TODO [spec 3.3 UpdateFund]: charter sanity re-checked; anchor value
        // unchanged.
        True
      CloseCycle { .. } ->
        // TODO [spec 3.3 common]: self-reference + single-own-input discipline.
        // TODO [spec 3.3 CloseCycle]: credential_authorized(quorum, tx);
        // status == Active; validity range at/after cycle_end when set.
        // TODO [spec 3.3 CloseCycle]: new status = SharingOut { pot = vault
        // fund-asset value - social_total, shares = shares_total,
        // shares_remaining = shares_total }.
        // TODO [spec 3.3 CloseCycle]: continuation — shares_total = 0,
        // savings_total = 0; social_total + charter unchanged; value
        // unchanged (freezing moves no money).
        True
      ClaimShareOut { .. } ->
        // TODO [spec 3.3 common]: self-reference + two-input discipline.
        // TODO [spec 3.3 ClaimShareOut]: member user token present; fund_id
        // match; anchor status is SharingOut.
        // TODO [spec 3.3 ClaimShareOut]: member share_units > 0;
        // paid = pot * share_units / shares (floor).
        // TODO [spec 3.3 ClaimShareOut]: anchor fund-asset value decreases by
        // exactly paid; shares_remaining -= share_units; pot and shares
        // immutable within the status.
        // TODO [spec 3.3 ClaimShareOut]: member continuation — share_units =
        // 0; social_paid, consent, joined_at unchanged.
        True
      RemoveAccount { .. } ->
        // TODO [spec 3.3 common]: self-reference (member account input).
        // TODO [spec 3.3 RemoveAccount]: member user token present in inputs.
        // TODO [spec 3.3 RemoveAccount]: share_units == 0 (exits can never
        // strand savings).
        // TODO [spec 3.3 RemoveAccount]: paired BurnAccount mint present —
        // both tokens of the suffix burn at -1.
        // TODO [spec 3.3 RemoveAccount]: standalone — no live anchor required
        // (accounts are never stuck after fund closure).
        True
      CloseFund { .. } ->
        // TODO [spec 3.3 common]: self-reference + single-own-input discipline.
        // TODO [spec 3.3 CloseFund]: credential_authorized(quorum, tx);
        // status is SharingOut with shares_remaining == 0.
        // TODO [spec 3.3 CloseFund]: paired BurnFund mint burns the Fund
        // State NFT; no continuation output at the script.
        True
    }
  }

  // [security]: else branch must fail — no staking withdrawals, certificates,
  // or governance actions from the vault script.
  else(_) {
    fail
  }
}
