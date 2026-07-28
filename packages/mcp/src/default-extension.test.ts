import { describe, it, expect } from 'vitest';
import { EXTENSION_RE } from '@magpie/protocol';
import {
  sanitizeSegment,
  osUsername,
  defaultExtension,
  resolveExtension,
  FALLBACK_OWNER,
} from './default-extension.js';

describe('sanitizeSegment', () => {
  it('lowercases and keeps already-valid names intact', () => {
    expect(sanitizeSegment('alice')).toBe('alice');
    expect(sanitizeSegment('ALICE')).toBe('alice');
    expect(sanitizeSegment('user2')).toBe('user2');
    expect(sanitizeSegment('a-b-c')).toBe('a-b-c');
  });

  it('collapses the separators real usernames actually contain', () => {
    // the three shapes that broke `@$(whoami)/main`
    expect(sanitizeSegment('Sang Hoon')).toBe('sang-hoon'); // macOS full-name account
    expect(sanitizeSegment('John.Doe')).toBe('john-doe'); // corporate login
    expect(sanitizeSegment('CORP\\alice')).toBe('corp-alice'); // Windows domain
  });

  it('collapses runs rather than emitting repeated hyphens', () => {
    expect(sanitizeSegment('a   b')).toBe('a-b');
    expect(sanitizeSegment('a...b')).toBe('a-b');
  });

  it('strips leading and trailing separators', () => {
    expect(sanitizeSegment('_alice_')).toBe('alice');
    expect(sanitizeSegment('-alice-')).toBe('alice');
    expect(sanitizeSegment('.alice.')).toBe('alice');
  });

  it('returns empty when nothing survives, rather than an invalid segment', () => {
    expect(sanitizeSegment('')).toBe('');
    expect(sanitizeSegment('___')).toBe('');
    expect(sanitizeSegment('한글')).toBe(''); // non-latin: no salvageable chars
    expect(sanitizeSegment('🙂')).toBe('');
  });

  it('truncates to the 31-char segment limit', () => {
    const long = 'a'.repeat(80);
    expect(sanitizeSegment(long)).toHaveLength(31);
  });

  it('never leaves a trailing hyphen after truncation', () => {
    // 31 chars then a separator run: the cut must not strand a '-'
    const name = `${'a'.repeat(31)} suffix`;
    const out = sanitizeSegment(name);
    expect(out.endsWith('-')).toBe(false);
    expect(out).toBe('a'.repeat(31));
  });
});

describe('osUsername', () => {
  it('prefers an explicit override, then the platform vars in order', () => {
    expect(osUsername({ MAGPIE_DEFAULT_OWNER: 'x', USER: 'y' })).toBe('x');
    expect(osUsername({ USER: 'y', USERNAME: 'z' })).toBe('y');
    expect(osUsername({ USERNAME: 'z', LOGNAME: 'w' })).toBe('z'); // Windows
    expect(osUsername({ LOGNAME: 'w' })).toBe('w');
    expect(osUsername({})).toBe('');
  });
});

describe('defaultExtension', () => {
  it('derives a VALID extension from ordinary usernames', () => {
    expect(defaultExtension({ USER: 'alice' })).toBe('@alice/main');
    expect(EXTENSION_RE.test(defaultExtension({ USER: 'alice' }))).toBe(true);
  });

  it('produces a valid extension for every username that used to break it', () => {
    // the whole point: these all passed `@$(whoami)/main` straight into a
    // config the MCP then rejected as malformed.
    const hostile = [
      'Sang Hoon',
      'John.Doe',
      'CORP\\alice',
      'ADMIN',
      '___',
      'the owner',
      '🙂',
      '',
      'a'.repeat(80),
      '-leading',
      'trailing-',
      'user@host',
      '2fast',
    ];
    for (const name of hostile) {
      const ext = defaultExtension({ USER: name });
      expect(EXTENSION_RE.test(ext), `username ${JSON.stringify(name)} -> ${ext}`).toBe(true);
    }
  });

  it('falls back when the username yields nothing usable', () => {
    expect(defaultExtension({ USER: '___' })).toBe(`@${FALLBACK_OWNER}/main`);
    expect(defaultExtension({})).toBe(`@${FALLBACK_OWNER}/main`);
  });
});

describe('resolveExtension', () => {
  it('uses an explicit MAGPIE_EXTENSION and reports it as not derived', () => {
    expect(resolveExtension({ MAGPIE_EXTENSION: '@alice/impl', USER: 'other' })).toEqual({
      extension: '@alice/impl',
      derived: false,
    });
  });

  it('passes an INVALID explicit value through untouched', () => {
    // silently rewriting it would hide the operator's typo behind a working
    // but wrong address; the downstream validator must still complain.
    expect(resolveExtension({ MAGPIE_EXTENSION: '@BAD/../x' })).toEqual({
      extension: '@BAD/../x',
      derived: false,
    });
  });

  it('treats blank/whitespace as unset', () => {
    expect(resolveExtension({ MAGPIE_EXTENSION: '', USER: 'alice' })).toEqual({
      extension: '@alice/main',
      derived: true,
    });
    expect(resolveExtension({ MAGPIE_EXTENSION: '   ', USER: 'alice' })).toEqual({
      extension: '@alice/main',
      derived: true,
    });
  });

  it('derives when unset', () => {
    expect(resolveExtension({ USER: 'alice' })).toEqual({
      extension: '@alice/main',
      derived: true,
    });
  });
});
