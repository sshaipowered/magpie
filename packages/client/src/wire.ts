/**
 * RELAY <-> CLIENT control frames: JSON over WebSocket.
 *
 * The relay brokers CIPHERTEXT ONLY. A `frame` field is always base64 of
 * `channel.seal(utf8(JSON(Message)))` — the relay never unseals it, and it
 * never appears in this file as anything but an opaque string.
 *
 * These mirror the relay contract so the two packages can't drift. Keep them
 * structural (plain interfaces) — they are validated defensively on receipt.
 */

import { CallId } from '@magpie/protocol';
import type { Extension } from '@magpie/protocol';

// ---- Client -> Relay -------------------------------------------------------

export interface OpenFrame {
  t: 'open';
  rendezvousId: string;
  from: Extension;
  topic: string;
  maxTurns: number;
}

export interface JoinFrame {
  t: 'join';
  rendezvousId: string;
  from: Extension;
}

export interface SendFrame {
  t: 'send';
  callId: string;
  /** base64 of channel.seal(utf8(JSON(Message))). Opaque to the relay. */
  frame: string;
}

export interface HangupFrame {
  t: 'hangup';
  callId: string;
}

export type ClientToRelay = OpenFrame | JoinFrame | SendFrame | HangupFrame;

// ---- Relay -> Client -------------------------------------------------------

export interface OpenedFrame {
  t: 'opened';
  callId: string;
}

export interface JoinedFrame {
  t: 'joined';
  callId: string;
  peer: Extension;
}

export interface PeerJoinedFrame {
  t: 'peer-joined';
  callId: string;
  peer: Extension;
}

export interface DeliverFrame {
  t: 'deliver';
  callId: string;
  /** base64 ciphertext to be opened with the per-call channel. */
  frame: string;
}

export interface HangupDeliverFrame {
  t: 'hangup';
  callId: string;
  reason: string;
}

export interface ErrorFrame {
  t: 'error';
  code: string;
  message: string;
}

export type RelayToClient =
  | OpenedFrame
  | JoinedFrame
  | PeerJoinedFrame
  | DeliverFrame
  | HangupDeliverFrame
  | ErrorFrame;

/**
 * Narrow an arbitrary parsed JSON value to a RelayToClient frame.
 * Defense in depth: the relay is semi-trusted (it routes our ciphertext) but
 * we still never trust the SHAPE of what arrives off the wire.
 */
/**
 * A relay-supplied callId reaches the filesystem: reports are written to
 * `<calls dir>/<callId>.json`. Accepting any string let a hostile or broken
 * relay escape that directory, so every frame is checked against the schema
 * here, at the boundary, before the id is used for anything.
 */
const isCallId = (v: unknown): v is string => typeof v === 'string' && CallId.safeParse(v).success;

export function parseRelayFrame(raw: unknown): RelayToClient | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const f = raw as Record<string, unknown>;
  switch (f.t) {
    case 'opened':
      return isCallId(f.callId) ? { t: 'opened', callId: f.callId } : null;
    case 'joined':
      return isCallId(f.callId) && typeof f.peer === 'string'
        ? { t: 'joined', callId: f.callId, peer: f.peer }
        : null;
    case 'peer-joined':
      return isCallId(f.callId) && typeof f.peer === 'string'
        ? { t: 'peer-joined', callId: f.callId, peer: f.peer }
        : null;
    case 'deliver':
      return isCallId(f.callId) && typeof f.frame === 'string'
        ? { t: 'deliver', callId: f.callId, frame: f.frame }
        : null;
    case 'hangup':
      return isCallId(f.callId) && typeof f.reason === 'string'
        ? { t: 'hangup', callId: f.callId, reason: f.reason }
        : null;
    case 'error':
      return typeof f.code === 'string' && typeof f.message === 'string'
        ? { t: 'error', code: f.code, message: f.message }
        : null;
    default:
      return null;
  }
}
