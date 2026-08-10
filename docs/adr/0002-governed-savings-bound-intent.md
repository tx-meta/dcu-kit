# ADR-0002: Parameter-bound governed savings actions

- Status: Accepted
- Date: 2026-08-09
- Scope: Experimental savings and governance validator families

## Context

The Governance Gate historically authorized a target operation by redeemer
constructor (`Generic` with an empty payload), exact redeemer CBOR (`Generic`
with a payload), or one of the typed governance actions. Savings economic
parameters do not generally live in its redeemer: loan terms and fund changes
live in output datums, while payout destinations live in transaction outputs.
Constructor-only authorization therefore could not prevent a proposer from
substituting different parameters when executing a passed decision.

## Decision

Governance adds an additive `BoundIntent { tag, intent }` action. Existing
typed actions and both `Generic` modes retain their constructor indices and
semantics. `BoundIntent` is constructor 6 of `GovAction`.

For `BoundIntent`, the Gate requires:

1. `intent` is exactly 32 bytes;
2. the target spend redeemer constructor equals `tag`; and
3. field index 0 of that redeemer is a byte string equal to `intent`.

Field index 0 is a protocol-level ABI requirement for every governed savings
redeemer. It avoids teaching the generic Gate each target family's schema.

The following savings constructors carry `intent_hash` at field 0 and validate
it against the actual economic outcome:

- `SocialPayout`: BLAKE2b-256 of CBOR `(destination address, amount)`;
- `UpdateFund`: BLAKE2b-256 of canonical CBOR containing every amendable
  charter field (title, quorum, deposit band, loan policy and cycle end), but
  no live balance or counter;
- `CloseCycle`: BLAKE2b-256 of the empty payload. The action tag and target
  Fund NFT are already bound by the Gate, and the snapshot is deterministically
  derived from authenticated live state;
- `DisburseLoan`: BLAKE2b-256 of CBOR of the complete loan `SavingsDatum`;
- `WriteOffLoan`: BLAKE2b-256 of the raw loan state-token name;
- `CloseFund`: BLAKE2b-256 of CBOR of the complete payout address; the validator
  additionally requires that one output receive the entire residual value.

The constructor tag is committed separately by the Gate, so the canonical
payload does not repeat a domain tag. The SDK computes these hashes from the
same datums and addresses it emits, and defaults governed savings integrations
to `govActionForIntent`. `govActionForOperation` remains available and is
explicitly constructor-only.

## Security and efficiency

The savings validator recomputes each commitment; it never trusts the SDK's
declared hash. A decision for one parameter set therefore cannot authorize a
different borrower, amount, loan term, fund charter, write-off, or payout
destination. Ordinary deposits, withdrawals and repayments cannot stale an
`UpdateFund` decision; `CloseCycle` has no quorum-selectable snapshot parameter
to substitute. Six shared golden vectors lock Aiken and TypeScript encoding,
and savings-layer negative tests reject a wrong hash for all six actions. A
cross-module emulator test submits a one-field
`UpdateFund` substitution and observes on-chain rejection before executing the
exact ratified parameters successfully.

To preserve deployability, the savings dispatcher centralizes its identical
own-input and exact-family-size guard. The compiled script is 16,105 bytes,
below the repository's conservative 16,128-byte reference-script ceiling.
Reference-script deployment uses an enterprise parking address to keep the
deployment transaction itself within the ledger transaction-size limit.

## Compatibility and deployment

This changes the savings validator hash and every governance validator that
depends on the extended `GovAction` type. Existing Preprod savings positions
and governance instances remain pinned to their old scripts; they are not
silently migrated. The two families remain experimental and require a fresh,
coupled deployment and lifecycle rehearsal before their new hashes are used.

Legacy `Generic`, typed governance actions, and non-governed savings operations
are preserved. The redeemer ABI changes only for the six quorum-controlled
savings constructors listed above.
