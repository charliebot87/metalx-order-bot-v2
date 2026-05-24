#!/usr/bin/env bash
set -euo pipefail

# Read-only chain smoke test for Metal X Order Bot.
# This intentionally uses the Proton CLI only. It does not accept private keys,
# does not sign transactions, and does not mutate chain state.

if ! command -v proton >/dev/null 2>&1; then
  echo "proton CLI not found. Install @proton/cli before running this smoke test." >&2
  exit 1
fi

echo "== Proton network =="
proton network || proton chain || true

echo
echo "== Current Proton endpoint =="
proton endpoint || true

echo
echo "== Read dex markets table =="
proton table dex markets dex -c 5

echo
echo "ok: read-only Proton CLI smoke test completed"
