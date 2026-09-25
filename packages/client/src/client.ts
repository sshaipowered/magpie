import WebSocket from 'ws';
import {
  parseMessage,
  rendezvousId,
  channelFromCode,
  generatePairingCode,
  newMessageId,
  MAX_CONTENT_BYTES,
  DEFAULT_MAX_TURNS,
  ABSOLUTE_MAX_TURNS,
  PROTOCOL_VERSION,
  decodeHello,
  decodeResolution,
  encodeHello,
  encodeResolution,
  RESERVED_TURN_BUDGET,
} from '@magpie/protocol';
import type {
  Extension,
  Message,
  PairingChannel,
  CallReport,
  CallOutcome,
  TranscriptEntry,
  IdentityRef,
  Resolution,
} from '@magpie/protocol';
import type {
  ClientToRelay,
  OpenFrame,
  OpenedFrame,
  JoinedFrame,
  ErrorFrame,
} from './wire.js';
import { parseRelayFrame } from './wire.js';

type MessageCb = (msg: Message) => void;
type HangupCb = (reason: string) => void;
type PeerJoinedCb = (callId: string, peer: Extension) => void;
type ResolvedCb = (callId: string, summary: string, resolution: Resolution) => void;

/** Per-call bookkeeping for transcript + report building. */
interface CallCtx {
  from: Extension;
  peer: Extension | null;
  topic: string;
  startedAt: string;
  transcript: TranscriptEntry[];
  /** Set when a `resolve` message is sent or received. */
  summary: string | null;
  /** The structured form of the same resolution; `summary` is its `.summary`. */
  resolution: Resolution | null;
  /** What the peer announced about itself, if anything. Attribution only. */
  peerIdentity: IdentityRef | null;
  /** Which end of the call this is. The opener owns the topic. */
  role: 'opener' | 'joiner';
}

/** A request awaiting its matching relay reply, correlated by reply type. */
interface Pending<T> {
  resolve: (value: T) => void;
  reject: (err: Error) => void;
}

/**
 * @magpie/client — a thin WebSocket client to the relay plus the per-call
 * pairing crypto.
 *
 * The relay sees CIPHERTEXT ONLY: every `Message` is JSON-serialized, sealed
 * with the call's `PairingChannel`, base64-encoded, and shipped as an opaque
 * `frame`. The channel for a call is held here, keyed by callId, and is the
 * ONLY thing that can read peer payloads.
 */
export class MagpieClient {
  readonly #ws: WebSocket;

  /** Per-call E2E channel. The relay can never produce one of these. */
  readonly #channels = new Map<string, PairingChannel>();

  /** Per-call transcript + metadata, for building the end-of-call report. */
  readonly #ctx = new Map<string, CallCtx>();

  readonly #messageCbs: MessageCb[] = [];
  readonly #hangupCbs: HangupCb[] = [];
  readonly #peerJoinedCbs: PeerJoinedCb[] = [];
  readonly #resolvedCbs: ResolvedCb[] = [];

  /**
   * Pending open/join requests. The relay correlates replies by connection
   * order (no request id on the wire), so we queue FIFO per reply type.
   */
  readonly #pendingOpen: Pending<OpenedFrame>[] = [];
  readonly #pendingJoin: Pending<JoinedFrame>[] = [];

  /**
   * The channel a join/open is about to be associated with, queued alongside
   * the pending request so the callId from the relay reply can be bound to it.
   */
  readonly #pendingChannel: PairingChannel[] = [];

  #closed = false;

  /** This side's announceable identity, or null when the caller opted out. */
  readonly #identity: IdentityRef | null;

  private constructor(ws: WebSocket, identity: IdentityRef | null) {
    this.#ws = ws;
    this.#identity = identity;
    ws.on('message', (data) => this.#onWireData(data));
    ws.on('close', () => this.#onClose('connection closed'));
    ws.on('error', (err) => this.#onClose(`connection error: ${String(err)}`));
  }

  /** Open a WebSocket to the relay and resolve once it is ready. */
  static connect(
    relayUrl: string,
    opts: { identity?: IdentityRef | null } = {},
  ): Promise<MagpieClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(relayUrl);
      const onError = (err: Error) => {
        ws.removeAllListeners();
        reject(err);
      };
      ws.once('error', onError);
      ws.once('open', () => {
        ws.removeListener('error', onError);
        resolve(new MagpieClient(ws, opts.identity ?? null));
      });
    });
  }

  /**
   * Open a new call. Mints a fresh pairing code, derives the per-call channel,
   * and tells the relay to register the rendezvous. Returns the human-shareable
   * code, the callId, and the channel (also retained internally).
   */
  async start(opts: {
    from: Extension;
    topic: string;
    maxTurns?: number;
  }): Promise<{ code: string; callId: string; channel: PairingChannel }> {
    const code = generatePairingCode();
    const channel = channelFromCode(code);

    // Clamp client-side too; the relay re-clamps, but never send nonsense.
    const requested = opts.maxTurns ?? DEFAULT_MAX_TURNS;
    // The relay counts every sealed send — two hellos and the closing resolve
    // included — so reserve their budget on top of what the caller asked for.
    // Unconditional: both sides always send a hello, and only one side ever
    // resolves, so the reservation is the same for every call.
    const maxTurns = Math.max(1, Math.min(requested + RESERVED_TURN_BUDGET, ABSOLUTE_MAX_TURNS));

    const send: OpenFrame = {
      t: 'open',
      rendezvousId: rendezvousId(code),
      from: opts.from,
      // Deliberately empty. The relay stored this field and never forwarded it
      // to the joiner, so a cleartext topic bought nothing and told the relay
      // operator what the call was about. The real topic travels to the peer
      // inside the sealed hello frame (#announceHello). Both relays accept ''.
      topic: '',
      maxTurns,
    };

    const opened = await this.#request<OpenedFrame>(this.#pendingOpen, channel, send);
    this.#channels.set(opened.callId, channel);
    this.#ctx.set(opened.callId, {
      from: opts.from,
      peer: null,
      topic: opts.topic,
      startedAt: new Date().toISOString(),
      transcript: [],
      summary: null,
      resolution: null,
      peerIdentity: null,
      role: 'opener',
    });
    return { code, callId: opened.callId, channel };
  }

  /**
   * Join an existing call using a code shared out-of-band. Derives the same
   * per-call channel from the code and registers it for the returned callId.
   */
  async join(opts: {
    from: Extension;
    code: string;
  }): Promise<{ callId: string; peer: Extension; channel: PairingChannel }> {
    const channel = channelFromCode(opts.code);
    const send: ClientToRelay = {
      t: 'join',
      rendezvousId: rendezvousId(opts.code),
      from: opts.from,
    };
    const joined = await this.#request<JoinedFrame>(this.#pendingJoin, channel, send);
    this.#channels.set(joined.callId, channel);
    this.#ctx.set(joined.callId, {
      from: opts.from,
      peer: joined.peer,
      // Filled in when the opener's hello arrives; stays '(joined)' only if the
      // opener predates hello-carried topics.
      topic: '(joined)',
      startedAt: new Date().toISOString(),
      transcript: [],
      summary: null,
      resolution: null,
      peerIdentity: null,
      role: 'joiner',
    });
    this.#announceHello(joined.callId);
    // `peer` is the opener's extension, reported by the relay in the `joined`
    // frame. Surfacing it lets callers address outbound messages correctly.
    return { callId: joined.callId, peer: joined.peer, channel };
  }

  /**
   * Seal a Message with the call's channel and ship the ciphertext to the relay.
   * The relay routes it to the other endpoint; it never sees the plaintext.
   */
  async send(callId: string, msg: Message): Promise<void> {
    this.#sendSealed(callId, msg);
    this.#record(callId, msg);
  }

  /** Seal + ship without touching the transcript. Control-plane frames use this. */
  #sendSealed(callId: string, msg: Message): void {
    const channel = this.#channels.get(callId);
    if (!channel) throw new Error(`no channel for call ${callId}`);

    // Defense in depth: validate our own outbound message and cap content.
    if (Buffer.byteLength(msg.content, 'utf8') > MAX_CONTENT_BYTES) {
      throw new Error(`content exceeds ${MAX_CONTENT_BYTES} bytes`);
    }
    parseMessage(msg);

    const plaintext = Buffer.from(JSON.stringify(msg), 'utf8');
    const sealed = channel.seal(plaintext);
    const frame = Buffer.from(sealed).toString('base64');

    this.#sendFrame({ t: 'send', callId, frame });
  }

  /**
   * Declare the call resolved with a human/agent-readable `summary`, then end
   * it. Sends a `resolve` message (the peer learns the conclusion) and hangs up.
   * The summary lands in both sides' end-of-call report.
   */
  async resolve(callId: string, resolution: string | Resolution): Promise<void> {
    const ctx = this.#ctx.get(callId);
    if (!ctx) throw new Error(`no such call ${callId}`);
    if (!ctx.peer) throw new Error('cannot resolve before a peer has joined');
    const r: Resolution = typeof resolution === 'string' ? { summary: resolution } : resolution;
    ctx.resolution = r;
    ctx.summary = r.summary;
    const msg: Message = {
      v: PROTOCOL_VERSION,
      id: newMessageId(),
      callId,
      from: ctx.from,
      to: ctx.peer,
      type: 'resolve',
      ts: new Date().toISOString(),
      turn: ctx.transcript.length,
      inReplyTo: null,
      content: encodeResolution(r),
    };
    this.#sendSealed(callId, msg);
    // The transcript keeps the human-readable summary, never the envelope.
    this.#record(callId, { ...msg, content: r.summary });
    await this.hangup(callId);
  }

  /** Build the end-of-call report from the recorded transcript. */
  buildReport(callId: string, outcome: CallOutcome): CallReport | null {
    const ctx = this.#ctx.get(callId);
    if (!ctx) return null;
    const resolved = outcome === 'resolved';
    return {
      callId,
      topic: ctx.topic,
      me: ctx.from,
      peer: ctx.peer,
      outcome,
      summary: resolved ? ctx.summary : null,
      // Present only on a resolution, and then always arrays: a parser must be
      // able to tell "listed none" from "this call never resolved".
      ...(resolved ? { agreed: ctx.resolution?.agreed ?? [], contested: ctx.resolution?.contested ?? [] } : {}),
      identity: { me: this.#identity, peer: ctx.peerIdentity },
      turns: ctx.transcript.length,
      startedAt: ctx.startedAt,
      endedAt: new Date().toISOString(),
      transcript: ctx.transcript,
    };
  }

  #record(callId: string, msg: Message): void {
    const ctx = this.#ctx.get(callId);
    if (!ctx) return;
    const entry: TranscriptEntry = {
      from: msg.from,
      type: msg.type,
      content: msg.content,
      ts: msg.ts,
    };
    ctx.transcript.push(entry);
  }

  /**
   * One sealed `system` frame per side, sent the moment the channel is live:
   * this side's public key (if it has one) and, from the opener, the topic.
   * Never recorded in the transcript and never surfaced to a model:
   * bookkeeping, not conversation. Failure is logged, not thrown — a call
   * without attribution or a title is still a call.
   *
   * ALWAYS sent, even as an empty envelope: the opener reserves exactly
   * RESERVED_TURN_BUDGET relay turns for hellos and cannot know whether
   * the joiner has anything to say. If a joiner with no key sent nothing, one
   * reserved turn would go unspent and the caller's cap would be one message
   * looser than asked. An empty hello costs ~60 sealed bytes.
   */
  #announceHello(callId: string): void {
    const ctx = this.#ctx.get(callId);
    if (!ctx || !ctx.peer) return;
    const topic = ctx.role === 'opener' ? ctx.topic : null;
    try {
      this.#sendSealed(callId, {
        v: PROTOCOL_VERSION,
        id: newMessageId(),
        callId,
        from: ctx.from,
        to: ctx.peer,
        type: 'system',
        ts: new Date().toISOString(),
        turn: ctx.transcript.length,
        inReplyTo: null,
        content: encodeHello({ identity: this.#identity, topic }),
      });
    } catch (err) {
      process.stderr.write(`[magpie] hello failed on ${callId}: ${String(err)}\n`);
    }
  }

  /** Register a callback for decrypted, validated inbound messages. */
  onMessage(cb: MessageCb): void {
    this.#messageCbs.push(cb);
  }

  /** Register a callback for remote hangups. */
  onHangup(cb: HangupCb): void {
    this.#hangupCbs.push(cb);
  }

  /**
   * Register a callback fired when the OPENER's peer joins the call. The opener
   * learns the joiner's extension here (the relay reports it in `peer-joined`),
   * which a session layer needs to address outbound messages before the peer
   * has sent anything.
   */
  onPeerJoined(cb: PeerJoinedCb): void {
    this.#peerJoinedCbs.push(cb);
  }

  /** Register a callback fired when the PEER declares the call resolved. */
  onResolved(cb: ResolvedCb): void {
    this.#resolvedCbs.push(cb);
  }

  /** Tear down a single call and tell the relay. */
  async hangup(callId: string): Promise<void> {
    this.#sendFrame({ t: 'hangup', callId });
    this.#channels.delete(callId);
  }

  /**
   * Whether the underlying socket is open and usable. A caller that memoizes
   * clients (e.g. the MCP session store) must check this before reuse: a relay
   * can drop us (an UNKNOWN_RENDEZVOUS join closes the socket), and a dead
   * client would fail every later start/join with "not connected".
   */
  get isConnected(): boolean {
    return !this.#closed && this.#ws.readyState === WebSocket.OPEN;
  }

  /** Close the underlying WebSocket and drop all per-call state. */
  close(): void {
    this.#closed = true;
    this.#channels.clear();
    try {
      this.#ws.close();
    } catch {
      // already closing/closed
    }
  }

  // ---- internals -----------------------------------------------------------

  /**
   * Send a control frame, attach the channel/pending bookkeeping, and return a
   * promise that resolves when the matching relay reply arrives.
   */
  #request<T extends OpenedFrame | JoinedFrame>(
    queue: Pending<T>[],
    channel: PairingChannel,
    frame: ClientToRelay,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push({ resolve, reject });
      this.#pendingChannel.push(channel);
      try {
        this.#sendFrame(frame);
      } catch (err) {
        queue.pop();
        this.#pendingChannel.pop();
        reject(err as Error);
      }
    });
  }

  #sendFrame(frame: ClientToRelay): void {
    if (this.#closed || this.#ws.readyState !== WebSocket.OPEN) {
      throw new Error('magpie client is not connected');
    }
    this.#ws.send(JSON.stringify(frame));
  }

  #onWireData(data: WebSocket.RawData): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      process.stderr.write('[magpie] dropped non-JSON relay frame\n');
      return;
    }
    const frame = parseRelayFrame(parsed);
    if (!frame) {
      process.stderr.write('[magpie] dropped malformed relay frame\n');
      return;
    }

    switch (frame.t) {
      case 'opened': {
        const pending = this.#pendingOpen.shift();
        const channel = this.#pendingChannel.shift();
        // Register the channel SYNCHRONOUSLY here, not in the awaited start()
        // continuation: ws can emit `opened` and a following `deliver` in the
        // same synchronous batch, and a message sent the instant we pair would
        // otherwise hit an unregistered channel and be dropped.
        if (channel) this.#channels.set(frame.callId, channel);
        if (pending) pending.resolve(frame);
        return;
      }
      case 'joined': {
        const pending = this.#pendingJoin.shift();
        const channel = this.#pendingChannel.shift();
        if (channel) this.#channels.set(frame.callId, channel);
        if (pending) pending.resolve(frame);
        return;
      }
      case 'peer-joined': {
        // The opener learns its peer connected, and who they are. Channel was
        // already registered at start; surface the peer to any session layer.
        const ctx = this.#ctx.get(frame.callId);
        if (ctx) ctx.peer = frame.peer;
        // Hello first, so a parked ask that wakes on this callback sends its
        // question to a peer that already knows who is asking and about what.
        this.#announceHello(frame.callId);
        for (const cb of this.#peerJoinedCbs) cb(frame.callId, frame.peer);
        return;
      }
      case 'deliver': {
        this.#onDeliver(frame.callId, frame.frame);
        return;
      }
      case 'hangup': {
        this.#channels.delete(frame.callId);
        for (const cb of this.#hangupCbs) cb(frame.reason);
        return;
      }
      case 'error': {
        this.#onError(frame);
        return;
      }
    }
  }

  /** Decrypt, validate (defense in depth), and dispatch one delivered frame. */
  #onDeliver(callId: string, b64: string): void {
    const channel = this.#channels.get(callId);
    if (!channel) {
      process.stderr.write(`[magpie] deliver for unknown call ${callId}; dropped\n`);
      return;
    }
    let msg: Message;
    try {
      const ciphertext = Buffer.from(b64, 'base64');
      const plaintext = channel.open(ciphertext); // throws on tamper
      const json: unknown = JSON.parse(Buffer.from(plaintext).toString('utf8'));
      msg = parseMessage(json); // throws on schema violation
    } catch (err) {
      process.stderr.write(
        `[magpie] dropped undecryptable/invalid frame on ${callId}: ${String(err)}\n`,
      );
      return;
    }
    // Hello frames are bookkeeping: record who and what, then vanish. They
    // never reach the transcript, the turn count, or a listener. A `system`
    // frame that is NOT a hello falls through untouched.
    if (msg.type === 'system') {
      const hello = decodeHello(msg.content);
      if (hello) {
        const ctx = this.#ctx.get(callId);
        if (ctx) {
          if (hello.identity) ctx.peerIdentity = hello.identity;
          // Only a joiner takes the topic, and only from the opener's hello.
          if (hello.topic && ctx.role === 'joiner') ctx.topic = hello.topic;
        }
        return;
      }
    }

    // A `resolve` message is the peer concluding the call — it is not a normal
    // query, so surface it via onResolved, not onMessage. The transcript keeps
    // the summary; the structured form is kept alongside for the report.
    if (msg.type === 'resolve') {
      const r = decodeResolution(msg.content);
      const ctx = this.#ctx.get(callId);
      if (ctx) {
        ctx.resolution = r;
        ctx.summary = r.summary;
      }
      this.#record(callId, { ...msg, content: r.summary });
      for (const cb of this.#resolvedCbs) cb(callId, r.summary, r);
      return;
    }

    this.#record(callId, msg);
    for (const cb of this.#messageCbs) cb(msg);
  }

  /**
   * Relay reported a violation. Reject the oldest in-flight request if any,
   * otherwise log — an error can also be unsolicited (e.g. turn cap on send).
   */
  #onError(frame: ErrorFrame): void {
    const err = new Error(`relay error [${frame.code}]: ${frame.message}`);
    const pendingJoin = this.#pendingJoin.shift();
    if (pendingJoin) {
      this.#pendingChannel.shift();
      pendingJoin.reject(err);
      return;
    }
    const pendingOpen = this.#pendingOpen.shift();
    if (pendingOpen) {
      this.#pendingChannel.shift();
      pendingOpen.reject(err);
      return;
    }
    process.stderr.write(`[magpie] ${err.message}\n`);
  }

  #onClose(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    const err = new Error(`magpie disconnected: ${reason}`);
    for (const p of this.#pendingOpen.splice(0)) p.reject(err);
    for (const p of this.#pendingJoin.splice(0)) p.reject(err);
    this.#pendingChannel.splice(0);
    this.#channels.clear();
    // A socket drop ends every call on this client. Notify the hangup
    // listeners so a session layer can unblock parked sb_ask/sb_listen calls
    // and invalidate any memoized reference to this now-dead client.
    for (const cb of this.#hangupCbs) {
      try {
        cb(reason);
      } catch {
        // a listener must not break teardown
      }
    }
  }
}
