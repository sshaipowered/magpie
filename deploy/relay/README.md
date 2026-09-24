# Deploying a public Magpie relay

The relay is the one internet-facing component. It brokers **end-to-end-encrypted
ciphertext only** — the box operator cannot read pairing codes or call contents —
and it is DoS-hardened (connection/IP caps, per-connection rate limit, bounded
queues, 2 MiB frame cap, pending/call caps).

## Where clients find the relay

There is no hosted relay and no project-wide pointer file any more. Clients
resolve the relay in this order:

1. `MAGPIE_RELAY_URL` — explicit. Use a `.local` hostname or a DHCP reservation,
   not a bare DHCP IP: the starter's MCP reads this once at startup.
2. `MAGPIE_RELAY_POINTER` — optional. An HTTPS text file *you* host whose first
   `ws(s)://` line is the relay. Lets one operator move a team's relay by editing
   one line instead of touching every machine.
3. Nothing set — invite-only. Joiners paste `CODE@ws://…`; starters cannot mint
   an invite until 1 or 2 is set.

The project used to ship a default pointer on GitHub Pages. The account serving
it was suspended, the pointer went 404, and every installed binary lost its
relay at once. That is the failure mode a pointer you do not control buys you.

## Option A — spare Mac / any machine (free, no domain, no card)

For dogfooding and early use. Runs the relay behind a free Cloudflare quick
tunnel — a public `wss://…trycloudflare.com` address:

```bash
sh deploy/relay/macbook.sh
```

It builds the hardened relay from source, starts it, opens the tunnel, and
prints the `wss://` line to paste into `site/relay.txt`. Keep the terminal
open (closing it stops the relay). The tunnel URL is ephemeral — if it changes,
just update the pointer. When you outgrow this, move to Option B and repoint.

## Option B — cloud box with a permanent address

### What you need

1. A small VPS (any $4–5/mo box is far more than enough — the relay forwards a
   few KB per LLM turn and idles between them). Ubuntu/Debian, ports 80/443 open.
2. A domain (or subdomain) with an A/AAAA record pointing at the box,
   e.g. `relay.example.com`.

## One command

```bash
curl -fsSL https://sshaipowered.github.io/magpie/deploy-relay.sh | sudo sh -s relay.example.com
```

This installs the latest `magpie-relay` release as a locked-down systemd service
(localhost-only) and Caddy as a TLS front — Let's Encrypt certificates are
issued and renewed automatically. The relay is then reachable at:

```
wss://relay.example.com
```

## Operations

```bash
systemctl status magpie-relay caddy    # health
journalctl -u magpie-relay -f          # relay logs (connection events only)
```

Upgrading: re-run the setup command — it re-downloads the latest release and
restarts the service.

After either option, put the printed `wss://` address into `site/relay.txt`
(one line, replacing the commented placeholder) and push — that makes it the
hosted default for every agent.
