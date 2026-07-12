#!/usr/bin/env bash
# Local mirror of .github/workflows/ci.yml — run BEFORE proposing a commit,
# a PR, or a staging merge. Every step here is the exact command CI runs
# (same order), plus two guards for failure classes CI cannot see.
#
#   ./scripts/ci-local.sh          # full gate (~4 min)
#   ./scripts/ci-local.sh fast     # skip the emulator test suite
#
# Requirements: nvm node 24, pnpm >= 10 (settings live in pnpm-workspace.yaml),
# aiken v1.1.22, and optionally typst. Aiken needs a TTY — handled via script(1).
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAST="${1:-}"
FAILED=()

step() { printf '\n\033[1m── %s\033[0m\n' "$1"; }
run() { # run <label> <dir> <cmd...>
  local label="$1" dir="$2"
  shift 2
  step "$label"
  if (cd "$ROOT/$dir" && "$@"); then
    echo "✓ $label"
  else
    echo "✗ $label"
    FAILED+=("$label")
  fi
}
run_tty() { # aiken needs a TTY for its diagnostics
  local label="$1" dir="$2" cmd="$3"
  step "$label"
  if (cd "$ROOT/$dir" && script -qec "$cmd" /dev/null >/tmp/ci-local-aiken.log 2>&1); then
    tail -2 /tmp/ci-local-aiken.log
    echo "✓ $label"
  else
    tail -15 /tmp/ci-local-aiken.log
    echo "✗ $label"
    FAILED+=("$label")
  fi
}

# --- toolchain (mirrors: setup-node 24, setup pnpm 11, setup-aiken 1.1.22) ---
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  source "$HOME/.nvm/nvm.sh" && nvm use 24 >/dev/null || true
fi
node -v | grep -q '^v24' || { echo "node 24 required (nvm use 24)"; exit 1; }
aiken --version 2>/dev/null | grep -q '1\.1\.22' ||
  echo "WARN: aiken v1.1.22 expected, found: $(aiken --version 2>/dev/null || echo none)"

# --- Verify Aiken (rosca, escrow) — fmt --check, build, check -------------
for project in rosca escrow savings governance; do
  run_tty "aiken fmt --check ($project)" "onchain/$project" "aiken fmt --check"
  run_tty "aiken build ($project)" "onchain/$project" "aiken build"
  run_tty "aiken check ($project)" "onchain/$project" "aiken check"
done

# --- Guard: blueprint drift (CI builds but never diffs; a stale committed
# plutus.json ships wrong hashes) -------------------------------------------
step "blueprint drift"
if git -C "$ROOT" diff --quiet -- onchain/*/plutus.json sdk/src/*/plutus.json 2>/dev/null; then
  echo "✓ committed blueprints match aiken build output"
else
  echo "✗ aiken build changed a plutus.json — commit the regenerated blueprint"
  git -C "$ROOT" diff --stat -- onchain/*/plutus.json sdk/src/*/plutus.json
  FAILED+=("blueprint drift")
fi

# --- Verify SDK — the exact package scripts CI runs -------------------------
run "pnpm format:check" sdk pnpm format:check
run "pnpm lint" sdk pnpm lint
run "pnpm tsc --noEmit" sdk pnpm tsc --noEmit
run "pnpm run build" sdk pnpm run build
if [ "$FAST" != "fast" ]; then
  run "pnpm test (NETWORK=Custom)" sdk env NETWORK=Custom pnpm test
else
  echo "(fast) skipping emulator test suite"
fi

# --- Verify Design Specs -----------------------------------------------------
if command -v typst >/dev/null; then
  run "typst compile dcu-kit.typ" docs/design-specs typst compile dcu-kit.typ
  run "typst compile savings-module.typ" docs/design-specs typst compile savings-module.typ
  run "typst compile governance-module.typ" docs/design-specs typst compile governance-module.typ
else
  echo "(skip) typst not installed — CI will still compile docs/design-specs/*.typ"
fi

# --- Guard: what you verified is what you'd commit ---------------------------
step "working tree"
UNSTAGED=$(git -C "$ROOT" status --short | grep -v '^??' || true)
if [ -n "$UNSTAGED" ]; then
  echo "NOTE: modified tracked files — confirm each is staged or intentionally left out:"
  echo "$UNSTAGED"
fi

step "result"
if [ ${#FAILED[@]} -eq 0 ]; then
  echo "✓ CI-parity gate green. Protocol changes (onchain/**) additionally need a Preprod live sweep before release."
else
  printf '✗ gate FAILED:\n'
  printf '  - %s\n' "${FAILED[@]}"
  exit 1
fi
