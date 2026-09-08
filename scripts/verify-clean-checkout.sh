#!/usr/bin/env bash
# verify-clean-checkout.sh — CAN-104 release hygiene gate.
#
# Clones the repo's committed HEAD into a temp dir, installs from the lockfile,
# and runs the fast gates (typecheck + full vitest). Exits non-zero on any
# failure so CI or a release step can call it. Not part of the default unit
# suite (it needs a network-free local clone only — file:// — plus npm).
#
# Usage:  scripts/verify-clean-checkout.sh
#         VERIFY_GATES="typecheck" scripts/verify-clean-checkout.sh  # subset
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/canon-verify.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

echo "[verify] cloning committed HEAD (file://${REPO_ROOT}) into ${TMP}/repo"
git clone --quiet --depth 1 "file://${REPO_ROOT}" "${TMP}/repo"

cd "${TMP}/repo"

echo "[verify] npm ci (cache: ${TMP}/.npm-cache)"
npm ci --cache "${TMP}/.npm-cache" --no-audit --no-fund

run_gate() {
  local name="$1"
  shift
  echo "[verify] gate: ${name}"
  "$@"
}

GATES="${VERIFY_GATES:-typecheck test}"
if [[ "$GATES" == *typecheck* ]]; then run_gate typecheck npx tsc --noEmit; fi
if [[ "$GATES" == *test* ]]; then run_gate test npx vitest run; fi

echo "[verify] OK — clean checkout: install + ${GATES// / + } pass."
