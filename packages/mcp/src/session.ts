import { MagpieClient, loadOrCreateIdentity, saveReport, toRef } from '@magpie/client';
import {
  newMessageId,
  parseInvite,
  PROTOCOL_VERSION,
  DEFAULT_MAX_TURNS,
} from '@magpie/protocol';
import type {
  CallOutcome,
  CallReport,
  Extension,
  IdentityRef,
  Message,
  MessageType,
  Resolution,
} from '@magpie/protocol';

/**
 * Session layer that sits between the MCP tools and the raw MagpieClient.
 *
 * The MCP tools are stateless request/response shaped (a host model calls
 * `sb_ask` and expects the peer's answer back in the SAME tool result), but the
 * wire is async and bidirectional. This layer bridges the two:
 *
 *   - it correlates an outbound `query` to the inbound `response` whose
 *     `inReplyTo` matches, so `sb_ask` can await the answer;
 *   - it queues inbound `query` messages so `sb_listen` can hand them to the
 *     host model one at a time;
 *   - it tracks remote hangups so tools fail loudly instead of hanging.
 *
 * Security note: this layer NEVER renders peer content. It carries raw
 * `Message` objects. Anything that becomes model-visible text is fenced via
 * `renderInbound` at the tool boundary (see tools.ts). Keeping the fence at one
 * choke point is deliberate.
 */

/** A pending `sb_ask` awaiting the peer's reply, keyed by the query's message id. */
interface AwaitedReply {
  resolve: (msg: Message) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface SessionInfo {
  callId: string;
  /** This endpoint's extension address. */
  self: Extension;
  /** The peer's extension address, once known (after join / peer-joined). */
  peer: Extension | null;
  /** Human-shareable pairing code — present only on the side that called start. */
  code: string | null;
  topic: string;
  /** Monotonic local turn counter; stamped onto every outbound message. */
  turn: number;
  closed: boolean;
  closedReason: string | null;
}

/**
 * How long `sb_ask` waits for the peer's answer before giving up. This is a
 * GENEROUS BACKSTOP, not a guess at turn duration: a peer that DISCONNECTS
 * fails the ask immediately (via `markClosed`), so this only bounds a peer that
 * is still connected but silent. A thorough answerer (read files + reason) can
 * legitimately take several minutes per turn, so a short timeout would cut off
 * live conversations. 15 min covers slow turns while still bounding a wedged peer.
 */
const DEFAULT_ASK_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * How long a single sb_ask call blocks before handing control back.
 *
 * An MCP host abandons a tool call on its own deadline (300s observed) and the
 * server is never told. The reply window above is deliberately far longer than
 * that, so the wait has to end here, below the host's limit, and end in a way
 * that keeps a late reply retrievable. See `askBounded`.
 */
const DEFAULT_ASK_WAIT_MS = 4 * 60 * 1000;

/**
 * What one bounded sb_ask call ended as. The two pending cases are NOT the same
 * thing and the model must be told which it got: after `pending-reply` the peer
 * holds the question and the answer will arrive in the inbound queue, so
 * resending would ask twice; after `pending-peer` nothing was sent at all, so
 * the question still has to be asked once someone joins.
 */
export type AskOutcome =
  | { status: 'replied'; reply: Message }
  | { status: 'pending-reply'; id: string }
  | { status: 'pending-peer' };

/**
 * How long `sb_ask` will wait for the peer to JOIN before sending, when asked
 * on a call nobody has joined yet. Matches the pairing-code TTL horizon: the
 * human shares the invite out-of-band and the peer joins whenever they can.
 */
const DEFAULT_PEER_WAIT_MS = 10 * 60 * 1000;

/** Actionable hint when no relay URL is available for an operation. */
const NO_RELAY_HINT =
  'set MAGPIE_RELAY_URL or pass relayUrl (joiners can instead paste a full ' +
  'invite like CODE@ws://relay-host:8787)';

/**
 * One open call. Wraps the shared client with this call's identity, an inbound
 * query queue, and reply correlation.
 */
/**
 * Map the free-text close reason (ours, or the relay's hangup reason) onto the
 * report's outcome enum. The relay phrases a cap as "turn cap of N reached".
 */
function outcomeFromReason(reason: string): CallOutcome {
  if (reason === 'resolved') return 'resolved';
  if (/turn cap/i.test(reason)) return 'turn-cap';
  if (/hangup|hung up/i.test(reason)) return 'hung-up';
  return 'disconnected';
}

export class CallSession {
  readonly callId: string;
  readonly self: Extension;
  readonly topic: string;
  readonly code: string | null;

  peer: Extension | null;

  #turn = 0;
  #closed = false;
  #closedReason: string | null = null;
  /** Built and persisted at close. The hand-off artifact for anything downstream. */
  #lastReport: CallReport | null = null;

  /** Inbound peer `query` messages not yet handed to the host model. */
  readonly #inbound: Message[] = [];
  /** A parked `sb_listen` waiting for the next inbound query (at most one). */
  #waitingListener: ((msg: Message) => void) | null = null;

  /** Outstanding `sb_ask` calls keyed by the query message id we are awaiting a reply to. */
  readonly #awaiting = new Map<string, AwaitedReply>();

  /** Resolvers for callers parked in `#waitForPeer` until the peer joins. */
  readonly #peerWaiters = new Set<{ resolve: () => void; reject: (e: Error) => void }>();

  readonly #client: MagpieClient;
  readonly #askTimeoutMs: number;
  readonly #askWaitMs: number;

  constructor(opts: {
    client: MagpieClient;
    callId: string;
    self: Extension;
    peer: Extension | null;
    topic: string;
    code: string | null;
    askTimeoutMs?: number;
    askWaitMs?: number;
  }) {
    this.#client = opts.client;
    this.callId = opts.callId;
    this.self = opts.self;
    this.peer = opts.peer;
    this.topic = opts.topic;
    this.code = opts.code;
    this.#askTimeoutMs = opts.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
    this.#askWaitMs = opts.askWaitMs ?? DEFAULT_ASK_WAIT_MS;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /**
   * The relay client this session lives on. Sessions remember their client
   * because the store may hold connections to SEVERAL relays (invite-carried
   * URLs), and dispatch/teardown must target only the right one.
   */
  get client(): MagpieClient {
    return this.#client;
  }

  info(): SessionInfo {
    return {
      callId: this.callId,
      self: this.self,
      peer: this.peer,
      code: this.code,
      topic: this.topic,
      turn: this.#turn,
      closed: this.#closed,
      closedReason: this.#closedReason,
    };
  }

  /**
   * The peer joined this call. Records their extension and wakes anyone parked
   * in `ask()` waiting to send their first question. Idempotent.
   */
  notePeerJoined(peer: Extension): void {
    this.peer = peer;
    for (const w of this.#peerWaiters) w.resolve();
    this.#peerWaiters.clear();
  }

  /**
   * Resolve once the peer has joined; reject if the call closes first or the
   * wait exceeds `timeoutMs`. Resolves immediately if the peer is already here.
   */
  #waitForPeer(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (this.peer) return Promise.resolve();
    if (this.#closed) {
      return Promise.reject(new Error(`call ${this.callId} closed: ${this.#closedReason}`));
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          clearTimeout(timer);
          this.#peerWaiters.delete(waiter);
          resolve();
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          this.#peerWaiters.delete(waiter);
          reject(e);
        },
      };
      const timer = setTimeout(
        () =>
          waiter.reject(
            new Error(
              `no peer has joined call ${this.callId} yet (waited ${Math.round(
                timeoutMs / 60000,
              )} min). Share the invite and have them sb_join first.`,
            ),
          ),
        timeoutMs,
      );
      if (typeof timer === 'object' && 'unref' in timer) timer.unref();
      this.#peerWaiters.add(waiter);
    });
  }

  /** Route a decrypted inbound message belonging to this call. */
  ingest(msg: Message): void {
    // A reply to one of our outstanding asks?
    if (msg.type === 'response' && msg.inReplyTo) {
      const waiter = this.#awaiting.get(msg.inReplyTo);
      if (waiter) {
        this.#awaiting.delete(msg.inReplyTo);
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
        return;
      }
      // Unmatched response (e.g. ask already timed out) — queue so a listener
      // can still surface it rather than silently dropping peer content.
    }

    if (msg.type === 'query' || msg.type === 'response') {
      // Hand directly to a parked listener if one is waiting; else queue.
      const listener = this.#waitingListener;
      if (listener) {
        this.#waitingListener = null;
        listener(msg);
      } else {
        this.#inbound.push(msg);
      }
    }
    // ping / system / hangup are control-plane; not surfaced to the model here.
  }

  /** Mark the call as closed and fail anything in flight. */
  markClosed(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closedReason = reason;
    const err = new Error(`call ${this.callId} closed: ${reason}`);
    for (const [, w] of this.#awaiting) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this.#awaiting.clear();
    for (const w of this.#peerWaiters) w.reject(err);
    this.#peerWaiters.clear();
    if (this.#waitingListener) {
      // Unpark with a synthetic hangup marker so sb_listen returns instead of hanging.
      const listener = this.#waitingListener;
      this.#waitingListener = null;
      listener(this.#hangupMarker(reason));
    }
    // Every termination leaves a report on disk, whatever the outcome. This is
    // the machine-readable hand-off point; a failed write must not turn a
    // finished call into an error for the model.
    this.#lastReport = this.#client.buildReport(this.callId, outcomeFromReason(reason));
    if (this.#lastReport) {
      try {
        saveReport(this.#lastReport);
      } catch (err) {
        process.stderr.write(`[magpie-mcp] could not save report for ${this.callId}: ${String(err)}\n`);
      }
    }
  }

  /** The report built at close, or null while the call is still open. */
  get lastReport(): CallReport | null {
    return this.#lastReport;
  }

  /**
   * Send a `query` to the peer and resolve with their matching `response`.
   * Used by `sb_ask`. Rejects on timeout, hangup, or send failure.
   *
   * If nobody has joined the call yet, this WAITS for the peer to join (up to
   * `peerWaitMs`) instead of failing — so "start a call and ask X" just works
   * without the caller inventing a poll loop. `replyTimeoutMs` overrides how
   * long to wait for the answer once sent.
   */
  async ask(question: string, replyTimeoutMs?: number, peerWaitMs?: number): Promise<Message> {
    const { reply } = await this.#startAsk(question, replyTimeoutMs, peerWaitMs);
    return reply;
  }

  /**
   * Like `ask`, but stops WAITING after `waitMs` and returns null instead of
   * rejecting, leaving the peer free to answer late.
   *
   * The reason this exists: an MCP host gives up on a tool call after its own
   * deadline and tells the server nothing. The ask stayed registered, so when
   * the reply finally arrived `ingest` matched it to a promise nobody was
   * awaiting any more, consumed it, and never queued it — the peer's answer was
   * in the transcript but unreachable through sb_listen. Ending the wait here
   * and DETACHING the ask makes that same reply fall through to the inbound
   * queue, where sb_listen picks it up.
   */
  async askBounded(
    question: string,
    opts: {
      /**
       * Upper bound on this ENTIRE call, pairing wait included. It has to cover
       * the whole call to be a safety net for hosts that cancel nothing: the
       * peer wait alone is 10 min by design, so bounding only the reply left
       * sb_ask able to block far past any host deadline.
       */
      waitMs?: number;
      replyTimeoutMs?: number;
      peerWaitMs?: number;
      /**
       * The MCP request's abort signal. This is the exact stop condition: a host
       * that times out a tool call sends notifications/cancelled and the SDK
       * aborts the handler, so we learn the caller is gone instead of guessing
       * its deadline. `waitMs` stays as the fallback for hosts that cancel
       * nothing.
       */
      signal?: AbortSignal;
    } = {},
  ): Promise<AskOutcome> {
    const { waitMs, replyTimeoutMs, peerWaitMs, signal } = opts;
    if (signal?.aborted) throw new Error('sb_ask was cancelled before the question was sent');

    const expired = Symbol('expired');
    // One deadline for the whole call, started before the pairing wait.
    const deadline = new Promise<typeof expired>((resolve) => {
      const t = setTimeout(() => resolve(expired), waitMs ?? this.#askWaitMs);
      if (typeof t === 'object' && 'unref' in t) t.unref();
      if (signal) {
        if (signal.aborted) resolve(expired);
        else signal.addEventListener('abort', () => resolve(expired), { once: true });
      }
    });

    // Pairing wait, bounded by the same deadline. Giving up here must send
    // NOTHING: a query put on the wire for a caller that has gone away would
    // consume a relay turn and reach a peer nobody is going to read the answer
    // for. There is correspondingly nothing for sb_listen to recover.
    this.#assertNotClosed();
    if (!this.peer) {
      const joined = await Promise.race([
        this.#waitForPeer(peerWaitMs ?? DEFAULT_PEER_WAIT_MS).then(() => 'joined' as const),
        deadline,
      ]);
      if (joined === expired) return { status: 'pending-peer' };
    }

    const { id, reply } = await this.#startAsk(question, replyTimeoutMs);
    // Settle the reply into a value either way so Promise.race cannot reject
    // before we have decided which side won.
    const settled = reply.then(
      (m) => ({ ok: true as const, m }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    const winner = await Promise.race([settled, deadline]);
    if (winner === expired) {
      // Only give up if the ask is still outstanding. If it is already gone the
      // reply landed in the same tick as the deadline; await it rather than
      // discarding a message we have in hand.
      if (this.#detachAsk(id)) return { status: 'pending-reply', id };
      return { status: 'replied', reply: await reply };
    }
    if (winner.ok) return { status: 'replied', reply: winner.m };
    throw winner.e;
  }

  /** Put a query on the wire and register its pending reply. */
  async #startAsk(
    question: string,
    replyTimeoutMs?: number,
    peerWaitMs?: number,
  ): Promise<{ id: string; reply: Promise<Message> }> {
    this.#assertNotClosed();
    // Ask-before-join: if nobody has joined yet, block until the peer arrives
    // rather than erroring. When a peer is already present (the common case)
    // this is skipped so the query is put on the wire synchronously.
    // askBounded does its own bounded wait and calls this with the peer present.
    if (!this.peer) {
      await this.#waitForPeer(peerWaitMs ?? DEFAULT_PEER_WAIT_MS);
    }
    this.#assertOpen();
    const id = newMessageId();
    const query = this.#build(id, 'query', question, null);

    const reply = new Promise<Message>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#awaiting.delete(id);
        reject(new Error(`timed out waiting for peer reply to ${id}`));
      }, replyTimeoutMs ?? this.#askTimeoutMs);
      // Don't keep the event loop alive solely for this timer.
      if (typeof timer === 'object' && 'unref' in timer) timer.unref();
      this.#awaiting.set(id, { resolve, reject, timer });
    });

    try {
      await this.#client.send(this.callId, query);
    } catch (err) {
      this.#detachAsk(id);
      // Nothing is awaiting `reply` yet, so its rejection would be unhandled.
      reply.catch(() => {});
      throw err;
    }
    return { id, reply };
  }

  /**
   * Stop tracking a pending ask WITHOUT rejecting it. A reply that arrives
   * afterwards no longer matches a waiter, so `ingest` queues it for
   * `sb_listen`. Returns false if the ask was already settled.
   */
  #detachAsk(id: string): boolean {
    const w = this.#awaiting.get(id);
    if (!w) return false;
    clearTimeout(w.timer);
    this.#awaiting.delete(id);
    return true;
  }

  /**
   * Return the next inbound peer message (query or unmatched response),
   * removing it from the queue. Resolves immediately if one is buffered,
   * otherwise parks until one arrives or the call closes.
   * Used by `sb_listen`. `null` means "no inbound and the call is closed".
   */
  nextInbound(timeoutMs?: number, signal?: AbortSignal): Promise<Message | null> {
    const buffered = this.#inbound.shift();
    if (buffered) return Promise.resolve(buffered);
    if (this.#closed) return Promise.resolve(null);

    return new Promise<Message | null>((resolve) => {
      let settled = false;
      const done = (m: Message | null) => {
        if (settled) return;
        settled = true;
        if (this.#waitingListener === deliver) this.#waitingListener = null;
        clearTimeout(timer);
        resolve(m);
      };
      const deliver = (m: Message) => {
        // A hangup marker means the call closed while we were parked.
        if (m.type === 'hangup') done(null);
        else done(m);
      };
      // Only one parked listener at a time; replace any prior parked one.
      this.#waitingListener = deliver;
      const timer = setTimeout(
        () => done(null),
        timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS,
      );
      if (typeof timer === 'object' && 'unref' in timer) timer.unref();
      // A host that gives up on the tool call leaves this listener parked, and
      // the next inbound query is then handed to a callback nobody reads —
      // the same loss sb_ask had. Un-park on cancellation so the query queues.
      if (signal) {
        if (signal.aborted) done(null);
        else signal.addEventListener('abort', () => done(null), { once: true });
      }
    });
  }

  /** Send a `response` to a specific inbound query. Used by `sb_answer`. */
  async answer(inReplyTo: string, text: string): Promise<Message> {
    this.#assertOpen();
    const id = newMessageId();
    const msg = this.#build(id, 'response', text, inReplyTo);
    await this.#client.send(this.callId, msg);
    return msg;
  }

  /**
   * Declare a FIRM CONCLUSION reached with the peer: sends a `resolve` message
   * (carrying `summary`) so the peer learns the conclusion, ends the call, and
   * returns the end-of-call report built from the transcript. Used by
   * `sb_resolve`. This is the autonomous agree-loop's terminal move — call it
   * once nothing is left to resolve (agreement, or a firm pass/fail verdict).
   */
  async resolve(resolution: string | Resolution): Promise<CallReport | null> {
    this.#assertOpen();
    await this.#client.resolve(this.callId, resolution);
    this.markClosed('resolved');
    return this.#lastReport;
  }

  /**
   * The PEER declared the call resolved. Surface their summary to a parked (or
   * next) `sb_listen` so the local agent can report the conclusion to its human,
   * then close. Wired from the client's `onResolved` by the SessionStore.
   */
  markResolved(summary: string): void {
    if (this.#closed) return;
    const marker = this.#resolveMarker(summary);
    const listener = this.#waitingListener;
    if (listener) {
      this.#waitingListener = null;
      listener(marker);
    } else {
      this.#inbound.push(marker);
    }
    this.markClosed('resolved');
  }

  /** Tear down this call on the wire. */
  async hangup(): Promise<void> {
    if (!this.#closed) {
      try {
        await this.#client.hangup(this.callId);
      } finally {
        this.markClosed('local hangup');
      }
    }
  }

  // ---- internals -----------------------------------------------------------

  #assertNotClosed(): void {
    if (this.#closed) {
      throw new Error(
        `call ${this.callId} is closed${this.#closedReason ? ` (${this.#closedReason})` : ''}`,
      );
    }
  }

  #assertOpen(): void {
    this.#assertNotClosed();
    if (!this.peer) {
      throw new Error(
        `call ${this.callId} has no peer yet; the other party must sb_join with the code first`,
      );
    }
  }

  #build(
    id: string,
    type: MessageType,
    content: string,
    inReplyTo: string | null,
  ): Message {
    // peer is guaranteed non-null by #assertOpen for query/response paths.
    const to = this.peer ?? this.self;
    this.#turn += 1;
    return {
      v: PROTOCOL_VERSION,
      id,
      callId: this.callId,
      from: this.self,
      to,
      type,
      ts: new Date().toISOString(),
      turn: this.#turn,
      inReplyTo,
      content,
    };
  }

  /** Synthetic, never-sent marker carrying the peer's resolution summary. */
  #resolveMarker(summary: string): Message {
    return {
      v: PROTOCOL_VERSION,
      id: newMessageId(),
      callId: this.callId,
      from: this.peer ?? this.self,
      to: this.self,
      type: 'resolve',
      ts: new Date().toISOString(),
      turn: this.#turn,
      inReplyTo: null,
      content: summary,
    };
  }

  /** Synthetic, never-sent marker used only to unpark a waiting listener. */
  #hangupMarker(reason: string): Message {
    return {
      v: PROTOCOL_VERSION,
      id: newMessageId(),
      callId: this.callId,
      from: this.peer ?? this.self,
      to: this.self,
      type: 'hangup',
      ts: new Date().toISOString(),
      turn: this.#turn,
      inReplyTo: null,
      content: reason,
    };
  }
}

/**
 * Owns the relay connections and the set of live CallSessions. The MCP tools
 * talk only to this store.
 *
 * One MCP process represents one endpoint identity (`self`), but it may talk
 * to SEVERAL relays: the env-configured default plus any relay carried inside
 * an invite token (`CODE@ws://…`). Clients are therefore keyed by relay URL
 * and connected lazily; each CallSession remembers which client it lives on.
 * Inbound deliveries and hangups are fanned out per client, to the matching
 * session by callId.
 */
export class SessionStore {
  readonly self: Extension;
  readonly #defaultRelayUrl: string | null;
  readonly #askTimeoutMs: number | undefined;
  readonly #askWaitMs: number | undefined;
  readonly #connect: (url: string) => Promise<MagpieClient>;

  /** Lazily-connected clients keyed by relay URL (memoized promises). */
  readonly #clients = new Map<string, Promise<MagpieClient>>();

  readonly #sessions = new Map<string, CallSession>();

  constructor(opts: {
    self: Extension;
    /** Default relay (env MAGPIE_RELAY_URL). Null = invite-carried URLs only. */
    relayUrl?: string | null;
    askTimeoutMs?: number;
    askWaitMs?: number;
    /** Test seam: how to open a relay connection. Defaults to MagpieClient.connect. */
    connect?: (url: string) => Promise<MagpieClient>;
  }) {
    this.self = opts.self;
    this.#defaultRelayUrl = opts.relayUrl ?? null;
    this.#askTimeoutMs = opts.askTimeoutMs;
    this.#askWaitMs = opts.askWaitMs;
    this.#connect = opts.connect ?? ((url) => MagpieClient.connect(url, { identity: this.identityRef }));
  }

  /** The default relay URL from configuration, if any (used to compose invites). */
  #identity: IdentityRef | null | undefined;

  /**
   * This user's announceable identity, loaded from `~/.magpie/identity/` on
   * first use. Null if that directory cannot be read or created; the MCP then
   * runs without attribution and says so once on stderr.
   */
  get identityRef(): IdentityRef | null {
    if (this.#identity === undefined) {
      try {
        this.#identity = toRef(loadOrCreateIdentity());
      } catch (err) {
        process.stderr.write(`[magpie-mcp] no identity, attribution disabled: ${String(err)}\n`);
        this.#identity = null;
      }
    }
    return this.#identity;
  }

  get relayUrl(): string | null {
    return this.#defaultRelayUrl;
  }

  /** Lazily connect to `url` (once per URL) and wire the dispatch handlers. */
  async #ensureClient(url: string): Promise<MagpieClient> {
    const existing = this.#clients.get(url);
    if (existing) {
      const client = await existing.catch(() => null);
      // Reuse only if the socket is still live. A relay can drop us after a
      // failed join (UNKNOWN_RENDEZVOUS closes the connection); a dead cached
      // client must not poison every later start/join with "not connected".
      if (client && client.isConnected) return client;
      this.#clients.delete(url);
    }

    const connecting = this.#connect(url).then((client) => {
      client.onMessage((msg) => {
        const session = this.#sessions.get(msg.callId);
        if (session) session.ingest(msg);
      });
      client.onHangup((reason, callId) => {
        if (callId) {
          // One call ended. Closing the rest would truncate unrelated live
          // calls and write them a `disconnected` report they never earned.
          const session = this.#sessions.get(callId);
          if (session?.client === client) session.markClosed(reason);
        } else {
          // The socket itself dropped, so every call on this client is over.
          for (const s of this.#sessions.values()) {
            if (s.client === client) s.markClosed(reason);
          }
        }
        // If the underlying socket dropped, evict this client from the cache
        // so the next start/join reconnects instead of reusing a dead socket.
        if (!client.isConnected && this.#clients.get(url) === connecting) {
          this.#clients.delete(url);
        }
      });
      client.onPeerJoined((callId, peer) => {
        // The opener learns who joined; record it (so sb_ask/sb_answer can
        // address outbound messages) AND wake any sb_ask parked waiting to send
        // its first question before the peer arrived.
        const session = this.#sessions.get(callId);
        if (session) session.notePeerJoined(peer);
      });
      client.onResolved((callId, summary) => {
        // The peer concluded the call; surface the summary to sb_listen so the
        // local agent can report it, then close the session.
        const session = this.#sessions.get(callId);
        if (session) session.markResolved(summary);
      });
      return client;
    });
    // A failed connect must not poison the cache — allow a retry next call.
    connecting.catch(() => this.#clients.delete(url));
    this.#clients.set(url, connecting);
    return connecting;
  }

  /** Resolve which relay a call should use, with a clear config error. */
  #resolveRelay(override: string | null | undefined, context: string): string {
    const url = override ?? this.#defaultRelayUrl;
    if (!url) throw new Error(`no relay configured for ${context}: ${NO_RELAY_HINT}`);
    return url;
  }

  /**
   * Start a new call; returns the session whose `.code` is shown to the human.
   * `relayUrl` (if given) overrides the configured default for this call.
   */
  async start(topic: string, maxTurns?: number, relayUrl?: string): Promise<CallSession> {
    const url = this.#resolveRelay(relayUrl, 'sb_start');
    const client = await this.#ensureClient(url);
    const opened = await client.start({
      from: this.self,
      topic,
      ...(maxTurns !== undefined ? { maxTurns } : {}),
    });
    const session = new CallSession({
      client,
      callId: opened.callId,
      self: this.self,
      peer: null, // learned when the peer joins
      topic,
      code: opened.code,
      ...(this.#askTimeoutMs !== undefined ? { askTimeoutMs: this.#askTimeoutMs } : {}),
      ...(this.#askWaitMs !== undefined ? { askWaitMs: this.#askWaitMs } : {}),
    });
    this.#sessions.set(session.callId, session);
    return session;
  }

  /**
   * Join an existing call by invite (`CODE@ws://relay`) or bare pairing code.
   * An invite-carried relay URL wins over the configured default, so a joiner
   * needs NO relay configuration when handed a full invite.
   */
  async join(inviteOrCode: string): Promise<CallSession> {
    const invite = parseInvite(inviteOrCode);
    const url = this.#resolveRelay(invite.relayUrl, 'sb_join with a bare code');
    const client = await this.#ensureClient(url);
    const joined = await client.join({ from: this.self, code: invite.code });
    const session = new CallSession({
      client,
      callId: joined.callId,
      self: this.self,
      peer: joined.peer,
      topic: '(joined)',
      code: null,
      ...(this.#askTimeoutMs !== undefined ? { askTimeoutMs: this.#askTimeoutMs } : {}),
      ...(this.#askWaitMs !== undefined ? { askWaitMs: this.#askWaitMs } : {}),
    });
    this.#sessions.set(session.callId, session);
    return session;
  }

  /** Look up a live session, throwing a clear error if absent. */
  require(callId: string): CallSession {
    const s = this.#sessions.get(callId);
    if (!s) {
      throw new Error(
        `unknown callId ${JSON.stringify(callId)}; call sb_start or sb_join first`,
      );
    }
    return s;
  }

  /** Hang up and forget a call. */
  async hangup(callId: string): Promise<void> {
    const s = this.#sessions.get(callId);
    if (!s) return;
    await s.hangup();
    this.#sessions.delete(callId);
  }

  /** Drop a call from the map without re-hanging-up (already closed/resolved). */
  forget(callId: string): void {
    this.#sessions.delete(callId);
  }

  list(): SessionInfo[] {
    return [...this.#sessions.values()].map((s) => s.info());
  }

  /** Close every relay connection and drop all call state. */
  close(): void {
    for (const s of this.#sessions.values()) s.markClosed('store closed');
    this.#sessions.clear();
    for (const pending of this.#clients.values()) {
      void pending.then((c) => c.close()).catch(() => {});
    }
    this.#clients.clear();
  }
}

export { DEFAULT_MAX_TURNS };
