import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallReport, Extension } from '@magpie/protocol';
import { callsDir, readReport, saveReport } from './reports.js';

const report = (callId: string): CallReport => ({
  callId,
  topic: 't',
  me: '@alice/impl' as Extension,
  peer: '@bob/strategy' as Extension,
  outcome: 'resolved',
  summary: 's',
  identity: { me: null, peer: null },
  turns: 1,
  startedAt: new Date().toISOString(),
  endedAt: new Date().toISOString(),
  transcript: [],
});

describe('report store keeps writes inside the calls directory', () => {
  let home: string;
  let prev: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'magpie-reports-'));
    prev = process.env.MAGPIE_HOME;
    process.env.MAGPIE_HOME = home;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.MAGPIE_HOME;
    else process.env.MAGPIE_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  });

  it('writes a well-formed callId into the calls directory', () => {
    const path = saveReport(report('call-abcdefghij12'));
    expect(path).toBe(join(callsDir(), 'call-abcdefghij12.json'));
    expect(existsSync(path)).toBe(true);
    expect(readReport('call-abcdefghij12')?.summary).toBe('s');
  });

  it('refuses a callId that would escape the directory', () => {
    // The wire layer rejects these first; this is the second line of defence,
    // so it is tested on its own rather than trusting that one.
    for (const bad of ['../escaped', '../../etc/passwd', 'a/b', '..']) {
      expect(() => saveReport(report(bad))).toThrow(/refusing a report path/);
      expect(readReport(bad)).toBeNull();
    }
    expect(existsSync(callsDir()) ? readdirSync(callsDir()) : []).toEqual([]);
    expect(readdirSync(home)).not.toContain('escaped.json');
  });
});
