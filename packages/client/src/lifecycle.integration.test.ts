import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { newMessageId, PROTOCOL_VERSION, rendezvousId, type Message } from '@magpie/protocol';
import { startRelay, type RelayHandle } from '@magpie/relay';
import { MagpieClient } from './client.js';

let relay: RelayHandle;
const clients: MagpieClient[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const s of sockets.splice(0)) s.terminate();
  if (relay) await relay.close();
});
async function client() {
  const c = await MagpieClient.connect(`ws://127.0.0.1:${relay.port}`);
  clients.push(c);
  return c;
}
async function pair(maxTurns = 2) {
  relay = await startRelay(0, { host: '127.0.0.1' });
  const a = await client();
  const b = await client();
  const opened = await a.start({ from: '@test/a', topic: 'lifecycle', maxTurns });
  const joined = new Promise<void>(r => a.onPeerJoined(() => r()));
  await b.join({ from: '@test/b', code: opened.code });
  await joined;
  return { a, b, ...opened };
}
function message(callId: string, from: '@test/a' | '@test/b', type: 'query' | 'response', inReplyTo: string | null = null): Message {
  return { v: PROTOCOL_VERSION, id: newMessageId(), callId, from, to: from === '@test/a' ? '@test/b' : '@test/a', type, ts: new Date().toISOString(), turn: 0, inReplyTo, content: 'test' };
}

describe('call lifecycle', () => {
  it('removes an unpaired invitation before reporting hangup success', async () => {
    relay = await startRelay(0, { host: '127.0.0.1' });
    const a = await client();
    const { callId, code } = await a.start({ from: '@test/a', topic: 'cancel' });
    await a.hangup(callId);
    const b = await client();
    await expect(b.join({ from: '@test/b', code })).rejects.toThrow('UNKNOWN_RENDEZVOUS');
  });

  it('keeps room for a received resolution after the full requested conversation', async () => {
    const { a, b, callId } = await pair();
    const inbound = new Promise<Message>(r => b.onMessage(r));
    const q = message(callId, '@test/a', 'query');
    await a.send(callId, q);
    await inbound;
    const reply = new Promise<Message>(r => a.onMessage(r));
    await b.send(callId, message(callId, '@test/b', 'response', q.id));
    await reply;
    await a.resolve(callId, 'done');
    expect(a.buildReport(callId, 'resolved')?.summary).toBe('done');
    expect(b.buildReport(callId, 'resolved')?.summary).toBe('done');
  });

  it('rejects simultaneous conclusions instead of reporting different successful summaries', async () => {
    const { a, b, callId } = await pair(12);
    const accepted: string[] = [];
    a.onResolved((_id, summary) => accepted.push(summary));
    b.onResolved((_id, summary) => accepted.push(summary));
    const outcomes = await Promise.allSettled([
      a.resolve(callId, 'conclusion A'), b.resolve(callId, 'conclusion B'),
    ]);
    expect(outcomes.map(o => o.status)).toEqual(['rejected', 'rejected']);
    expect(accepted).toEqual([]);
    for (const c of [a, b]) {
      expect(c.buildReport(callId, 'hung-up')?.summary).toBeNull();
      await expect(c.send(callId, message(callId, '@test/a', 'query'))).rejects.toThrow(/no channel/);
    }
  });

  it('fails honestly if the absolute relay cap rejects a conclusion', async () => {
    const { a, b, callId } = await pair(50);
    for (let n = 0; n < 48; n++) {
      const inbound = new Promise<Message>(r => b.onMessage(r));
      await a.send(callId, message(callId, '@test/a', 'query'));
      await inbound;
    }
    await expect(a.resolve(callId, 'over cap')).rejects.toThrow(/receipt|closed/);
    expect(a.buildReport(callId, 'hung-up')?.summary).toBeNull();
    expect(b.buildReport(callId, 'hung-up')?.summary).toBeNull();
  });

  it('does not mistake a peer hangup for receipt of the resolution', async () => {
    relay = await startRelay(0, { host: '127.0.0.1' });
    const a = await client();
    const { callId, code, channel } = await a.start({ from: '@test/a', topic: 'legacy peer' });
    const ws = new WebSocket(`ws://127.0.0.1:${relay.port}`);
    sockets.push(ws);
    await new Promise<void>(r => ws.once('open', r));
    const paired = new Promise<void>(r => a.onPeerJoined(() => r()));
    ws.on('message', d => {
      const f = JSON.parse(d.toString());
      if (f.t !== 'deliver') return;
      const msg = JSON.parse(Buffer.from(channel.open(Buffer.from(f.frame, 'base64'))).toString());
      if (msg.type === 'resolve') {
        const receipt = { ...msg, id: newMessageId(), from: '@test/b', to: '@test/a', type: 'system', inReplyTo: newMessageId(), content: 'magpie:resolution-received/1' };
        ws.send(JSON.stringify({ t: 'send', callId, frame: Buffer.from(channel.seal(Buffer.from(JSON.stringify(receipt)))).toString('base64') }));
        ws.send(JSON.stringify({ t: 'hangup', callId }));
      }
    });
    ws.send(JSON.stringify({ t: 'join', rendezvousId: rendezvousId(code), from: '@test/b' }));
    await paired;
    await expect(a.resolve(callId, 'not acknowledged')).rejects.toThrow(/receipt|confirm|closed/);
    expect(a.buildReport(callId, 'hung-up')?.summary).toBeNull();
  });
});
