# Versioning — validators, blueprints, and fund safety

Why this exists: on-chain validators are immutable per script hash. Funds
locked at a hash stay reachable forever **on-chain**, but they become
practically unreachable the moment tooling stops being able to construct
transactions for that hash. The fund-loss mode across SDK versions is
operational, not cryptographic — a release that silently swaps validator
bytes strands every instance created on the old ones. These rules make any
hash change an explicit, reviewed event.

## The registry

`validator-registry.json` (root; the SDK bundles an identical copy at
`sdk/src/core/validators/validator-registry.json`) records, per family:

- `status` — `launch` (mainnet-approved) or `experimental`,
- a sha256 fingerprint of every validator's `compiledCode`,
- which onchain blueprint the SDK copy must match,
- known deployments,
- a `history` of every fingerprint change with the SDK version and reason.

`scripts/check-validator-registry.mjs` runs in CI (`sdk-verify`), in the
publish workflow, and in `ci-local.sh`. It fails when validator bytes,
the SDK blueprint copies, or the package version drift from the registry.
Declare a change with:

```
node scripts/update-validator-registry.mjs --note "why the hashes changed"
```

## Rules

1. **No silent hash changes.** A publish whose validator fingerprints differ
   from the previous release MUST carry a registry `history` entry and at
   least a minor version bump, and the release notes MUST name the changed
   validators.
2. **Version-never-replace.** A new hash is a NEW deployment. Existing
   instances keep operating on the hashes they were created with; the SDK
   version that operated them keeps doing so. Integrators pin the SDK
   version matching their deployment (`history` + npm dist-tags are the
   lookup).
3. **Migration is always explicit.** Moving funds from an old deployment to
   a new one is a designed, user-visible flow (exit/recreate or a dedicated
   migration path). Tooling never silently re-points an existing instance
   at new hashes.
4. **Launch surface.** Only `status: "launch"` families may be deployed to
   Mainnet — enforced in `deployScripts` via `isDeployAllowed()`. Flipping a
   family to `launch` requires: external audit of the frozen hashes,
   Preprod rehearsal on those exact hashes, and a registry history entry.
   Current surface: `rosca`, `escrow` = launch; `savings`, `governance` =
   experimental. Example deploy scripts (`savings-deploy.ts`,
   `escrow-v2-deploy.ts`) are Preprod-scoped tooling.
5. **Blueprint copies.** `sdk/src/*/plutus.json` must be byte-equivalent (per
   validator `compiledCode`) to their `onchain/*/plutus.json` sources — the
   check script enforces this; copying is part of the aiken build ritual.
6. **Toolchain bumps are hash changes.** Recompiling with a different Aiken
   version usually changes bytes → same rules apply (see
   DEPENDENCY_POLICY.md pinning).

## Release checklist (npm publish)

1. `./scripts/ci-local.sh` green.
2. Registry current (`check-validator-registry.mjs` passes; history entry if
   fingerprints changed).
3. Version bump in `sdk/package.json` + registry refresh (the check fails on
   mismatch by design).
4. CHANGELOG/release notes: state either "validator hashes unchanged" or the
   changed list with migration guidance.
5. GitHub Release from `main` → `publish.yml` re-verifies everything,
   generates an SBOM, and publishes with npm provenance.
