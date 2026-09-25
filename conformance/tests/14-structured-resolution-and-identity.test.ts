import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRelay } from '@magpie/relay';
import type { RelayHandle } from '@magpie/relay';
import { MagpieClient, loadOrCreateIdentity, toRef } from '@magpie/client';
import { newMessageId, PROTOCOL_VERSION } from '@magpie/protocol';
import type { Extension, Message, Resolution } from '@magpie/protocol';

/**
 * Two things the AX hand-off depends on, end to end through a real relay:
 *
 *  1. A structured resolution ({summary, agreed[], contested[]}) reaches the
 *     peer intact and lands in BOTH reports, while the wire message schema is
 *     untouched (the relay still sees only sealed frames it cannot read).
 *  2. Each side's identity fingerprint lands in the OTHER side's report,
 *     without ever appearing in the transcript or costing the caller a turn.
 */
const A_EXT = '@a/impl' as Extension;
const B_EXT = '@b/strategy' as Extension;

function query(callId: string, from: Extension, to: Extension, content: string, turn = 0): Message {
  return { v: PROTOCOL_VERSION, id: newMessageId(), callId, from, to, type: 'query', ts: new Date().toISOString(), turn, inReplyTo: null, content };
}
const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

describe('structured resolution + identity attribution', () => {
  let relay: RelayHandle | undefined;
  const dirs: string[] = [];
  const idDir = () => {
    const d = mkdtempSync(join(tmpdir(), 'magpie-conf-id-'));
    dirs.push(d);
    return d;
  };
  afterEach(async () => {
    if (relay) {
      await relay.close();
      relay = undefined;
    }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('agreed/contested reach the peer; both reports carry them and each other\'s fingerprint', async () => {
    relay = await startRelay(0, { host: '127.0.0.1' });
    const url = `ws://127.0.0.1:${relay.port}`;
    const idA = toRef(loadOrCreateIdentity(idDir()));
    const idB = toRef(loadOrCreateIdentity(idDir()));
    expect(idA.fingerprint).not.toBe(idB.fingerprint);

    // Sniff every client→relay frame at the WebSocketServer itself. This is the
    // relay's own view: whatever appears here in cleartext, a relay operator
    // can read. The topic must not.
    const relaySaw: string[] = [];
    relay.wss.on('connection', (sock) => sock.on('message', (d) => relaySaw.push(d.toString())));

    const A = await MagpieClient.connect(url, { identity: idA });
    const B = await MagpieClient.connect(url, { identity: idB });
    const bSeen: Resolution[] = [];
    B.onResolved((_c, _s, r) => bSeen.push(r));
    const bMsgs: Message[] = [];
    B.onMessage((m) => bMsgs.push(m));

    const started = await A.start({ from: A_EXT, topic: 'risk limit' });
    const joined = await B.join({ from: B_EXT, code: started.code });
    await settle();

    await A.send(started.callId, query(started.callId, A_EXT, B_EXT, 'is the 6% cap enforced?'));
    await settle();

    const resolution: Resolution = {
      summary: 'MET on 2%, open on the portfolio cap',
      agreed: ['per-trade risk is 2% (risk.py:4)'],
      contested: [{ point: 'portfolio cap 6%', mine: 'enforced at positions.py:12', theirs: 'no such check exists' }],
    };
    await A.resolve(started.callId, resolution);
    await settle();

    // Peer got the structure, not just the summary.
    expect(bSeen).toEqual([resolution]);
    // Identity frames never surfaced as messages.
    expect(bMsgs.map((m) => m.type)).toEqual(['query']);

    const ra = A.buildReport(started.callId, 'resolved')!;
    const rb = B.buildReport(joined.callId, 'resolved')!;
    for (const r of [ra, rb]) {
      expect(r.summary).toBe(resolution.summary);
      expect(r.agreed).toEqual(resolution.agreed);
      expect(r.contested).toEqual(resolution.contested);
      // transcript: query + resolve only. No identity frames, and the resolve
      // entry holds the summary, not the envelope.
      expect(r.transcript.map((t) => t.type)).toEqual(['query', 'resolve']);
      expect(r.transcript[1]?.content).toBe(resolution.summary);
      expect(r.turns).toBe(2);
    }
    expect(ra.identity).toEqual({ me: idA, peer: idB });
    expect(rb.identity).toEqual({ me: idB, peer: idA });

    // The joiner's report is titled by the opener's topic, delivered inside the
    // sealed hello — not by the relay, which never forwarded it.
    expect(rb.topic).toBe('risk limit');
    // And the relay never had it: the cleartext open frame carried an empty
    // topic, and the string appears nowhere in anything the relay received.
    const open = relaySaw.map((f) => JSON.parse(f) as { t: string; topic?: string }).find((f) => f.t === 'open');
    expect(open?.topic).toBe('');
    expect(relaySaw.some((f) => f.includes('risk limit'))).toBe(false);
    A.close();
    B.close();
  });

  it('interoperates with a peer that announces no identity and resolves with a bare string', async () => {
    relay = await startRelay(0, { host: '127.0.0.1' });
    const url = `ws://127.0.0.1:${relay.port}`;
    const idA = toRef(loadOrCreateIdentity(idDir()));
    const A = await MagpieClient.connect(url, { identity: idA });
    const C = await MagpieClient.connect(url); // older-build shape: no identity

    const started = await A.start({ from: A_EXT, topic: 't' });
    const joined = await C.join({ from: B_EXT, code: started.code });
    await settle();
    await C.resolve(joined.callId, 'agreed: ship it');
    await settle();

    const ra = A.buildReport(started.callId, 'resolved')!;
    const rc = C.buildReport(joined.callId, 'resolved')!;
    // C has no key but still received A's hello, topic included.
    expect(rc.topic).toBe('t');
    expect(ra.summary).toBe('agreed: ship it');
    expect(ra.agreed).toEqual([]);
    expect(ra.contested).toEqual([]);
    expect(ra.identity).toEqual({ me: idA, peer: null });
    // C announced nothing but still recorded A's announcement.
    expect(rc.identity).toEqual({ me: null, peer: idA });
    // A non-resolved report omits the lists entirely.
    const open = A.buildReport(started.callId, 'hung-up')!;
    expect('agreed' in open).toBe(false);
    A.close();
    C.close();
  });

  it('identity announcements do not eat the caller\'s turn budget', async () => {
    relay = await startRelay(0, { host: '127.0.0.1' });
    const url = `ws://127.0.0.1:${relay.port}`;
    const A = await MagpieClient.connect(url, { identity: toRef(loadOrCreateIdentity(idDir())) });
    const B = await MagpieClient.connect(url, { identity: toRef(loadOrCreateIdentity(idDir())) });
    const hangups: string[] = [];
    A.onHangup((r) => hangups.push(r));

    // maxTurns: 1 means ONE real message plus the resolve that ends the call.
    // Three sealed frames are reserved (a hello per side, one resolve), so the
    // first message is free of them. A call that never resolves spends its
    // resolve reservation on a message instead, which is why the cap trips on
    // the THIRD send here and not the second: one message of slack is the price
    // of never handing a resolver a cap breach.
    const started = await A.start({ from: A_EXT, topic: 't', maxTurns: 1 });
    await B.join({ from: B_EXT, code: started.code });
    await settle();
    await A.send(started.callId, query(started.callId, A_EXT, B_EXT, 'one'));
    await settle();
    expect(hangups).toEqual([]);
    await A.send(started.callId, query(started.callId, A_EXT, B_EXT, 'two', 1));
    await settle();
    expect(hangups).toEqual([]);
    await A.send(started.callId, query(started.callId, A_EXT, B_EXT, 'three', 2));
    await settle();
    expect(hangups.some((h) => /turn cap/.test(h))).toBe(true);
    A.close();
    B.close();
  });

  it('a resolve at the caller\'s turn cap is delivered, not rejected as a cap breach', async () => {
    relay = await startRelay(0, { host: '127.0.0.1' });
    const url = `ws://127.0.0.1:${relay.port}`;
    const A = await MagpieClient.connect(url, { identity: toRef(loadOrCreateIdentity(idDir())) });
    const B = await MagpieClient.connect(url, { identity: toRef(loadOrCreateIdentity(idDir())) });
    const bResolved: string[] = [];
    B.onResolved((_c, s2) => bResolved.push(s2));

    // maxTurns: 2 means two messages between the agents. The resolve frame is a
    // third sealed send on top of the two hellos, so the reserved budget has to
    // cover it: before this it tripped the cap and A reported `resolved` while B
    // reported `turn-cap` with a null summary for the same call.
    const started = await A.start({ from: A_EXT, topic: 'cap', maxTurns: 2 });
    const joined = await B.join({ from: B_EXT, code: started.code });
    await settle();
    await A.send(started.callId, query(started.callId, A_EXT, B_EXT, 'q'));
    await settle();
    await B.send(joined.callId, { ...query(joined.callId, B_EXT, A_EXT, 'a', 1), type: 'response' });
    await settle();
    await A.resolve(started.callId, 'settled at the cap');
    await settle();

    expect(bResolved).toEqual(['settled at the cap']);
    expect(A.buildReport(started.callId, 'resolved')?.outcome).toBe('resolved');
    expect(B.buildReport(joined.callId, 'resolved')?.summary).toBe('settled at the cap');
    A.close();
    B.close();
  });
});
