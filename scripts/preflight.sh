#!/bin/sh
# What the release workflow does, run locally BEFORE a tag is pushed.
#
# A warm working tree lies: dist/ and *.tsbuildinfo left over from earlier
# builds let `tsc -b` resolve packages that a clean checkout cannot. v0.4.0's
# first release failed on all five platforms for exactly that reason while
# every local check was green. Start from nothing, like CI does.
set -eu
cd "$(dirname "$0")/.."
npx tsc -b --clean
rm -rf packages/*/dist conformance/dist
npx tsc -b
npx vitest run --reporter=dot
cargo test --manifest-path rust/Cargo.toml --quiet
bun build --compile packages/mcp/src/bin.ts --outfile /tmp/magpie-mcp-preflight >/dev/null
rm -f /tmp/magpie-mcp-preflight
echo "preflight: clean build, tests, and bun compile all pass"
