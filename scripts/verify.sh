#!/usr/bin/env bash
#
# The full gate, in one place, with failures that cannot be swallowed.
#
# This exists because of a mistake worth not repeating: a verification command
# was written as `npx vitest run … | grep …`, and a pipeline reports the exit
# status of its *last* command. Grep succeeded, vitest had failed, and the
# `&&` chain that guarded the push never saw it. A commit went out red.
#
# So: `set -euo pipefail` at the top, every command run for its exit status,
# and no filtering in the path between a test and its verdict. Anything that
# needs to read the output can read the output; nothing gets to decide the
# verdict except the command itself.
#
#   ./scripts/verify.sh           everything except the real-browser suite
#   ./scripts/verify.sh --e2e     everything, including real Chromium
#
set -euo pipefail

run() {
  printf '\n\033[1m── %s\033[0m\n' "$1"
  shift
  "$@"
}

run 'format'            npx prettier --check .
run 'lint'              npx eslint .
run 'typecheck'         npx tsc --noEmit
run 'unit + integration + security' npx vitest run
run 'build'             npm run build
run 'package'           node scripts/validate-package.mjs
run 'parity'            node scripts/check-parity.mjs

if [ "${1:-}" = '--e2e' ]; then
  run 'real Chromium'   npx playwright test
fi

printf '\n\033[1;32mAll gates passed.\033[0m\n'
