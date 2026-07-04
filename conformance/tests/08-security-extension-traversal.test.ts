import { describe, it, expect } from 'vitest';
import { EXTENSION_RE, Extension, assertSafeExtension } from '@magpie/protocol';

/**
 * SECURITY (b): an extension containing "../" (or any path-traversal / id-spoof
 * shape) is rejected by BOTH gates — the EXTENSION_RE / zod schema (first line
 * of defense) AND assertSafeExtension (defense in depth before any persistence
 * keyed by the address).
 *
 * This is the exact vuln class from prior art: an id interpolated unvalidated
 * into a filesystem path. The corpus pins that neither gate can be slipped.
 */
describe('conformance/08 security — "../" extension is rejected', () => {
  const TRAVERSAL: string[] = [
    '@alice/../etc',
    '@../root/x',
    '@alice/impl/../../secret',
    '@a/..',
    '@../../x',
    '@alice/..%2f',
  ];

  const SPOOFY: string[] = [
    '@alice/impl/extra', // too many segments
    'alice/impl', // missing leading @
    '@Alice/Impl', // uppercase not allowed
    '@alice\\impl', // backslash
    '@alice//impl', // empty role
    '@/impl', // empty owner
    '@alice/impl ', // trailing space
    '@alice/im pl', // inner space
  ];

  const VALID: string[] = ['@alice/impl', '@bob/strategy', '@a1/b2', '@x-y/z-w'];

  it('EXTENSION_RE rejects every traversal shape', () => {
    for (const ext of TRAVERSAL) {
      expect(EXTENSION_RE.test(ext), ext).toBe(false);
    }
  });

  it('the zod Extension schema rejects every traversal shape', () => {
    for (const ext of TRAVERSAL) {
      expect(Extension.safeParse(ext).success, ext).toBe(false);
    }
  });

  it('assertSafeExtension throws on every traversal shape', () => {
    for (const ext of TRAVERSAL) {
      expect(() => assertSafeExtension(ext), ext).toThrow(/unsafe extension/);
    }
  });

  it('EXTENSION_RE rejects other id-spoofing shapes too', () => {
    for (const ext of SPOOFY) {
      expect(EXTENSION_RE.test(ext), ext).toBe(false);
    }
  });

  it('accepts only well-formed @owner/role extensions through every gate', () => {
    for (const ext of VALID) {
      expect(EXTENSION_RE.test(ext), ext).toBe(true);
      expect(Extension.safeParse(ext).success, ext).toBe(true);
      expect(() => assertSafeExtension(ext), ext).not.toThrow();
    }
  });
});
