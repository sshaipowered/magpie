#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMagpieMcp } from './server.js';
import { identityDir } from '@magpie/client';
import { resolveDefaultRelay } from './relay-pointer.js';
import { resolveExtension } from './default-extension.js';

/**
 * Magpie MCP stdio entrypoint.
 *
 * Configure your MCP host (Claude Code, Codex, Gemini CLI) to launch:
 *
 *   MAGPIE_RELAY_URL=ws://localhost:8787 \
 *   MAGPIE_EXTENSION=@alice/impl \
 *   magpie-mcp
 *
 * - MAGPIE_RELAY_URL : WebSocket URL of the default relay. OPTIONAL — when unset,
 *   the hosted default relay is resolved from a stable pointer file (see
 *   relay-pointer.ts). A joiner pasting a full invite (`CODE@ws://…`) needs no
 *   relay config at all. Set it to pin a self-hosted relay.
 * - MAGPIE_RELAY_POINTER : override the pointer URL, or set to '' to disable
 *   the hosted default (invite-only). OPTIONAL.
 * - MAGPIE_EXTENSION  : this endpoint's address `@owner/role`. OPTIONAL — when
 *   unset it is derived as `@<os-user>/main` (see default-extension.ts). Set it
 *   to pick a role, e.g. `@alice/impl`.
 * - MAGPIE_DEFAULT_OWNER : override just the derived owner half. OPTIONAL.
 * - MAGPIE_ASK_TIMEOUT_MS : optional override for how long sb_ask waits.
 *
 * IMPORTANT: stdout is the MCP transport — never write logs there. Diagnostics
 * go to stderr only.
 */
async function main(): Promise<void> {
  // Unset is NOT fatal: MCP hosts swallow stderr, so exiting here surfaced to
  // the operator as an unexplained "server failed to start".
  const { extension, derived } = resolveExtension(process.env);

  // Resolve the default relay: explicit env wins, else an optional operator pointer.
  // Never throws — nothing configured or an unreachable pointer means invite-only.
  const relayUrl = await resolveDefaultRelay(process.env, {
    warn: (m) => process.stderr.write(`[magpie-mcp] ${m}\n`),
  });

  const askWaitRaw = process.env.MAGPIE_ASK_WAIT_MS;
  const askWaitMs = askWaitRaw !== undefined ? Number.parseInt(askWaitRaw, 10) : undefined;
  if (askWaitMs !== undefined && (!Number.isInteger(askWaitMs) || askWaitMs <= 0)) {
    process.stderr.write(`[magpie-mcp] invalid MAGPIE_ASK_WAIT_MS: ${askWaitRaw}\n`);
    process.exit(1);
  }

  const askTimeoutRaw = process.env.MAGPIE_ASK_TIMEOUT_MS;
  const askTimeoutMs =
    askTimeoutRaw !== undefined ? Number.parseInt(askTimeoutRaw, 10) : undefined;
  if (askTimeoutMs !== undefined && (!Number.isInteger(askTimeoutMs) || askTimeoutMs <= 0)) {
    process.stderr.write(`[magpie-mcp] invalid MAGPIE_ASK_TIMEOUT_MS: ${askTimeoutRaw}\n`);
    process.exit(1);
  }

  let mcp;
  try {
    mcp = createMagpieMcp({
      ...(relayUrl ? { relayUrl } : {}),
      extension, // validated inside createMagpieMcp; throws on bad shape
      ...(askTimeoutMs !== undefined ? { askTimeoutMs } : {}),
      ...(askWaitMs !== undefined ? { askWaitMs } : {}),
    });
  } catch (err) {
    process.stderr.write(
      `[magpie-mcp] bad config: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    if (!derived) {
      // The only knob that can land here is a hand-written MAGPIE_EXTENSION, and
      // the host may not show stderr, so spell out the accepted shape.
      process.stderr.write(
        `[magpie-mcp] MAGPIE_EXTENSION=${JSON.stringify(process.env.MAGPIE_EXTENSION)} — ` +
          'expected @owner/role, lowercase letters/digits/hyphens only (e.g. @alice/impl). ' +
          'Unset it to use the derived default.\n',
      );
    }
    process.exit(1);
    return;
  }

  const transport = new StdioServerTransport();
  await mcp.server.connect(transport);
  process.stderr.write(
    `[magpie-mcp] ready as ${extension}${derived ? ' (derived; set MAGPIE_EXTENSION to change)' : ''} via ${relayUrl || '(no default relay — join with a full invite, or pass relayUrl to sb_start)'} (stdio)\n`,
  );
  // A separate line on purpose: the ready line is matched by the release
  // smoke test and must not change shape. This is what a human copies into a
  // people mapping. Attribution only; nothing verifies it.
  const identity = mcp.store.identityRef;
  if (identity) {
    process.stderr.write(`[magpie-mcp] identity ${identity.fingerprint} (${identityDir()})\n`);
  }

  const shutdown = (sig: string) => {
    process.stderr.write(`[magpie-mcp] ${sig} received, shutting down\n`);
    mcp.store.close();
    void mcp.server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  process.stderr.write(`[magpie-mcp] fatal: ${String(err)}\n`);
  process.exit(1);
});
