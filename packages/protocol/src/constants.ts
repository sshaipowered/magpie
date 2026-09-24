/**
 * Magpie protocol constants.
 *
 * These are security- and UX-load-bearing. Changing them changes the
 * threat model or the onboarding feel — touch deliberately.
 */

/** Max bytes of a single message `content` field. Anti-DoS / anti-context-blowup. */
export const MAX_CONTENT_BYTES = 256 * 1024; // 256 KiB

/** Default cap on the number of turns in a single call before auto-hangup + escalate. */
export const DEFAULT_MAX_TURNS = 12;

/** Hard ceiling — a call may never exceed this regardless of caller override. */
export const ABSOLUTE_MAX_TURNS = 50;

/**
 * Sealed frames each side may spend on identity announcement, on top of the
 * caller's turn budget. The relay cannot see message types, so it counts every
 * sealed send as a turn; a client that announces identity adds this to the cap
 * it requests so the caller's `maxTurns` still means "messages between agents".
 */
export const IDENTITY_TURN_BUDGET = 2;

/** A pairing code is single-use and expires this long after `start`. */
export const PAIRING_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** How long an idle call stays open before the relay reaps it. */
export const CALL_IDLE_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Wire protocol version. Bumped on any breaking change to message/pairing shape. */
export const PROTOCOL_VERSION = 1 as const;

/**
 * Pairing-code alphabet: Crockford-style, no ambiguous characters (no I/L/O/0/1).
 * Human-transcribable over voice/chat.
 */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Number of groups and group length in a pairing code, e.g. K7F3-9M2P-XQ4R. */
export const CODE_GROUPS = 3;
export const CODE_GROUP_LEN = 4;
/** => 12 chars * log2(31) ≈ 59 bits of entropy. Enough for an HKDF-keyed channel today; PAKE later allows shorter. */
