# Dependency Policy

Rules for adding, updating, and auditing dependencies in this repository.
Advisory scanning finds *known* vulnerabilities; this policy is the defense
against the rest (malicious packages, name-squatting, hijacked maintainers).

## Adding a new dependency

Every NEW package (including dev dependencies and transitive additions pinned
via overrides) requires all of the following before it lands:

1. **Name verification** — the exact package name matches the project's
   official documentation. Watch for lookalikes and hallucinated names
   (`lucid-evolution` vs `@lucid-evolution/lucid`); typos and AI-suggested
   names are the primary infection path.
2. **Owner + provenance** — check the npm page: publisher account, linked
   repository, and that the repository actually contains the published code.
   Prefer packages with npm provenance attestations.
3. **Age + adoption** — a package younger than ~90 days or with trivial
   download counts needs an explicit reason to be trusted.
4. **Install scripts** — inspect `preinstall`/`postinstall` before first
   install (`npm view <pkg> scripts`). pnpm blocks build scripts by default;
   only allowlist a script after reading it.
5. **Lockfile review** — the `pnpm-lock.yaml` diff is part of the PR review.
   A one-line `package.json` change with a large lockfile diff is a finding.
6. **No unattended installs** — coding agents must not add dependencies
   autonomously. An agent may PROPOSE a dependency; a human runs the checks
   above and performs the install.

## Version pinning

- `lucid` is PINNED at 0.4.31 — 0.5.x breaks RedeemerBuilder index
  resolution. Do not bump without an emulator-suite proof.
- Aiken toolchain is pinned at v1.1.22 in CI, ci-local.sh, and READMEs;
  bumping it regenerates blueprints and is a validator-registry event
  (see VERSIONING.md).
- GitHub Actions are pinned to full commit SHAs, with the version in a
  trailing comment. Bumping an action = updating both.

## Advisory scanning

- CI job `deps-audit` runs `pnpm audit --prod --audit-level high` on every
  push/PR and fails on high or critical advisories.
- **Exception process:** if an advisory has no fix or the fix is breaking,
  record an entry here (advisory ID, affected package, why it is not
  exploitable in this codebase, review-by date) and add the narrowest
  possible ignore. Exceptions expire — re-review by the recorded date.

### Active exceptions

None.

## Publishing

`publish.yml` publishes only from CI (OIDC + npm provenance), never from a
developer machine. The tarball is bounded by `files: ["dist"]` in
`sdk/package.json`.
