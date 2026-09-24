/**
 * Envelopes carried INSIDE sealed message content.
 *
 * Neither the wire `Message` schema nor the relay changes for these. `content`
 * stays a string, the relay stays blind, and a peer that predates these
 * envelopes sees ordinary text and keeps working: a plain summary decodes as a
 * resolution with no lists, and an identity announcement it does not recognise
 * is a `system` message it already ignores.
 *
 *   resolution/1  — the resolver's summary plus what was settled and what was
 *                   not. One contested item is meant to become one downstream
 *                   question with two positions, so it carries both.
 *   identity/1    — a per-user public key and its fingerprint, announced once
 *                   per call by each side. ATTRIBUTION ONLY: nothing verifies a
 *                   signature yet. The key is announced so that can be added
 *                   later without changing anything already on disk.
 *
 * Everything decoded here is peer-supplied and treated as hostile: types are
 * checked, strings are capped, lists are capped, and anything malformed
 * degrades to "no structure" rather than throwing.
 */
import type { ContestedPoint, IdentityRef, Resolution } from './schema.js';

const RESOLUTION_TAG = 'resolution/1';
const IDENTITY_TAG = 'identity/1';

/** Per-item and per-list caps. Generous for real use, tight against abuse. */
export const MAX_POINT_CHARS = 4096;
export const MAX_POINTS = 64;
/** A PEM-encoded Ed25519 SPKI is ~113 bytes; this is a ceiling, not a target. */
export const MAX_PUBLIC_KEY_CHARS = 2048;
export const FINGERPRINT_RE = /^[0-9a-f]{32}$/;

function tagged(content: string, tag: string): Record<string, unknown> | null {
  // Cheap pre-check so ordinary prose never pays for a JSON.parse attempt.
  if (!content.startsWith('{') || !content.includes(tag)) return null;
  try {
    const o: unknown = JSON.parse(content);
    if (o && typeof o === 'object' && !Array.isArray(o) && (o as Record<string, unknown>).magpie === tag) {
      return o as Record<string, unknown>;
    }
  } catch {
    /* not an envelope */
  }
  return null;
}

const clip = (s: unknown): string | undefined =>
  typeof s === 'string' ? s.slice(0, MAX_POINT_CHARS) : undefined;

function normContested(x: unknown): ContestedPoint | null {
  if (typeof x === 'string') return x.trim() ? { point: x.slice(0, MAX_POINT_CHARS) } : null;
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const point = clip(o.point);
  if (!point || !point.trim()) return null;
  const out: ContestedPoint = { point };
  const mine = clip(o.mine);
  const theirs = clip(o.theirs);
  if (mine) out.mine = mine;
  if (theirs) out.theirs = theirs;
  return out;
}

/**
 * Serialise a resolution for the wire. A summary with nothing settled and
 * nothing contested goes out as the bare summary string, so a peer on an older
 * build reads exactly what it always did.
 */
export function encodeResolution(r: Resolution): string {
  const agreed = (r.agreed ?? []).filter((s) => typeof s === 'string' && s.trim());
  const contested = (r.contested ?? []).map(normContested).filter((c): c is ContestedPoint => c !== null);
  if (agreed.length === 0 && contested.length === 0) return r.summary;
  return JSON.stringify({
    magpie: RESOLUTION_TAG,
    summary: r.summary,
    agreed: agreed.slice(0, MAX_POINTS),
    contested: contested.slice(0, MAX_POINTS),
  });
}

/** Never throws. Anything that is not a well-formed envelope is a plain summary. */
export function decodeResolution(content: string): Resolution {
  const o = tagged(content, RESOLUTION_TAG);
  if (!o) return { summary: content, agreed: [], contested: [] };
  const summary = typeof o.summary === 'string' ? o.summary : content;
  const agreed = Array.isArray(o.agreed)
    ? o.agreed.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        .map((s) => s.slice(0, MAX_POINT_CHARS)).slice(0, MAX_POINTS)
    : [];
  const contested = Array.isArray(o.contested)
    ? o.contested.map(normContested).filter((c): c is ContestedPoint => c !== null).slice(0, MAX_POINTS)
    : [];
  return { summary, agreed, contested };
}

export function encodeIdentity(id: IdentityRef): string {
  return JSON.stringify({ magpie: IDENTITY_TAG, fingerprint: id.fingerprint, publicKey: id.publicKey });
}

/** Null unless the content is a well-formed identity announcement. */
export function decodeIdentity(content: string): IdentityRef | null {
  const o = tagged(content, IDENTITY_TAG);
  if (!o) return null;
  const fingerprint = o.fingerprint;
  const publicKey = o.publicKey;
  if (typeof fingerprint !== 'string' || !FINGERPRINT_RE.test(fingerprint)) return null;
  if (
    typeof publicKey !== 'string' ||
    publicKey.length > MAX_PUBLIC_KEY_CHARS ||
    !publicKey.startsWith('-----BEGIN PUBLIC KEY-----')
  ) {
    return null;
  }
  return { fingerprint, publicKey };
}
