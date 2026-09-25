import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newCallId, type CallReport } from '@magpie/protocol';
import { readReport, saveReport } from './reports.js';
import { parseRelayFrame } from './wire.js';

describe('report identifier boundaries', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'magpie-report-boundary-'));
    vi.stubEnv('MAGPIE_HOME', home);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  function report(callId: string): CallReport {
    return { callId, topic: 'test', me: '@test/a', peer: null, outcome: 'hung-up',
      summary: null, identity: { me: null, peer: null }, turns: 0, startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(), transcript: [] };
  }

  it('refuses invalid report identifiers before creating or reading paths', () => {
    expect(() => saveReport(report('../escaped-report'))).toThrow();
    expect(existsSync(join(home, 'escaped-report.json'))).toBe(false);
    expect(readReport('../escaped-report')).toBeNull();
  });

  it('preserves valid report round trips', () => {
    const r = report(newCallId());
    expect(saveReport(r)).toBe(join(home, 'calls', `${r.callId}.json`));
    expect(readReport(r.callId)).toEqual(r);
  });

  it('rejects invalid identifiers and peer addresses on every relay control path', () => {
    for (const t of ['opened', 'joined', 'peer-joined', 'deliver', 'hangup']) {
      expect(parseRelayFrame({ t, callId: '../escaped-report', peer: '@test/b', frame: 'AAAA', reason: 'done' })).toBeNull();
    }
    for (const t of ['joined', 'peer-joined']) {
      expect(parseRelayFrame({ t, callId: newCallId(), peer: 'not-an-extension' })).toBeNull();
    }
    const callId = newCallId();
    expect(parseRelayFrame({ t: 'opened', callId })).toEqual({ t: 'opened', callId });
  });
});
