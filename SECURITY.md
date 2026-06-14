# Security Policy

DCU Toolkit is smart-contract software that custodies user funds. On-chain validators are **immutable
once deployed**, so vulnerabilities found *before* a mainnet deployment are the highest-value reports —
they can still be fixed without migrating funds.

## Supported versions

This project is pre-1.0 and under active development. Only the latest release on the default branch is
supported. Deployed on-chain validators are versioned by their script hash; report against the hash you
are testing where possible.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately via GitHub's **["Report a vulnerability"](https://github.com/tx-meta/dcu-kit/security/advisories/new)**
(Security → Advisories) on this repository.

Include where possible:
- the affected component (validator + script hash, or SDK version),
- a description of the impact (e.g. fund loss, theft, lock-up, griefing),
- steps to reproduce or a proof-of-concept (an Aiken test or SDK script is ideal).

## Scope

In scope: the Aiken validators (`onchain/`), the offchain SDK (`sdk/src/`), and any fund-safety or
authorization flaw. Out of scope: issues in example scripts' test wallets/keys, and the documented,
deliberately-deferred scale ceiling (see the roadmap).

## Disclosure

We aim to acknowledge a report within a few business days and to coordinate a fix and disclosure
timeline with the reporter before any public details are shared.
