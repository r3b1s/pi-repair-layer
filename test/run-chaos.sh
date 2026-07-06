#!/usr/bin/env bash
# Deterministic live exercise of the repair layer through the real pi binary.
# Creates fixtures in a temp dir, runs pi in print mode with the scripted chaos
# provider, and asserts on the report the fake model produced.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$(mktemp -d -t pi-repair-chaos-XXXXXX)"
trap 'rm -rf "$DIR"' EXIT
cd "$DIR"

printf 'alpha anchor\n' > fixture-a.txt
printf 'edit me: alpha\n' > fixture-b.txt
printf 'edit me: gamma\n' > fixture-c.txt

export PI_TOOL_REPAIR_TELEMETRY="$DIR/telemetry.jsonl"
export PI_TOOL_REPAIR_LOG=1

OUT="$(pi -e "$REPO/test/chaos-provider.ts" --provider chaos --model repair-chaos -p go 2>"$DIR/stderr.log")" || {
  echo "pi exited non-zero"; cat "$DIR/stderr.log"; exit 1;
}

echo "$OUT"
echo
echo "=== stderr repair diagnostics ==="
grep '\[pi-repair\]' "$DIR/stderr.log" || true
echo
echo "=== telemetry ==="
wc -l < "$PI_TOOL_REPAIR_TELEMETRY" 2>/dev/null || echo "no telemetry file"

FAIL=0
check() {
  if echo "$OUT" | grep -q "$1"; then echo "PASS: $1"; else echo "FAIL: $1"; FAIL=1; fi
}

echo
echo "=== assertions ==="
# 9 repair notes: read alias(1) + read autolink(1) + bash root-string(1) +
# bash root-json(1) + edit flat(rename path + fold = 2) + edit nested(1) +
# grep(rename pattern + drop null = 2)
check "repair_notes=9"
check "errors=1"
check 'Renamed `file_path` to `path` for tool "read"'
check "Unwrapped a markdown auto-link"
check 'Wrapped your bare string as `{command: "..."}` for tool "bash"'
check "Parsed your JSON-stringified arguments"
check "Folded flat \`old_string\`/\`new_string\` fields"
check 'Renamed `old_string` to `oldText` for tool "edit"'
check 'Renamed `query` to `pattern` for tool "grep"'
check 'Dropped null `glob` from tool "grep"'
check 'Invalid input for tool "write"'

# The repairs must also have actually worked:
if grep -q 'edit me: omega' fixture-b.txt; then echo "PASS: flat edit applied"; else echo "FAIL: flat edit applied"; FAIL=1; fi
if grep -q 'edit me: theta' fixture-c.txt; then echo "PASS: nested edit applied"; else echo "FAIL: nested edit applied"; FAIL=1; fi
if [ ! -f chaos-out.txt ]; then echo "PASS: unrepairable write did not create a file"; else echo "FAIL: unrepairable write created chaos-out.txt"; FAIL=1; fi

echo
if [ "$FAIL" -eq 0 ]; then echo "CHAOS: ALL CHECKS PASSED"; else echo "CHAOS: FAILURES DETECTED"; exit 1; fi
