import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { startRelay } from '@magpie/relay';
import type { RelayHandle } from '@magpie/relay';
import { createMagpieMcp } from './server.js';
import type { MagpieMcp } from './server.js';
import { SessionStore } from './session.js';

/**
 * Real MCP RPC + real relay + real SessionStore for the peer.
 *
 * These are the failure modes the maintainer review at call-aR3rDR49YM1HGWwF
 * pinned down but did not yet fix: sb_listen cancellation losing the next
 * message, askBounded's deadline missing pairing, output that lies about
 * whether a question was sent, and response render that tells the model to
 * answer a message that is already an answer. Each test must fail against the
 * current code so we know we are measuring the right thing.
 */

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Harness {
  relay: RelayHandle;
  mcp: MagpieMcp;
  peer: SessionStore;
  rpc: Client;
  home: string;
}

async function makeHarness(opts: {
  askWaitMs?: number;
  askTimeoutMs?: number;
} = {}): Promise<Harness> {
  const home = mkdtempSync(join(tmpdir(), 'magpie-cancel-'));
  process.env.MAGPIE_HOME = home;

  const relay = await startRelay(0, { host: '127.0.0.1' });
  const url = `ws://127.0.0.1:${relay.port}`;

  const mcp = createMagpieMcp({
    extension: '@alice/main',
    relayUrl: url,
    ...(opts.askWaitMs !== undefined ? { askWaitMs: opts.askWaitMs } : {}),
    ...(opts.askTimeoutMs !== undefined ? { askTimeoutMs: opts.askTimeoutMs } : {}),
  });

  const peer = new SessionStore({ self: '@bob/main', relayUrl: url });

  const rpc = new Client({ name: 'cancel-tests', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await mcp.server.connect(st);
  await rpc.connect(ct);

  return { relay, mcp, peer, rpc, home };
}

async function teardown(h: Harness): Promise<void> {
  try { h.peer.close(); } catch { /* noop */ }
  try { h.mcp.store.close(); } catch { /* noop */ }
  try { await h.rpc.close(); } catch { /* noop */ }
  try { await h.mcp.server.close(); } catch { /* noop */ }
  try { await h.relay.close(); } catch { /* noop */ }
  rmSync(h.home, { recursive: true, force: true });
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? '').join('\n');
}

async function paired(h: Harness): Promise<{ callId: string; code: string; b: Awaited<ReturnType<SessionStore['join']>> }> {
  await h.rpc.callTool({ name: 'sb_start', arguments: { topic: 'test' } });
  const info = h.mcp.store.list()[0]!;
  const b = await h.peer.join(info.code!);
  await delay(30);
  return { callId: info.callId, code: info.code!, b };
}

describe('sb_listen cancellation preserves the next inbound message', () => {
  let h: Harness;
  beforeEach(async () => { h = await makeHarness(); });
  afterEach(async () => { await teardown(h); });

  it('a cancelled sb_listen must not consume the next query', async () => {
    const { callId, b } = await paired(h);

    // Long listen, cancelled quickly. Before the fix, the parked #waitingListener
    // stays set; the next ingest hands the message to a dead promise.
    const cancelled = h.rpc
      .callTool({ name: 'sb_listen', arguments: { callId, timeoutMs: 5000 } }, undefined, { timeout: 60 })
      .then(() => 'ok', (e) => e.message);
    await cancelled;

    // Don't await b.ask — it waits 15 min for the response by default. We only
    // need the QUERY on the wire; the response comes later from sb_answer.
    void b.ask('question after listener cancellation').catch(() => null);
    await delay(80);

    const recovered = await h.rpc.callTool({
      name: 'sb_listen',
      arguments: { callId, timeoutMs: 500 },
    });
    const text = textOf(recovered as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain('question after listener cancellation');
    expect(text).toContain('Inbound message id:');

    // And that ONE message must not appear again on the following listen.
    const second = await h.rpc.callTool({
      name: 'sb_listen',
      arguments: { callId, timeoutMs: 100 },
    });
    const secondText = textOf(second as { content: Array<{ type: string; text?: string }> });
    expect(secondText).not.toContain('question after listener cancellation');
    expect(secondText).toMatch(/nothing to listen for|before the timeout/);
  });
});

describe('askBounded covers the whole call, not just the reply wait', () => {
  let h: Harness;
  beforeEach(async () => { h = await makeHarness(); });
  afterEach(async () => { await teardown(h); });

  it('a pre-join sb_ask that hits waitMs must return NOT SENT and never put the question on the wire', async () => {
    // Opener starts but nobody joins. Before the fix the deadline timer is only
    // created after #waitForPeer returns, so waitMs=20 cannot fire while pairing
    // is pending. The tool call blocks for the full 10-minute peer-wait.
    await h.rpc.callTool({
      name: 'sb_start',
      arguments: { topic: 'unpaired', maxTurns: 4 },
    });
    const info = h.mcp.store.list()[0]!;

    const bounded = h.rpc.callTool({
      name: 'sb_ask',
      arguments: { callId: info.callId, question: 'never delivered', waitMs: 20 },
    });
    const returned = await Promise.race([
      bounded.then(() => 'returned' as const, () => 'errored' as const),
      delay(200).then(() => 'timeout' as const),
    ]);
    expect(returned).toBe('returned');

    const out = textOf((await bounded) as { content: Array<{ type: string; text?: string }> });
    // Truthful termination: never delivered, so NOT SENT, not "peer already has it".
    expect(out).toMatch(/NOT SENT|not.*sent|no peer joined/i);
    expect(out).not.toMatch(/peer already has it/i);

    // And when the peer eventually joins, the cancelled question must not appear.
    const b = await h.peer.join(info.code!);
    const inbound = await b.nextInbound(200);
    expect(inbound).toBeNull();
  });

  it('a pre-join sb_ask cancelled by RPC abort must not send the question after a later join', async () => {
    await h.rpc.callTool({
      name: 'sb_start',
      arguments: { topic: 'abort-then-join', maxTurns: 4 },
    });
    const info = h.mcp.store.list()[0]!;

    // Deliberately no waitMs; rely on RPC cancellation. Before the fix the
    // signal listener is added AFTER #waitForPeer returns, so cancellation
    // during pairing is silently ignored and the question is sent later.
    const cancelled = h.rpc
      .callTool({ name: 'sb_ask', arguments: { callId: info.callId, question: 'must-not-send' } }, undefined, { timeout: 60 })
      .then(() => 'ok', (e) => e.message);
    await cancelled;

    const b = await h.peer.join(info.code!);
    const arrived = await b.nextInbound(300);
    expect(arrived).toBeNull();
  });
});

describe('per-call hangup isolation on the same relay client', () => {
  let h: Harness;
  beforeEach(async () => { h = await makeHarness(); });
  afterEach(async () => { await teardown(h); });

  // End-to-end proof that closing call A leaves call B usable when both
  // sessions share the store's cached client to the same relay. Requires the
  // client's onHangup to fire with (reason, callId) on a wire-delivered
  // hangup; the SessionStore filter is exercised even if the client still
  // only passes reason (callId undefined would close BOTH, failing this test
  // and pinning the client-side dependency).
  it('ending one call leaves other calls on the same client usable', async () => {
    // Call A on the shared client.
    await h.rpc.callTool({ name: 'sb_start', arguments: { topic: 'A' } });
    const infoA = h.mcp.store.list()[0]!;
    const b1 = await h.peer.join(infoA.code!);
    await delay(30);

    // Call B on the same shared client (same relay URL — reuses the cached client).
    await h.rpc.callTool({ name: 'sb_start', arguments: { topic: 'B' } });
    const infoB = h.mcp.store.list().find((s) => s.callId !== infoA.callId)!;
    const b2 = await h.peer.join(infoB.code!);
    await delay(30);

    // The peer hangs up call A only.
    await b1.hangup();
    await delay(80);

    // A closed, B still open and usable end-to-end.
    const sessA = h.mcp.store.require(infoA.callId);
    expect(sessA.info().closed).toBe(true);

    const sessB = h.mcp.store.require(infoB.callId);
    expect(sessB.info().closed).toBe(false);

    // And a real question on B goes through: proves the shared client survives.
    const ask = h.rpc.callTool({
      name: 'sb_ask',
      arguments: { callId: infoB.callId, question: 'still alive?' },
    });
    const query = await b2.nextInbound(1000);
    expect(query?.content).toBe('still alive?');
    await b2.answer(query!.id, 'yes');
    const result = await ask;
    const text = textOf(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain('yes');
  });
});

describe('a recovered response is rendered as an answer, not as a new query', () => {
  let h: Harness;
  beforeEach(async () => { h = await makeHarness(); });
  afterEach(async () => { await teardown(h); });

  it('sb_listen surfaces a late response with its inReplyTo and no answer-back instructions', async () => {
    const { callId, b } = await paired(h);

    // Ask, RPC-cancel, peer answers late, listen recovers.
    const first = h.rpc
      .callTool({ name: 'sb_ask', arguments: { callId, question: 'q' } }, undefined, { timeout: 60 })
      .then(() => 'ok', (e) => e.message);
    const query = await b.nextInbound(500);
    expect(query).not.toBeNull();
    await first;

    await b.answer(query!.id, 'late-answer-payload');
    await delay(50);

    const recovered = await h.rpc.callTool({
      name: 'sb_listen',
      arguments: { callId, timeoutMs: 500 },
    });
    const out = textOf(recovered as { content: Array<{ type: string; text?: string }> });

    expect(out).toContain('late-answer-payload');
    // Response render must carry the correlation to the original question.
    expect(out).toContain(query!.id);
    // The "Answer this from YOUR OWN context..." line is a QUERY branch. A
    // response is already an answer; asking the model to answer it invites
    // duplicate work.
    expect(out).not.toMatch(/Answer this from YOUR OWN context/);
    expect(out).not.toMatch(/call sb_answer\(callId=/);
  });
});
