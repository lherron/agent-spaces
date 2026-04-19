#!/usr/bin/env bash
set -euo pipefail

assert_output() {
  local name="$1"
  local expected="$2"
  local actual

  actual="$(./scenario-test/greet.sh "$name")"

  if [[ "$actual" != "$expected" ]]; then
    echo "FAIL: greet.sh output for '$name' was '$actual', expected '$expected'" >&2
    exit 1
  fi

  echo "PASS: $name"
}

assert_output "World" "Hello, World!"
assert_output "Clod" "Hello, Clod!"

echo "All greet tests passed."
