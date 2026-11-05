#!/bin/sh
# Runs the unit tests for js/links.js on macOS JavaScriptCore (no Node.js needed).
# Usage: ./tests/run.sh   (works from any folder; it moves to the repo root first)
# Exit status 0 = all tests passed, 1 = a test failed.

set -u

cd "$(dirname "$0")/.." || exit 2

if ! command -v osascript >/dev/null 2>&1; then
  echo "osascript was not found. These tests run on a Mac." >&2
  exit 2
fi

osascript -l JavaScript tests/links.test.js
exit $?
