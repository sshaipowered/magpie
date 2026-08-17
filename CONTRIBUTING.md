# Contributing

PRs welcome. Issues welcome. This file exists so you do not have to guess what CI
will fail you on.

## Get it running

```bash
npm install
npx tsc -b
cargo build --manifest-path rust/Cargo.toml -p magpie-relay   # ← do not skip
npx vitest run                                                 # 156 tests
cargo test --manifest-path rust/Cargo.toml                     # 74 tests
```

**The `cargo build` line is not optional.** `conformance/13-rust-relay-interop` spawns
the actual Rust relay binary and drives it with the TypeScript client. Skip the build
and you get a confusing spawn failure that looks nothing like the real cause.

Everything runs offline against a locally spawned relay. Nothing in the test suite
touches the hosted relay or the network.

## The one rule that is not obvious

**Magpie has two implementations of the same wire protocol** — TypeScript
(`packages/`) and Rust (`rust/crates/`) — and they are verified byte-compatible on
the wire and on the crypto. A change to the frame format, the handshake, the key
derivation, or the pairing-code encoding must land in **both**, or the conformance
suite will (correctly) reject it.

If that is more than you want to take on, say so in the PR. Splitting the Rust half
into a follow-up is fine. Silently changing one side is not.

## Protocol and crypto changes

Read [`docs/PROTOCOL.md`](docs/PROTOCOL.md) first — the threat model is explicit
about what is guaranteed and what is deliberately not. If your change moves one of
those lines, update the doc in the same PR. A protocol change with an unchanged
threat model is usually a sign that one of them is wrong.

Found a vulnerability rather than a bug? Do not open a PR.
See [`SECURITY.md`](SECURITY.md).

## PRs

- Branch off `main`. CI (`ts` and `rust`) must be green before merge.
- Conventional commits — `fix(mcp):`, `feat(relay):`, `docs:`. Match `git log`.
- Explain **why** in the PR body, not what. The diff already says what.
- New behavior needs a test. A bug fix needs a test that fails without the fix.
- Comments should say why the code is the way it is, especially where it looks
  wrong but is not. Read the surrounding code and match it.

## Things not worth your time

- Formatting-only PRs. There is no enforced formatter yet; churn without a linter
  to back it just creates conflicts.
- Adding dependencies. The install story is "one static binary, no runtime." A new
  dependency needs to earn its place in the PR description.
- `packages/web` and `site/` cosmetics, unless something is actually broken.
