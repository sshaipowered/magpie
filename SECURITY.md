# Security Policy

Magpie carries other people's code discussions over a channel it claims is end-to-end
encrypted, and it feeds attacker-influenced text to an LLM that holds tools. Both of
those are worth attacking. Reports are welcome.

## Reporting a vulnerability

**Use GitHub's private vulnerability reporting:**
[Report a vulnerability](https://github.com/sshaipowered/magpie/security/advisories/new)

Do not open a public issue for anything that lets someone read a call's plaintext,
impersonate an endpoint, or make a peer's agent take an action its human did not
approve. Public issues are fine for everything else.

Maintained by one person, unpaid, with no bounty. Realistic expectations: an
acknowledgement within about a week, and a fix timeline that depends on severity.
If a week passes with silence, open a public issue that says only "sent a private
report, no response" — no details.

## Supported versions

Only the **latest release** is supported. There is no backport branch. If you are on
an older tag, upgrade before reporting.

## In scope

The properties Magpie actually claims, in [`docs/PROTOCOL.md`](docs/PROTOCOL.md):

- **Relay confidentiality** — the relay must never be able to derive a `channelKey`
  or read message plaintext. Anything that breaks this is the highest severity here.
- **Endpoint binding** — a party without the pairing code must not be able to join a
  call, replay frames from one call into another, or resume a consumed rendezvous.
- **Content-execution containment** — peer text must not be able to make the
  receiving agent run tools or edit files without local human approval. Bypasses of
  `fenceUntrusted` or of the `ActionPolicy` default (`runTools: false`) are in scope.
- **Identifier handling** — any peer-supplied string that reaches a filesystem path,
  a shell, or a config file. `assertSafeExtension` / `EXTENSION_RE` exist to close
  this class; a way around them is a real finding.
- **Turn cap and TTL enforcement** — a way to keep a call alive past its cap, or to
  extend a pairing past `PAIRING_TTL_MS`.
- **Supply chain** — anything in the install one-liner or the release workflow that lets a
  third party change what a user ends up executing.

## Already known — please do not report these as new

These are documented trade-offs, not oversights. Reporting them costs us both time.

| Known limitation | Status |
| --- | --- |
| `channelKey = HKDF-SHA256(pairing code)`, so the channel is only as strong as the side channel you paste the code into. | By design for now; ~59 bits, single-use, 10-minute TTL. SPAKE2 PAKE is the planned replacement — `PairingChannel` is the swap seam. See PROTOCOL §2. |
| `rendezvousId` and control frames are cleartext over plain `ws://`, so an on-path attacker can grief a pairing (not read it). | Documented in PROTOCOL §6a. There is no hosted relay; anyone exposing one beyond a LAN must terminate TLS. |
| **Released binaries are unsigned and un-notarized.** macOS Gatekeeper and Windows SmartScreen will object, and antivirus may quarantine them. | Known and unfixed. Verify what you run against the release checksums until this is resolved. |
| The relay observes metadata: both extensions, both IPs, and the count, size, and timing of frames. | Explicit non-goal. The relay is untrusted for content, not for traffic analysis. The call topic is **not** among these since v0.3.1; it travels sealed. |
| A misbehaving MCP *host* can ignore the untrusted-content fence entirely. | Outside our control. Magpie can label peer text as data; it cannot force a host to respect the label. |
| The identity fingerprint in call reports is **announced, not proven**. Anyone who can join a call can claim any fingerprint. | By design (PROTOCOL §6b): attribution for the record, not authentication. A signed challenge is the planned upgrade; the key pair already exists for it. |

## Out of scope

Findings that require an attacker to
already control the user's machine or their agent's config, missing hardening headers
on the static site, and automated-scanner output with no demonstrated impact.
