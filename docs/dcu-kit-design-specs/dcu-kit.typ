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
    #v(-0.5cm)
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
#show heading: set text(rgb("#c41112"))

= Overview
\

The DCU-Toolkit (Decentralized Credit Unions Toolkit) is a comprehensive smart contract infrastructure developed using Aiken for the Cardano blockchain. It is designed to facilitate automated cooperative finance operations including group savings, rotating fund distribution, democratic governance, and treasury management for traditional savings groups such as Chamas, SACCOs, Tontines, and similar cooperative finance models.

This toolkit empowers members to seamlessly create accounts, form cooperative groups, contribute funds, participate in democratic decision-making, and manage shared treasuries directly from their wallets. It ensures secure and efficient transactions by automating group governance, fund rotation, and treasury operations within a decentralized framework.

#pagebreak()
\
= Architecture

\
#figure(
  image("./images/dcu-kit-architecture.png", width: 100%),
  caption: [DCU-Toolkit Architecture],
)
\

There are three validators in this cooperative finance system.

+ *Account Validator* 
  
  A multi-validator responsible for creating member accounts by minting CIP-68 compliant Account NFT Assets and sending the user NFT to the member's wallet while sending the reference NFT to the spending endpoint. It enables members to update their account metadata and delete their accounts by burning the Account NFTs.

+ *Group Validator*
  
  A multi-validator responsible for creating cooperative groups by minting CIP-68 compliant Group NFT Assets. It manages group configuration including contribution fees, joining fees, penalties, subscription intervals, and democratic governance rules. The validator enables group administrators to update group metadata and deactivate groups when necessary.

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

  - *TokenName:* Defined in Account Validator using CIP-68 standards with transaction ID, output index, and appropriate prefix (prefix_100 for reference NFT, prefix_222 for user NFT).

+ *Group NFT*

  Can only be minted when creating a cooperative group and held by the group administrator. This NFT represents ownership and administrative control over the group configuration and operations.

  - *TokenName:* Defined in Group Validator using CIP-68 standards with transaction ID, output index, and appropriate prefix (prefix_100 for reference NFT, prefix_222 for user NFT).

+ *Treasury NFT* 

  Can only be minted when a member joins a group by depositing funds to the Treasury Validator and burned when a member exits the system or when penalties are processed.

  - *TokenName:* Defined in Treasury Validator parameters with a static identifier (e.g., "treasury-membership").

#pagebreak()

\
== Smart Contracts
\
=== Treasury Multi-validator
\
The Treasury Validator is the core contract responsible for managing member contributions, validating group memberships, and ensuring proper distribution of funds through rotating schedules and linear vesting. It facilitates member joins, exits, fund withdrawals, and penalty processing, allowing both members and administrators to interact securely within the cooperative finance framework.

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
    member_input_index: Int,
    treasury_output_index: Int,
  }
`````````````*

- *```rs 
  TerminateGroup
````````````*

\
===== Validation
\
+ *JoinGroup* 
  
  The redeemer allows a member to join a cooperative group by minting one unique Treasury Token representing their membership.

  - Validate that the member's Account NFT is present in the transaction inputs.
  
  - A reference input must provide the Group datum from the Group Validator.
  
  - The treasury output must be sent to the Treasury Script's address and contain a Treasury datum that is consistent with the Group datum.
  
  - Exactly one Treasury Token (with token name "treasury-membership") is minted.
  
  - Validate that sufficient contribution fees and joining fees are locked in the Treasury UTxO according to the Group datum specifications.
  
  - Ensure that the User NFT doesn't go to the Script
  - Ensure Treasury token goes back to the script
  \

+ *TerminateGroup*
  
  - The redeemer must burn exactly one Treasury Token (i.e. a single token with the token name "treasury-membership" is burned).
  
  - Validate that the Group reference input provides valid Group datum.

\

==== Spend Purpose
\
==== Datum
\
This is a Sum type datum where one represents the treasury datum and the other represents a penalty datum.

\
===== Treasury datum <treasury-datum>
\
- *`group_reference_tokenname`: ```rs AssetName```* – Links to the Group Validator.

- *`member_reference_tokenname`: ```rs AssetName```* – Identifies the member's Account NFT.

- *`membership_start`: ```rs Int```*  – The timestamp when the member joined the group.

- *`membership_end`: ```rs Int```*  – The current expiry time of the membership.

- *`total_installments`:* List of Installment – Each installment specifies when and how much can be withdrawn based on the rotation schedule.

  - *`Installment`*:
    - *`claimable_at` : ```rs Int```*  – Time after which the installment can be claimed.
    - *`claimable_amount` : ```rs Int```*  – The amount available for withdrawal at that time.

- *`group_shares`: ```rs Int```* – The number of shares allocated to this member within the group.

===== Penalty datum <penalty-datum>

\
- *`group_reference_tokenname`: ```rs AssetName```* – Links to the Group Validator.

- *`member_reference_tokenname`: ```rs AssetName```* – Identifies the member's Account NFT.

\
==== Redeemer

\
- *```rust 
  AdminWithdraw {
    group_ref_input_index: Int,
    admin_input_index: Int,
    treasury_input_index: Int,
    treasury_output_index: Int,
    installments_withdrawn: Int,
  }
 ```*

- *```rust
  ExitGroup {
    group_ref_input_index: Int,
    member_input_index: Int,
    treasury_input_index: Int,
    penalty_output_index: Int,
  }
  ```*

- *```rust
  MemberWithdraw {
    group_ref_input_index: Int,
    member_input_index: Int,
    treasury_input_index: Int,
    treasury_output_index: Int,
    installments_withdrawn: Int,
  } 
```*

\
==== Validation

\
+ *AdminWithdraw* 
  
  This redeemer allows the group administrator to withdraw accumulated contributions according to the rotation schedule and vesting rules.

  - The Treasury UTxO being spent must be identified and contain a valid Treasury datum.

  - A Group datum must be supplied as a reference input (at *`group_ref_input_index`*), ensuring that the Group NFT is present.

  - The administrator input (at *`admin_input_index`*) must prove ownership of the Group NFT.

  - The output UTxO (at treasury_output_index) must remain at the Treasury Script's address and include an updated Treasury datum.

  - Implement linear vesting for fund release by:
    - Dropping the first *`installments_withdrawn`* elements from the original installments list to form the new Treasury datum.
    
    - Verifying that the difference in value between input and output does not exceed the sum of the *`claimable_amount`* of installments that are past their *`claimable_at`* time.

  \
+ *ExitGroup* 

  The redeemer allows a member to exit a cooperative group, unlocking remaining contributions to their wallet address.

  - The member must provide an input (at *`member_input_index`*) containing the appropriate Account NFT.

  - The Treasury UTxO (from treasury_input_index) must have a valid Treasury datum.
  
  - A Group datum is provided as a reference input to verify group conditions.

  - The decision branch is based on the membership timing:

    - *Without Penalty:* If the current time is past the membership period or if the Group is inactive, the Treasury Token is burned.

    - *With Penalty:* If exiting early (active group), the transaction must produce an output (at penalty_output_index) carrying a Penalty datum. This output must include at least the minimum penalty fee as defined by the Group datum.

  \
+ *MemberWithdraw* 
  
  The redeemer allows a member to withdraw their allocated funds when it's their turn in the rotation schedule.

  - The member's input (at member_input_index) must contain the correct Account NFT.
    
  - The Treasury UTxO (from treasury_input_index) must have a valid Treasury datum.

  - The Group datum (from the reference input at group_ref_input_index) must be validated for withdrawal eligibility.

  - Implement linear vesting by verifying withdrawal amount against vesting schedule and member's share allocation.
  
  - If group is inactive, allow full withdrawal and burn the Treasury Token.

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

    - *contribution_fee*: Must be greater than 0.
    - *joining_fee*: Must be ≥ 0.
    - *penalty_fee*: Must be ≥ 0.
    - *interval_length*: Must be greater than 0.
    - *num_intervals*: Must be > 0 and within a reasonable bound (e.g. ≤ 100).
    - *is_active*: Must be set to true. 

\

==== Spend Purpose
\
===== Datum <group-datum>
\

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

- *`share_holding: Bool`* A Bool indicating if members can hold multiple shares.

- *`is_active: Bool`* A Bool indicating whether the group is currently active.
  
*Note:* Contribution fees can be based on length of period the member commits to, e.g. If they pay for one cycle, the fees may differ from paying for multiple cycles. Group administrators can configure flexible pricing models.

\

===== Redeemer
\
-  *```rust
  UpdateGroup {
    group_ref_token_name: AssetName,
    admin_input_index: Int,
    group_input_index: Int,
    group_output_index: Int,
  }
````````*
  

- *```rust
  RemoveGroup {
    group_ref_token_name: AssetName,
    admin_input_index: Int,
    group_input_index: Int,
    group_output_index: Int,
  }
```````*
\
====== Validation
\
+ *UpdateGroup*

  This redeemer endpoint allows the administrator to update the group metadata attached to a Group UTxO.

  - A Group UTxO containing the Group NFT must be provided (at group_input_index) with its output reference matching the provided reference.

  - An administrator input (at admin_input_index) must be present to prove ownership of the Group NFT (derived from group_ref_token_name).
  
  - The output at group_output_index must be sent to the Group Script's address and must include an updated Group datum.
  
  - Validate that the metadata of the Reference NFT token is updated within acceptable bounds.
  
  - Metadata changes must be within acceptable bounds (for example, fee adjustments limited to within +/-10%).
  
  - The reference token must be spent back to its own address, ensuring that the Group NFT remains intact.

  \
+ *RemoveGroup*

  This redeemer endpoint allows an administrator to deactivate a group from the cooperative finance system.

  - The transaction must include two script inputs:

    - One input containing the Group UTxO with the Group NFT (at *`group_input_index`*).

    - An administrator input (at *`admin_input_index`*) proving ownership of the Group NFT.

  - Two script outputs must be produced, with one of them (at *`group_output_index`*) sent to the Group Script's address.
  
  - The output Group datum must indicate that the group is inactivated by setting is_active to false.
  
  - The Group NFT must still be present in the output to maintain correct state tracking.

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
// #figure(
//   image("./images/create-account-image.png", width: 100%),
//   caption: [Create Account UTxO diagram]
// )

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
// #figure(
//   image("./images/update-account-metadata-image.png", width: 100%),
//   caption: [Update Account MetaData UTxO diagram]
// )
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

== Group Validator
\
=== Mint :: CreateGroup
\
This transaction creates a new cooperative group by minting Group NFTs. This transaction is performed by a member who wishes to become a group administrator.

\
// #figure(
//   image("./images/create-group-image.png", width: 100%),
//   caption: [Create Group UTxO diagram]
// )
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
      - *`share_holding: Bool`* A Bool indicating if members can hold multiple shares.
      - *`is_active: Bool`* A Bool indicating whether the group is currently active.

    - Value:

      - 1 Group Reference NFT Asset
#pagebreak()

=== Spend :: UpdateGroup
\

This transaction updates the group metadata attached to the Group UTxO at the script address. It enables administrators to adjust group parameters such as fees, intervals, and governance rules.

\
// #figure(
//   image("./images/update-group-metadata-image.png", width: 100%),
//   caption: [Update Group Metadata UTxO diagram],
// )
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

== Treasury Validator
\
=== Mint :: JoinGroup
\
This transaction occurs when a member joins a cooperative group by locking contribution funds in the Treasury Validator script address.

\
// #figure(
//   image("./images/join-group-image.png", width: 100%),
//   caption: [Join Group UTxO diagram],
// )
\

==== Inputs
\
  + *Member Wallet UTxO*

    - Address: Member's wallet address

    - Value: 

      - 100 ADA: Contribution amount to lock in the Treasury Contract.

      - 1 Account NFT Asset

  + *Group Reference UTxO*

    - Address: Group Contract Address

    - Datum:

      - group_datum: listed in @group-datum

    - Value: 

      - 1 Group Reference NFT Asset
      - Minimum Ada
\
==== Mints
\
  + *Treasury Validator*
    - Redeemer: JoinGroup

    - Value: 

      - +1 Treasury NFT Asset
      
\
==== Outputs
\
  + *Member Wallet UTxO*

    - Address: Member's wallet address

    - Value:

      - Change ADA

      - 1 Account NFT Asset

  + *Treasury Validator UTxO*

    - Address: Treasury validator script address

    - Datum: 
      - treasury datum as listed in @treasury-datum

    - Value:
    
      - 100 ADA: Contribution funds to be managed by the group

      - 1 Treasury NFT Asset
#pagebreak()

=== Spend :: MemberWithdraw
\
This transaction allows a member to withdraw their allocated funds when it's their turn in the rotation schedule.

\
// #figure(
//   image("./images/member-withdraw-image.png", width: 100%),
//   caption: [Member Withdraw UTxO diagram],
// )
\

==== Inputs
\
  + *Member Wallet UTxO*

    - Address: Member's wallet address

    - Value: 

      - Minimum ADA

      - 1 Account NFT Asset

  + *Treasury Validator UTxO*

    - Address: Treasury validator script address

    - Datum:
      - datum listed in @treasury-datum

    - Value:

      - Locked contribution funds

      - 1 Treasury NFT Asset

  + *Group Reference UTxO*

    - Address: Group Contract Address

    - Datum:

      - group_datum: listed in @group-datum

    - Value: 

      - 1 Group Reference NFT Asset
      - Minimum Ada
\
==== Outputs
\
  + *Member Wallet UTxO*

    - Address: Member's wallet address

    - Value:
    
      - Minimum ADA
      
      - Withdrawn funds according to vesting schedule
      
      - 1 Account NFT Asset

  + *Treasury Validator UTxO*

    - Address: Treasury validator script address

    - Datum:

      - datum listed in @treasury-datum with updated installments

    - Value:
    
      - Remaining funds after withdrawal

      - 1 Treasury NFT Asset

#pagebreak()

=== Spend :: ExitGroup
\
This transaction allows a member to exit a cooperative group by spending a Treasury UTxO, unlocking the remaining contribution to their wallet address and potentially creating a Penalty UTxO.

\
// #figure(
//   image("./images/exit-group-image.png", width: 100%),
//   caption: [Exit Group UTxO diagram],
// )
\

==== Inputs
\
  + *Member Wallet UTxO*

    - Address: Member's wallet address

    - Value: 

      - Minimum ADA 

      - 1 Account NFT Asset

  + *Treasury Validator UTxO*

    - Address: Treasury validator script address

    - Datum:

      - current_datum: Current treasury metadata listed in @treasury-datum

    - Value:

      - Remaining contribution funds

      - Treasury NFT Asset

  + *Group Reference UTxO*

    - Address: Group Contract Address

    - Datum:

      - group_datum: listed in @group-datum

    - Value: 

      - 1 Group Reference NFT Asset
      - Minimum Ada
\
==== Outputs
\
  + *Member Wallet UTxO*

    - Address: Member's wallet address

    - Value:

      - Minimum ADA

      - Remaining contribution funds (minus any penalties)

      - 1 Account NFT Asset

  + *Treasury Validator UTxO* (if exiting early with penalty)

    - Address: Treasury validator script address

    - Datum:

      - penalty_datum: Metadata indicating the penalty for early exit as listed in @penalty-datum

    - Value:
    
      - Penalty ADA

      - Treasury NFT Asset

*Note:* If the group is inactive or membership period has ended, the Treasury NFT is burned instead of creating a Penalty UTxO.

#pagebreak()

=== Spend :: AdminWithdraw
\
This transaction allows a group administrator to withdraw accumulated contributions from the Treasury UTxO according to the rotation schedule and vesting rules.

\
// #figure(
//   image("./images/admin-withdraw-image.png", width: 100%),
//   caption: [Admin Withdraw UTxO diagram],
// )
\

==== Inputs:
\
+ *Administrator Wallet UTxO*

  - Address: Administrator's wallet address
  
  - Value:

    - Minimum ADA

    - 1 Group NFT Asset

+ *Treasury Validator UTxO*

  - Address: Treasury validator script address

  - Datum:

    - treasury_datum: listed in @treasury-datum

  - Value:

    - Locked contribution funds

    - 1 Treasury NFT Asset

+ *Group Reference UTxO*

    - Address: Group Contract Address

    - Datum:

      - group_datum: listed in @group-datum

    - Value: 

      - 1 Group Reference NFT Asset
      - Minimum Ada
\
==== Outputs:
\
+ *Administrator Wallet UTxO*

  - Address: Administrator's wallet address

  - Value:

    - Minimum ADA

    - Withdrawn contribution funds for the installment
    
    - 1 Group NFT Asset

+ *Treasury Validator UTxO*

  - Address: Treasury validator script address

  - Datum:

    - updated_datum: Metadata reflecting the withdrawal
    
  - Value:

    - Remaining ADA after withdrawal

    - 1 Treasury NFT Asset
#pagebreak()


=== Spend :: Penalty Withdraw
\
This transaction allows a group administrator with a Group NFT to unlock penalty funds from the Penalty UTxO, burning the Treasury NFT attached to the UTxO.

\
// #figure(
//   image("./images/penalty-withdraw-image.png", width: 100%),
//   caption: [Penalty Withdraw UTxO diagram],
// )
\

==== Inputs:
\
+ *Administrator Wallet UTxO*

  - Address: Administrator's wallet address

  - Value:

    - Minimum ADA

    - Group NFT Asset

+ *Treasury Validator UTxO*

  - Address: Treasury validator script address

  - Penalty Datum: as listed in @penalty-datum

  - Value:

    - Penalty funds

    - Treasury NFT Asset

+ *Group Reference UTxO*

    - Address: Group Contract Address

    - Datum:

      - group_datum: listed in @group-datum

    - Value: 

      - 1 Group Reference NFT Asset
      - Minimum Ada
\
==== Mints
\
  + *Treasury Validator*
    - Redeemer: TerminateGroup

    - Value: 

      - -1 Treasury NFT Asset

\
==== Outputs:
\
+ *Administrator Wallet UTxO*

  - Address: Administrator's wallet address

  - Value:

    - Minimum ADA

    - Withdrawn penalty funds
    
    - Group NFT Asset

+ *Treasury Validator UTxO*

  - Address: Treasury validator script address

  - Value:

    - Remaining ADA after withdrawal (if any)


// Additional Features for Future Versions

// TODO:(V2) Member funds should be associated with their own staking credentials so they can earn staking rewards even while funds are locked in the contract.

// TODO:(V2) Implement multiplier for discounts and penalties. The longer members participate, the less penalty they pay for early exit.

// TODO:(V2) Groups should be deletable after a specified time period following inactivation.

// TODO:(V2) Democratic governance features: on-chain voting for group decisions, proposal systems, and member-driven parameter adjustments.

// TODO:(V2) Multi-signature requirements for administrative actions in larger groups.

