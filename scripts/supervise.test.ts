import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, access, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-ignore plain Node supervisor, shared by automation and these process tests
import { supervise } from './supervise.mjs';

async function run(code: string, overrides = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'magpie-supervisor-'));
  try {
    const result = await supervise({ command: process.execPath, args: ['-e', code], stateDir, timeoutMs: 250, graceMs: 30, ...overrides });
    expect(JSON.parse(await readFile(join(stateDir, 'last-result.json'), 'utf8'))).toMatchObject(result);
    await expect(access(join(stateDir, 'active'))).rejects.toThrow();
    return result;
  } finally { await rm(stateDir, { recursive: true, force: true }); }
}
describe('owned worker lifecycle', () => {
  it('persists a normal result and releases its lock', async () => {
    expect((await run('process.exit(0)')).status).toBe('completed');
  });
  it('escalates to SIGKILL when the worker ignores SIGTERM', async () => {
    const r = await run("process.on('SIGTERM',()=>{});setInterval(()=>{},1000)");
    expect(r.status).toBe('timed-out');
    expect(r.signal).toBe('SIGKILL');
    expect(() => process.kill(r.childPid, 0)).toThrow();
  });
  it('cleans an inherited worker process after its parent exits', async () => {
    let output = '';
    await run("const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);c.unref()", {
      onOutput: (stream: string, chunk: string) => { if (stream === 'stdout') output += chunk; },
    });
    const pid = Number(output.trim());
    expect(pid).toBeGreaterThan(0);
    await new Promise(r => setTimeout(r, 50));
    expect(() => process.kill(pid, 0)).toThrow();
  });
  it('refuses a second run without disturbing the existing lock', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'magpie-lock-'));
    try {
      await mkdir(join(stateDir, 'active'));
      await expect(supervise({ command: process.execPath, args: ['-e', 'process.exit(0)'], stateDir })).rejects.toMatchObject({ code: 'EEXIST' });
      await access(join(stateDir, 'active'));
    } finally { await rm(stateDir, { recursive: true, force: true }); }
  });
  it('reports command failure rather than completion', async () => {
    expect((await run('process.exit(7)')).status).toBe('failed');
  });
  it('does not spawn for an already cancelled invocation', async () => {
    const r = await run('process.exit(0)', { signal: AbortSignal.abort() });
    expect(r.status).toBe('cancelled');
    expect(r.childPid).toBeUndefined();
  });
});
