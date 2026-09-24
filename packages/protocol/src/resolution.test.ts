import { describe, it, expect } from 'vitest';
import {
  decodeIdentity,
  decodeResolution,
  encodeIdentity,
  encodeResolution,
  MAX_POINTS,
  MAX_POINT_CHARS,
} from './resolution.js';

const PEM = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAabc=\n-----END PUBLIC KEY-----\n';
const FP = 'a'.repeat(32);

describe('resolution envelope', () => {
  it('round-trips summary + agreed + contested', () => {
    const r = {
      summary: 'MET with one open point',
      agreed: ['risk limit is 2%', 'max 3 positions'],
      contested: [{ point: 'is 6% portfolio cap enforced?', mine: 'yes, risk.py:9', theirs: 'no such check' }],
    };
    expect(decodeResolution(encodeResolution(r))).toEqual(r);
  });

  it('sends a bare summary when nothing is listed, so an older peer reads plain text', () => {
    const wire = encodeResolution({ summary: 'agreed: ship it' });
    expect(wire).toBe('agreed: ship it');
    expect(decodeResolution(wire)).toEqual({ summary: 'agreed: ship it', agreed: [], contested: [] });
  });

  it('treats ordinary prose and untagged JSON as a plain summary', () => {
    expect(decodeResolution('NOT MET: requirement 2 missing').summary).toBe('NOT MET: requirement 2 missing');
    const raw = JSON.stringify({ summary: 'x', agreed: ['y'] }); // no magpie tag
    expect(decodeResolution(raw)).toEqual({ summary: raw, agreed: [], contested: [] });
  });

  it('never throws on hostile envelopes and filters bad items', () => {
    const hostile = JSON.stringify({
      magpie: 'resolution/1',
      summary: 42,
      agreed: ['ok', 7, '', null],
      contested: ['bare string point', { point: '' }, { point: 'p', mine: 3 }, 'x', null, { nope: 1 }],
    });
    const r = decodeResolution(hostile);
    expect(r.agreed).toEqual(['ok']);
    expect(r.contested).toEqual([{ point: 'bare string point' }, { point: 'p' }, { point: 'x' }]);
    expect(typeof r.summary).toBe('string');
  });

  it('caps list length and item size', () => {
    const r = decodeResolution(
      JSON.stringify({
        magpie: 'resolution/1',
        summary: 's',
        agreed: Array.from({ length: MAX_POINTS + 10 }, (_, i) => `a${i}`),
        contested: [{ point: 'x'.repeat(MAX_POINT_CHARS + 100) }],
      }),
    );
    expect(r.agreed).toHaveLength(MAX_POINTS);
    expect(r.contested?.[0]?.point).toHaveLength(MAX_POINT_CHARS);
  });
});

describe('identity envelope', () => {
  it('round-trips a fingerprint + PEM', () => {
    expect(decodeIdentity(encodeIdentity({ fingerprint: FP, publicKey: PEM }))).toEqual({
      fingerprint: FP,
      publicKey: PEM,
    });
  });

  it('rejects anything that is not a well-formed announcement', () => {
    expect(decodeIdentity('hello')).toBeNull();
    expect(decodeIdentity(JSON.stringify({ magpie: 'identity/1', fingerprint: 'ZZ', publicKey: PEM }))).toBeNull();
    expect(decodeIdentity(JSON.stringify({ magpie: 'identity/1', fingerprint: FP, publicKey: 'not pem' }))).toBeNull();
    expect(decodeIdentity(JSON.stringify({ magpie: 'identity/1', fingerprint: FP, publicKey: PEM.repeat(40) }))).toBeNull();
    // a resolution envelope is not an identity
    expect(decodeIdentity(encodeResolution({ summary: 's', agreed: ['a'] }))).toBeNull();
  });
});
