# Magpie

**Your agent talks to their agent — until they agree.** Magpie patches one person's coding agent through to another's, over an end-to-end-encrypted line.

When two people collaborate and each drives their own coding agent (Claude, Codex, Gemini, …), keeping them in sync means copy-pasting between agents — one round trip per question, and it stalls the moment someone steps away. Magpie replaces the human relay with a direct, secure line between the two agents. Each agent keeps its **own private context** and reads its **own files**; only the Q&A crosses.

> Think of it as an old telephone exchange for agents: every agent gets an **extension**, you **patch** two through, and they're on a **call**. An **auto-attendant** can answer on your behalf when you're away.

## Why it's different

The agent-to-agent messaging space exists (session-bridge, AgentPipe, A2A, …) but every option is one of: same-machine-only, single-operator, Claude-only, or developer-CLI-only. Magpie targets the unmet combination:

- **Cross-vendor** — Claude↔Claude, GPT↔GPT, or any mix, via one MCP adapter.
- **Cross-machine** — two people on two laptops, brokered by a relay (not a shared filesystem).
- **Async / answer-on-behalf** — your agent answers within its domain while you're away; escalates to you when unsure.
- **Dead-simple onboarding** — no accounts, no key files. One command + a short code, like a Zoom invite.
- **Secure by construction** — end-to-end encrypted channel from the pairing code; inbound peer text is treated as untrusted data, never executed without your approval.

## How a call works

```
A's agent:  magpie start "is agbot's risk limit implemented correctly?"
            → code: K7F3-9M2P-XQ4R   (share this with B over chat)

B's agent:  magpie join K7F3-9M2P-XQ4R
            → patched through.

… the two agents exchange queries/answers autonomously, each reading its own
   files, until they converge or hit the turn cap, then auto-hang-up and
   summarize to both humans.
```

One handshake, then unlimited automatic round trips — strictly cheaper than relaying by hand.

## Quickstart

No accounts, no config, no server to run. A hosted relay is the default, so install is the whole setup.

**1. Install** (both people, once):

```bash
curl -fsSL https://sshaipowered.github.io/magpie/install.sh | sh     # macOS / Linux
irm https://sshaipowered.github.io/magpie/install.ps1 | iex          # Windows
```

Single static binaries (`magpie`, `magpie-relay`, `magpie-mcp`) into `~/.magpie/bin`. No Node, no Docker. The installer auto-registers the MCP server with **Claude Code, Codex, and Gemini CLI** if it finds them; for any other MCP host it prints the command to paste.

> Gemini CLI users: Gemini gates MCP servers behind *folder trust*. If `gemini mcp list` shows magpie as `Disabled`, that is the gate, not a broken install — trust the folder.

**2. Just talk to your agent:**

```
You → agent:            "start a magpie call about the agbot risk limit"
agent → you:            invite K7F3-9M2P-XQ4R@wss://magpie-relay.fly.dev   # ONE token: code + relay
partner → their agent:  "join K7F3-9M2P-XQ4R@wss://magpie-relay.fly.dev"
# the two agents exchange Q&A autonomously until they agree, then summarize to both of you.
```

That's it. The invite carries the relay address, so the joiner configures nothing.

Your agent's address defaults to `@<your-username>/main`. Set `MAGPIE_EXTENSION=@you/role` to pick a different one (useful when you run several agents).

Prefer a human at the keyboard instead of an agent? The `magpie` CLI (Rust, single binary) does `start` / `join` interactively.

### Run your own relay (optional)

The default relay brokers **ciphertext only** and can never read your code or messages, but nothing stops you from running your own. It is the same ~1 MB binary you already installed:

```bash
magpie-relay                      # → listening on ws://0.0.0.0:8787
# …or from source, in ./rust:  cargo run --release -p magpie-relay
# …or Docker:  docker build -t magpie-relay rust/ && docker run -p 8787:8787 magpie-relay
```

Then point the *starting* side at it with `MAGPIE_RELAY_URL=ws://<host>:8787` (put it behind a TLS reverse proxy for `wss://` on the public internet; see [`deploy/relay/`](deploy/relay/)). The joining side still needs nothing, since the invite carries the address.

**From source instead of the installer:**

```bash
npm install && npx tsc -b
claude mcp add magpie -- node "$(pwd)/packages/mcp/dist/bin.js"
```

## Security model (summary)

- The **pairing code** is a one-time, short-lived shared secret. It derives an **AES-256-GCM end-to-end channel**; the relay brokers bytes it cannot read. (Upgrade path: SPAKE2 PAKE for shorter codes — see [`docs/PROTOCOL.md`](docs/PROTOCOL.md).)
- Every message is **schema-validated**; extensions (`@owner/role`) are strictly formatted, killing the id-spoofing / path-traversal class.
- Inbound peer content is **fenced as untrusted data**. A peer message may make your agent read its **own** files by default; running tools / editing requires your explicit approval (`runTools` gate).
- Calls have a **turn cap** and auto-terminate — no infinite agent ping-pong.

- Each agent runs on **its own owner's own authentication**; the relay never touches any provider token. Magpie supports agent↔agent (each self-authenticated, cross-vendor) and you-talking-to-your-own-agent — it deliberately does **not** let one person drive another person's agent on the other's seat (a provider-ToS violation). See [`docs/COMPLIANCE.md`](docs/COMPLIANCE.md).

See [`docs/PROTOCOL.md`](docs/PROTOCOL.md) for the full handshake and threat model, [`docs/COMPLIANCE.md`](docs/COMPLIANCE.md) for the provider-terms constraints, and [`docs/DESIGN.md`](docs/DESIGN.md) for the prior-art analysis this is built on.

## Packages

| Package | Role |
| --- | --- |
| `@magpie/protocol` | Shared contract: message schema, pairing/handshake, security primitives. |
| `@magpie/relay` | The exchange: WebSocket rendezvous + call/extension registry + turn-cap enforcement. Brokers ciphertext only. |
| `@magpie/mcp` | MCP server so **any** MCP-capable agent (Claude Code, Codex, Gemini CLI, …) gets `start`/`join`/`ask`/`listen` tools. |
| `@magpie/cli` | `magpie start｜join｜call｜listen｜hangup`. |
| `@magpie/auto-attendant` | Vendor-pluggable headless responder that answers on your behalf (claude / codex / gemini adapters) and escalates when unsure. |
| `conformance/` | Behavioral tests, including the ported session-bridge scenario corpus. |

## Status

Working core, MIT licensed. Agent↔agent calls (query → answer → mutual agreement → report) run cross-machine, end-to-end encrypted, over MCP, verified live across vendors (Claude ↔ Gemini). The relay/protocol/client/CLI have a **Rust implementation** (single static binaries; relay ~1 MB) alongside the TypeScript reference packages, verified byte-compatible on the wire and crypto. Install via the one-liner above; the npm packages are not published yet, so the from-source path is still `node packages/mcp/dist/bin.js`.
