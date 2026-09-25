import { spawn } from 'node:child_process';
import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** One POSIX process group per run. Only that owned group is ever signalled. */
export async function supervise({ command, args = [], cwd, stateDir, timeoutMs = 900000, graceMs = 5000, signal, onOutput = () => {}, validateExit = () => undefined, finalize = async () => {} }) {
  if (process.platform === 'win32') throw new Error('process-group supervision requires POSIX');
  if (!(timeoutMs > 0 && graceMs > 0)) throw new Error('timeouts must be positive');
  await mkdir(stateDir, { recursive: true });
  const lock = join(stateDir, 'active');
  await mkdir(lock); // Atomic lock; a second run must not launch another worker.
  const result = { status: 'running', startedAt: new Date().toISOString(), supervisorPid: process.pid };
  let child, deadline, force;
  let groupStopped = false;
  const stopGroup = (sig) => {
    if (!child?.pid || groupStopped) return;
    try { process.kill(-child.pid, sig); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    if (sig === 'SIGKILL') groupStopped = true;
  };
  const stop = (status) => {
    if (result.status === 'timed-out' || result.status === 'cancelled') return;
    result.status = status;
    stopGroup('SIGTERM');
    force = setTimeout(() => stopGroup('SIGKILL'), graceMs);
  };
  const abort = () => stop('cancelled');
  try {
    await writeFile(join(lock, 'owner.json'), JSON.stringify(result));
    if (signal?.aborted) { result.status = 'cancelled'; return result; }
    child = spawn(command, args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    result.childPid = child.pid;
    const drained = new Promise(resolve => child.once('close', resolve));
    // Drain output continuously; no unbounded stdout buffer or raw prompt logs.
    child.stdout.on('data', d => onOutput('stdout', d.toString()));
    child.stderr.on('data', d => onOutput('stderr', d.toString()));
    signal?.addEventListener('abort', abort, { once: true });
    deadline = setTimeout(() => stop('timed-out'), timeoutMs);
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    void exited.catch(() => undefined);
    await writeFile(join(lock, 'owner.json'), JSON.stringify(result));
    const exit = await exited;
    // Stop inherited MCP children before waiting for pipe closure.
    stopGroup('SIGKILL');
    await drained;
    Object.assign(result, exit);
    if (result.status !== 'timed-out' && result.status !== 'cancelled') {
      const failure = validateExit();
      if (failure) result.error = failure;
      result.status = exit.code === 0 && !failure ? 'completed' : 'failed';
    }
    return result;
  } catch (error) {
    result.status = 'failed';
    result.error = String(error);
    return result;
  } finally {
    clearTimeout(deadline);
    clearTimeout(force);
    signal?.removeEventListener('abort', abort);
    // Also clean descendants that outlive a normally exiting parent (MCP hosts).
    stopGroup('SIGKILL');
    result.endedAt = new Date().toISOString();
    try { await finalize(result); } catch (error) { result.status = 'failed'; result.error = String(error); }
    try {
      await writeFile(join(stateDir, 'last-result.tmp'), JSON.stringify(result, null, 2) + '\n');
      await rename(join(stateDir, 'last-result.tmp'), join(stateDir, 'last-result.json'));
    } finally { await rm(lock, { recursive: true, force: true }); }
  }
}
