import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MagpieClient, readReport } from '@magpie/client';
import { startRelay, type RelayHandle } from '@magpie/relay';
import { SessionStore } from './session.js';

let relay: RelayHandle;
let home: string;
let previousHome: string | undefined;
const stores: SessionStore[] = [];
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'magpie-retention-'));
  previousHome = process.env.MAGPIE_HOME;
  process.env.MAGPIE_HOME = home;
  relay = await startRelay(0, { host: '127.0.0.1' });
});
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await relay.close();
  if (previousHome === undefined) delete process.env.MAGPIE_HOME;
  else process.env.MAGPIE_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});
function store(maxSessions = 128) {
  const s = new SessionStore({ self: '@test/retention', relayUrl: `ws://127.0.0.1:${relay.port}`, maxSessions });
  stores.push(s);
  return s;
}

describe('closed call retention', () => {
  it('releases client transcript state after saving and forgetting a hung-up call', async () => {
    const owner = store();
    const session = await owner.start('release');
    await owner.hangup(session.callId);
    expect(readReport(session.callId)?.outcome).toBe('hung-up');
    expect(session.lastReport?.callId).toBe(session.callId);
    expect(session.client.buildReport(session.callId, 'hung-up')).toBeNull();
    expect(owner.list()).toEqual([]);
  });

  it('preserves an unread peer conclusion, then prunes the drained persisted session', async () => {
    const owner = store();
    const peer = store();
    const a = await owner.start('unread conclusion');
    const b = await peer.join(a.code!);
    await expect.poll(() => a.peer).not.toBeNull();
    await a.resolve('retained conclusion');
    expect(peer.list()).toHaveLength(1);
    const terminal = await peer.require(b.callId).nextInbound();
    expect(terminal?.type).toBe('resolve');
    expect(terminal?.content).toBe('retained conclusion');
    expect(b.lastReport?.summary).toBe('retained conclusion');
    expect(peer.list()).toEqual([]);
    expect(b.client.buildReport(b.callId, 'resolved')).toBeNull();
    expect(readReport(b.callId)?.summary).toBe('retained conclusion');
  });

  it('reserves capacity before awaiting concurrent opens and frees it after termination', async () => {
    const owner = store(1);
    const first = owner.start('first');
    await expect(owner.start('over capacity')).rejects.toThrow(/capacity/);
    const session = await first;
    await owner.hangup(session.callId);
    const next = await owner.start('next');
    expect(owner.list()).toHaveLength(1);
    expect(next.callId).not.toBe(session.callId);
  });

  it('releases reservations after invalid joins without losing unread closed replies', async () => {
    const owner = store(1);
    await expect(owner.join('invalid')).rejects.toThrow();
    const peer = store(1);
    const a = await peer.start('late answer');
    const b = await owner.join(a.code!);
    await expect.poll(() => a.peer).not.toBeNull();
    await a.answer('msg-AAAAAAAAAA', 'late answer survives');
    await a.hangup();
    await expect.poll(() => b.closed).toBe(true);
    await expect(owner.start('would evict unread')).rejects.toThrow(/capacity/);
    expect(await b.nextInbound(1, AbortSignal.abort())).toBeNull();
    await expect(owner.start('still unread')).rejects.toThrow(/capacity/);
    expect((await b.nextInbound())?.content).toBe('late answer survives');
    await owner.start('after consumption');
    expect(owner.list()).toHaveLength(1);
  });

  it('retains the only report snapshot when saving fails, even on explicit forget', async () => {
    const owner = store(1);
    const session = await owner.start('save failure');
    mkdirSync(join(home, 'calls', `${session.callId}.json`), { recursive: true });
    await owner.hangup(session.callId);
    owner.forget(session.callId);
    expect(owner.require(session.callId).lastReport?.topic).toBe('save failure');
    expect(session.reportSaved).toBe(false);
    expect(session.client.buildReport(session.callId, 'hung-up')).toBeNull();
    expect(owner.list()).toHaveLength(1);
    await expect(owner.start('no silent loss')).rejects.toThrow(/unsaved reports/);
  });

  it('does not register a call whose opening completes after store shutdown', async () => {
    const client = await MagpieClient.connect(`ws://127.0.0.1:${relay.port}`);
    const owner = new SessionStore({ self: '@test/retention', relayUrl: 'ws://test', connect: async () => client });
    stores.push(owner);
    const start = client.start.bind(client);
    client.start = async opts => {
      const opened = await start(opts);
      owner.close();
      return opened;
    };
    await expect(owner.start('shutdown race')).rejects.toThrow(/store closed/);
    expect(owner.list()).toEqual([]);
    expect(client.isConnected).toBe(false);
    await expect(owner.start('after shutdown')).rejects.toThrow(/store is closed/);
  });

  it('reuses bounded capacity across repeated closed calls while retaining disk reports', async () => {
    const owner = store(1);
    for (let i = 0; i < 20; i++) {
      const session = await owner.start(`iteration ${i}`);
      await session.hangup();
      expect(session.client.buildReport(session.callId, 'hung-up')).toBeNull();
      expect(readReport(session.callId)?.topic).toBe(`iteration ${i}`);
    }
    expect(owner.list()).toEqual([]);
  });

  it('closes a connection that finishes after store shutdown', async () => {
    const client = await MagpieClient.connect(`ws://127.0.0.1:${relay.port}`);
    let finish!: (client: MagpieClient) => void;
    const connecting = new Promise<MagpieClient>(resolve => { finish = resolve; });
    const owner = new SessionStore({ self: '@test/retention', relayUrl: 'ws://test', connect: () => connecting });
    stores.push(owner);
    const opening = owner.start('connecting');
    owner.close();
    finish(client);
    await expect(opening).rejects.toThrow(/store closed during connection/);
    expect(client.isConnected).toBe(false);
    expect(owner.list()).toEqual([]);
  });
});
