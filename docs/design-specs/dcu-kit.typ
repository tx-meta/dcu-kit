#import "./resources/transaction.typ": *
#let background-color = rect(width: 100%, height: 100%, fill: rgb("#102E4A"))
#let image-foreground = image("./images/tx-logo.png", width: 100%, fit: "contain")
#let image-header = image("./images/tx-logo-dark.png", height: 75%, fit: "contain")
#let fund-link = link("https://projectcatalyst.io/funds/14/f14-cardano-use-cases-concept")[Catalyst Proposal]
#let git-link = link("https://github.com/tx-meta/dcu-kit")[Main Github Repo]

#set page(
  background: background-color,
  paper :"a4",
  margin: (left : 20mm,right : 20mm,top : 40mm,bottom : 30mm)
)

// Set default text style
#set text(15pt, font: "Barlow")

#v(3cm) // Add vertical space

#align(center)[
  #box(
    width: 60%,
    stroke: none,
    image-foreground,
  )
]

#v(1cm) // Add vertical space

// Set text style for the report title
#set text(22pt, fill: white)

// Center-align the report title
#align(center)[#strong[Decentralized Credit Unions Toolkit]]
#set text(20pt, fill: white)
#align(center)[#strong[Design Specification]]

#v(5cm)

// Set text style for project details
#set text(13pt, fill: white)


// Reset text style to default
#set text(fill: luma(0%))

// Display project details
#show link: underline
#set terms(separator:[: ],hanging-indent: 18mm)

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

#outline(depth:3, indent: 1em)
#pagebreak()
#set text(size: 11pt)  // Reset text size to 11pt
#set page(
   footer: [
    #line(length: 100%, stroke: 0.5pt)
    #v(-3mm)
    #align(center)[ 
      #set text(size: 11pt, fill: black)
      *TxMeta – *
      #set text(size: 11pt, fill: gray)
      *DCU-Toolkit*
      #v(-3mm)
      Project Design Specification
      #v(-3mm)
    ]
    #v(-6mm)
    #align(right)[
      #context counter(page).display( "1/1",both: true)]
  ] 
)

// Initialize page counter
#counter(page).update(1)
#v(100pt)
// Display project details
#set terms(separator:[: ],hanging-indent: 18mm)
#align(center)[
  #set text(size: 20pt)
  #strong[Decentralized Credit Unions (DCU) Toolkit]]
#v(20pt)
\

#set heading(numbering: "1.")
#show heading: set text(rgb("#102E4A"))

= Overview
\

The DCU-Toolkit (Decentralized Credit Unions Toolkit) is a smart contract infrastructure developed using Aiken for the Cardano blockchain. It is designed to facilitate automated cooperative finance operations including group savings, rotating fund distribution, democratic governance, and treasury management for traditional savings groups such as Chamas, SACCOs, Tontines, and similar cooperative finance models.

This toolkit empowers members to seamlessly create accounts, form cooperative groups, contribute funds, participate in democratic decision-making, and manage shared treasuries directly from their wallets. It ensures secure and efficient transactions by automating group governance, fund rotation, and treasury operations within a decentralized framework.

#pagebreak()
\
= Architecture

\
#figure(
  image("./images/dcu-kit-architecture.png", width: 100%),
  caption: [DCU Toolkit Architecture],
)
\

There are three validators in this cooperative finance system.

+ *Account Validator* 
  
  A multi-validator responsible for creating member accounts by minting CIP-68 compliant Account NFT Assets and sending the user NFT to the member's wallet while sending the reference NFT to the spending endpoint. It enables members to update their account metadata and delete their accounts by burning the Account NFTs.

+ *Group Validator*
  
  A multi-validator responsible for creating cooperative groups by minting CIP-68 compliant Group NFT Assets. It manages group configuration including contribution fees, joining fees, penalties, subscription intervals, and democratic governance rules. The validator enables group administrators to update group metadata and deactivate groups when necessary given a signature threshold.

+ *Treasury Validator*
  
  This is the core validator responsible for managing prepaid contributions, rotating fund distribution, member participation, and withdrawal operations. The contract incorporates a linear vesting mechanism to gradually release funds to members according to the group's rotation schedule. It handles member joins, exits, administrative withdrawals, and penalty management within the cooperative finance framework.

#pagebreak()

\
= Specification

\
== System Actors
\ 
+ *Member*
  
  An entity who interacts with the Account Validator to create an account and join cooperative groups by depositing contributions to the Treasury Validator. A user becomes a member when they mint an Account NFT and can participate in multiple cooperative groups.

+ *Group Administrator*

  An entity who interacts with the Group Validator to create cooperative groups and manage group configurations. A member becomes a group administrator when they create a group by minting a Group NFT. Administrators can update group parameters, manage member participation, and withdraw funds according to group rules.

\
== Tokens
\
+ *Account NFT*

  Can only be minted by a user when creating an account in the cooperative finance system and burned when the user deletes their account. A check must be included to verify that there are no active memberships in any Treasury before burning.

  - *TokenName:* Defined in Account Validator using CIP-68 standards with transaction ID, output index, and appropriate prefix (`prefix_100` for reference NFT, `prefix_222` for user NFT).

+ *Group NFT*

  Can only be minted when creating a cooperative group and held by the group administrator. This NFT represents ownership and administrative control over the group configuration and operations.

  - *TokenName:* Defined in Group Validator using CIP-68 standards with transaction ID, output index, and appropriate prefix (`prefix_100` for reference NFT, `prefix_222` for user NFT).

+ *Membership NFT*

  Can only be minted when a user joins a group. Exactly one membership token is minted and locked in the Treasury Validator at the member's Treasury UTxO. The token name is derived from the member's account user token name (CIP-68 prefix_222 form).



\
== Smart Contracts
\
=== Treasury Multi-validator
\
The Treasury Validator is the core contract responsible for managing member contributions, validating group memberships, and ensuring proper distribution of funds through rotating schedules and linear vesting. It facilitates member joins, exits, fund withdrawals, and penalty processing, allowing both members and administrators to interact securely within the cooperative finance framework.

\
==== Slot Assignment & Rotation Mechanism
\
The DCU-Toolkit implements a deterministic, round-based slot assignment system for ROSCA-style rotating fund distribution:

1. *Membership seal*: After at least two members have joined, the admin calls `StartGroup`, which fixes `num_intervals = member_count` and records `start_time = tx.validity_range.lower_bound`. No new members may join after this point.

2. *Slot assignment*: When a member joins, they are assigned a fixed slot position (0 to `num_intervals − 1`) equal to `group.member_count` at join time (join order). Stored in their Treasury datum's `assigned_slot` field.

3. *Round tracking*: The group datum's `last_distributed_round` starts at `−1` (no rounds run) and increments atomically with each `DistributeRound`. Rounds are strictly sequential — the next round number must equal `last_distributed_round + 1`.

4. *Slot calculation*: The scheduled borrower for round N is:
   ```
   current_slot = round_number % num_intervals
   borrower     = member with assigned_slot == current_slot
   ```

5. *Time gate*: Round N may not execute before:
   ```
   current_time >= start_time + round_number × interval_length
   ```

6. *Deferred payout*: A member may voluntarily defer their scheduled borrower turn by calling `DeferRound`, which sets `is_deferred = True` on their Treasury UTxO. During `DistributeRound`, if the scheduled borrower has `is_deferred = True`, the payout routes to the *next* slot instead:
   ```
   effective_borrower_slot = (current_slot + 1) % num_intervals
   ```
   The deferred member still contributes their `contribution_fee` for the round and their `is_deferred` flag is reset to `False`. This ensures the interval ends with exactly one member receiving the pot — no round is ever left empty.

7. *Round completion*: After each `DistributeRound`, every participating Treasury UTxO has `rounds_paid` incremented by 1 and `is_deferred` reset to `False`.

\
==== Parameters
\
- *`group_policy_id`* : Hash of the Group PolicyId

- *`member_account_policy_id`* : Hash of the Account PolicyId
\

==== Minting Purpose
\
===== Redeemer
\
- *```rust
  JoinGroup {
    group_ref_input_index: Int,
    group_output_index: Int,
    member_input_index: Int,
    treasury_output_index: Int,
  }
  ```*

- *```rs 
  TerminateGroup
  ```*

\
===== Validation
\
+ *JoinGroup*

  The redeemer allows a member to join a cooperative group by minting one unique Membership Token representing their membership.

  - The group must be active (`is_active == True`) — members cannot join deactivated groups.

  - Validate that the member's Account NFT is present in the transaction inputs.

  - A Group Input must be provided from the Group Validator (as a spending input) to update the member count; the group output must have `member_count + 1`.

  - The treasury output must be sent to the Treasury Script's address and contain a `TreasuryState` datum consistent with the Group datum: `assigned_slot == group.member_count`, `rounds_paid == 0`, `is_deferred == False`, `group_reference_tokenname` linking to the group, and `member_payment_credential` recording the member's wallet PKH.

  - Exactly one Membership Token is minted under the Treasury policy; the token name matches `member_reference_tokenname` in the datum.

  - Sufficient fees are locked: `contribution_fee + joining_fee`. When both fees are the same asset, the combined sum is required (not two independent checks).

  - The Account NFT (member user token) must not go to a script address.

  - The treasury output must hold only ADA + the membership token (no unbounded value accumulation).
  \

+ *TerminateGroup*
  
  - The redeemer must burn exactly one Membership Token (i.e. a single token with the token name "treasury-membership" is burned).
  
  - Validate that the Group reference input provides valid Group datum.

\

==== Spend Purpose
\
==== Datum
\
The Treasury datum is a sum type with three variants representing the different states a Treasury UTxO may be in during its lifecycle.

\
===== TreasuryState <treasury-datum>
\
The active-member state. Created at JoinGroup; updated by DistributeRound, DeferRound, Contribute, and UpdatePayoutCredential; consumed by ExitGroup.

- *`group_reference_tokenname`: ```rs AssetName```* – Links to the Group Validator. Matches the (100) ref token name on the Group UTxO.

- *`member_reference_tokenname`: ```rs AssetName```* – The membership token name (CIP-68 prefix_222 form of the member's account suffix) locked in this UTxO.

- *`assigned_slot`: ```rs Int```* – The member's fixed slot position (0 to `num_intervals − 1`), assigned in join order. Determines when this member is the scheduled borrower.

- *`rounds_paid`: ```rs Int```* – Number of distribution rounds this member has contributed to. Starts at 0 at join time; incremented by DistributeRound. A treasury instance is eligible for round N only when `rounds_paid == N`.

- *`is_deferred`: ```rs Bool```* – Set to `True` by DeferRound when the member wishes to skip their scheduled borrower turn. Reset to `False` by every DistributeRound regardless of which member received the payout. When `True` at payout time, the pot routes to `(assigned_slot + 1) % num_intervals` instead.

- *`member_payment_credential`: ```rs ByteArray```* – 28-byte payment key hash of the member's wallet. Used by DistributeRound to route the payout to the correct address. Updatable via `UpdatePayoutCredential`.

\
===== PenaltyState <penalty-datum>
\
Created when a member exits early (before maturity). The membership token is locked in this UTxO until the admin claims it via `TerminateGroup`, which burns the token and returns the penalty ADA to the admin.

- *`group_reference_tokenname`: ```rs AssetName```* – Links to the Group Validator.

- *`member_reference_tokenname`: ```rs AssetName```* – Identifies the membership token locked in this UTxO.

\
===== InsufficientCollateralState <insufficient-collateral-datum>
\
Transition state for members whose contribution balance falls below `contribution_fee`. The admin may grant up to `max_grace_extensions` (= 2) grace window extensions via `ExtendGraceWindow`. After the grace limit is reached, the UTxO is claimed via `TerminateGroup`.

- *`group_reference_tokenname`: ```rs AssetName```* – Links to the Group Validator.

- *`member_reference_tokenname`: ```rs AssetName```* – Identifies the membership token.

- *`grace_expires_at`: ```rs Int```* – POSIX ms timestamp when the current grace window expires.

- *`grace_extensions_used`: ```rs Int```* – Number of grace extensions already granted (max = 2).

- *`rounds_paid`: ```rs Int```* – The `rounds_paid` value at the time of transition — carried for record keeping.

\
==== Redeemer

\
- *```rust
  DistributeRound {
    round_number: Int,
    group_ref_input_index: Int,
    group_output_index: Int,
    treasury_input_indices: List<Int>,
    treasury_output_indices: List<Int>,
    borrower_output_index: Int,
  }
  ```*

- *```rust
  ExitGroup {
    group_ref_input_index: Int,
    group_output_index: Int,
    member_input_index: Int,
    treasury_input_index: Int,
    penalty_output_index: Int,
  }
  ```*

- *```rust
  Contribute {
    member_input_index: Int,
    treasury_input_index: Int,
    treasury_output_index: Int,
  }
  ```*

- *```rust
  DeferRound {
    round_number: Int,
    member_input_index: Int,
    treasury_input_index: Int,
    treasury_output_index: Int,
  }
  ```*

- *```rust
  UpdatePayoutCredential {
    member_input_index: Int,
    treasury_input_index: Int,
    treasury_output_index: Int,
  }
  ```*

- *```rust
  ExtendGraceWindow {
    group_ref_input_index: Int,
    admin_input_index: Int,
    treasury_input_index: Int,
    treasury_output_index: Int,
  }
  ```*

\
==== Validation

\
+ *DistributeRound*

  Triggers distribution of the group pot for one sequential round. All active members' Treasury UTxOs are consumed and updated atomically with the group UTxO.

  - *Sequential enforcement*: `round_number` must equal `group.last_distributed_round + 1`. Rounds cannot be skipped or replayed.

  - *Time gate*: `current_time >= start_time + round_number × interval_length`. A round cannot execute before its scheduled window.

  - *Round eligibility*: Every Treasury UTxO spent must be in `TreasuryState` with `rounds_paid == round_number`. Members that have already paid this round (stale UTxO) are excluded automatically.

  - *Borrower resolution*: `current_slot = round_number % num_intervals`. The borrower is the member with `assigned_slot == current_slot`. If that member's `is_deferred == True`, the payout routes to `(current_slot + 1) % num_intervals` instead. This ensures every interval ends with one recipient.

  - *Payout amount*: Total payout = `contribution_fee × number_of_treasury_inputs` (the contribution asset moves out of each input and is aggregated to the borrower).

  - *Ascending index requirement*: `treasury_input_indices` and `treasury_output_indices` must both be in strictly ascending order. This prevents duplicate-index attacks.

  - *Group output*: `last_distributed_round` incremented to `round_number`; all other group datum fields unchanged. The group UTxO must be a spending input (not a reference input) so its state is updated atomically.

  - *Treasury outputs*: Each spent Treasury UTxO is returned to the script address with `rounds_paid` incremented by 1 and `is_deferred` reset to `False`. Output ADA equals input ADA minus `contribution_fee` (contribution asset balance decreases). Only ADA + the membership token may remain in the output (no value accumulation).

  \
+ *ExitGroup*

  Allows a member to exit a cooperative group. The group UTxO is a spending input so `member_count` decrements atomically.

  - The member input (at `member_input_index`) must contain the Account User NFT.

  - The Treasury UTxO must be in `TreasuryState`. The `group_reference_tokenname` in the datum must match the ref token name on the actual Group UTxO input (prevents cross-group substitution attacks).

  - The group output must have `member_count − 1`; all other group fields are unchanged.

  - *Maturity check*: `maturity_time = start_time + num_intervals × interval_length`. If `num_intervals == 0` (group not yet started), maturity is immediate.

    - *Mature / inactive exit* (now >= maturity_time OR group is inactive): The membership token is burned. All locked ADA returns to the member.

    - *Early exit* (group active AND now < maturity_time): A `PenaltyState` UTxO is produced at `penalty_output_index` retaining the membership token and at least `penalty_fee`. The remaining ADA (minus penalty) returns to the member.

  \
+ *DeferRound*

  Allows a member to voluntarily defer their scheduled borrower turn for the next round. The deferred member still contributes their `contribution_fee` that round; the payout routes to the next slot instead.

  - `round_number` must equal `datum.rounds_paid` — the member is deferring the round they are next due for, not a future one.

  - The member input (at `member_input_index`) must hold the Account User NFT.

  - Output datum: identical to input with `is_deferred = True`. All other fields frozen.

  - Output ADA and membership token preserved unchanged at the script address.

  \
+ *Contribute*

  Allows a member to top up their Treasury balance when it falls below `contribution_fee`, preventing transition to `InsufficientCollateralState`.

  - The member input (at `member_input_index`) must hold the Account User NFT.

  - Output datum: identical to input — no field changes (only the UTxO value increases).

  - Output ADA ≥ input ADA; membership token preserved.

  \
+ *UpdatePayoutCredential*

  Allows a member to redirect future payouts to a new wallet address by updating `member_payment_credential`.

  - The member input must hold the Account User NFT.

  - Output datum: identical to input with only `member_payment_credential` updated to the new 28-byte key hash.

  - Output ADA and membership token preserved unchanged.

  \
+ *ExtendGraceWindow*

  Allows the group administrator to grant an additional grace window to a member in `InsufficientCollateralState`.

  - Only the administrator (holding the Group (222) user token at `admin_input_index`) may call this.

  - The Treasury UTxO must be in `InsufficientCollateralState`. The group UTxO is provided as a reference input.

  - `grace_extensions_used` must be < `max_grace_extensions` (= 2). After two extensions, only `TerminateGroup` is available.

  - Output: `grace_expires_at` extended by `group.grace_period_length`; `grace_extensions_used` incremented by 1; all other datum fields frozen. ADA and membership token unchanged.

#pagebreak()

=== Group Validator
\
The Group Validator is responsible for creating cooperative groups, managing group configurations, and controlling group lifecycle operations including activation and deactivation.

==== Parameter
\
Nothing

\
==== Minting Purpose

===== Redeemer
\
- CreateGroup

- BurnGroup
\
===== Validation
\
+ *CreateGroup*

  The redeemer allows creating a new cooperative group by minting one unique CIP-68 compliant Group Token.

  - An input (at *`input_index`*) must be present to derive unique token names (using CIP68 prefixes).

  - Validate that exactly one Reference Token and one User Token are minted as per the CIP68 compliance standards.
  
  - The unique tokens are derived from the transaction ID and output index of the input.
  
  - The output at *`group_output_index`* must be sent to the Group Script's address.
  
  - The output must contain a Group datum with the following requirements:

    - *`contribution_fee`*: Must be > 0.
    - *`joining_fee`*: Must be ≥ 0.
    - *`penalty_fee`*: Must be ≥ 0.
    - *`grace_period_length`*: Must be ≥ 0.
    - *`creator_bond`*: Must be ≥ 0 (0 is valid for trusted groups; ≥ `contribution_fee` recommended for open groups).
    - *`interval_length`*: Must be > 0.
    - *`num_intervals`*: Must be exactly 0 at creation. `StartGroup` sets this to `member_count` when sealing membership.
    - *`max_members`*: Must be > 0.
    - *`member_count`*: Must be 0 at creation.
    - *`is_active`*: Must be `True` at creation.
    - *`is_started`*: Must be `False` at creation — only `StartGroup` may set this to `True`.
    - *`last_distributed_round`*: Must be `−1` at creation — no rounds have run yet.
    - *`start_time`*: Must be 0 at creation — `StartGroup` sets this to the transaction's validity range lower bound.
    - *`member_token_names`*: Must be an empty list `[]` at creation.
    - *`admin_payment_credential`*: Must be exactly 28 bytes (a valid payment key hash).
    - The Group Reference NFT must be the only token under this policy in the script output (exact token check).
    - The Group User NFT must go to a VerificationKey address — if sent to a script, admin authority is permanently lost.

+ *BurnGroup*

  The redeemer authorises the destruction of a Group's CIP-68 token pair as part of the hard-delete lifecycle. All real validation (admin auth, `member_count == 0`, deactivation prerequisite) is enforced by the paired `RemoveGroup` spend handler running in the same transaction. The mint handler only verifies:

  - Exactly two tokens are burned under this policy (the Reference NFT and the User NFT — no partial burns).

  - All quantities under this policy are negative (burning only, no new minting).

  *Note:* Both `BurnGroup` (mint) and `RemoveGroup` (spend) must execute in the same transaction. A `BurnGroup` call without a paired `RemoveGroup` spend is rejected because burning fewer than two tokens fails the exact-count check.

\

==== Spend Purpose
\
===== Datum <group-datum>
\

- *`contribution_fee_policyid: PolicyId`* The PolicyId governing the asset used for the contribution fee. Empty string (`""`) for ADA.

- *`contribution_fee_assetname: AssetName`* The AssetName of the contribution fee. Empty string for ADA.

- *`contribution_fee: Int`* The contribution fee amount per round. Must be > 0. Each member locks `max_members × contribution_fee` (ADA) or `2 ADA` minimum (non-ADA) at join time to pre-pay all future rounds.

- *`joining_fee_policyid: PolicyId`* The PolicyId governing the asset used for the joining fee. Empty string for ADA.

- *`joining_fee_assetname: AssetName`* The AssetName of the joining fee.

- *`joining_fee: Int`* A one-time fee paid to `admin_payment_credential` at join time. May be 0.

- *`penalty_fee_policyid: PolicyId`* The PolicyId governing the asset used for the penalty fee.

- *`penalty_fee_assetname: AssetName`* The AssetName of the penalty fee.

- *`penalty_fee: Int`* The fee retained in the `PenaltyState` UTxO when a member exits early. Must be ≥ 0.

- *`grace_period_length: Int`* Duration in POSIX milliseconds of one grace window extension granted by `ExtendGraceWindow`. Used to compute `grace_expires_at`. May be 0.

- *`creator_bond: Int`* ADA bond locked in the Group UTxO at creation that the admin forfeits if the group is deleted while members are still active. 0 is valid for trusted groups; ≥ `contribution_fee` is recommended for open groups. Must be ≥ 0.

- *`interval_length: Int`* Duration in POSIX milliseconds of one distribution round. Must be > 0.

- *`num_intervals: Int`* Total number of distribution rounds in one ROSCA cycle. *Must be 0 at creation* — `StartGroup` sets it to `member_count` when sealing membership. After `StartGroup` this field is frozen.

- *`max_members: Int`* Maximum number of members who may join. Must be > 0. Frozen once any member is active (`member_count > 0`).

- *`member_count: Int`* Number of active members. Initialized to 0 at creation; incremented by `MemberJoin`, decremented by `MemberExit`. Managed exclusively by the treasury validator via those two redeemers.

- *`is_active: Bool`* Whether the group is currently active. Set to `True` at creation; may only transition `True → False` via `UpdateGroup`. Deactivation is permanent — reactivation is forbidden.

- *`is_started: Bool`* Whether `StartGroup` has been called. `False` at creation; `True` after `StartGroup`. Once `True`, no new members may join and `num_intervals`, `start_time` are fixed. This is a one-way latch.

- *`start_time: Int`* POSIX millisecond timestamp when the ROSCA rotation schedule begins. *Must be 0 at creation* — `StartGroup` sets it to the transaction's validity range lower bound. Used by `DistributeRound` for the time gate: `current_time >= start_time + round_number × interval_length`.

- *`last_distributed_round: Int`* Index of the last completed distribution round. Initialized to `−1` at creation (no rounds run); incremented atomically by `DistributeRound`. Frozen by `UpdateGroup`.

- *`admin_payment_credential: ByteArray`* The 28-byte payment key hash of the group administrator's wallet. Joining fees are routed here at join time. Must be exactly 28 bytes.

- *`member_token_names: List<AssetName>`* On-chain membership registry: one entry per active member, containing their treasury membership token name (CIP-68 prefix_222 form). Appended at `MemberJoin`, removed at `MemberExit`. Invariant: `list.length(member_token_names) == member_count`.

*Note:* All fee amounts, policy IDs, and asset names are *critical fields* — they cannot be changed via `UpdateGroup` while `member_count > 0`. Changing a fee's currency is as disruptive as changing its amount.

\

===== Redeemer
\
- *```rust
  UpdateGroup {
    group_ref_token_name: AssetName,
    admin_input_index: Int,
    group_input_index: Int,
    group_output_index: Int,
  }
  ```*

- *```rust
  RemoveGroup {
    group_ref_token_name: AssetName,
    admin_input_index: Int,
    group_input_index: Int,
  }
  ```*

- *```rust
  MemberJoin {
    group_ref_token_name: AssetName,
    member_token_name: AssetName,
    group_input_index: Int,
    group_output_index: Int,
  }
  ```*

- *```rust
  MemberExit {
    group_ref_token_name: AssetName,
    member_token_name: AssetName,
    group_input_index: Int,
    group_output_index: Int,
  }
  ```*

- *```rust
  StartGroup {
    group_ref_token_name: AssetName,
    admin_input_index: Int,
    group_input_index: Int,
    group_output_index: Int,
  }
  ```*

- *```rust
  DistributeRound {
    group_ref_token_name: AssetName,
    group_input_index: Int,
    group_output_index: Int,
    round_number: Int,
  }
  ```*

\
====== Validation
\
+ *UpdateGroup*

  This redeemer endpoint allows the administrator to update the group metadata attached to a Group UTxO.

  - A Group UTxO containing the Group NFT must be provided (at group_input_index) with its output reference matching the provided reference.

  - An administrator input (at admin_input_index) must be present to prove ownership of the Group NFT (derived from group_ref_token_name).

  - The output at group_output_index must be sent to the same Group Script address and must contain exactly the Reference NFT — no other tokens under this policy (prevents the admin from accidentally locking their User NFT inside the script, which would permanently revoke admin authority).

  - The output ADA must be ≥ the input ADA (no draining the group UTxO during metadata updates).

  - `member_count` is frozen — it cannot be changed via UpdateGroup (managed exclusively by MemberJoin/MemberExit).

  - `is_active` is a one-way latch: only `true → false` is permitted. Reactivation (`false → true`) is permanently forbidden; deactivation is the admin's irrevocable signal to members to exit.

  - The following fields are *critical* and may only be changed when `member_count == 0`: all fee amounts, all fee policy IDs, all fee asset names, `creator_bond`, `grace_period_length`, `interval_length`, `num_intervals`, `start_time`, `max_members`, and `admin_payment_credential`. Changing `start_time` while members are active would shift every member's payout window; changing fee currency is an economic rug-pull equivalent to raising the amount.

  \
+ *RemoveGroup*

  This redeemer endpoint permanently dissolves a group by burning both CIP-68 tokens. It must be paired with the `BurnGroup` mint redeemer in the same transaction. No group UTxO is produced — the group is gone from the chain entirely and all creation-deposit ADA is returned to the admin as transaction change.

  - The group must already be deactivated (`is_active == false`) before deletion — the admin must call UpdateGroup to deactivate first, giving members time to exit.

  - `member_count` must be 0 — all members must have exited before the group can be dissolved.

  - The transaction must spend the Group UTxO (at *`group_input_index`*) and include an administrator input (at *`admin_input_index`*) holding the Group User NFT.

  - The `BurnGroup` mint redeemer must burn exactly the Reference NFT (qty −1) and the User NFT (qty −1) under this policy — no other tokens, no partial burns.

  - No group script output is produced. The ADA previously locked in the Group UTxO (including `creator_bond`) returns to the admin.

  \
+ *MemberJoin*

  This redeemer is invoked by the Treasury validator's JoinGroup mint path in the same transaction. It atomically updates the group state when a new member joins.

  - The Treasury validator must mint exactly one membership token in the same transaction — proves JoinGroup ran and a corresponding Treasury UTxO was created.

  - The group output (at `group_output_index`) must be at the same script address as the group input and retain the Group NFT.

  - Only `member_count` changes — it must increment by exactly 1; all other datum fields are structurally identical to the input datum.

  \
+ *MemberExit*

  This redeemer is invoked when a member exits a group. `member_count` always decrements by exactly 1 regardless of exit path — the slot is freed immediately so the group's rotation continues without stalling.

  - *Mature/inactive exit*: The Treasury validator burns the membership token in the same transaction. `member_count` decrements by 1. The member's token name is removed from `member_token_names`.

  - *Early exit (penalty path)*: The membership token is not burned — it moves to a PenaltyState UTxO. `member_count` still decrements by 1 immediately, freeing the slot for a new member. The penalty token is claimed separately by the admin via TerminateGroup. The member's token name is removed from `member_token_names`.

  - `member_count` must be ≥ 1 before exit (enforced as a hard crash — passing `member_count == 0` is an invalid state).

  - Only `member_count` and `member_token_names` change; all other datum fields are structurally frozen.

  - The group output must be at the same script address with exactly the Reference NFT retained and ADA ≥ input ADA.

  - The treasury validator must co-participate in the transaction — either by burning a treasury token (mature/inactive exit) or by having a Treasury UTxO spent (early/penalty exit). This is an explicit on-chain requirement: without it, any wallet could invoke MemberExit and decrement `member_count` without the treasury validator ever executing.

  \
+ *StartGroup*

  Seals membership and begins the ROSCA rotation schedule. After this point, no new members may join and `DistributeRound` becomes available.

  - The admin input (at `admin_input_index`) must hold the Group (222) user token.

  - `is_started` must be `False` (cannot call StartGroup twice).

  - `member_count` must be ≥ 2 — a minimum two-member ROSCA is required for meaningful rotation.

  - Group output fields set by StartGroup:
    - `is_started = True`
    - `num_intervals = member_count` (fixes the rotation cycle length)
    - `start_time = tx.validity_range.lower_bound` (anchors the schedule)

  - All other datum fields are frozen — only the three fields above may change.

  - Group output ADA ≥ input ADA; only ADA + Group Reference NFT in the output.

  \
+ *DistributeRound*

  Increments `last_distributed_round` atomically with the Treasury validator's distribution. This redeemer runs only as part of a `DistributeRound` treasury spend — both must execute in the same transaction.

  - `round_number` must equal `last_distributed_round + 1` (sequential enforcement).

  - `is_started` must be `True` — group must be sealed before any round can run.

  - `is_active` must be `True`.

  - `round_number` must be < `num_intervals` (round must be within the current cycle).

  - Group output: `last_distributed_round = round_number`; all other fields frozen.

  - Group output ADA ≥ input ADA; only ADA + Group Reference NFT in the output.

#pagebreak()

=== Account Validator

\
The Account Validator handles the creation, update, and removal of member accounts within the cooperative finance system.

\
==== Parameter
\  
Nothing

\
==== Minting Purpose

===== Redeemer
\
- *```rust 
  CreateAccount { input_index: Int, output_index: Int }
  ```*

- *```rust 
  DeleteAccount { reference_token_name: AssetName }
  ```*

\
====== Validation
\
+ *CreateAccount*
  
  The redeemer allows creating a new member account by minting one unique CIP-68 compliant Account Token.

  - An input must be present to derive unique token names using CIP68 prefixes.

  - Validate that exactly one Account Reference Token and one Account User Token are minted and the unique tokens are generated from the transaction's ID and output index.
  
  - Ensure the output (at* `output_index`*) must be sent to the Account Script's address and must carry an Account datum.
  
  - Ensure the datum includes valid account detail:

    - *`email_hash`:* Must be 32 bytes long, or

    - *`phone_hash`:* Must be 32 bytes long.  
  
  - The User NFT must not be sent to the script.
  
  - The Reference NFT must be preserved at the script address.

  \
+ *DeleteAccount*

  This redeemer endpoint allows for the removal of a member account by burning the associated Account Tokens.

  _A Check That there are no active memberships should be done off-chain._

  - Validate that the redeemer only burns one Account Reference Token and one Account User Token.

  - There should be no remaining account-related tokens in the transaction after burning.

\

==== Spend Purpose

===== Datum <account-datum>
\
- *`email_hash: Hash<ByteArray, Sha2_256>`:* A hash (using Sha2_256) of the member's email as a ByteArray. This must be exactly 32 bytes long.

- *`phone_hash: Hash<ByteArray, Sha2_256>`:* A hash (using Sha2_256) of the member's phone number as a ByteArray. This must also be exactly 32 bytes long.
\
===== Redeemer
\
- *```rust
  UpdateAccount {
    reference_token_name: AssetName,
    user_input_index: Int,
    account_input_index: Int,
    account_output_index: Int,
  }
```*

- *```rust
  RemoveAccount {
    reference_token_name: AssetName,
    user_input_index: Int,
    account_input_index: Int,
  }
```*

\
====== Validation
\
+ *UpdateAccount*

  This redeemer endpoint allows a member to update the metadata attached to an Account UTxO.

  - Validate that an Account UTxO containing the Account NFT must be present in the inputs (at *`account_input_index`*).

  - A user input (at *`user_input_index`*) must include the Account User Token, proving ownership.
  
  - The output (at *`account_output_index`*) must be sent to the Account Script's address and it must carry an updated Account datum.
  
  - The updated Account datum must satisfy metadata validation, ensuring that contact details remain correctly formatted.
  
  - The Reference NFT must be forwarded correctly to the spending endpoint. 
  
  \
+ *RemoveAccount*
  
  The redeemer allows the removal of an account by a member from the cooperative finance system. 
  
  _Must Check That there are no active memberships in the off-chain code._
 
  - The transaction must include an Account UTxO (at *`account_input_index`*) containing the Account NFT.

  - A user input (at *`user_input_index`*) must be present to prove ownership via the Account User Token.

  - The redeemer must burn the Account Reference NFT, which is validated by confirming that the minted value includes a burn (i.e. a negative quantity) for the reference token.

#pagebreak()

= Transactions
\
This section outlines the various transactions involved in the DCU-Toolkit on the Cardano blockchain. Each transaction type demonstrates the interaction patterns between members, administrators, and the three core validators.

\
== Account Validator
\
=== Mint :: CreateAccount
\
This transaction creates a new member account by minting Account NFTs. This transaction is performed by a user to establish their identity within the cooperative finance system and enable participation in multiple groups.

\
#transaction(
  "CreateAccount",
  inputs: (
    (
      name: "Member Wallet UTxO",
      address: "member_wallet",
      value: (
        ada: 5000000,
      ),
    ),
  ),
  outputs: (
    (
      name: "Account Validator UTxO",
      address: "account_validator",
      value: (
        ada: 2000000,
        Ref_NFT: 1,
      ),
      datum: (
        email_hash: "0x12..ef",
        phone_hash: "0xab..89",
      ),
    ),
    (
      name: "Member Wallet UTxO",
      address: "member_wallet",
      value: (
        ada: 1000000, // Change
        User_NFT: 1,
      ),
    ),
  ),
  show_mints: true,
  notes: [Create Account Transaction],
)

\
==== Inputs
\
  + *Member Wallet UTxO.*
    - Address: Member's wallet address

    - Value:

      - Minimum ADA

      - Any ADA required for the transaction.
\
==== Mints
\
  + *Account Multi-validator*
    - Redeemer: CreateAccount

    - Value: 

      - +1 Account NFT Asset

      - +1 Reference NFT Asset
\
==== Outputs
\
  + *Member Wallet UTxO:*

    - Address: Member wallet address

      - minimum ADA

      - 1 Account NFT Asset
  
  + *Account Validator UTxO:*

    - Address: Account Validator script address
    - Datum:

      - *`email_hash: Hash<ByteArray, Sha2_256>`:* A hash (using Sha2_256) of the member's email as a ByteArray. This must be exactly 32 bytes long.
      - *`phone_hash: Hash<ByteArray, Sha2_256>`:* A hash (using Sha2_256) of the member's phone number as a ByteArray. This must also be exactly 32 bytes long.
    
    - Value:     

      - 1 Account Reference NFT Asset
#pagebreak()

=== Spend :: UpdateAccount
\

This transaction updates the member's account metadata. It consumes both the Account NFT and the Reference NFT, then sends the updated Account NFT back to the member's wallet and the updated Reference NFT to the spending endpoint.

\
#transaction(
  "UpdateAccount",
  inputs: (
    (
      name: "Account Validator UTxO",
      address: "account_validator",
      value: (
        ada: 2000000,
        Ref_NFT: 1,
      ),
      datum: (
        email_hash: "0x12..ef",
        phone_hash: "0xab..89",
      ),
    ),
    (
      name: "Member Wallet UTxO",
      address: "member_wallet",
      value: (
        ada: 2000000,
        User_NFT: 1,
      ),
    ),
  ),
  outputs: (
    (
      name: "Account Validator UTxO",
      address: "account_validator",
      value: (
        ada: 2000000,
        Ref_NFT: 1,
      ),
      datum: (
        email_hash: "0xnew..",
        phone_hash: "0xnew..",
      ),
    ),
    (
      name: "Member Wallet UTxO",
      address: "member_wallet",
      value: (
        ada: 1500000,
        User_NFT: 1,
      ),
    ),
  ),
  show_mints: false,
  notes: [Update Account Metadata],
)
\

==== Inputs
\
  + *Member Wallet UTxO*

    - Address: Member's wallet address

    - Value:
    
      - Minimum ADA

      - 1 Account NFT Asset

  + *Account Validator UTxO*

    - Address: Account validator script address

    - Datum:

      - existing_metadata: listed in @account-datum
.
    - Value:

      - Minimum ADA

      - 1 Reference NFT Asset
\
==== Outputs
\
  + *Member Wallet UTxO*
    - Address: Member wallet address

    - Datum:
      - updated_metadata: New metadata for the account.
    - Value:

      - Minimum ADA

      - 1 Account NFT Asset

  + *Account Validator UTxO:*
    - Address: Account validator script address

    - Datum:
      - updated_metadata: New metadata for the account    
    - Value:

      - Minimum ADA

      - 1 Reference NFT Asset



#pagebreak()

=== Mint :: DeleteAccount
\
This transaction removes a member account from the cooperative finance system by burning both the Account Reference NFT and the Account User NFT. The check that the member has no active group memberships must be performed off-chain before submitting this transaction.

\
#transaction(
  "DeleteAccount",
  inputs: (
    (
      name: "Member Wallet UTxO",
      address: "member_wallet",
      value: (
        ada: 2000000,
        User_NFT: 1,
      ),
    ),
    (
      name: "Account Validator UTxO",
      address: "account_validator",
      value: (
        ada: 2000000,
        Ref_NFT: 1,
      ),
      datum: (
        email_hash: "0x12..ef",
        phone_hash: "0xab..89",
      ),
    ),
  ),
  outputs: (
    (
      name: "Member Wallet UTxO",
      address: "member_wallet",
      value: (
        ada: 3500000, // Reclaimed ADA
      ),
    ),
  ),
  show_mints: true,
  notes: [Delete Account & Burn NFTs],
)

\
==== Inputs
\
  + *Member Wallet UTxO*

    - Address: Member's wallet address

    - Value:

      - Minimum ADA

      - 1 Account User NFT Asset

  + *Account Validator UTxO*

    - Address: Account validator script address

    - Datum:

      - existing_datum: listed in @account-datum

    - Value:

      - Minimum ADA

      - 1 Account Reference NFT Asset
\
==== Mints
\
  + *Account Multi-validator (Mint)*

    - Redeemer: DeleteAccount

    - Value:

      - -1 Account Reference NFT Asset

      - -1 Account User NFT Asset

  + *Account Multi-validator (Spend)*

    - Redeemer: RemoveAccount

    - Authorizes spending the Account Validator UTxO and proves ownership via the User NFT.
\
==== Outputs
\
  + *Member Wallet UTxO*

    - Address: Member's wallet address

    - Value:

      - Reclaimed ADA (from both UTxOs)

*Note:* No script output is produced. `RemoveAccount` (spend) and `DeleteAccount` (mint) execute in the same transaction — the spend validator authorizes unlocking the script UTxO while the mint validator burns both tokens. The check that the member has no active group memberships must be performed off-chain before submission.

#pagebreak()

== Group Validator
\
=== Mint :: CreateGroup
\
This transaction creates a new cooperative group by minting Group NFTs. This transaction is performed by a member who wishes to become a group administrator.

\
#transaction(
  "CreateGroup",
  inputs: (
    (
      name: "Admin Wallet UTxO",
      address: "admin_wallet",
      value: (
        ada: 10000000,
      ),
    ),
  ),
  outputs: (
    (
      name: "Group Validator UTxO",
      address: "group_validator",
      value: (
        ada: 3000000,
        Group_Ref: 1,
      ),
      datum: (
        joining_fee: 100,
        contribution_fee: 10,
        penalty_fee: 50,
        interval: 86400,
        member_count: 0, // Initialized
        active: true,
      ),
    ),
    (
      name: "Admin Wallet UTxO",
      address: "admin_wallet",
      value: (
        ada: 1000000, // Change
        Group_User: 1,
      ),
    ),
  ),
  show_mints: true,
  notes: [Create Group Transaction],
)
\

==== Inputs
\
  + *Administrator Wallet UTxO.*
    - Address: Administrator's wallet address

    - Value:

      - Minimum ADA

      - Any additional ADA required for the transaction
\
==== Mints
\
  + *Group Multi-validator*

    - Redeemer: CreateGroup
    
    - Value:

      - +1 Group NFT Asset

      - +1 Reference NFT Asset
\
==== Outputs
\
  + *Administrator Wallet UTxO:*

    - Address: Administrator wallet address

    - Value:

      - minimum ADA

      - 1 Group NFT Asset
  
  + *Group Validator UTxO:*

    - Address: Group validator script address

    - Datum:

      - *`contribution_fee_policyid: PolicyId`* The PolicyId governing the asset used for the contribution fee.
      - *`contribution_fee_assetname: AssetName`* The AssetName of the contribution fee.
      - *`contribution_fee: Int`* An Int representing the contribution fee amount per interval.
      - *`joining_fee_policyid: PolicyId`* The PolicyId governing the asset used for the joining fee.
      - *`joining_fee_assetname: AssetName`* The AssetName of the joining fee.
      - *`joining_fee: Int`* An Int representing the one-time joining fee.
      - *`penalty_fee_policyid: PolicyId`* The PolicyId governing the asset used for the penalty fee.
      - *`penalty_fee_assetname: AssetName`* The AssetName of the penalty fee.
      - *`penalty_fee: Int`* An Int representing the fee deducted when a member exits early.
      - *`interval_length: Int`* An Int defining the duration of one contribution interval.
      - *`num_intervals: Int`* An Int representing the total number of intervals in the rotation cycle.
      - *`is_active: Bool`* A Bool indicating whether the group is currently active.

    - Value:

      - 1 Group Reference NFT Asset
#pagebreak()

=== Spend :: UpdateGroup
\

This transaction updates the group metadata attached to the Group UTxO at the script address. It enables administrators to adjust group parameters such as fees, intervals, and governance rules.

\
#transaction(
  "UpdateGroup",
  inputs: (
    (
      name: "Admin Wallet UTxO",
      address: "admin_wallet",
      value: (
        ada: 2000000,
        Group_NFT: 1,
      ),
    ),
    (
      name: "Group Validator UTxO",
      address: "group_validator",
      value: (
        ada: 3000000,
        Group_Ref: 1,
      ),
      datum: (
        member_count: 0, // Must be 0
        active: false,
      ),
    ),
  ),
  outputs: (
    (
      name: "Admin Wallet UTxO",
      address: "admin_wallet",
      value: (
        ada: 1000000,
        Group_NFT: 1,
      ),
    ),
    (
      name: "Group Validator UTxO",
      address: "group_validator",
      value: (
        ada: 3000000,
        Group_Ref: 1,
      ),
      datum: (
        member_count: 0,
        active: true,
      ),
    ),
  ),
  show_mints: false,
  notes: [Update Group Metadata (Safe)],
)
\

==== Inputs
\
  + *Administrator Wallet UTxO*

    - Address: Administrator's wallet address

    - Value:
     
      - Minimum ADA 

      - Group NFT Asset

  + *Group Validator UTxO*

    - Address: Group validator script address

    - Datum:

      - existing_metadata: Current metadata listed in @group-datum.

    - Value: 

      - Minimum ADA

      - 1 Reference NFT Asset
\
==== Outputs
\
  + *Administrator Wallet UTxO*
    - Address: Administrator's wallet address

    - Value:

      - Minimum ADA

      - 1 Group NFT Asset

  + *Group Validator UTxO*
    - Address: Group validator script address

    - Datum:

      - updated_metadata: updated metadata for the group listed in @group-datum

    - Value:

      - Minimum ADA

      - 1 Reference NFT Asset


#pagebreak()

=== Spend :: StartGroup
\
This transaction seals membership and begins the ROSCA rotation schedule. It may only be called by the group administrator after at least two members have joined. After this point, no new members may join and `DistributeRound` becomes available. The admin's wallet UTxO is NOT required to be a spending input — the admin token (Group (222) NFT) is enough proof of authority.

\
#transaction(
  "StartGroup",
  inputs: (
    (
      name: "Admin Wallet UTxO",
      address: "admin_wallet",
      value: (
        ada: 2000000,
        Group_NFT: 1, // (222) admin token proves authority
      ),
    ),
    (
      name: "Group Validator UTxO",
      address: "group_validator",
      value: (
        ada: 3000000,
        Group_Ref: 1,
      ),
      datum: (
        member_count: 3,
        is_started: false,
        num_intervals: 0,
        start_time: 0,
      ),
    ),
  ),
  outputs: (
    (
      name: "Admin Wallet UTxO",
      address: "admin_wallet",
      value: (
        ada: 1500000,
        Group_NFT: 1,
      ),
    ),
    (
      name: "Group Validator UTxO",
      address: "group_validator",
      value: (
        ada: 3000000,
        Group_Ref: 1,
      ),
      datum: (
        member_count: 3,
        is_started: true,        // Set to True — one-way latch
        num_intervals: 3,        // Set to member_count
        start_time: 1716000000000, // tx.validity_range.lower_bound
      ),
    ),
  ),
  show_mints: false,
  notes: [Seal membership — is_started True, num_intervals = member_count, start_time anchored],
)
\

==== Inputs
\
  + *Admin Wallet UTxO*

    - Address: Administrator's wallet address

    - Value:

      - Minimum ADA

      - 1 Group (222) NFT (admin authority token)

  + *Group Validator UTxO* (spending input)

    - Address: Group validator script address

    - Datum: group datum with `is_started = False` and `member_count ≥ 2`

    - Value: 1 Group Reference NFT + minimum ADA
\
==== Outputs
\
  + *Admin Wallet UTxO*

    - Address: Administrator's wallet address

    - Value: change ADA + Group (222) NFT returned

  + *Group Validator UTxO*

    - Address: Group validator script address

    - Datum: same as input with three fields updated:
      - `is_started = True`
      - `num_intervals = member_count`
      - `start_time = tx.validity_range.lower_bound`

    - Value: identical to input (no ADA change)

#pagebreak()

=== Spend :: RemoveGroup (+ Mint :: BurnGroup)
\
This transaction permanently deletes a cooperative group. It is a hard-delete: both the Group Reference NFT (100) and the Group NFT (222) are burned, the Group Validator UTxO is consumed and produces no output, and the locked ADA is returned to the administrator. The group must already be deactivated (`is_active == false`) and have zero active members (`member_count == 0`) before it can be deleted. Deactivation is performed first via `UpdateGroup` (setting `is_active` to `false`), then deletion via this two-redeemer transaction.

\
#transaction(
  "RemoveGroup + BurnGroup",
  inputs: (
    (
      name: "Admin Wallet UTxO",
      address: "admin_wallet",
      value: (
        ada: 2000000,
        Group_NFT: 1, // (222) user token — burned
      ),
    ),
    (
      name: "Group Validator UTxO",
      address: "group_validator",
      value: (
        ada: 3000000,
        Group_Ref: 1, // (100) ref token — burned
      ),
      datum: (
        member_count: 0, // Required
        active: false,   // Must be deactivated first
      ),
    ),
  ),
  outputs: (
    (
      name: "Admin Wallet UTxO",
      address: "admin_wallet",
      value: (
        ada: 4500000, // Reclaimed: admin deposit + group UTxO ADA (minus fees)
      ),
    ),
  ),
  show_mints: true,
  notes: [Hard-delete Group: both tokens burned (−1 Group_Ref, −1 Group_NFT), no group output],
)

\
==== Inputs
\
  + *Administrator Wallet UTxO*

    - Address: Administrator's wallet address

    - Value:

      - Minimum ADA

      - 1 Group NFT (222) asset (proves admin ownership; burned in this tx)

  + *Group Validator UTxO*

    - Address: Group validator script address

    - Datum:

      - existing_datum: listed in @group-datum, with `member_count == 0` and `is_active == false`

    - Value:

      - Minimum ADA

      - 1 Group Reference NFT (100) asset (burned in this tx)
\
==== Mints
\
  - Group policy: `-1` Group Reference NFT (100) + `-1` Group NFT (222)

  - Exactly two tokens burned under this policy; all quantities must be negative.
\
==== Outputs
\
  + *Administrator Wallet UTxO*

    - Address: Administrator's wallet address

    - Value:

      - Reclaimed ADA (creation deposit + group UTxO balance, minus tx fees)

*Note:* No Group Validator UTxO is produced. Both CIP-68 tokens are permanently burned. This is a two-step lifecycle: first call `UpdateGroup` to set `is_active = false` (while `member_count == 0`), then call this transaction to burn both tokens and reclaim ADA. A `BurnGroup` mint without a paired `RemoveGroup` spend is rejected because the spend handler enforces admin auth and deactivation; a `RemoveGroup` spend without `BurnGroup` is rejected because the mint handler enforces exact-2-burns.

#pagebreak()

== Treasury Validator
\
=== Mint :: JoinGroup
\
This transaction occurs when a member joins a cooperative group. It atomically mints one Membership Token, creates the member's Treasury UTxO with pre-paid contributions, and updates the Group UTxO to increment `member_count`. The Group UTxO is a *spending input* — not a reference — so the group state is updated in the same transaction.

\
#transaction(
  "JoinGroup",
  inputs: (
    (
      name: "Member Wallet UTxO",
      address: "member_wallet",
      value: (
        ada: 10000000,
        Account_NFT: 1,
      ),
    ),
    (
      name: "Group Validator UTxO",
      address: "group_validator",
      value: (
        ada: 3000000,
        Group_Ref: 1,
      ),
      datum: (
        joining_fee: 0,
        contribution_fee: 2000000,
        member_count: 5,
        is_started: false,
      ),
    ),
  ),
  outputs: (
    (
      name: "Member Wallet UTxO",
      address: "member_wallet",
      value: (
        ada: 1000000,
        Account_NFT: 1,
        Member_User: 1, // Account user token stays in wallet
      ),
    ),
    (
      name: "Treasury Validator UTxO",
      address: "treasury_validator",
      value: (
        ada: 60000000, // max_members × contribution_fee pre-paid
        Member_Ref: 1, // Membership token locked here
      ),
      datum: (
        assigned_slot: 5,   // == member_count at join time
        rounds_paid: 0,
        is_deferred: false,
      ),
    ),
    (
      name: "Group Validator UTxO",
      address: "group_validator",
      value: (
        ada: 3000000,
        Group_Ref: 1,
      ),
      datum: (
        member_count: 6, // Incremented by 1
      ),
    ),
  ),
  show_mints: true,
  notes: [Join Group — Group UTxO is a spending input; member_count atomically incremented],
)
\

==== Inputs
\
  + *Member Wallet UTxO*

    - Address: Member's wallet address

    - Value:

      - `max_members × contribution_fee` ADA (pre-pays all future rounds) or minimum 2 ADA for non-ADA fees

      - 1 Account User NFT (proves account ownership; stays in wallet)

  + *Group Validator UTxO* (spending input)

    - Address: Group validator script address

    - Datum: existing group datum as listed in @group-datum

    - Value:

      - 1 Group Reference NFT Asset
      - Minimum ADA
\
==== Mints
\
  + *Treasury Validator (Mint — JoinGroup)*

    - Value:

      - +1 Membership Token (the member's CIP-68 treasury token)

  + *Group Validator (Spend — MemberJoin)*

    - Atomically updates the Group UTxO: `member_count + 1`, appends token name to `member_token_names`

\
==== Outputs
\
  + *Member Wallet UTxO*

    - Address: Member's wallet address

    - Value:

      - Change ADA (after contribution lock and optional joining fee)

      - 1 Account User NFT (returned)

      - 1 Membership User Token (the (222) prefix copy, returned to wallet)

  + *Treasury Validator UTxO*

    - Address: Treasury validator script address

    - Datum (`TreasuryState`):

      - `assigned_slot`: index equal to `group.member_count` at join time
      - `rounds_paid`: 0
      - `is_deferred`: False
      - `member_payment_credential`: member's wallet PKH
      - `group_reference_tokenname` / `member_reference_tokenname`: linking tokens

    - Value:

      - `max_members × contribution_fee` ADA (pre-paid contributions)

      - 1 Membership Reference Token (the (100) prefix, locked at script)

  + *Group Validator UTxO*

    - Address: Group validator script address

    - Datum: same as input with `member_count` incremented by 1 and member token name appended to `member_token_names`

    - Value: same as input
#pagebreak()

=== Spend :: DeferRound
\
This transaction allows a member to voluntarily defer their scheduled borrower turn for the next distribution round. The deferred member still contributes their `contribution_fee` when the round runs; the pot routes to the next slot instead. The `is_deferred` flag resets automatically when `DistributeRound` processes this member.

\
#transaction(
  "DeferRound",
  inputs: (
    (
      name: "Member Wallet UTxO",
      address: "member_wallet",
      value: (
        ada: 2000000,
        Account_NFT: 1,
        Member_User: 1,
      ),
    ),
    (
      name: "Treasury Validator UTxO",
      address: "treasury_validator",
      value: (
        ada: 60000000,
        Member_Ref: 1,
      ),
      datum: (
        assigned_slot: 2,
        rounds_paid: 2,
        is_deferred: false,
      ),
    ),
  ),
  outputs: (
    (
      name: "Member Wallet UTxO",
      address: "member_wallet",
      value: (
        ada: 1500000,
        Account_NFT: 1,
        Member_User: 1,
      ),
    ),
    (
      name: "Treasury Validator UTxO",
      address: "treasury_validator",
      value: (
        ada: 60000000, // ADA unchanged
        Member_Ref: 1,
      ),
      datum: (
        assigned_slot: 2,
        rounds_paid: 2,
        is_deferred: true, // Only this field changes
      ),
    ),
  ),
  show_mints: false,
  notes: [Defer scheduled payout turn — is_deferred set to True, resets at DistributeRound],
)
\

==== Inputs
\
  + *Member Wallet UTxO*

    - Address: Member's wallet address

    - Value:

      - Minimum ADA

      - 1 Account User NFT Asset (proves ownership)

  + *Treasury Validator UTxO*

    - Address: Treasury validator script address

    - Datum: `TreasuryState` as listed in @treasury-datum

    - Value:

      - Locked contribution funds

      - 1 Membership Reference Token
\
==== Outputs
\
  + *Member Wallet UTxO*

    - Address: Member's wallet address

    - Value:

      - Change ADA

      - 1 Account User NFT (returned)

  + *Treasury Validator UTxO*

    - Address: Treasury validator script address

    - Datum: identical to input with `is_deferred = True`

    - Value: identical to input (ADA and membership token unchanged)

#pagebreak()

=== Spend :: ExitGroup
\
This transaction allows a member to exit a cooperative group by spending a Treasury UTxO, unlocking the remaining contribution to their wallet address and potentially creating a Penalty UTxO.

\
#transaction(
  "ExitGroup",
  inputs: (
    (
      name: "Member Wallet UTxO",
      address: "member_wallet",
      value: (
        ada: 2000000,
        Account_NFT: 1,
        Member_User: 1,
      ),
    ),
    (
      name: "Treasury Validator UTxO",
      address: "treasury_validator",
      value: (
        ada: 500000000,
        Member_Ref: 1,
      ),
      datum: (
        start: 123456789,
        contribution: 500,
        assigned_slot: 6,
      ),
    ),
    (
      name: "Group Validator UTxO",
      address: "group_validator",
      value: (
        ada: 3000000,
        Group_Ref: 1,
      ),
      datum: (
        member_count: 6,
      ),
    ),
  ),
  outputs: (
    (
      name: "Member Wallet UTxO",
      address: "member_wallet",
      value: (
        ada: 452000000, // Refund - Penalty
        Account_NFT: 1,
      ),
    ),
    (
      name: "Treasury Validator UTxO",
      address: "treasury_validator",
      value: (
        ada: 50000000, // Penalty Locked
        Member_Ref: 1,
      ),
      datum: (
        // PenaltyState — group_reference_tokenname + member_reference_tokenname
        type: "PenaltyState",
      ),
    ),
    (
      name: "Group Validator UTxO",
      address: "group_validator",
      value: (
        ada: 3000000,
        Group_Ref: 1,
      ),
      datum: (
        member_count: 5, // Decremented
      ),
    ),
  ),
  show_mints: false,
  notes: [Early exit: PenaltyState UTxO created; Group UTxO is a spending input for member_count decrement],
)
\

==== Inputs
\
  + *Member Wallet UTxO*

    - Address: Member's wallet address

    - Value:

      - Minimum ADA

      - 1 Account User NFT Asset

  + *Treasury Validator UTxO*

    - Address: Treasury validator script address

    - Datum: `TreasuryState` as listed in @treasury-datum

    - Value:

      - Locked contribution funds

      - 1 Membership Reference Token

  + *Group Validator UTxO* (spending input)

    - Address: Group validator script address

    - Datum: group datum as listed in @group-datum

    - Value:

      - 1 Group Reference NFT Asset
      - Minimum ADA
\
==== Outputs
\
  + *Member Wallet UTxO*

    - Address: Member's wallet address

    - Value:

      - Minimum ADA

      - Remaining contribution funds (minus penalty if early exit)

      - 1 Account User NFT Asset

  + *Treasury Validator UTxO* (early exit path only — PenaltyState)

    - Address: Treasury validator script address

    - Datum: `PenaltyState` as listed in @penalty-datum

    - Value:

      - Penalty ADA (≥ `penalty_fee`)

      - 1 Membership Reference Token (held until admin claims via TerminateGroup)

  + *Group Validator UTxO*

    - Address: Group validator script address

    - Datum: same as input with `member_count − 1` and member token name removed from `member_token_names`

    - Value: same as input

*Note:* Mature / inactive exit path burns the Membership token and returns all ADA to the member. No PenaltyState UTxO is created.

#pagebreak()

=== Spend :: DistributeRound
\
This transaction distributes the group pot for one sequential round. All active members' Treasury UTxOs are consumed and updated atomically with the Group UTxO. The Group UTxO is a *spending input* so `last_distributed_round` is updated on-chain. The borrower (scheduled slot member) receives the full pot. If the borrower has `is_deferred = True`, the payout routes to the next slot.

\
#transaction(
  "DistributeRound",
  inputs: (
    (
      name: "Treasury UTxO (A) — Borrower",
      address: "treasury_validator",
      value: (
        ada: 60000000,
        Member_Ref: 1,
      ),
      datum: (
        assigned_slot: 0,    // current_slot = round_number % num_intervals
        rounds_paid: 0,
        is_deferred: false,
      ),
    ),
    (
      name: "Treasury UTxO (B)",
      address: "treasury_validator",
      value: (
        ada: 60000000,
        Member_Ref: 1,
      ),
      datum: (
        assigned_slot: 1,
        rounds_paid: 0,
        is_deferred: false,
      ),
    ),
    (
      name: "Group Validator UTxO",
      address: "group_validator",
      value: (
        ada: 3000000,
        Group_Ref: 1,
      ),
      datum: (
        last_distributed_round: -1, // round_number - 1
        num_intervals: 2,
        is_started: true,
      ),
    ),
  ),
  outputs: (
    (
      name: "Borrower Wallet UTxO",
      address: "member_wallet",
      value: (
        ada: 4000000, // contribution_fee × num_members (2 × 2 ADA)
      ),
    ),
    (
      name: "Treasury UTxO (A)",
      address: "treasury_validator",
      value: (
        ada: 58000000, // −contribution_fee
        Member_Ref: 1,
      ),
      datum: (
        rounds_paid: 1,   // Incremented
        is_deferred: false, // Always reset
      ),
    ),
    (
      name: "Treasury UTxO (B)",
      address: "treasury_validator",
      value: (
        ada: 58000000,
        Member_Ref: 1,
      ),
      datum: (
        rounds_paid: 1,
        is_deferred: false,
      ),
    ),
    (
      name: "Group Validator UTxO",
      address: "group_validator",
      value: (
        ada: 3000000,
        Group_Ref: 1,
      ),
      datum: (
        last_distributed_round: 0, // Incremented to round_number
      ),
    ),
  ),
  show_mints: false,
  notes: [DistributeRound 0: Group UTxO is a spending input; all treasury UTxOs updated atomically],
)
\

==== Inputs:
\
+ *Treasury Validator UTxOs (all active members)*

  - Address: Treasury validator script address

  - Datum: `TreasuryState` with `rounds_paid == round_number` (not yet processed this round)

  - Value: locked contribution funds + membership reference token

+ *Group Validator UTxO* (spending input)

  - Address: Group validator script address

  - Datum: group datum with `last_distributed_round == round_number − 1`

  - Value: Group Reference NFT + minimum ADA
\
==== Outputs:
\
+ *Borrower Wallet UTxO*

  - Address: Member's wallet with `assigned_slot == current_slot` (or next slot if deferred)

  - Value: `contribution_fee × number_of_treasury_inputs` (the full pot for this round)

+ *Treasury Validator UTxOs (all active members)*

  - Address: Treasury validator script address

  - Datum: same `TreasuryState` with `rounds_paid` incremented by 1 and `is_deferred` reset to `False`

  - Value: input ADA minus `contribution_fee` per member; membership token preserved

+ *Group Validator UTxO*

  - Address: Group validator script address

  - Datum: same as input with `last_distributed_round = round_number`

  - Value: same as input
#pagebreak()


=== Spend :: Contribute
\
This transaction allows a member to top up their Treasury balance when it has fallen below the `contribution_fee` threshold, preventing transition to `InsufficientCollateralState`. The datum is preserved exactly — only the UTxO value increases.

\
#transaction(
  "Contribute",
  inputs: (
    (
      name: "Member Wallet UTxO",
      address: "member_wallet",
      value: (
        ada: 10000000,
        Account_NFT: 1,
        Member_User: 1,
      ),
    ),
    (
      name: "Treasury Validator UTxO",
      address: "treasury_validator",
      value: (
        ada: 3000000, // balance has fallen below contribution_fee
        Member_Ref: 1,
      ),
      datum: (
        rounds_paid: 2,
        is_deferred: false,
      ),
    ),
  ),
  outputs: (
    (
      name: "Member Wallet UTxO",
      address: "member_wallet",
      value: (
        ada: 4500000,
        Account_NFT: 1,
        Member_User: 1,
      ),
    ),
    (
      name: "Treasury Validator UTxO",
      address: "treasury_validator",
      value: (
        ada: 8000000, // topped up (> input ADA)
        Member_Ref: 1,
      ),
      datum: (
        rounds_paid: 2,   // datum structurally unchanged
        is_deferred: false,
      ),
    ),
  ),
  show_mints: false,
  notes: [Top-up treasury balance — datum frozen, ADA must strictly increase],
)
\

==== Inputs
\
+ *Member Wallet UTxO*

  - Address: Member's wallet address

  - Value:

    - Top-up ADA (sufficient to bring treasury above `contribution_fee`)

    - 1 Account User NFT Asset (proves ownership)

+ *Treasury Validator UTxO*

  - Address: Treasury validator script address

  - Datum: `TreasuryState` as listed in @treasury-datum

  - Value:

    - Current (low) contribution balance

    - 1 Membership Reference Token
\
==== Outputs
\
+ *Member Wallet UTxO*

  - Address: Member's wallet address

  - Value:

    - Change ADA

    - 1 Account User NFT (returned)

    - 1 Membership User Token (returned)

+ *Treasury Validator UTxO*

  - Address: Treasury validator script address

  - Datum: identical to input (no field changes)

  - Value:

    - Increased ADA balance (> input ADA)

    - 1 Membership Reference Token

#pagebreak()

=== Spend :: UpdatePayoutCredential
\
This transaction allows a member to redirect future payouts to a new wallet address. The new `member_payment_credential` is automatically derived from the address of the spending member input — the member proves control by signing the transaction with the corresponding key. No manual 28-byte credential entry is required.

\
#transaction(
  "UpdatePayoutCredential",
  inputs: (
    (
      name: "Member Wallet UTxO",
      address: "member_wallet",
      value: (
        ada: 2000000,
        Account_NFT: 1,
        Member_User: 1,
      ),
    ),
    (
      name: "Treasury Validator UTxO",
      address: "treasury_validator",
      value: (
        ada: 40000000,
        Member_Ref: 1,
      ),
      datum: (
        member_payment_credential: "old_pkh_28bytes",
        rounds_paid: 1,
        is_deferred: false,
      ),
    ),
  ),
  outputs: (
    (
      name: "Member Wallet UTxO",
      address: "member_wallet",
      value: (
        ada: 1500000,
        Account_NFT: 1,
        Member_User: 1,
      ),
    ),
    (
      name: "Treasury Validator UTxO",
      address: "treasury_validator",
      value: (
        ada: 40000000, // ADA unchanged
        Member_Ref: 1,
      ),
      datum: (
        member_payment_credential: "new_pkh_28bytes", // updated to current wallet
        rounds_paid: 1,    // all other fields frozen
        is_deferred: false,
      ),
    ),
  ),
  show_mints: false,
  notes: [Redirect future payouts — only member_payment_credential changes, ADA and membership token unchanged],
)
\

==== Inputs
\
+ *Member Wallet UTxO*

  - Address: Member's *new* wallet address (the new payment key hash is read from this input)

  - Value:

    - Minimum ADA

    - 1 Account User NFT Asset (proves ownership)

+ *Treasury Validator UTxO*

  - Address: Treasury validator script address

  - Datum: `TreasuryState` as listed in @treasury-datum

  - Value:

    - Locked contribution funds

    - 1 Membership Reference Token
\
==== Outputs
\
+ *Member Wallet UTxO*

  - Address: Member's wallet address

  - Value:

    - Change ADA

    - 1 Account User NFT (returned)

    - 1 Membership User Token (returned)

+ *Treasury Validator UTxO*

  - Address: Treasury validator script address

  - Datum: identical to input with `member_payment_credential` updated to the new 28-byte key hash

  - Value: identical to input (ADA and membership token unchanged)

#pagebreak()

=== Spend :: ExtendGraceWindow
\
This transaction allows the group administrator to grant an additional grace window to a member whose Treasury UTxO is in `InsufficientCollateralState`. The Group UTxO is provided as a *reference input* — its `grace_period_length` field is read but the group state is not modified. At most two extensions may be granted (`max_grace_extensions = 2`). After both extensions are exhausted, only `TerminateGroup` is available.

\
#transaction(
  "ExtendGraceWindow",
  inputs: (
    (
      name: "Admin Wallet UTxO",
      address: "admin_wallet",
      value: (
        ada: 2000000,
        Group_NFT: 1, // (222) admin authority token
      ),
    ),
    (
      name: "Treasury Validator UTxO",
      address: "treasury_validator",
      value: (
        ada: 1500000,
        Member_Ref: 1,
      ),
      datum: (
        type: "InsufficientCollateralState",
        grace_expires_at: 1716000000000,
        grace_extensions_used: 0,
      ),
    ),
    (
      reference: true,
      name: "Group Validator UTxO",
      address: "group_validator",
      value: (
        ada: 3000000,
        Group_Ref: 1,
      ),
    ),
  ),
  outputs: (
    (
      name: "Admin Wallet UTxO",
      address: "admin_wallet",
      value: (
        ada: 1500000,
        Group_NFT: 1,
      ),
    ),
    (
      name: "Treasury Validator UTxO",
      address: "treasury_validator",
      value: (
        ada: 1500000, // ADA unchanged
        Member_Ref: 1,
      ),
      datum: (
        grace_expires_at: 1716300000000, // + grace_period_length
        grace_extensions_used: 1,        // incremented
      ),
    ),
  ),
  show_mints: false,
  notes: [Grant grace extension — grace_expires_at extended, grace_extensions_used incremented; max 2 extensions],
)
\

==== Inputs
\
+ *Administrator Wallet UTxO*

  - Address: Administrator's wallet address

  - Value:

    - Minimum ADA

    - 1 Group NFT (222) asset (proves admin authority)

+ *Treasury Validator UTxO*

  - Address: Treasury validator script address

  - Datum: `InsufficientCollateralState` as listed in @insufficient-collateral-datum

  - Value:

    - Locked ADA (member's remaining balance)

    - 1 Membership Reference Token

+ *Group Validator UTxO* (reference input)

  - Address: Group validator script address

  - Datum: group datum listed in @group-datum (provides `grace_period_length`)

  - Value:

    - 1 Group Reference NFT Asset
    - Minimum ADA
\
==== Outputs
\
+ *Administrator Wallet UTxO*

  - Address: Administrator's wallet address

  - Value:

    - Change ADA

    - 1 Group NFT (222) asset (returned)

+ *Treasury Validator UTxO*

  - Address: Treasury validator script address

  - Datum: `InsufficientCollateralState` with:
    - `grace_expires_at` extended by `grace_period_length`
    - `grace_extensions_used` incremented by 1
    - all other fields frozen

  - Value: identical to input (ADA and membership token unchanged)

#pagebreak()

=== Spend :: TerminateGroup (+ Mint :: TerminateGroup)
\
This transaction allows a group administrator to claim the penalty funds from a `PenaltyState` UTxO. It burns the membership reference token locked in the UTxO and returns all locked ADA (including `penalty_fee`) to the administrator. The Group UTxO is provided as a *reference input* — `member_count` was already decremented atomically at `ExitGroup` time, so no group state update is required here.

\
#transaction(
  "TerminateGroup",
  inputs: (
    (
      name: "Admin Wallet UTxO",
      address: "admin_wallet",
      value: (
        ada: 2000000,
        Group_NFT: 1,
      ),
    ),
    (
      name: "Treasury Validator UTxO",
      address: "treasury_validator",
      value: (
        ada: 50000000,
        Member_Ref: 1, // Membership Reference Token locked at ExitGroup
      ),
      datum: (
        type: "PenaltyState",
      ),
    ),
    (
      reference: true,
      name: "Group Validator UTxO",
      address: "group_validator",
      value: (
        ada: 3000000,
        Group_Ref: 1,
      ),
    ),
  ),
  outputs: (
    (
      name: "Admin Wallet UTxO",
      address: "admin_wallet",
      value: (
        ada: 52000000, // penalty ADA returned to admin
        Group_NFT: 1,
      ),
    ),
  ),
  show_mints: true,
  notes: [Claim penalty — Membership Reference Token burned, all ADA returned to admin, no script output],
)
\

==== Inputs:
\
+ *Administrator Wallet UTxO*

  - Address: Administrator's wallet address

  - Value:

    - Minimum ADA

    - 1 Group NFT (222) asset (proves admin ownership)

+ *Treasury Validator UTxO*

  - Address: Treasury validator script address

  - Datum: `PenaltyState` as listed in @penalty-datum

  - Value:

    - Penalty funds (≥ `penalty_fee`)

    - 1 Membership Reference Token (locked since `ExitGroup`)

+ *Group Validator UTxO* (reference input)

    - Address: Group validator script address

    - Datum: group datum listed in @group-datum

    - Value:

      - 1 Group Reference NFT Asset
      - Minimum ADA
\
==== Mints
\
  + *Treasury Validator (Mint — TerminateGroup)*

    - Value:

      - -1 Membership Reference Token (burned)

\
==== Outputs:
\
+ *Administrator Wallet UTxO*

  - Address: Administrator's wallet address

  - Value:

    - Reclaimed penalty ADA

    - 1 Group NFT (222) asset (returned)

*Note:* No Treasury Validator UTxO is produced. The membership token is permanently burned. The `PenaltyState` UTxO is fully consumed — the penalty ADA flows to the admin as transaction change.


#pagebreak()

// Additional Features for Future Versions

// TODO:(V2) Member funds should be associated with their own staking credentials so they can earn staking rewards even while funds are locked in the contract.

// TODO:(V2) Implement multiplier for discounts and penalties. The longer members participate, the less penalty they pay for early exit.

// TODO:(V2) Groups should be deletable after a specified time period following inactivation.

// TODO:(V2) Democratic governance features: on-chain voting for group decisions, proposal systems, and member-driven parameter adjustments.

// TODO:(V2) Multi-signature requirements for administrative actions in larger groups.

