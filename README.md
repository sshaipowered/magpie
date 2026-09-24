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

No accounts, no config files, no hosted service. One of you runs a relay; the other needs no configuration.

**1. Install** (both people, once):

```bash
curl -fsSL https://sshaipowered.github.io/magpie/install.sh | sh     # macOS / Linux
irm https://sshaipowered.github.io/magpie/install.ps1 | iex          # Windows
```

Single static binaries (`magpie`, `magpie-relay`, `magpie-mcp`) into `~/.magpie/bin`. No Node, no Docker. The installer auto-registers the MCP server with **Claude Code, Codex, and Gemini CLI** if it finds them; for any other MCP host it prints the command to paste.

> Gemini CLI users: Gemini gates MCP servers behind *folder trust*. If `gemini mcp list` shows magpie as `Disabled`, that is the gate, not a broken install — trust the folder.

**Then restart your agent.** MCP hosts read their server list when a session starts, so a session that was already open will not see `magpie` until you open a new one. Verify:

```bash
magpie --version                 # open a new shell first, or source your rc file
claude mcp list                  # or: codex mcp list / gemini mcp list — magpie should be listed
```

**2. Run the relay** (one machine both agents can reach, e.g. a spare laptop):

```bash
magpie-relay                      # → listening on ws://0.0.0.0:8787
```

The relay brokers **ciphertext only**. It cannot read your code, your messages, or the call topic, so where it runs is a reachability question, not a trust one. It does see who is talking to whom and how much. Keep it up with `launchd`/`systemd` if it is meant to stay up.

**3. Tell the *starting* side which relay to use** — the joining side needs no configuration, the invite carries the address. Two ways:

*Say it in the prompt.* Works in every host, nothing to configure:

```
"start a magpie call on relay ws://relay-laptop.local:8787 about the agbot risk limit"
```

*Or bake it into the MCP registration*, so you never repeat it. **Not a shell `export`:** GUI-launched hosts (Claude Desktop, VS Code/Cursor extensions, the Codex app) do not inherit your shell, so the MCP would never see the variable. Put it where the host starts the server:

```bash
claude mcp remove magpie -s user
claude mcp add magpie -s user -e MAGPIE_RELAY_URL=ws://relay-laptop.local:8787 -- ~/.magpie/bin/magpie-mcp
codex  mcp add magpie --env MAGPIE_RELAY_URL=ws://relay-laptop.local:8787 -- ~/.magpie/bin/magpie-mcp
gemini mcp add -s user -e MAGPIE_RELAY_URL=ws://relay-laptop.local:8787 magpie ~/.magpie/bin/magpie-mcp
```

Then restart the agent; the MCP reads the variable once, at startup. A plain `export` in your shell only reaches a CLI host launched from that same shell.

Use a `.local` name (mDNS, built into macOS and most Linux) or a DHCP reservation, not a raw IP: it goes stale the day the router hands out a different one. **On different networks, `.local` does not resolve at all** — see [Not on the same LAN](#not-on-the-same-lan) before this step.

**4. Just talk to your agent:**

```
You → agent:            "start a magpie call about the agbot risk limit"
agent → you:            invite K7F3-9M2P-XQ4R@ws://relay-laptop.local:8787   # ONE token: code + relay
partner → their agent:  "join K7F3-9M2P-XQ4R@ws://relay-laptop.local:8787"
# the two agents exchange Q&A autonomously until they agree, then summarize to both of you.
```

When a call ends, both sides get the full report as the tool's structured content and a JSON copy at `~/.magpie/calls/<callId>.json`: outcome, summary, what was `agreed`, what stayed `contested` (each with both positions), the transcript, and each side's identity fingerprint. The fingerprint comes from a key pair Magpie creates once under `~/.magpie/identity/`. MCP hosts hide the server's log output, so read your own fingerprint from any report's `identity.me.fingerprint` after your first call. It attributes, it does not authenticate.

Your agent's address defaults to `@<your-username>/main`. Set `MAGPIE_EXTENSION=@you/role` to pick a different one (useful when you run several agents).

Prefer a human at the keyboard instead of an agent? The `magpie` CLI (Rust, single binary) does `start` / `join` interactively.

### Joining a call (for your partner)

You received an invite line. This is everything you need to do:

1. **Install** (step 1 above), then **restart your agent** and confirm `claude mcp list` (or `codex mcp list` / `gemini mcp list`) shows `magpie`.
2. **Same LAN as the relay?** Nothing more. **Different network?** Accept the starter's Tailscale invitation first — see the next section.
3. **Tell your agent to join**, pasting the whole invite line exactly as sent: `join K7F3-9M2P-XQ4R@ws://relay-laptop.local:8787`. The relay address is inside the invite; you set no variables. Invites expire after 10 minutes and work once, so paste it as soon as you get it.
4. Your agent handles the conversation and reports the conclusion when the call ends. The full report is at `~/.magpie/calls/<callId>.json`.

### Not on the same LAN

`.local` names only resolve on one LAN. Across networks, the simplest path is a shared tailnet. No port forwarding, no public endpoint.

1. **Relay host:** install [Tailscale](https://tailscale.com), sign in, and invite your partner from the admin console (**Users → Invite**). The free Personal plan covers a small team.
2. **Partner:** install the Tailscale app (macOS/Windows: the app — on macOS the CLI lives inside the app bundle, so use the app; Linux: `tailscale up`) and sign in through the invitation. You are now on the same tailnet.
3. **Starter:** use the relay host's MagicDNS name instead of `.local`, in the prompt or in the registration exactly as in step 3 above. It survives IP and network changes:

```
"start a magpie call on relay ws://relay-laptop.<your-tailnet>.ts.net:8787 about ..."
```

If your partner cannot install anything, put the relay behind a TLS reverse proxy (`wss://`, see [`deploy/relay/`](deploy/relay/)) or a Cloudflare Tunnel and use that public `wss://` URL in step 3 instead. Whoever runs that endpoint sees the relay's metadata (addresses, sizes, timing), never the content or topic.

### Updating and uninstalling

**Update:** re-run the install one-liner. It overwrites the binaries and registration is idempotent. Then **restart your agent**: a running `magpie-mcp` process is still the old binary until the host starts a new one.

**Uninstall:**

```bash
claude mcp remove magpie -s user      # and/or: codex mcp remove magpie / gemini mcp remove -s user magpie
rm -rf ~/.magpie/bin
```

Then remove the `# magpie` PATH line from `~/.zshrc` or `~/.bashrc` (Windows: the `~\.magpie\bin` entry in your user PATH). `~/.magpie/calls/` (your reports) and `~/.magpie/identity/` (your key) are left alone; delete them yourself if you want them gone.

### Troubleshooting

- **`sb_start` fails with connection refused** (starter): the relay is not running, or `MAGPIE_RELAY_URL` names the wrong host. Start `magpie-relay` where the variable points.
- **Set `MAGPIE_RELAY_URL` and the call still starts in invite-only mode** (starter): either the MCP was already running (it reads the variable once, at startup — restart the agent), or you exported it in a shell and your host is a GUI app that never saw it. Put it in the MCP registration (step 3) or say the relay in the prompt. The joiner never needs this variable.
- **macOS asks whether `magpie-relay` may accept incoming connections** (relay host): the binaries are unsigned, so the application firewall prompts. Click Allow; it may ask again after an update.
- **Joiner gets `UNKNOWN_RENDEZVOUS`**: the code expired (10 minutes, single use) or was mistyped. Ask for a fresh invite.
- **`magpie: command not found` right after installing**: the installer added `~/.magpie/bin` to your PATH for *new* shells. Open a new terminal.

**From source instead of the installer:**

```bash
npm install && npx tsc -b
claude mcp add magpie --scope user -- node "$(pwd)/packages/mcp/dist/bin.js"
codex mcp add magpie -- node "$(pwd)/packages/mcp/dist/bin.js"
gemini mcp add -s user magpie node "$(pwd)/packages/mcp/dist/bin.js"
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

Working core, MIT licensed. Agent↔agent calls (query → answer → mutual agreement → report) run cross-machine, end-to-end encrypted, over MCP, verified live across vendors: Claude ↔ Gemini (2026-07) and Claude ↔ Codex (2026-09, seven turns ending in an honestly recorded non-agreement). The relay/protocol/client/CLI have a **Rust implementation** (single static binaries; relay ~1 MB) alongside the TypeScript reference packages, verified byte-compatible on the wire and crypto. **Self-host only**: there is no hosted relay. Install via the one-liner above; the npm packages are not published yet, so the from-source path is still `node packages/mcp/dist/bin.js`.
