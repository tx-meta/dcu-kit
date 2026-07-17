#import "./resources/transaction.typ": *
#let background-color = rect(width: 100%, height: 100%, fill: rgb("#102E4A"))
#let image-foreground = image("./images/tx-logo.png", width: 100%, fit: "contain")
#let image-header = image("./images/tx-logo-dark.png", height: 75%, fit: "contain")

#set page(
  background: background-color,
  paper: "a4",
  margin: (left: 20mm, right: 20mm, top: 40mm, bottom: 30mm),
)

#set text(15pt, font: "Barlow")

#v(3cm)

#align(center)[
  #box(
    width: 60%,
    stroke: none,
    image-foreground,
  )
]

#v(1cm)

#set text(22pt, fill: white)
#align(center)[#strong[DCU Toolkit — Savings & Credit Module]]
#set text(20pt, fill: white)
#align(center)[#strong[Design Specification]]

#v(5cm)

#set text(13pt, fill: white)

#set text(fill: luma(0%))
#show link: underline
#set terms(separator: [: ], hanging-indent: 18mm)

#set par(justify: true)
#set page(
  paper: "a4",
  margin: (left: 20mm, right: 20mm, top: 40mm, bottom: 35mm),
  background: none,
  header: [
    #align(right)[
      #image("./images/tx-logo-dark.png", width: 25%, fit: "contain")
    ]
    #line(length: 100%, stroke: 0.5pt)
  ],
)

#v(20mm)
#show link: underline
#show outline.entry.where(level: 1): it => {
  v(6mm, weak: true)
  strong(it)
}

#outline(depth: 2, indent: 1em)
#pagebreak()
#set text(size: 11pt)
#set page(
  footer: [
    #line(length: 100%, stroke: 0.5pt)
    #v(-3mm)
    #align(center)[
      #set text(size: 11pt, fill: black)
      *TxMeta – *
      #set text(size: 11pt, fill: gray)
      *DCU-Toolkit Savings & Credit Module*
      #v(-3mm)
      Project Design Specification
      #v(-3mm)
    ]
    #v(-6mm)
    #align(right)[
      #context counter(page).display("1/1", both: true)]
  ],
)

#counter(page).update(1)
#v(100pt)
#set terms(separator: [: ], hanging-indent: 18mm)
#align(center)[
  #set text(size: 20pt)
  #strong[DCU Toolkit — Savings & Credit Module (Primitives \#7 + \#8)]]
#v(20pt)
\

#set heading(numbering: "1.")
#show heading: set text(rgb("#102E4A"))

= Overview
\

The Savings & Credit Module gives every member of a savings-credit group (ASCA, VSLA, table-banking group) a persistent on-chain capital account — how many share units they have purchased, what they have paid into the social fund, what claim that gives them at end-of-cycle share-out — and lets members borrow from the pooled fund they saved into. It implements primitives \#7 (persistent per-member capital accounts) and \#8 (internal loans) of the cooperative finance OS as ONE engine: loans draw from the savings vault, eligibility is capped by the borrower's own shares, and repaid service charges grow everyone's share-out pot.

The credit half is honest about its mechanism-design ceiling: a loan is SECURED up to the borrower's own share value (the write-off path can seize shares — code-enforceable) and UNSECURED above it (a pseudonymous borrower cannot be forced to repay beyond what is locked; the on-chain record — a Defaulted loan status — is the standing signal that social enforcement, future loan denial, and the later collateral primitive \#10 build on). A fund opts into unsecured lending deliberately: the charter's loan multiple defaults to 1 (fully secured).

The module is built with Aiken on Cardano and ships as a standalone validator family (`onchain/savings/`), following the same additive-module policy as the escrow family: it introduces no changes to any deployed validator. The offchain layer is TypeScript with Lucid Evolution and Effect, following the DCU Toolkit SDK conventions. Under the trust-state rule (July 11, 2026), every balance another member must trust — share units, fund totals, the share-out snapshot — lives on-chain; member personal data never does.

Design lineage: the pooled-custody vault with individually-owned member state generalizes the escrow pool vault (`PoolDeposit` pattern); the quorum `Credential` socket and one-shot state token reuse the escrow v2 idioms; member accounts are CIP-68 pairs following the account validator idiom. Share-out is member-claimed (each member spends only their own account), so the module has no O(N) distribution transaction and no on-chain member ceiling.

Deliberate v1 exclusions: transferable share positions (share units are datum balances, not fungible tokens), time-weighted share-out (v1 is proportional to share units held at close), on-chain meeting/attendance records (product layer), concurrent loans per member (one active loan at a time), compounding interest (the service charge is a flat amount fixed at disbursement), and external collateral (primitive \#10 — the write-off path seizes only the borrower's own shares).

#pagebreak()
\
= Architecture
\

The module is one multi-validator, mirroring the pool vault's shape: a single script whose minting purpose controls fund, account, and loan token lifecycles and whose spending purpose guards three datum variants at one address.

+ *Savings Vault Validator*

  A multi-validator with three datum variants. The *fund anchor* UTxO holds the group's charter (rules, quorum, asset) and custodies the pooled funds in a single UTxO; its datum tracks the fund totals, the outstanding loan book total, and the cycle status. Each *member account* is a CIP-68 reference UTxO at the same address holding that member's share units, social-fund history, and outstanding borrowing; the paired user token in the member's wallet is the spending authority for the account. Each *loan account* is a record UTxO (one per active loan) holding the loan's terms and repayment state, authenticated by a one-shot Loan State NFT.

Key structural decisions:

+ *Pooled custody, individual accounting.* All deposited value sits in the fund anchor UTxO (one vault); loans draw from that single pot. Member claims on the pot are datum balances in per-member account UTxOs. The conservation invariant binds them: the vault's asset value plus the outstanding loan book always covers `savings_total + social_total`.

+ *Loans are records, not vaults.* Disbursed principal goes to the borrower's wallet; the loan account UTxO holds only its min-ADA and the Loan State NFT — it is the on-chain loan book entry (terms, outstanding, arrears status), not a second pot. The record's min-ADA is funded by the disbursement transaction's builder and released when the loan closes.

+ *Shares back loans.* A member's account tracks `borrowed` (their outstanding principal). Eligibility caps a loan at `max_loan_multiple` times the member's share value; withdrawals cannot take shares that back a live loan; write-off seizes shares first and socializes only the remainder. At the charter default (`max_loan_multiple = 1`) every loan is fully self-collateralized.

+ *Joins do not touch the vault.* Minting a member account references the fund anchor read-only, so onboarding never contends with deposits. Nothing on-chain iterates members — there is no member list and no member count in any datum; aggregate trust state is carried by `shares_total`.

+ *Untagged value is welcome.* Penalties, donations, and the service-charge portion of loan repayments enter the vault as plain value above the tracked totals. Everything in the vault above the social fund is captured into the share-out pot at cycle close — loan income reaches members automatically, pro-rata to shares.

+ *Member-claimed share-out.* Cycle close freezes a snapshot (`pot`, `shares`); each member then claims their proportional payout by spending their own account against the vault. Claims are independent transactions — concurrent, crank-free, and unbounded by group size.

#pagebreak()
\
= Specification

== System Actors
\
+ *Member*

  An entity holding a Member Account user token (CIP-68 label 222). Members buy share units (deposits), contribute to the social fund, withdraw where the fund's policy allows, claim their share-out after cycle close, and exit by burning their account pair. A member's on-chain identity for this module is the account token suffix.

+ *Borrower*

  A member with an active loan. Disbursement requires BOTH the quorum's ratification and the borrower's user token in the transaction inputs — mutual consent, and the borrower's signature is what directs the principal to their own wallet. The borrower repays with their user token; one active loan per member.

+ *Quorum*

  The fund's ratification authority, a `Credential` (native multisig script or verification key; a vote-tally script later, by rotation — the primitive \#9 socket). The quorum ratifies rule updates, social-fund payouts, loan disbursements (the loan committee), write-offs, cycle close, and fund closure. The quorum never holds member funds: it cannot reach member savings, and loans it ratifies are bounded by the borrower-consent rule and the eligibility cap.

+ *Anyone (arrears crank)*

  Marking an overdue loan Late, then Defaulted, is permissionless — the on-chain default record never depends on the quorum's diligence.
\

== Tokens
\
+ *Fund State NFT*

  A one-shot state token identifying the fund instance, locked in the fund anchor UTxO forever until fund closure burns it.

  - *TokenName:* 32-byte `blake2b_256` digest of the seed `OutputReference` consumed at creation (single state token — no CIP-68 prefix), as in the escrow pool vault.

+ *Loan State NFT*

  A one-shot state token identifying an active loan, locked in the loan account UTxO. Minted at disbursement, burned at loan closure (final repayment or write-off).

  - *TokenName:* 32-byte `blake2b_256` digest of the seed `OutputReference` consumed at disbursement — the same construction as the Fund State NFT. Fund and loan tokens are told apart by the datum variant they authenticate, never by name shape.

+ *Member Account NFT pair*

  A CIP-68 pair minted when a member joins: the reference token (prefix `000643b0`) locks at the Savings Vault address carrying the member's account datum; the user token (prefix `000de140`) goes to the member's wallet and is the spending authority for the account. Burned together on exit.

  - *TokenName:* CIP-68 prefixes + a shared 28-byte suffix derived from the seed input consumed at join, per the DCU Toolkit account convention. The suffix is the member's permanent handle in this module; offchain configs take the suffix, never a UTxO reference.
\

== Smart Contracts

=== Savings Vault Validator
\
A multi-validator handling minting (fund and account token lifecycles) and spending (all fund and account state transitions). The minting policy ID equals the validator's script hash. The `else` handler fails: the script cannot be used for staking withdrawals, certificates, or governance actions.

==== Parameters
\
Nothing — uniqueness comes from one-shot token names derived from consumed seed inputs.
\

==== Minting Purpose

===== Redeemer
\
- *```rust
  CreateFund { seed_input_index: Int, fund_output_index: Int }
  ```*

- *```rust
  MintAccount {
    seed_input_index: Int,
    fund_ref_index: Int,
    ref_output_index: Int,
    user_output_index: Int,
  }
  ```*

- *```rust
  MintLoan { seed_input_index: Int }
  ```*

- *```rust
  BurnLoan
  ```*

- *```rust
  BurnAccount
  ```*

- *```rust
  BurnFund
  ```*
\

===== Validation
\
+ *CreateFund*

  Mints the Fund State NFT and initializes the fund anchor.

  - The input at `seed_input_index` is consumed; the token name equals `blake2b_256(serialise(seed.output_reference))`.
  - Exactly one token of the own policy is minted in the transaction, quantity `+1`.
  - The output at `fund_output_index` is at the own script address, carries the Fund State NFT, and holds an inline `SavingsFund` datum.
  - *Charter sanity:* `share_value > 0`, `0 < min_shares_per_deposit <= max_shares_per_deposit`, `withdrawal_policy` is `0` or `1`, `max_loan_multiple >= 0` (`0` disables lending), `loan_grace >= 0`, `status` is `Active`.
  - *Zero start:* `shares_total == 0`, `savings_total == 0`, `social_total == 0`, `loans_outstanding == 0`.
  - The anchor output's non-ADA value is exactly the Fund State NFT (no foreign tokens smuggled in at creation).

+ *MintAccount*

  Mints one Member Account pair against a live fund.

  - The reference input at `fund_ref_index` is at the own script address, carries a Fund State NFT of the own policy, and its `SavingsFund` datum has `status == Active`.
  - The input at `seed_input_index` is consumed; the 28-byte suffix is derived from its `output_reference`.
  - Exactly two tokens of the own policy are minted: reference token (`000643b0` + suffix) and user token (`000de140` + suffix), quantity `+1` each.
  - The output at `ref_output_index` is at the own script address, carries the reference token, and holds an inline `MemberAccount` datum with: `fund_id` equal to the referenced Fund State NFT's token name, `share_units == 0`, `social_paid == 0`, `joined_at` inside the transaction validity window.
  - *User token destination:* the output at `user_output_index` pays the user token to a `VerificationKey` payment credential (never a script).

+ *MintLoan*

  Mints one Loan State NFT. Runs only alongside the fund anchor spend under `DisburseLoan`, which carries the full loan-origination validation; this policy enforces the token's shape and one-shot uniqueness.

  - The input at `seed_input_index` is consumed; the token name equals `blake2b_256(serialise(seed.output_reference))` and is not CIP-68 prefixed.
  - Exactly one token of the own policy is minted, quantity `+1`.
  - At least one spending input sits at the own script address (the anchor spend — every own spend path except `DisburseLoan` forbids own-policy mints, so the coupling is transitive).

+ *BurnLoan*

  - Exactly one token of the own policy is minted, quantity `-1`, with a Fund-State-shaped name (32 bytes, not CIP-68 prefixed). The loan spend paths (`RepayLoan` closing, `WriteOffLoan`) authorize which token actually burns.

+ *BurnAccount*

  - Exactly two tokens of the own policy are minted, quantity `-1` each: a reference token and a user token sharing one suffix.
  - Runs only alongside the spend of the member's reference UTxO under `RemoveAccount` (two-phase deregistration — the spending validator authorizes the exit; this policy only enforces the paired burn).

+ *BurnFund*

  - Exactly one token of the own policy is minted, quantity `-1`, and it is a Fund State NFT (32-byte name, no CIP-68 prefix).
  - Runs only alongside the spend of the fund anchor under `CloseFund`.
\

==== Spend Purpose

===== Datum
\
The address holds one datum type with two variants.

- *```rust
  SavingsFund
  ```* — the fund anchor:
  - *`title`: ```rs ByteArray```* – Human-readable fund name (not PII; group-level only).
  - *`quorum`: ```rs Credential```* – Ratification authority (multisig script or key). Rotatable via `UpdateFund`.
  - *`asset_policy`: ```rs PolicyId```* / *`asset_name`: ```rs AssetName```* – The fund's asset; empty policy = ADA. Set at creation, immutable (USDCx-ready).
  - *`share_value`: ```rs Int```* – Price of one share unit, in base units of the fund asset. Immutable for the fund's lifetime — the unit that keeps share math exact.
  - *`min_shares_per_deposit`: ```rs Int```* / *`max_shares_per_deposit`: ```rs Int```* – VSLA-style per-transaction purchase band.
  - *`withdrawal_policy`: ```rs Int```* – `0` = savings locked until share-out (VSLA preset); `1` = flexible withdrawal (ASCA preset).
  - *`max_loan_multiple`: ```rs Int```* – Loan eligibility cap: a member may borrow up to this multiple of their share value. `0` disables lending; `1` (the SDK default) keeps every loan fully self-collateralized; above `1` the excess is unsecured by construction.
  - *`loan_grace`: ```rs Int```* – Milliseconds after a loan's `due` before `Late` can become `Defaulted`.
  - *`cycle_end`: ```rs Option<Int>```* – POSIX ms; before this bound, `CloseCycle` is invalid (`None` = quorum may close at any time).
  - *`shares_total`: ```rs Int```* – Sum of all members' share units. The load-bearing aggregate.
  - *`savings_total`: ```rs Int```* – Always `shares_total * share_value`; tracked explicitly so every transition can assert the invariant cheaply.
  - *`social_total`: ```rs Int```* – The social (welfare) fund; separate from the share-out pot by construction.
  - *`status`: ```rs FundStatus```* – `Active` or `SharingOut { pot: Int, shares: Int, shares_remaining: Int }`.

- *```rust
  MemberAccount
  ```* — one per member:
  - *`fund_id`: ```rs AssetName```* – The Fund State NFT token name this account belongs to.
  - *`share_units`: ```rs Int```* – The member's current share units. The balance \#8 will read for loan eligibility.
  - *`social_paid`: ```rs Int```* – Cumulative social-fund contributions (standing/eligibility history; never redeemable as savings).
  - *`consent`: ```rs Bool```* – Standing-layer event-capture consent flag (credentials-not-scores; set at join, member-changeable).
  - *`joined_at`: ```rs Int```* – POSIX ms.

- *```rust
  LoanAccount
  ```* — one per active loan (the loan book entry):
  - *`fund_id`: ```rs AssetName```* – The Fund State NFT token name this loan belongs to.
  - *`borrower_ref`: ```rs AssetName```* – The borrower's member (100) reference-token name.
  - *`principal`: ```rs Int```* – Amount disbursed, in base units of the fund asset.
  - *`outstanding`: ```rs Int```* – Remaining principal; repayments reduce it.
  - *`service_charge`: ```rs Int```* – The flat charge due, fixed at disbursement (never compounds).
  - *`charge_paid`: ```rs Int```* – Charge repaid so far (income — flows to the pot).
  - *`due`: ```rs Int```* – POSIX ms repayment deadline; arrears transitions key off it.
  - *`grace`: ```rs Int```* – Milliseconds after `due` before `Late` can become `Defaulted`. Copied from the charter's `loan_grace` at disbursement — like the service charge, arrears terms are FIXED at disbursement and immune to later charter updates.
  - *`status`: ```rs LoanStatus```* – `Current`, `Late` (past due), or `Defaulted` (past `due + grace`).

No datum field in any variant carries personal data. Balances, flags, terms, and identifiers only.
\

===== Redeemer
\
- *```rust
  Deposit {
    fund_input_index: Int,
    member_input_index: Int,
    fund_output_index: Int,
    member_output_index: Int,
    fund_tag: Int,
  }
  ```*

- *```rust
  Withdraw {
    fund_input_index: Int,
    member_input_index: Int,
    fund_output_index: Int,
    member_output_index: Int,
  }
  ```*

- *```rust
  SocialPayout { fund_input_index: Int, fund_output_index: Int }
  ```*

- *```rust
  UpdateFund { fund_input_index: Int, fund_output_index: Int }
  ```*

- *```rust
  CloseCycle { fund_input_index: Int, fund_output_index: Int }
  ```*

- *```rust
  ClaimShareOut {
    fund_input_index: Int,
    member_input_index: Int,
    fund_output_index: Int,
    member_output_index: Int,
  }
  ```*

- *```rust
  DisburseLoan {
    fund_input_index: Int,
    member_input_index: Int,
    seed_input_index: Int,
    fund_output_index: Int,
    member_output_index: Int,
    loan_output_index: Int,
  }
  ```*

- *```rust
  RepayLoan {
    fund_input_index: Int,
    member_input_index: Int,
    loan_input_index: Int,
    fund_output_index: Int,
    member_output_index: Int,
    loan_output_index: Int,
  }
  ```*
  (`loan_output_index = 99` when the repayment closes the loan — no loan continuation; the Loan State NFT burns.)

- *```rust
  MarkArrears { loan_input_index: Int, loan_output_index: Int }
  ```*

- *```rust
  WriteOffLoan {
    fund_input_index: Int,
    member_input_index: Int,
    loan_input_index: Int,
    fund_output_index: Int,
    member_output_index: Int,
  }
  ```*

- *```rust
  RemoveAccount { member_input_index: Int }
  ```*

- *```rust
  CloseFund { fund_input_index: Int }
  ```*

Paired transitions (`Deposit`, `Withdraw`, `ClaimShareOut`) spend the fund anchor and the member's reference UTxO in one transaction; triple transitions (`DisburseLoan`, `RepayLoan`, `WriteOffLoan`) additionally spend or create the loan account UTxO. All spent script inputs present the same redeemer value, and validation branches on the spent input's own datum variant (the pool-vault idiom): the ANCHOR branch always carries the full transition check; member and loan branches only verify that their fund's anchor is a spending input in the same transaction.
\

===== Validation
\
Common checks on every spend (stated once, applied everywhere):

- *Self-reference:* the input at the redeemer index for the spent UTxO resolves to the UTxO being validated (`inputs[i].output_reference == own_ref`), and its payment credential yields the own policy ID.
- *Input discipline:* the transaction spends exactly the expected own-script inputs for the redeemer — one (anchor-only, member-only, and loan-only actions), two (paired actions), or three (loan transitions: anchor + member + loan). Nothing extra may ride along.
- *Datum present:* a missing datum fails before any branch.
- *Continuation integrity:* every continuing output returns to the own script address, keeps its state token, and holds an inline datum; only the fields named per-redeemer may change.

+ *Deposit* (paired; member-authorized)

  A member pays into the fund. `fund_tag`: `0` = buy share units, `1` = social fund, `2` = untagged top-up (penalties, donations).

  - The member's user token (label 222, matching suffix) is present in the transaction inputs, and the account's `fund_id` matches the anchor's Fund State NFT name.
  - Anchor `status == Active`.
  - Let `delta` = increase of the fund asset in the anchor continuation value. `delta > 0`.
  - *Tag 0:* `delta` is an exact multiple of `share_value`; `units = delta / share_value`; `min_shares_per_deposit <= units <= max_shares_per_deposit`; anchor `shares_total += units`, `savings_total += delta`; member `share_units += units`.
  - *Tag 1:* anchor `social_total += delta`; member `social_paid += delta`; share fields unchanged.
  - *Tag 2:* no datum change on either side — pure value top-up (captured by the pot at cycle close).
  - No other anchor or member datum field changes; no tokens of the own policy are minted.

+ *Withdraw* (paired; member-authorized)

  A member sells share units back before cycle close (ASCA flexibility).

  - Member user token present; `fund_id` matches; anchor `status == Active`.
  - *Policy gate:* anchor `withdrawal_policy == 1`.
  - Let `units` = decrease of member `share_units`. `0 < units <= share_units`.
  - *Loan lock:* the remaining shares must still back the member's live loan — `borrowed <= max_loan_multiple * (share_units - units) * share_value`. A borrower cannot withdraw the shares securing their own loan.
  - The anchor's fund-asset value decreases by exactly `units * share_value`; anchor `shares_total -= units`, `savings_total -= units * share_value`.
  - `social_paid`, `social_total`, and all charter fields unchanged.

+ *SocialPayout* (anchor only; quorum-authorized)

  The quorum pays a welfare claim from the social fund.

  - `credential_authorized(quorum, tx)`.
  - Valid in `Active` *and* `SharingOut` status (welfare does not stop during share-out).
  - Let `paid` = decrease of the fund asset in the anchor continuation. `0 < paid <= social_total`; anchor `social_total -= paid`.
  - Share fields, charter fields, and status unchanged. Destination is the quorum's decision (unrestricted output).

+ *UpdateFund* (anchor only; quorum-authorized)

  - `credential_authorized(quorum, tx)`; `status == Active`.
  - Mutable fields only: `title`, `quorum` (rotation), `min_shares_per_deposit`, `max_shares_per_deposit`, `withdrawal_policy`, `cycle_end`.
  - *Immutable forever:* `asset_policy`, `asset_name`, `share_value`, `shares_total`, `savings_total`, `social_total`, `status`. (Changing `share_value` mid-flight would corrupt the share invariant; changing the asset would strand custody.)
  - Post-update charter sanity re-checked (band ordering, policy in range).
  - Anchor value unchanged.

+ *CloseCycle* (anchor only; quorum-authorized)

  Freezes the share-out snapshot.

  - `credential_authorized(quorum, tx)`; `status == Active`; if `cycle_end` is `Some(t)`, the transaction validity range starts at or after `t`.
  - *Loans clear first (VSLA rule):* `loans_outstanding == 0` — every loan is repaid or written off before the share-out snapshot freezes.
  - Let `vault` = the anchor's fund-asset value, and `buffer` = `2_000_000` when the fund asset is ADA, else `0` (the anchor's protocol min-ADA buffer is not a deposit — excluding it keeps the last claims from breaking on min-ADA). New status, EXACT: `SharingOut { pot: vault - social_total - buffer, shares: shares_total, shares_remaining: shares_total }` — everything else is distributable, including untagged top-ups. Exactness keeps the quorum honest: it cannot understate the pot to enlarge the closure residual.
  - Anchor continuation: `shares_total = 0`, `savings_total = 0` (superseded by the frozen snapshot); `social_total` and charter unchanged; value unchanged (freezing moves no money).

+ *ClaimShareOut* (paired; member-authorized)

  A member claims their proportional share-out. Independent per member — no ordering, no crank.

  - Member user token present; `fund_id` matches; anchor `status` is `SharingOut { pot, shares, shares_remaining }`.
  - Member `share_units > 0`. `paid = pot * share_units / shares` (integer floor division).
  - The anchor's fund-asset value decreases by exactly `paid`; `shares_remaining -= share_units`; `pot` and `shares` are immutable within the status.
  - Member continuation: `share_units = 0`; `social_paid`, `consent`, `joined_at` unchanged.
  - *Dust honesty:* floor remainders accumulate in the vault and are swept at `CloseFund`; a claim never rounds up.

+ *DisburseLoan* (triple: anchor + member + loan creation; quorum AND borrower authorized)

  The loan committee disburses a loan to a consenting member. Principal goes to the borrower's wallet; the loan account UTxO is the on-chain loan book entry.

  - `credential_authorized(quorum, tx)` AND the borrower's user token (matching the member account's suffix) is present in the inputs — mutual consent; the borrower's signature is what directs the principal.
  - Anchor `status == Active`; `max_loan_multiple > 0` (lending enabled).
  - Member `fund_id` matches; *one loan at a time:* member `borrowed == 0`.
  - Read the new loan's terms from the output at `loan_output_index` (inline `LoanAccount` datum): `fund_id` = the anchor's Fund State NFT name, `borrower_ref` = the member's (100) token name, `principal > 0`, `outstanding == principal`, `service_charge >= 0`, `charge_paid == 0`, `due` beyond the transaction validity's upper bound, `grace` equal to the charter's `loan_grace`, `status == Current`.
  - *Eligibility cap:* `principal <= max_loan_multiple * share_units * share_value`.
  - *Liquidity guard:* the vault's fund-asset value after disbursement is at least `social_total` (plus the min-ADA buffer for ADA funds) — loans never draw the welfare fund or the protocol buffer.
  - The loan output carries exactly the one-shot Loan State NFT (minted via `MintLoan` from the consumed seed at `seed_input_index`) plus its min-ADA — no fund asset (the record is not a vault); the record's min-ADA is funded by the transaction, not the vault.
  - Anchor continuation: fund-asset value decreases by exactly `principal`; `loans_outstanding += principal`; all other fields unchanged.
  - Member continuation: `borrowed = principal`; value and all other fields unchanged.

+ *RepayLoan* (triple: anchor + member + loan; borrower-authorized)

  The borrower repays — partially or fully. The principal portion restores vault liquidity; the charge portion is income and flows to the share-out pot as untagged surplus.

  - Borrower's user token present; loan `fund_id` and member `fund_id` match the anchor; loan `borrower_ref` matches the member's token.
  - Let `principal_paid` = decrease of loan `outstanding` and `charge_inc` = increase of loan `charge_paid`. `principal_paid >= 0`, `charge_inc >= 0`, `principal_paid + charge_inc > 0`; `principal_paid <= outstanding`; `charge_paid + charge_inc <= service_charge`.
  - The anchor's fund-asset value increases by exactly `principal_paid + charge_inc`; `loans_outstanding -= principal_paid`; all other anchor fields unchanged.
  - Member continuation: `borrowed -= principal_paid`; all else unchanged.
  - *Partial:* loan continues at the script with the updated datum — only `outstanding` and `charge_paid` may change (terms and status are immutable through repayment); value unchanged (min-ADA + Loan State NFT).
  - *Closing* (`loan_output_index == 99`): requires `outstanding` reaches `0` AND `charge_paid` reaches `service_charge`; the Loan State NFT burns (`BurnLoan`); the record's min-ADA is released to wherever the borrower directs it.
  - Repayment is valid in ANY loan status (a Late or Defaulted borrower can always still pay) and in both fund phases.

+ *MarkArrears* (loan only; permissionless)

  Anyone advances an overdue loan's status — the default record never waits on the quorum.

  - Status transition is exactly one step: `Current -> Late` valid when the transaction validity's lower bound is past `due`; `Late -> Defaulted` valid when it is past `due + grace` (both read from the loan record itself — no anchor needed, the transition stays permissionless and contention-free).
  - Only `status` changes; every other datum field, and the UTxO's value, are immutable.
  - No own-policy tokens minted or burned.

+ *WriteOffLoan* (triple: anchor + member + loan consumption; quorum-authorized)

  Closes a `Defaulted` loan so the cycle can end. The borrower's own shares are seized first (the secured portion); only the remainder is socialized.

  - `credential_authorized(quorum, tx)`; loan `status == Defaulted`; loan and member both belong to the anchor's fund; loan `borrower_ref` matches the member.
  - *Share seizure:* `seized_units = min(share_units, ceil(outstanding / share_value))`; `seized_value = seized_units * share_value`. Rounding is against the defaulter and bounded by one share.
  - Anchor continuation: `loans_outstanding -= outstanding`; `shares_total -= seized_units`; `savings_total -= seized_value`; the fund-asset value is UNCHANGED (no money moves — the loss already happened at disbursement; seized shares are cancelled, and any shortfall beyond the seizure shrinks the future pot: the socialized remainder).
  - Member continuation: `share_units -= seized_units`; `borrowed = 0`; all else unchanged.
  - The Loan State NFT burns (`BurnLoan`); the defaulted record leaves the loan book with its status permanently visible in the transaction history (the standing signal).

+ *RemoveAccount* (member only; member-authorized; standalone)

  A member exits and reclaims their reference UTxO's min-ADA.

  - Member user token present in inputs.
  - `share_units == 0` and `borrowed == 0` (claim or withdraw first; repay first — an exit can never strand savings or walk out on a live loan).
  - The paired `BurnAccount` mint is present: both tokens of the suffix burn at `-1`.
  - No continuation — the reference UTxO's ADA is released to wherever the exiting member directs it (they authorize the transaction). Works with or without a live fund anchor, so accounts are never stuck after fund closure.

+ *CloseFund* (anchor only; quorum-authorized)

  - `credential_authorized(quorum, tx)`; `status` is `SharingOut { .., shares_remaining: 0 }` — every share has been claimed.
  - The paired `BurnFund` mint burns the Fund State NFT.
  - Residual value (dust remainders plus any unpaid `social_total`) is released under quorum authorization — the quorum signs where it goes, on the group's instruction.
  - No continuation output at the script for this fund.
\

#pagebreak()
= Transactions
\
This section outlines the transactions of the Savings Module on the Cardano blockchain. `SA` abbreviates the fund's configured asset (`asset_policy`/`asset_name`); all `ada` figures are lovelace.
\

== Savings Vault Validator
\

=== Mint :: CreateFund
\
Creates a savings fund: consumes a seed input, mints the one-shot Fund State NFT, and locks it at the script with the charter datum.
\
#transaction(
  "CreateFund",
  inputs: (
    (
      name: "Creator Wallet UTxO",
      address: "creator_wallet",
      value: (ada: 5000000),
    ),
  ),
  outputs: (
    (
      name: "Fund Anchor UTxO",
      address: "savings_vault",
      value: (
        ada: 2000000,
        Fund_State_NFT: 1,
      ),
      datum: (
        quorum: "quorum_credential",
        share_value: 1000000,
        withdrawal_policy: 0,
        shares_total: 0,
        savings_total: 0,
        social_total: 0,
        status: "Active",
      ),
    ),
    (
      name: "Creator Wallet UTxO",
      address: "creator_wallet",
      value: (ada: 2800000),
    ),
  ),
  signatures: ("Creator",),
  show_mints: true,
  notes: [CreateFund Transaction],
)
\
==== Inputs
\
+ *Creator Wallet UTxO.*
  - Address: Creator's wallet address
  - Value: ADA for the anchor's minimum ADA and fees. The input at `seed_input_index` fixes the Fund State NFT name.
\
==== Mints
\
+ *Savings Vault Validator*
  - Redeemer: CreateFund
  - Value: +1 Fund State NFT (`blake2b_256` of the seed `OutputReference`)
\
==== Outputs
\
+ *Fund Anchor UTxO:*
  - Address: Savings Vault script address
  - Datum: `SavingsFund` charter — quorum credential, asset, `share_value`, purchase band, `withdrawal_policy`, optional `cycle_end`; all totals zero; `status = Active`
  - Value: minimum ADA + 1 Fund State NFT

+ *Creator Wallet UTxO:*
  - Address: Creator's wallet address
  - Value: change ADA
#pagebreak()

=== Mint :: MintAccount (Join Fund)
\
A member joins by minting their CIP-68 account pair. The fund anchor is a reference input — joining never contends with deposits.
\
#transaction(
  "MintAccount",
  inputs: (
    (
      name: "Member Wallet UTxO",
      address: "member_wallet",
      value: (ada: 5000000),
    ),
    (
      name: "Fund Anchor UTxO",
      address: "savings_vault",
      reference: true,
      value: (
        ada: 2000000,
        Fund_State_NFT: 1,
      ),
      datum: (status: "Active"),
    ),
  ),
  outputs: (
    (
      name: "Member Account UTxO",
      address: "savings_vault",
      value: (
        ada: 2000000,
        Account_Ref_NFT: 1,
      ),
      datum: (
        fund_id: "fund_state_nft_name",
        share_units: 0,
        social_paid: 0,
        consent: "true",
      ),
    ),
    (
      name: "Member Wallet UTxO",
      address: "member_wallet",
      value: (
        ada: 2800000,
        Account_User_NFT: 1,
      ),
    ),
  ),
  signatures: ("Member",),
  show_mints: true,
  notes: [MintAccount (Join) Transaction],
)
\
==== Inputs
\
+ *Member Wallet UTxO.*
  - Address: Member's wallet address
  - Value: ADA for the account UTxO's minimum ADA and fees. The input at `seed_input_index` fixes the 28-byte account suffix.

+ *Fund Anchor UTxO (reference).*
  - Address: Savings Vault script address
  - Datum: `SavingsFund` with `status = Active`
  - Value: unchanged (read-only)
\
==== Mints
\
+ *Savings Vault Validator*
  - Redeemer: MintAccount
  - Value: +1 Account Reference NFT (`000643b0` + suffix), +1 Account User NFT (`000de140` + suffix)
\
==== Outputs
\
+ *Member Account UTxO:*
  - Address: Savings Vault script address
  - Datum: `MemberAccount` — `fund_id` = Fund State NFT name, `share_units = 0`, `social_paid = 0`, `consent`, `joined_at`
  - Value: minimum ADA + 1 Account Reference NFT

+ *Member Wallet UTxO:*
  - Address: Member's wallet address (VerificationKey credential — enforced)
  - Value: change ADA + 1 Account User NFT
#pagebreak()

=== Spend :: Deposit
\
A member buys share units (tag 0), contributes to the social fund (tag 1), or tops the vault up untagged (tag 2 — penalties, donations). Diagram shows tag 0: 5 shares at `share_value` 1_000_000.
\
#transaction(
  "Deposit",
  inputs: (
    (
      name: "Fund Anchor UTxO",
      address: "savings_vault",
      value: (
        ada: 2000000,
        Fund_State_NFT: 1,
        SA: "X",
      ),
      datum: (
        shares_total: 40,
        savings_total: 40000000,
        status: "Active",
      ),
      redeemer: "Deposit",
    ),
    (
      name: "Member Account UTxO",
      address: "savings_vault",
      value: (
        ada: 2000000,
        Account_Ref_NFT: 1,
      ),
      datum: (share_units: 10),
      redeemer: "Deposit",
    ),
    (
      name: "Member Wallet UTxO",
      address: "member_wallet",
      value: (
        ada: 3000000,
        Account_User_NFT: 1,
        SA: 5000000,
      ),
    ),
  ),
  outputs: (
    (
      name: "Fund Anchor UTxO",
      address: "savings_vault",
      value: (
        ada: 2000000,
        Fund_State_NFT: 1,
        SA: "X + 5000000",
      ),
      datum: (
        shares_total: 45,
        savings_total: 45000000,
        status: "Active",
      ),
    ),
    (
      name: "Member Account UTxO",
      address: "savings_vault",
      value: (
        ada: 2000000,
        Account_Ref_NFT: 1,
      ),
      datum: (share_units: 15),
    ),
    (
      name: "Member Wallet UTxO",
      address: "member_wallet",
      value: (
        ada: 2800000,
        Account_User_NFT: 1,
      ),
    ),
  ),
  signatures: ("Member",),
  show_mints: true,
  notes: [Deposit Transaction (tag 0 — share purchase)],
)
\
==== Inputs
\
+ *Fund Anchor UTxO.*
  - Address: Savings Vault script address
  - Redeemer: Deposit (`fund_tag = 0`)
  - Datum: current `SavingsFund`, `status = Active`
  - Value: minimum ADA + Fund State NFT + pooled `SA`

+ *Member Account UTxO.*
  - Address: Savings Vault script address
  - Redeemer: Deposit (same value; validated from the account's perspective)
  - Datum: current `MemberAccount`
  - Value: minimum ADA + Account Reference NFT

+ *Member Wallet UTxO.*
  - Address: Member's wallet address
  - Value: the deposit amount in `SA` + the Account User NFT (spending authority)
\
==== Mints
\
None.
\
==== Outputs
\
+ *Fund Anchor UTxO:*
  - Datum: `shares_total` and `savings_total` increased by exactly the purchased units / amount (tag 1: `social_total` instead; tag 2: unchanged)
  - Value: pooled `SA` increased by the deposit `delta`

+ *Member Account UTxO:*
  - Datum: `share_units` increased by `delta / share_value` (tag 1: `social_paid` increased; tag 2: unchanged)
  - Value: unchanged

+ *Member Wallet UTxO:*
  - Value: change + Account User NFT retained
#pagebreak()

=== Spend :: Withdraw
\
A member sells share units back before cycle close. Only valid when the charter's `withdrawal_policy = 1` (ASCA preset); the VSLA preset (`0`) locks savings until share-out.
\
#transaction(
  "Withdraw",
  inputs: (
    (
      name: "Fund Anchor UTxO",
      address: "savings_vault",
      value: (
        ada: 2000000,
        Fund_State_NFT: 1,
        SA: "X",
      ),
      datum: (
        withdrawal_policy: 1,
        shares_total: 45,
        savings_total: 45000000,
        status: "Active",
      ),
      redeemer: "Withdraw",
    ),
    (
      name: "Member Account UTxO",
      address: "savings_vault",
      value: (
        ada: 2000000,
        Account_Ref_NFT: 1,
      ),
      datum: (share_units: 15),
      redeemer: "Withdraw",
    ),
    (
      name: "Member Wallet UTxO",
      address: "member_wallet",
      value: (
        ada: 3000000,
        Account_User_NFT: 1,
      ),
    ),
  ),
  outputs: (
    (
      name: "Fund Anchor UTxO",
      address: "savings_vault",
      value: (
        ada: 2000000,
        Fund_State_NFT: 1,
        SA: "X - 5000000",
      ),
      datum: (
        shares_total: 40,
        savings_total: 40000000,
        status: "Active",
      ),
    ),
    (
      name: "Member Account UTxO",
      address: "savings_vault",
      value: (
        ada: 2000000,
        Account_Ref_NFT: 1,
      ),
      datum: (share_units: 10),
    ),
    (
      name: "Member Wallet UTxO",
      address: "member_wallet",
      value: (
        ada: 2800000,
        Account_User_NFT: 1,
        SA: 5000000,
      ),
    ),
  ),
  signatures: ("Member",),
  show_mints: true,
  notes: [Withdraw Transaction (5 units sold back)],
)
\
==== Inputs
\
+ *Fund Anchor UTxO.* Redeemer: Withdraw; `status = Active`, `withdrawal_policy = 1`.
+ *Member Account UTxO.* Redeemer: Withdraw; `share_units >= units` sold.
+ *Member Wallet UTxO.* Carries the Account User NFT (authority).
\
==== Mints
\
None.
\
==== Outputs
\
+ *Fund Anchor UTxO:* `shares_total` and `savings_total` decreased by exactly the sold units / amount; vault `SA` decreased by `units * share_value`.
+ *Member Account UTxO:* `share_units` decreased by `units`; all else unchanged.
+ *Member Wallet UTxO:* receives `units * share_value` in `SA`; retains the user NFT.
#pagebreak()

=== Spend :: SocialPayout
\
The quorum pays a welfare claim from the social fund. Valid during `Active` and `SharingOut` — welfare does not stop for share-out.
\
#transaction(
  "SocialPayout",
  inputs: (
    (
      name: "Fund Anchor UTxO",
      address: "savings_vault",
      value: (
        ada: 2000000,
        Fund_State_NFT: 1,
        SA: "X",
      ),
      datum: (
        social_total: 8000000,
        status: "Active",
      ),
      redeemer: "SocialPayout",
    ),
    (
      name: "Quorum UTxO",
      address: "quorum_multisig",
      value: (ada: 2000000),
    ),
  ),
  outputs: (
    (
      name: "Fund Anchor UTxO",
      address: "savings_vault",
      value: (
        ada: 2000000,
        Fund_State_NFT: 1,
        SA: "X - 3000000",
      ),
      datum: (
        social_total: 5000000,
        status: "Active",
      ),
    ),
    (
      name: "Beneficiary Wallet UTxO",
      address: "beneficiary_wallet",
      value: (SA: 3000000, ada: 1500000),
    ),
    (
      name: "Quorum UTxO",
      address: "quorum_multisig",
      value: (ada: 2300000),
    ),
  ),
  signatures: ("Quorum",),
  show_mints: true,
  notes: [SocialPayout Transaction],
)
\
==== Inputs
\
+ *Fund Anchor UTxO.* Redeemer: SocialPayout; `social_total >= paid`.
+ *Quorum UTxO.* Spent to satisfy `credential_authorized` when the quorum is a script credential (a signature suffices for a key credential).
\
==== Mints
\
None.
\
==== Outputs
\
+ *Fund Anchor UTxO:* `social_total` decreased by exactly `paid`; vault `SA` decreased by `paid`; share fields and charter unchanged.
+ *Beneficiary Wallet UTxO:* the welfare payment — destination is the quorum's decision.
#pagebreak()

=== Spend :: UpdateFund
\
The quorum amends the charter's mutable fields (purchase band, withdrawal policy, cycle end, title) or rotates the quorum credential. `share_value`, the asset, all totals, and the status are immutable through this path.
\
#transaction(
  "UpdateFund",
  inputs: (
    (
      name: "Fund Anchor UTxO",
      address: "savings_vault",
      value: (
        ada: 2000000,
        Fund_State_NFT: 1,
        SA: "X",
      ),
      datum: (
        quorum: "old_quorum",
        max_shares_per_deposit: 10,
        status: "Active",
      ),
      redeemer: "UpdateFund",
    ),
    (
      name: "Quorum UTxO",
      address: "quorum_multisig",
      value: (ada: 2000000),
    ),
  ),
  outputs: (
    (
      name: "Fund Anchor UTxO",
      address: "savings_vault",
      value: (
        ada: 2000000,
        Fund_State_NFT: 1,
        SA: "X",
      ),
      datum: (
        quorum: "new_quorum",
        max_shares_per_deposit: 20,
        status: "Active",
      ),
    ),
    (
      name: "Quorum UTxO",
      address: "quorum_multisig",
      value: (ada: 2300000),
    ),
  ),
  signatures: ("Quorum",),
  show_mints: true,
  notes: [UpdateFund Transaction (band widened, quorum rotated)],
)
\
==== Inputs
\
+ *Fund Anchor UTxO.* Redeemer: UpdateFund; `status = Active`.
+ *Quorum UTxO.* Authority per `credential_authorized`.
\
==== Mints
\
None.
\
==== Outputs
\
+ *Fund Anchor UTxO:* mutable charter fields updated; charter sanity re-validated; value unchanged.
#pagebreak()

=== Spend :: CloseCycle
\
The quorum freezes the share-out snapshot: everything in the vault except the social fund becomes the distributable pot, at the share ratio standing at close. Freezing moves no money.
\
#transaction(
  "CloseCycle",
  inputs: (
    (
      name: "Fund Anchor UTxO",
      address: "savings_vault",
      value: (
        ada: 2000000,
        Fund_State_NFT: 1,
        SA: 53000000,
      ),
      datum: (
        shares_total: 45,
        savings_total: 45000000,
        social_total: 5000000,
        status: "Active",
      ),
      redeemer: "CloseCycle",
    ),
    (
      name: "Quorum UTxO",
      address: "quorum_multisig",
      value: (ada: 2000000),
    ),
  ),
  outputs: (
    (
      name: "Fund Anchor UTxO",
      address: "savings_vault",
      value: (
        ada: 2000000,
        Fund_State_NFT: 1,
        SA: 53000000,
      ),
      datum: (
        shares_total: 0,
        savings_total: 0,
        social_total: 5000000,
        status: "SharingOut{pot:48000000, shares:45, rem:45}",
      ),
    ),
    (
      name: "Quorum UTxO",
      address: "quorum_multisig",
      value: (ada: 2300000),
    ),
  ),
  signatures: ("Quorum",),
  show_mints: true,
  notes: [CloseCycle Transaction — `pot = 53000000 - 5000000`; the `3000000` above `savings_total` is untagged income (penalties/top-ups) flowing into the pot],
)
\
==== Inputs
\
+ *Fund Anchor UTxO.* Redeemer: CloseCycle; `status = Active`; validity range at or after `cycle_end` when set.
+ *Quorum UTxO.* Authority per `credential_authorized`.
\
==== Mints
\
None.
\
==== Outputs
\
+ *Fund Anchor UTxO:*
  - Datum: `status = SharingOut { pot = vault SA - social_total, shares = shares_total, shares_remaining = shares_total }`; `shares_total` and `savings_total` zeroed (superseded by the snapshot); `social_total` unchanged
  - Value: unchanged
#pagebreak()

=== Spend :: ClaimShareOut
\
A member claims `pot * share_units / shares` (floor). Claims are independent — any order, any concurrency, no crank, no member ceiling.
\
#transaction(
  "ClaimShareOut",
  inputs: (
    (
      name: "Fund Anchor UTxO",
      address: "savings_vault",
      value: (
        ada: 2000000,
        Fund_State_NFT: 1,
        SA: 53000000,
      ),
      datum: (
        social_total: 5000000,
        status: "SharingOut{pot:48000000, shares:45, rem:45}",
      ),
      redeemer: "ClaimShareOut",
    ),
    (
      name: "Member Account UTxO",
      address: "savings_vault",
      value: (
        ada: 2000000,
        Account_Ref_NFT: 1,
      ),
      datum: (share_units: 15),
      redeemer: "ClaimShareOut",
    ),
    (
      name: "Member Wallet UTxO",
      address: "member_wallet",
      value: (
        ada: 3000000,
        Account_User_NFT: 1,
      ),
    ),
  ),
  outputs: (
    (
      name: "Fund Anchor UTxO",
      address: "savings_vault",
      value: (
        ada: 2000000,
        Fund_State_NFT: 1,
        SA: 37000000,
      ),
      datum: (
        social_total: 5000000,
        status: "SharingOut{pot:48000000, shares:45, rem:30}",
      ),
    ),
    (
      name: "Member Account UTxO",
      address: "savings_vault",
      value: (
        ada: 2000000,
        Account_Ref_NFT: 1,
      ),
      datum: (share_units: 0),
    ),
    (
      name: "Member Wallet UTxO",
      address: "member_wallet",
      value: (
        ada: 2800000,
        Account_User_NFT: 1,
        SA: 16000000,
      ),
    ),
  ),
  signatures: ("Member",),
  show_mints: true,
  notes: [ClaimShareOut Transaction — `paid = 48000000 * 15 / 45 = 16000000`],
)
\
==== Inputs
\
+ *Fund Anchor UTxO.* Redeemer: ClaimShareOut; `status = SharingOut`.
+ *Member Account UTxO.* Redeemer: ClaimShareOut; `share_units > 0`, `fund_id` matches.
+ *Member Wallet UTxO.* Carries the Account User NFT (authority).
\
==== Mints
\
None.
\
==== Outputs
\
+ *Fund Anchor UTxO:* vault `SA` decreased by exactly `paid`; `shares_remaining` decreased by the member's `share_units`; `pot` and `shares` immutable.
+ *Member Account UTxO:* `share_units = 0`; history fields (`social_paid`, `consent`, `joined_at`) unchanged.
+ *Member Wallet UTxO:* receives `paid` in `SA`.
#pagebreak()

=== Spend :: DisburseLoan + Mint :: MintLoan
\
The loan committee (quorum) disburses 8 ADA to a member holding 10 shares (`max_loan_multiple` 1): principal to the borrower's wallet, a loan record UTxO to the vault. Both the quorum and the borrower authorize.
\
#transaction(
  "DisburseLoan",
  inputs: (
    (
      name: "Fund Anchor UTxO",
      address: "savings_vault",
      value: (
        ada: 2000000,
        Fund_State_NFT: 1,
        SA: 22000000,
      ),
      datum: (
        shares_total: 15,
        savings_total: 15000000,
        loans_outstanding: 0,
        status: "Active",
      ),
      redeemer: "DisburseLoan",
    ),
    (
      name: "Member Account UTxO",
      address: "savings_vault",
      value: (
        ada: 2000000,
        Account_Ref_NFT: 1,
      ),
      datum: (share_units: 10, borrowed: 0),
      redeemer: "DisburseLoan",
    ),
    (
      name: "Borrower Wallet UTxO",
      address: "member_wallet",
      value: (
        ada: 6000000,
        Account_User_NFT: 1,
      ),
    ),
  ),
  outputs: (
    (
      name: "Fund Anchor UTxO",
      address: "savings_vault",
      value: (
        ada: 2000000,
        Fund_State_NFT: 1,
        SA: 14000000,
      ),
      datum: (
        shares_total: 15,
        savings_total: 15000000,
        loans_outstanding: 8000000,
        status: "Active",
      ),
    ),
    (
      name: "Member Account UTxO",
      address: "savings_vault",
      value: (
        ada: 2000000,
        Account_Ref_NFT: 1,
      ),
      datum: (share_units: 10, borrowed: 8000000),
    ),
    (
      name: "Loan Account UTxO",
      address: "savings_vault",
      value: (
        ada: 2000000,
        Loan_State_NFT: 1,
      ),
      datum: (
        principal: 8000000,
        outstanding: 8000000,
        service_charge: 400000,
        status: "Current",
      ),
    ),
    (
      name: "Borrower Wallet UTxO",
      address: "member_wallet",
      value: (
        ada: 1500000,
        Account_User_NFT: 1,
        SA: 8000000,
      ),
    ),
  ),
  signatures: ("Quorum", "Borrower"),
  show_mints: true,
  notes: [DisburseLoan Transaction — eligibility: 8 ADA <= 1 x 10 shares x 1 ADA],
)
\
==== Inputs
\
+ *Fund Anchor UTxO.* Redeemer: DisburseLoan; `status = Active`, `max_loan_multiple > 0`.
+ *Member Account UTxO.* Redeemer: DisburseLoan; `borrowed = 0` (one loan at a time).
+ *Borrower Wallet UTxO.* Carries the Account User NFT — borrower consent; also funds the loan record's min-ADA and pays fees. The seed input at `seed_input_index` names the Loan State NFT.
\
==== Mints
\
+ *Savings Vault Validator*
  - Redeemer: MintLoan
  - Value: +1 Loan State NFT
\
==== Outputs
\
+ *Fund Anchor UTxO:* fund asset decreased by exactly the principal; `loans_outstanding` increased by the principal; liquidity guard holds (remaining vault covers the social fund + buffer).
+ *Member Account UTxO:* `borrowed = principal`; value unchanged.
+ *Loan Account UTxO:* min-ADA + Loan State NFT; `LoanAccount` datum with the fixed terms (`principal`, `service_charge`, `due`, `grace`) and `status = Current`.
+ *Borrower Wallet UTxO:* receives the principal.
#pagebreak()

=== Spend :: RepayLoan
\
The borrower repays 5 ADA principal plus the full 0.4 ADA service charge. Partial repayments are allowed; the charge portion is income above the tracked totals and flows to the next share-out pot.
\
#transaction(
  "RepayLoan",
  inputs: (
    (
      name: "Fund Anchor UTxO",
      address: "savings_vault",
      value: (
        ada: 2000000,
        Fund_State_NFT: 1,
        SA: 14000000,
      ),
      datum: (loans_outstanding: 8000000, status: "Active"),
      redeemer: "RepayLoan",
    ),
    (
      name: "Member Account UTxO",
      address: "savings_vault",
      value: (
        ada: 2000000,
        Account_Ref_NFT: 1,
      ),
      datum: (share_units: 10, borrowed: 8000000),
      redeemer: "RepayLoan",
    ),
    (
      name: "Loan Account UTxO",
      address: "savings_vault",
      value: (
        ada: 2000000,
        Loan_State_NFT: 1,
      ),
      datum: (
        outstanding: 8000000,
        service_charge: 400000,
        charge_paid: 0,
        status: "Current",
      ),
      redeemer: "RepayLoan",
    ),
    (
      name: "Borrower Wallet UTxO",
      address: "member_wallet",
      value: (
        ada: 8000000,
        Account_User_NFT: 1,
      ),
    ),
  ),
  outputs: (
    (
      name: "Fund Anchor UTxO",
      address: "savings_vault",
      value: (
        ada: 2000000,
        Fund_State_NFT: 1,
        SA: 19400000,
      ),
      datum: (loans_outstanding: 3000000, status: "Active"),
    ),
    (
      name: "Member Account UTxO",
      address: "savings_vault",
      value: (
        ada: 2000000,
        Account_Ref_NFT: 1,
      ),
      datum: (share_units: 10, borrowed: 3000000),
    ),
    (
      name: "Loan Account UTxO",
      address: "savings_vault",
      value: (
        ada: 2000000,
        Loan_State_NFT: 1,
      ),
      datum: (
        outstanding: 3000000,
        service_charge: 400000,
        charge_paid: 400000,
        status: "Current",
      ),
    ),
    (
      name: "Borrower Wallet UTxO",
      address: "member_wallet",
      value: (
        ada: 2300000,
        Account_User_NFT: 1,
      ),
    ),
  ),
  signatures: ("Borrower",),
  show_mints: true,
  notes: [RepayLoan Transaction — 5 ADA principal + 0.4 ADA charge; closing repayment burns the Loan State NFT instead of continuing the record],
)
\
==== Inputs
\
+ *Fund Anchor UTxO.* Redeemer: RepayLoan.
+ *Member Account UTxO.* Redeemer: RepayLoan; `borrowed` tracks the loan's outstanding.
+ *Loan Account UTxO.* Redeemer: RepayLoan; any status (a Late or Defaulted borrower can always still pay).
+ *Borrower Wallet UTxO.* Carries the user token and the repayment.
\
==== Mints
\
None (closing repayment: −1 Loan State NFT via BurnLoan).
\
==== Outputs
\
+ *Fund Anchor UTxO:* fund asset increased by exactly `principal_paid + charge_inc`; `loans_outstanding -= principal_paid`.
+ *Member Account UTxO:* `borrowed -= principal_paid`.
+ *Loan Account UTxO:* `outstanding` and `charge_paid` updated; terms immutable. Omitted when the repayment closes the loan (`outstanding` hits 0 and the charge is fully paid) — the NFT burns and the record's min-ADA returns to the borrower.
#pagebreak()

=== Spend :: MarkArrears
\
Anyone advances an overdue loan one status step: `Current -> Late` past `due`, `Late -> Defaulted` past `due + grace`. The default record never waits on the quorum.
\
#transaction(
  "MarkArrears",
  inputs: (
    (
      name: "Loan Account UTxO",
      address: "savings_vault",
      value: (
        ada: 2000000,
        Loan_State_NFT: 1,
      ),
      datum: (
        outstanding: 3000000,
        due: 1700000000000,
        status: "Current",
      ),
      redeemer: "MarkArrears",
    ),
    (
      name: "Crank Wallet UTxO",
      address: "any_wallet",
      value: (ada: 3000000),
    ),
  ),
  outputs: (
    (
      name: "Loan Account UTxO",
      address: "savings_vault",
      value: (
        ada: 2000000,
        Loan_State_NFT: 1,
      ),
      datum: (
        outstanding: 3000000,
        due: 1700000000000,
        status: "Late",
      ),
    ),
    (
      name: "Crank Wallet UTxO",
      address: "any_wallet",
      value: (ada: 2800000),
    ),
  ),
  signatures: ("Anyone",),
  show_mints: true,
  notes: [MarkArrears Transaction — validity lower bound proves the deadline passed],
)
\
==== Inputs
\
+ *Loan Account UTxO.* Redeemer: MarkArrears; the transaction validity's lower bound is past `due` (or past `due + grace` for the second step).
\
==== Mints
\
None.
\
==== Outputs
\
+ *Loan Account UTxO:* only `status` advanced by exactly one step; value and every other field immutable.
#pagebreak()

=== Spend :: WriteOffLoan + Mint :: BurnLoan
\
The quorum closes a Defaulted loan: the borrower's shares are seized up to the outstanding amount (3 shares here), the remainder is socialized (shrinks the future pot), and the loan leaves the book. No value moves — the loss happened at disbursement.
\
#transaction(
  "WriteOffLoan",
  inputs: (
    (
      name: "Fund Anchor UTxO",
      address: "savings_vault",
      value: (
        ada: 2000000,
        Fund_State_NFT: 1,
        SA: 19400000,
      ),
      datum: (
        shares_total: 15,
        savings_total: 15000000,
        loans_outstanding: 3000000,
      ),
      redeemer: "WriteOffLoan",
    ),
    (
      name: "Member Account UTxO",
      address: "savings_vault",
      value: (
        ada: 2000000,
        Account_Ref_NFT: 1,
      ),
      datum: (share_units: 10, borrowed: 3000000),
      redeemer: "WriteOffLoan",
    ),
    (
      name: "Loan Account UTxO",
      address: "savings_vault",
      value: (
        ada: 2000000,
        Loan_State_NFT: 1,
      ),
      datum: (outstanding: 3000000, status: "Defaulted"),
      redeemer: "WriteOffLoan",
    ),
    (
      name: "Quorum UTxO",
      address: "quorum_multisig",
      value: (ada: 2000000),
    ),
  ),
  outputs: (
    (
      name: "Fund Anchor UTxO",
      address: "savings_vault",
      value: (
        ada: 2000000,
        Fund_State_NFT: 1,
        SA: 19400000,
      ),
      datum: (
        shares_total: 12,
        savings_total: 12000000,
        loans_outstanding: 0,
      ),
    ),
    (
      name: "Member Account UTxO",
      address: "savings_vault",
      value: (
        ada: 2000000,
        Account_Ref_NFT: 1,
      ),
      datum: (share_units: 7, borrowed: 0),
    ),
    (
      name: "Quorum UTxO",
      address: "quorum_multisig",
      value: (ada: 4300000),
    ),
  ),
  signatures: ("Quorum",),
  show_mints: true,
  notes: [WriteOffLoan Transaction — seized = ceil(3M / 1M) = 3 shares; vault value unchanged],
)
\
==== Inputs
\
+ *Fund Anchor UTxO.* Redeemer: WriteOffLoan.
+ *Member Account UTxO.* Redeemer: WriteOffLoan; the defaulter's account.
+ *Loan Account UTxO.* Redeemer: WriteOffLoan; `status = Defaulted` only.
+ *Quorum UTxO.* Authority per `credential_authorized`.
\
==== Mints
\
+ *Savings Vault Validator*
  - Redeemer: BurnLoan
  - Value: −1 Loan State NFT
\
==== Outputs
\
+ *Fund Anchor UTxO:* `loans_outstanding -= outstanding`; `shares_total -= seized_units`; `savings_total -= seized_value`; fund-asset value UNCHANGED.
+ *Member Account UTxO:* `share_units -= seized_units`; `borrowed = 0`.
+ *Quorum (or any) Wallet:* the loan record's min-ADA, released as the quorum directs.
#pagebreak()

=== Spend :: RemoveAccount + Mint :: BurnAccount (Exit)
\
A member with a zeroed balance exits: the account reference UTxO is spent, both tokens of the pair burn, and the reference UTxO's minimum ADA returns to the member. Works with or without a live fund anchor — accounts are never stuck after fund closure.
\
#transaction(
  "RemoveAccount",
  inputs: (
    (
      name: "Member Account UTxO",
      address: "savings_vault",
      value: (
        ada: 2000000,
        Account_Ref_NFT: 1,
      ),
      datum: (share_units: 0),
      redeemer: "RemoveAccount",
    ),
    (
      name: "Member Wallet UTxO",
      address: "member_wallet",
      value: (
        ada: 3000000,
        Account_User_NFT: 1,
      ),
    ),
  ),
  outputs: (
    (
      name: "Member Wallet UTxO",
      address: "member_wallet",
      value: (ada: 4800000),
    ),
  ),
  signatures: ("Member",),
  show_mints: true,
  notes: [Exit Transaction — pair burns, min-ADA returns to the member],
)
\
==== Inputs
\
+ *Member Account UTxO.* Redeemer: RemoveAccount; `share_units == 0`.
+ *Member Wallet UTxO.* Carries the Account User NFT — consumed for the burn.
\
==== Mints
\
+ *Savings Vault Validator*
  - Redeemer: BurnAccount
  - Value: −1 Account Reference NFT, −1 Account User NFT (same suffix)
\
==== Outputs
\
+ *Member Wallet UTxO:* the reference UTxO's minimum ADA plus change, directed by the exiting member.
#pagebreak()

=== Spend :: CloseFund + Mint :: BurnFund
\
After every share has been claimed (`shares_remaining = 0`), the quorum closes the fund: the Fund State NFT burns and the residual value (floor dust plus any unclaimed social fund) is released under quorum authorization.
\
#transaction(
  "CloseFund",
  inputs: (
    (
      name: "Fund Anchor UTxO",
      address: "savings_vault",
      value: (
        ada: 2000000,
        Fund_State_NFT: 1,
        SA: 5000045,
      ),
      datum: (
        social_total: 5000000,
        status: "SharingOut{pot:48000000, shares:45, rem:0}",
      ),
      redeemer: "CloseFund",
    ),
    (
      name: "Quorum UTxO",
      address: "quorum_multisig",
      value: (ada: 2000000),
    ),
  ),
  outputs: (
    (
      name: "Group Destination UTxO",
      address: "group_destination",
      value: (ada: 3500000, SA: 5000045),
    ),
  ),
  signatures: ("Quorum",),
  show_mints: true,
  notes: [CloseFund Transaction — residual = unclaimed social fund + 45 units of floor dust],
)
\
==== Inputs
\
+ *Fund Anchor UTxO.* Redeemer: CloseFund; `status = SharingOut` with `shares_remaining = 0`.
+ *Quorum UTxO.* Authority per `credential_authorized`.
\
==== Mints
\
+ *Savings Vault Validator*
  - Redeemer: BurnFund
  - Value: −1 Fund State NFT
\
==== Outputs
\
+ *Group Destination UTxO:* the anchor's minimum ADA and residual `SA`, released to the destination the quorum authorizes.
#pagebreak()

= Invariants and Security Notes
\
+ *Conservation.* In `Active` status the anchor's fund-asset value PLUS `loans_outstanding` is always at least `savings_total + social_total`; `savings_total == shares_total * share_value` at all times; `loans_outstanding` equals the sum of live loans' `outstanding` and of member `borrowed` fields (each loan transition updates all three sides atomically). Every transition changes vault value and datum totals by the same amount, or fails.

+ *Self-reference and input discipline.* Every spend resolves its own input by redeemer index and verifies `output_reference` equality; transactions spend exactly the expected own-script inputs (one or two) — the double-satisfaction guard for paired transitions.

+ *Authority separation.* Members move only their own balances (user-token authorization). The quorum moves only the social fund, ratified loan disbursements (which additionally require the borrower's consent and are capped by the borrower's own shares), write-offs of Defaulted loans, and the post-close residual. It cannot touch member savings or the share-out pot: `CloseCycle` moves no value, and `ClaimShareOut` pays only user-token holders by share math.

+ *Credit honesty (the mechanism-design ceiling, stated plainly).* A loan is secured up to the borrower's seizable share value and unsecured above it. At `max_loan_multiple = 1` no loss is possible; above 1, the unsecured portion is recoverable only socially — the protocol ENFORCES the secured part (share seizure at write-off) and RECORDS the rest (the permanent `Defaulted` history that standing, future loan denial, and primitive \#10 collateral build on). Code does not pretend to close what game theory leaves open.

+ *Loans clear before share-out.* `CloseCycle` requires `loans_outstanding == 0` (the VSLA rule): every loan is repaid or written off before the pot freezes, so claims never race the loan book.

+ *No stranded state.* `RemoveAccount` requires a zero balance (exits cannot strand savings) and works without a live anchor (fund closure cannot strand accounts). `CloseFund` requires `shares_remaining == 0` (closure cannot strand claims).

+ *Share math exactness.* `share_value` is immutable; purchases must be exact multiples; claims use floor division and the dust is swept at closure, visibly. Nothing rounds in a member's favor at another member's expense.

+ *Soul-bound caveat (stated honestly).* The user token's destination is checked at mint (VerificationKey address), but user tokens are ordinary native assets thereafter — a member CAN hand their account authority to someone else by transferring the token. v1 accepts this (it matches passbook reality); non-transferable accounts would require a spending validator on member wallets, which is out of scope.

+ *Else-fail.* The validator's `else` handler fails: no staking withdrawals, certificates, or governance actions from the vault script.

+ *Module versioning.* Primitive \#8 was folded into this validator BEFORE any deployment (July 12, 2026 — nothing was live, so version-never-replace did not yet bind; the savings-only revision of this spec is in git history). From the first deployment onward the policy binds: future additions ship as versioned validators beside this one. The untagged top-up path (tag 2) remains the forward-compatible income inlet for later modules.
