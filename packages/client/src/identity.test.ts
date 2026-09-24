import { describe, it, expect } from 'vitest';
import { mkdtempSync, statSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fingerprintOf,
  identityDir,
  loadOrCreateIdentity,
  IDENTITY_KEY_FILE,
  IDENTITY_PUB_FILE,
} from './identity.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'magpie-id-'));

describe('identity', () => {
  it('creates an Ed25519 pair with a 32-hex fingerprint and tight file modes', () => {
    const dir = tmp();
    const id = loadOrCreateIdentity(dir);
    expect(id.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(id.publicKey.startsWith('-----BEGIN PUBLIC KEY-----')).toBe(true);
    expect(id.privateKeyPem).not.toBeNull();
    if (process.platform !== 'win32') {
      expect(statSync(join(dir, IDENTITY_KEY_FILE)).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, IDENTITY_PUB_FILE)).mode & 0o777).toBe(0o644);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('is stable across reloads', () => {
    const dir = tmp();
    const a = loadOrCreateIdentity(dir);
    const b = loadOrCreateIdentity(dir);
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(b.publicKey).toBe(a.publicKey);
    rmSync(dir, { recursive: true, force: true });
  });

  it('rederives the public half from a lone private key without changing the fingerprint', () => {
    const dir = tmp();
    const a = loadOrCreateIdentity(dir);
    rmSync(join(dir, IDENTITY_PUB_FILE));
    const b = loadOrCreateIdentity(dir);
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(readFileSync(join(dir, IDENTITY_PUB_FILE), 'utf8')).toBe(a.publicKey);
    rmSync(dir, { recursive: true, force: true });
  });

  it('honours a lone public key: attribution needs nothing more', () => {
    const src = tmp();
    const a = loadOrCreateIdentity(src);
    const dir = tmp();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, IDENTITY_PUB_FILE), a.publicKey);
    const b = loadOrCreateIdentity(dir);
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(b.privateKeyPem).toBeNull();
    rmSync(src, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it('fingerprint depends on the key, not the PEM formatting', () => {
    const dir = tmp();
    const a = loadOrCreateIdentity(dir);
    expect(fingerprintOf(a.publicKey.replace(/\n/g, '\r\n'))).toBe(a.fingerprint);
    rmSync(dir, { recursive: true, force: true });
  });

  it('identityDir follows MAGPIE_HOME', () => {
    const prev = process.env.MAGPIE_HOME;
    process.env.MAGPIE_HOME = '/tmp/magpie-x';
    expect(identityDir()).toBe(join('/tmp/magpie-x', 'identity'));
    if (prev === undefined) delete process.env.MAGPIE_HOME;
    else process.env.MAGPIE_HOME = prev;
  });
});
