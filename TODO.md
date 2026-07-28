# Magpie — TODO / Roadmap

Status snapshot (2026-06-25): core transport works and is validated live
cross-machine (iMac ↔ MacBook over LAN/Tailscale). 86 tests green. What remains
is mode ② (real agent autonomy) + UX + hardening + reach.

## Scope decisions (2026-06-25, situation-driven)
- **THE core (S2):** two agents talk DIRECTLY, multi-turn, until **mutual
  agreement** — then report to both humans. One-shot Q&A is NOT the product
  (you wouldn't need this for that). Origin: A plans / B implements; A thinks it's
  wrong → repeated human-relayed back-and-forth until it's right → that repetition
  is the pain. Stop condition = "nothing left to resolve / agreed", with the turn
  cap only as a safety backstop. **This is the main thing still missing** (we have
  the answerer side; we lack the autonomous driver that evaluates the peer's reply
  against its own spec, pushes back, and declares agreement).
- Both sides are LIVE/present (see S3 below), so this runs over live sessions (MCP).
- **S5 (app users) is IN scope** — needs a remote HTTP MCP server (BYO-key).
- **S3 (answer-while-away from saved files): DEFERRED by decision.** Felt wrong —
  connection should require the other person to actually be working/present. So
  drop the "files-if-off" fallback for now (the live-or-files switch we built stays,
  but the file fallback is optional). Revisit later if a real need appears.
- **S6 (non-dev web watch/approve): OUT for now** — target is developers; app
  users (S5) cover participation.
- S4 (Codex/Gemini) later; S8 hard sandbox later; S9 works (harden only on public
  exposure).

## ✅ Done
- Protocol/relay/client/MCP/CLI/auto-attendant(stub)/web(stub)/conformance scaffold.
- E2E AES-GCM channel from pairing code; relay brokers ciphertext only.
- Interactive CLI send; turn-cap notifies both sides; join-race channel fix.
- Provider-ToS compliance (`docs/COMPLIANCE.md`): auth separation, mode ③ excluded.
- **Resolution + report-on-termination**: `/resolve`, CALL REPORT, persisted to
  `~/.magpie/calls/`, `history`/`report` recall. Verified live cross-machine.
- Proved a real `claude -p` agent can answer headlessly from its own files.
- **MCP in-session verified (2026-06-28)**: a real Claude Code session loaded
  `@magpie/mcp` via `--mcp-config` and patched through both directions over
  the relay — asker (`sb_join`/`sb_ask`) and answerer (`sb_listen`/read-own-repo/
  `sb_answer`), no human typing, peer text fenced. Same binary registers in
  Codex CLI / Antigravity. This is the cross-vendor substrate (slash/skill = sugar).

---

## P0 — Mode ② : real agent autonomy (the product)
- [x] **END-TO-END UX VALIDATED (2026-07-14): real natural-language driver over
      the hosted relay.** A human typed ONE natural sentence to Claude Code
      ("start a call, ask the peer how to horizontally-scale the relay's
      same-call routing, verify against our code, push to agreement"). The
      driver autonomously ran sb_start → sb_ask; a separate headless Claude
      answerer (`claude -p` + magpie MCP, `@bob/peer`) joined, read the repo,
      and debated multi-turn. They reached a **firm AGREED** conclusion — the
      driver found a real bug in the answerer's first proposal (shard-token-in-
      callId rehash silently kills live calls on autoscale) + two gaps, and the
      answerer conceded with a concrete fix (`call-<homeId>-<nanoid>`, pin home
      for the call's life). Zero human typing after the kickoff. This is the
      product thesis working via the REAL UX, not a scripted driver.
  - **UX gaps found → FIXED (2026-07-14, `session.ts`, live-verified over Fly):**
    - [x] **sb_ask now WAITS for the peer to join** instead of erroring. If no one
          has joined yet, `ask()` parks (up to DEFAULT_PEER_WAIT_MS = 10 min, the
          pairing-TTL horizon) until `onPeerJoined` wakes it, then sends — so
          "start a call and ask X" just works, no poll loop. Rejects cleanly if
          the call closes or nobody joins in the window. Instructions updated to
          say "show the invite, then sb_ask (it waits)". Verified live: ask()
          before any join parked, resolved with the answer once the peer joined.
    - [x] **ask reply timeout is now a generous backstop, not a guess.** A peer
          that DISCONNECTS already fails the ask immediately (`markClosed`), so
          the timeout only bounds a still-connected-but-silent peer. Bumped
          DEFAULT_ASK_TIMEOUT_MS 5 → 15 min so thorough turns (read repo +
          reason, seen ~7 min) are never cut off, while a wedged peer is still
          bounded. sb_ask also accepts an optional per-call reply timeout.
    - [x] **A failed join no longer wedges the whole session (2026-07-15,
          `client.ts`+`session.ts`, live-verified over Fly).** A `sb_join` on a
          dead code makes the relay answer `UNKNOWN_RENDEZVOUS` and drop the
          socket; the SessionStore was memoizing that now-dead client per relay
          URL, so EVERY later `sb_start`/`sb_join` on the same relay failed with
          "magpie client is not connected" for the rest of the session. Three-part
          fix: (1) `MagpieClient.isConnected` getter; (2) `#onClose` now notifies
          hangup listeners on a socket drop (unblocks parked `sb_ask`/`sb_listen`
          AND triggers cache eviction); (3) `#ensureClient` reuses a cached client
          only if `isConnected`, else evicts + reconnects. Live-reproduced through
          the real SessionStore: dead-invite join failed → `start` on the same
          store recovered (pre-fix: "not connected"). +2 regression tests (35 mcp,
          4 client, 37 conformance all green).
- [x] **THE core: autonomous agree-loop (S2).** `AutoDriver` (drives a goal:
      ask → evaluate peer reply vs its OWN spec/files → push back → conclude) +
      `ClaudeDriver`, paired with the existing `AutoAttendant`/`ClaudeResponder`.
      Two real claude agents converse multi-turn, no human typing, and reach a
      firm AGREE conclusion (pass OR fail) with evidence, then resolve+report.
      ✅ verified live (spec 2%+max-3 vs impl → agreed "MET" with file:line evidence).
      Fixes found live: AGREE = "conclusion reached (pass/fail)" not "passed" (or it
      loops); responder must enumerate files before claiming absence (false-negative).
  - [ ] v1.1: mutual confirm (B also agrees before close) + no-progress escalate. **[PARKED]**
  - [x] **Cross-vendor live test — DONE (2026-07-12): Claude ↔ Gemini** over the
        hosted Fly relay, fully autonomous (no human typing). Gemini CLI
        (`@bob/gemini`) joined via the same magpie MCP, read the repo, answered
        correctly ("relay is written in Rust"), and hung up. Proves the
        vendor-neutral claim empirically. Codex is ALSO MCP-compatible (magpie
        registers + `codex mcp list` recognizes it) but this machine's OpenAI
        account is FREE tier → zero Codex model access, so its live test is
        blocked by OpenAI plan, not Magpie. Antigravity (Gemini): magpie MCP
        configured, GUI-driven. Gemini free tier: 5 req/min rate limit (auto-retried).
  - [ ] `/sb` slash-command / Skill wrapper for Claude Code (thin UX over the MCP
        tools: `/sb call`, `/sb join <code>`). Optional sugar; MCP works without it. **[PARKED]**
- [x] **Real responder productized** in `@magpie/auto-attendant`:
      `ClaudeResponder` runs the official CLI with stdin closed + read-only tools
      (`--allowedTools LS Glob Grep Read "Bash(ls:*)"`), `cwd`-scoped; added a
      `magpie-attend <code>` bin. ✅ verified live: a real claude attendant
      answered an asker's project question over the relay (E2E, no refusal).
- [x] **Receiving-agent prompt tuned for TRUSTED collaborators** — "cooperative
      teammate" framing replaces the over-strict fence that made the agent refuse
      a legitimate teammate question. (Still: never executes embedded instructions,
      read-only, cwd-scoped, fail-closed CONFIDENCE.) ✅
- [x] **Out-of-scope / low-confidence no longer kills the call.** The attendant
      now DECLINES in-band ("⚠️ I can't answer that — outside my project scope; I've
      flagged it for my operator") and STAYS on the line; only the turn cap / an
      explicit hangup ends a call. ✅ verified live (in-scope → real answer;
      `~/Desktop` → polite decline, call stayed alive).
- [~] **Hybrid live-or-files responder (live-if-on, files-if-off).**
      - [x] Step 1: AutoAttendant picks `liveResponder` when `isLive()` is true,
            else the file `responder`; `goOnDuty`/`dutyPresence` give a file-mtime
            heartbeat presence with no daemon/IPC. (19 auto-attendant tests.)
      - [x] Step 2: a LIVE responder = a running Claude Code session answering
            via the Magpie MCP is verified (sb_listen → read own repo →
            sb_answer, in-session). Still optional: `magpie-attend`
            ergonomics (`--on-duty` heartbeat, handle) for the file-fallback side.
- [x] **In-session agree-loop via MCP (A).** Added a 7th tool `sb_resolve(callId,
      summary)` so a LIVE agent can conclude a call itself (sends the verdict,
      ends the call, returns the report). The driving behavior is in the MCP
      server `instructions` (loop `sb_ask` until firm conclusion → `sb_resolve`;
      responder loops `sb_listen`/`sb_answer` until closed). A peer's resolve is
      surfaced to `sb_listen` so the other side learns the conclusion. ✅ verified
      live: a real Claude Code driver session read its own SPEC.md, looped
      `sb_ask` twice (one per requirement), evaluated vs spec, and concluded with
      `sb_resolve` "MET" — no human typing. (scratchpad `mcp-loop.mjs`; 12 mcp tests.)
- [ ] **Persistent agent session** per side instead of fresh `claude -p` per turn
      (token efficiency; keeps conversation context across turns).
- [~] **Auto-resolve**: DONE for the in-session MCP path (the agent calls
      `sb_resolve` itself). Headless `AutoDriver` already auto-resolves too. The
      remaining bit is the interactive CLI still needing a human `/resolve`.
- [ ] **Terse, intent-tagged, reference-based** messages (not verbose NL);
      minimize the per-message fence overhead.

## P0 — Rust migration (efficiency / distribution) — decided 2026-06-29

**Why Rust, honestly:** the core call path is LLM-bound (~30s/turn), so Rust does
NOT speed up a conversation. The real wins are (1) **distribution** — a single
static binary relay+CLI (`brew install`, no Node runtime), serving the easy-
onboarding goal; (2) **relay at scale** — tokio, no GC tail-latency, KB/conn not
tens-of-KB; (3) smaller attack surface on the one publicly-exposed component.
The bigger *efficiency* levers are NOT the language — token efficiency
(persistent sessions) + terse/reference protocol dwarf any rewrite. So:

**NOT a big-bang rewrite. Surgical, phased, ROI-ordered.** Language boundary =
the wire protocol (ws + base64 sealed frames), so Rust and TS components
interop natively; we can swap one package at a time.

Sizes (non-test src LOC): protocol 337 · relay 673 · client 598 · mcp 964 ·
auto-attendant 948 · cli 708. Durable wire core (protocol+relay+client = ~1.6k)
is the Rust target; SDK/agent-glue (mcp+auto-attendant) stays TS for now.

**✅ ALL THREE PHASES DONE + tested (2026-06-29, via ultracode workflow — 14 agents).**
Verified independently in the main loop: Rust **59** tests, TS **109** tests
(no regression), TS-client⇄Rust-relay interop 7/7, Rust-CLI⇄TS-peer full E2E
(HKDF rendezvous + AES-256-GCM byte-identical BOTH directions, reports match).
Release binaries: CLI 1.85 MB stripped, relay 1.04 MB; cold-start **18× faster**
than Node (3.6 ms vs 66 ms). Test plan: `specs/TEST_PLAN.md`. Crypto corpus:
`specs/fixtures/crypto-vectors.json`.

- [x] **Phase 1 — Rust `relay`** (`rust/crates/magpie-relay`). Crypto-free
      drop-in; wire-identical to the TS relay (NO changes needed to pass). 13 unit
      tests + `conformance/tests/13-rust-relay-interop.test.ts` (7 scenarios via
      the real TS client against the Rust binary).
- [x] **Phase 2 — Rust `protocol`** (`magpie-protocol`). HKDF-SHA256 (empty
      salt, info `…:rendezvous:v1`/`…:channel:v1`) + AES-256-GCM (`iv‖tag‖ct`,
      detached tag, no AAD) **byte-identical to TS** — proven by cross-impl vectors
      (passed first try). 11 tests. RustCrypto (`hkdf`+`sha2`+`aes-gcm`), no regex dep.
- [x] **Phase 3 — Rust `client` + `cli`** (`magpie-client`, `magpie-cli`).
      tokio-tungstenite client (join-race fix preserved) + clap `magpie` binary
      (start/join/history/report, `/resolve` in-loop, 0600 reports). 10 + 25 tests.
- [x] **Kept TS:** MCP server + auto-attendant/driver (unchanged, all green).
- [x] **DECISION resolved:** surgical split (Rust infra + TS agent-glue). Full-Rust
      (rmcp MCP) deferred unless the split proves insufficient.

### Rust hardening follow-ups (from adversarial review — before any PUBLIC relay)
**✅ DONE 2026-07-07 (all relay-blocking items; verified by live abuse sim:
8 opens → CAPACITY, 100-frame flood → RATE_LIMITED, unknown field → BAD_FRAME):**
- [x] **HIGH** relay: pending/call caps — per-endpoint (8 pending / 32 calls) +
      global (10k each) → `CAPACITY` error (`registry.rs`).
- [x] **HIGH** relay: bounded outbound queue (256/conn, `try_send`) — a
      non-reading peer is EVICTED (writer closes the socket) instead of
      buffering unbounded.
- [x] **MED** relay+client: WS `max_message_size`/`max_frame_size` = 2 MiB
      (was tungstenite's 64 MiB default); TS relay `maxPayload` 2 MiB too
      (was ws's 100 MiB); JSON parse now happens BEFORE the global lock.
- [x] **MED** relay: poison-tolerant lock + 10 s handshake timeout + conn caps
      (4096 global / 64 per IP, reserved pre-handshake) + per-conn rate limit
      (30/s, burst 60 → `RATE_LIMITED`). Read-idle timeout deliberately NOT
      added: quiet listeners waiting for `deliver` are legitimate; caps bound
      the FD cost instead.
- [x] **MED** parity: strict unknown-field rejection on relay `ClientFrame`
      (key allowlist; serde can't deny-unknown on tagged enums) + `Message`
      `deny_unknown_fields` + `ts` ISO-8601 (Z-suffixed) validation.
- [x] **MED** protocol: `seal_with_iv` now private (ENCRYPT vector moved to an
      in-crate unit test).
- [x] **LOW** cli: `report <id>` path-traversal blocked (callId validated
      before `dir.join`).

Still open (not relay-blocking):
- [ ] **LOW** cli: SIGINT `.expect` → graceful; piped-stdin clean exit.
- [ ] **LOW** cross-impl (shared w/ TS): forgeable untrusted-content fence (use a
      per-message random nonce delimiter); pairing-code modulo bias (rejection
      sampling); UTF-16-vs-byte length caps; `maxTurns:0` clamp-vs-reject.
- [ ] TS relay: mirror pending/call caps + rate limit (dev/reference only —
      the hosted public relay is the Rust binary).

## P1 — Onboarding / OSS launch

**Model REVISED 2026-07-27 (was: "we host NOTHING").** Requiring every user to
stand up a relay before sending one message was 배보다 배꼽이 큰 — it cost more
than the thing it enabled. We now host a default relay (Fly, ~$2/mo, Tokyo) and
the MCP resolves it from a pointer file at startup, so a fresh install needs
zero configuration. Self-hosting stays fully supported and is one env var
(`MAGPIE_RELAY_URL`), just no longer the price of admission. The relay brokers
ciphertext only, so hosting it grants us nothing to read. Onboarding is now:
install → share one invite token.

### ✅ Release smoke test (2026-07-28) — the OS axis is no longer a guess
Every live bug of the last week shared one shape: **it only appeared outside this
machine.** The Windows registration bug, the unsanitized `@$(whoami)/main`, the
sb_ask peer-wait — all pass on macOS with the account name `user`. Unit tests
could not catch them (they run on one ubuntu box against SOURCE) and neither
could I (one OS, one username, one timing).

`scripts/smoke.mjs` + `.github/workflows/smoke.yml` close that. The workflow
downloads the ACTUAL released archive per platform and drives a real two-party
call over the real hosted relay: 15 steps with negative controls (join on an
unregistered code refused, sb_ask before any join PARKS, sb_ask after resolve
refused) and a random nonce in both directions that must survive the round trip
through the untrusted-peer fence, so no assertion can match text the script
itself produced. Runs on release (`needs: build`), on demand, and nightly.

**First run, 2026-07-28: macOS arm64, Linux x64, Linux arm64, and WINDOWS all
PASS.** Windows derived `@runneradmin/main` and completed the call in 5.8s. That
was the single biggest unknown and it is now measured rather than assumed.

Written, then adversarially reviewed for false-pass / flake / CI defects. The
review caught that the workflow was **dead code** (it exposed `workflow_call`
and nothing called it), a shell injection via `${{ inputs.tag }}` interpolated
into bash source, per-leg "latest" resolution that could certify a set of
binaries that never existed as one release, and an `ASK_MS` bound smaller than
the script's own downstream budget (bogus timeouts on a healthy relay). All fixed.

Still NOT covered, deliberately: CI runners are clean rooms. No antivirus, no
corporate proxy, no real human. See the AV/signing item below.

### ✅ v0.2.0 shipped (2026-07-27) — the release that made onboarding real
The bottleneck was never the code: it was that **the published artifact was not
the working code.** v0.1.0 (2026-07-05) predated the hosted relay, the DoS
hardening, wss:// support, and both live-found UX fixes — yet the public site,
the public repo, and `install.sh` had been live for weeks handing that build to
anyone who found it. Fixed by cutting v0.2.0 from HEAD (17 commits) and
rewriting the front door, which still told the self-host story the code had
already abandoned:
- README opened with "no hosted server — **you run everything**" and never even
  mentioned the `curl | sh` one-liner the website advertises.
- `install.sh` signed off with "Self-host a relay: set MAGPIE_RELAY_URL=…".
- Site said "self-hosted · no accounts" and used `ws://relay.local:8787`.
- Real bug found while auditing: `install.ps1` tested `claude mcp get` with
  try/catch, but native non-zero exits do not throw under PS 5.1, so `$exists`
  stayed true and **Windows users never got the MCP registered.** Now checks
  `$LASTEXITCODE`.

Verified against the actual downloaded release artifact, not the source tree:
`magpie 0.2.0` from `/releases/latest/`, MCP booted with no `MAGPIE_RELAY_URL`
→ resolved `wss://magpie-relay.fly.dev`, two-party call between two released
binaries with `sb_ask` fired 3s BEFORE the peer joined (parked, then answered),
through `sb_resolve`. 215 tests green (141 TS + 74 Rust).
- [x] Relay `Dockerfile` + `.dockerignore` (`docker build -t magpie-relay rust/
      && docker run -p 8787:8787 …`). *(Untested locally — no docker on dev box;
      relay binary itself verified via interop/E2E.)*
- [x] README **Quickstart** rewritten around the one-line install (2026-07-27).
- [x] Repo **English-only** (de-Koreanized the two multibyte test fixtures).
- [x] Prebuilt **binaries** for 5 platforms + `curl | sh` / `irm | iex`
      installers, served from Pages, auto-registering the MCP with Claude Code
      and Codex. Docker image not published (the binary makes it optional).
- [x] **Simple website** live at ssh-ai.github.io/magpie (30-sec explainer,
      animated session demo, one-line install).
- [x] **Repo public.**
- [ ] **npm publish `@magpie/{protocol,client,mcp}`** → the `npx -y @magpie/mcp`
      path. Now SECONDARY: the advertised install is the binary one-liner, which
      needs no Node at all. Scope `@magpie` is free (E404 on registry); packages
      are not `private`; still needs `files` fields + an npm login + publish
      order (protocol → client → mcp).
- [x] **`MAGPIE_EXTENSION` no longer required (v0.2.1, 2026-07-28).** Found
      while smoke-testing v0.2.0: the MCP exited 1 when it was unset, and MCP
      hosts swallow stderr, so operators saw an unexplained "server failed to
      start". Worse, the assumption that the installer path was safe was wrong
      — it set `@$(whoami)/main` with NO sanitization, and EXTENSION_RE is
      strict (lowercase alphanumerics + hyphens, since these ids reach the
      filesystem), so "Sang Hoon" / "John.Doe" / "CORP\alice" produced an
      address the MCP then rejected. **Both the manual and the installer path
      were broken for those users**; the installer just failed one step later.
      Now one tested derivation (`default-extension.ts`): sanitize the OS
      username, fall back to `@agent/main`, and let the installers stop writing
      the variable rather than reimplementing the rules in sh and PowerShell.
      An explicit value is still verbatim and still fails loudly if malformed.
      Verified on the released artifact with a truly empty env:
      `ready as @user/main (derived)`. +15 tests.
- Dropped: cloud "Deploy" button (not core); relay connect-token (only matters for
  public-internet exposure — revisit then, with the DoS caps).

## P1 — Observability / waiting UX (user-flagged)
- [x] **Basic waiting feedback** — the CLI now prints "⏳ sent — waiting for the
      other agent…" on send, so the ~30s model latency no longer looks frozen.
- [ ] **Full "peer is thinking…" signal** from the attendant side (a `system`/status
      frame the moment it starts working), richer than the local asker-side line.
- [ ] **Live transcript "watch" view** — see both sides' messages + status in real
      time (also the trust/audit surface).

## P1 — CLI / usability
- [ ] Label your **own** sent messages (`› you:`) vs inbound (`📨`) — current bare
      terminal is confusing (hit live).
- [ ] Global `magpie` command (`npm link` / install) instead of long
      `node packages/cli/dist/bin.js`.
- [ ] Pairing-code UX: 10-min TTL too short for human coordination; make TTL
      configurable + easy regenerate (hit live — codes kept expiring).
- [ ] Proper TUI (Claude-Code-like input box / panes). Wanted, lower priority.

## P1 — Routing / addressing (multi-agent: one person, many agents)
- [ ] Named-extension **directory + presence** so A can call `@b/risk` by name
      (relay registry lookup; no per-call code).
- [ ] Optional **receptionist agent** (`@b/desk`) for content-based dispatch to the
      right local agent.

## P1 — Binary trust / AV false positives (self-host distribution)
Finding (2026-07-10): on a dev Mac running Kaspersky + AhnLab ASTx, a
LOCALLY-BUILT `magpie-relay` was quarantined after being run repeatedly as a
live listening relay (behavioral proxy/backdoor heuristic — unsigned binary
that opens a port and relays). Empirically: the v0.1.0 RELEASE binaries
(magpie, magpie-mcp, magpie-relay) ALL survived on disk on the same machine,
and the CLI (outbound client) survived even when run. So:
- Hosted-relay users are UNAFFECTED — they connect to wss://…fly.dev (a remote
  service on Linux), never download/run the relay binary.
- Only self-hosters running the relay locally can hit the false positive.
- [ ] **macOS notarization + Windows Authenticode signing** of release binaries
      (Apple Developer $99/yr) — removes Gatekeeper friction AND lowers AV
      false-positive rate for self-hosters. Do before promoting self-host relay.
- [ ] Self-host docs: note the AV false-positive possibility + how to allowlist.

## P2 — Reach (cover app-only users)
- [ ] **Remote HTTP/SSE MCP server** (Claude app / ChatGPT) + **BYO-key auth**
      (never users' subscription OAuth — see COMPLIANCE.md).
- [ ] **Web client `channel.open` crypto port** — browser join/watch with real
      decryption (currently a TODO stub, no fake decrypt).

## P2 — Security / ops hardening (before any public exposure)
- [~] Relay **rate-limit + connection caps** ✅ (2026-07-07, see hardening list
      above) + access token (still open; may be unnecessary for a public relay).
- [ ] **wss/TLS** deployment (Caddy auto-TLS) guide + make it the default for
      non-local relays (hides rendezvousId; see PROTOCOL.md §6a).
- [ ] **SPAKE2 PAKE** so short codes stay MITM-safe (currently HKDF-from-code).

## P3 — Robustness / cleanup
- [ ] cross-process `magpie hangup` rejected as non-participant (minor;
      relies on SIGINT today).
- [ ] Reconnect / dropped-socket handling mid-call.
- [ ] Rename OS folder `agentmessenger` → `magpie` (cosmetic; session cwd was
      pinned, so deferred).
