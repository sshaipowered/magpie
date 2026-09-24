/**
 * A per-user key pair, generated once and kept under `~/.magpie/identity/`.
 *
 * What it is for: ATTRIBUTION. Each side announces its public key once per
 * call, the fingerprint lands in both end-of-call reports, and a downstream
 * system can map fingerprint → person the same way it maps git author →
 * person. A self-declared `@owner/role` extension cannot do that: anyone can
 * set MAGPIE_EXTENSION to anything.
 *
 * What it is NOT: authentication. Nothing signs a challenge and nothing checks
 * a signature. Possession of the pairing code is still what admits a peer.
 * The private key exists so that verification can be added later without a
 * migration; today it is never read after generation.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IdentityRef } from '@magpie/protocol';
import { magpieHome } from './home.js';

export const IDENTITY_DIR = 'identity';
export const IDENTITY_KEY_FILE = 'ed25519.key'; // PKCS#8 PEM, mode 0600
export const IDENTITY_PUB_FILE = 'ed25519.pub'; // SPKI PEM

export interface Identity extends IdentityRef {
  /** Present when this process holds the private half. Unused today. */
  privateKeyPem: string | null;
}

/** First 32 hex chars of SHA-256 over the SPKI DER. Stable across PEM reformatting. */
export function fingerprintOf(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex').slice(0, 32);
}

export function identityDir(): string {
  return join(magpieHome(), IDENTITY_DIR);
}

/**
 * Load the identity from `dir`, deriving the public half from the private key
 * when only that exists, or create a fresh pair. A public key on its own is
 * honoured too (attribution needs nothing more), so losing the private file
 * never silently changes who you are.
 */
export function loadOrCreateIdentity(dir: string = identityDir()): Identity {
  const keyPath = join(dir, IDENTITY_KEY_FILE);
  const pubPath = join(dir, IDENTITY_PUB_FILE);

  if (existsSync(keyPath)) {
    const privateKeyPem = readFileSync(keyPath, 'utf8');
    const pub = createPublicKey(createPrivateKey(privateKeyPem));
    const publicKey = pub.export({ type: 'spki', format: 'pem' }) as string;
    if (!existsSync(pubPath)) writeFileSync(pubPath, publicKey, { mode: 0o644 });
    return { fingerprint: fingerprintOf(publicKey), publicKey, privateKeyPem };
  }
  if (existsSync(pubPath)) {
    const publicKey = readFileSync(pubPath, 'utf8');
    return { fingerprint: fingerprintOf(publicKey), publicKey, privateKeyPem: null };
  }

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }) as string;
  const privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  writeFileSync(keyPath, privateKeyPem, { mode: 0o600 });
  writeFileSync(pubPath, publicKey, { mode: 0o644 });
  return { fingerprint: fingerprintOf(publicKey), publicKey, privateKeyPem };
}

/** The announceable half only. What goes on the wire and into reports. */
export function toRef(id: Identity): IdentityRef {
  return { fingerprint: id.fingerprint, publicKey: id.publicKey };
}
