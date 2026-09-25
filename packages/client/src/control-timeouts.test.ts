import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Socket } from 'node:net';
import { WebSocketServer } from 'ws';
import { generatePairingCode, newCallId } from '@magpie/protocol';
import { MagpieClient } from './client.js';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function outcome(promise: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise.then(() => 'fulfilled', error => String(error)),
      new Promise<string>(resolve => { timer = setTimeout(() => resolve('still pending'), 500); }),
    ]);
  } finally { clearTimeout(timer!); }
}

async function silentRelay() {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(resolve => server.once('listening', resolve));
  cleanup.push(() => new Promise<void>(resolve => {
    for (const socket of server.clients) socket.terminate();
    server.close(() => resolve());
  }));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('unexpected address');
  const client = await MagpieClient.connect(`ws://127.0.0.1:${address.port}`, {
    connectTimeoutMs: 40, requestTimeoutMs: 40,
  });
  cleanup.push(() => client.close());
  return { client, server };
}

describe('bounded relay control waits', () => {
  it('rejects a silent WebSocket handshake and closes its TCP socket', async () => {
    const sockets = new Set<Socket>();
    let accepted = false;
    let disconnected = false;
    const server = createServer(socket => {
      accepted = true;
      sockets.add(socket);
      socket.on('data', () => undefined);
      socket.once('close', () => { sockets.delete(socket); disconnected = true; });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>(resolve => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('unexpected address');
    const result = await outcome(MagpieClient.connect(`ws://127.0.0.1:${address.port}`, { connectTimeoutMs: 40 }));
    expect(result).toMatch(/timed out|timeout/i);
    expect(accepted).toBe(true);
    await expect.poll(() => disconnected).toBe(true);
  });

  it.each(['open', 'join'] as const)('bounds a silent %s reply and invalidates the connection', async operation => {
    const { client, server } = await silentRelay();
    const closed = new Promise<void>(resolve => [...server.clients][0]!.once('close', () => resolve()));
    const call = operation === 'open'
      ? client.start({ from: '@test/a', topic: 'silent relay' })
      : client.join({ from: '@test/a', code: generatePairingCode() });
    expect(await outcome(call)).toMatch(/timed out|timeout/i);
    expect(client.isConnected).toBe(false);
    await closed;
    await expect(client.start({ from: '@test/a', topic: 'no reuse' })).rejects.toThrow(/not connected/);
  });

  it('bounds the entire handshake even if incomplete headers keep arriving', async () => {
    const sockets = new Set<Socket>();
    const server = createServer(socket => {
      sockets.add(socket);
      socket.on('data', () => undefined);
      socket.write('HTTP/1.1 101 Switching Protocols\r\nX-Drip: ');
      const drip = setInterval(() => socket.write('x'), 10);
      socket.once('close', () => { clearInterval(drip); sockets.delete(socket); });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>(resolve => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('unexpected address');
    expect(await outcome(MagpieClient.connect(`ws://127.0.0.1:${address.port}`, { connectTimeoutMs: 40 })))
      .toMatch(/timed out|timeout/i);
    await expect.poll(() => sockets.size).toBe(0);
  });

  it('rejects all outstanding requests and notifies existing calls once on timeout', async () => {
    const { client, server } = await silentRelay();
    const socket = [...server.clients][0]!;
    const callId = newCallId();
    socket.once('message', () => socket.send(JSON.stringify({ t: 'opened', callId })));
    await client.start({ from: '@test/a', topic: 'existing call' });
    const hangups: (string | null | undefined)[] = [];
    client.onHangup((_reason, id) => hangups.push(id));
    const results = await Promise.all([
      outcome(client.start({ from: '@test/a', topic: 'unanswered' })),
      outcome(client.join({ from: '@test/b', code: generatePairingCode() })),
      outcome(client.hangup(callId)),
    ]);
    expect(results.every(result => /timed out/.test(result))).toBe(true);
    expect(client.isConnected).toBe(false);
    await expect.poll(() => server.clients.size).toBe(0);
    expect(hangups).toEqual([null]);
  });

  it('clears deadlines after successful replies and relay errors', async () => {
    const { client, server } = await silentRelay();
    const socket = [...server.clients][0]!;
    socket.once('message', () => socket.send(JSON.stringify({ t: 'opened', callId: newCallId() })));
    await client.start({ from: '@test/a', topic: 'successful' });
    socket.once('message', () => socket.send(JSON.stringify({ t: 'error', code: 'TEST', message: 'refused' })));
    await expect(client.start({ from: '@test/a', topic: 'refused' })).rejects.toThrow('refused');
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(client.isConnected).toBe(true);
  });

  it('rejects pending requests immediately on explicit close', async () => {
    const { client } = await silentRelay();
    const pending = outcome(client.start({ from: '@test/a', topic: 'cancel' }));
    client.close();
    expect(await pending).toMatch(/client closed/);
  });

  it.each([0, -1, NaN, Infinity, 0.5, 2_147_483_648])('rejects invalid timeout %s before opening a socket', async ms => {
    await expect(MagpieClient.connect('ws://127.0.0.1:1', { connectTimeoutMs: ms })).rejects.toThrow(/control timeout/);
    await expect(MagpieClient.connect('ws://127.0.0.1:1', { requestTimeoutMs: ms })).rejects.toThrow(/control timeout/);
  });
});
