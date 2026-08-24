// Release smoke test: drive a REAL two-party call through the REAL hosted relay
// using the ACTUAL released magpie-mcp binary.
//
//   node scripts/smoke.mjs <path-to-magpie-mcp[.exe]>
//
// Zero npm dependencies on purpose: this runs on a bare runner where the only
// thing present is the extracted archive, so it must not import from
// node_modules or from the repo's own packages.
//
// Exit 0 means every assertion below held. Anything else prints
// "SMOKE FAIL: <reason>" and exits 1.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, writeSync } from 'node:fs';
import path from 'node:path';

// Default to FAILURE, before anything else can go wrong. Every server-side
// timer in session.ts is unref()'d, so a flow that aborts halfway lets the
// event loop drain and Node would exit 0 with the call unfinished. CI reads
// that as a pass. Only the single success path below clears this.
process.exitCode = 1;

// ---------------------------------------------------------------------------
// Bounds. Every await in this file is wrapped in one of these.
// ---------------------------------------------------------------------------

// Generous: on windows-latest, Defender scans a ~64 MB unsigned exe on first
// exec, and the relay-pointer fetch adds up to 4 s on top. The two processes
// start serially so only the first pays the scan.
const READY_MS = 90_000;
const INIT_MS = 20_000;
const LIST_MS = 10_000;
const JOIN_MS = 30_000;
const START_MS = 30_000;
const ANSWER_MS = 20_000;
const RESOLVE_MS = 20_000;
const NEG_ASK_MS = 15_000;
const LISTEN_TIMEOUT_MS = 45_000;
// sb_listen returns a "nothing yet" notice at timeoutMs, so the RPC only needs
// slack on top of the value we passed.
const LISTEN_RPC_MS = LISTEN_TIMEOUT_MS + 15_000;
// sb_ask's own peer-wait is 10 min and its reply backstop 15 min, both
// hardcoded server-side. This client-side bound is what actually stops CI from
// burning the 6 h default job timeout when the relay wedges.
//
// It has to dominate everything that may legitimately happen between issuing
// the ask and awaiting it, because its clock starts at issue: the script parks
// the promise, then sleeps, joins, listens and answers before collecting it.
// Sized under that sum rather than over it, a slow-but-working relay reports a
// bogus "sb_ask timed out" — a red run with no bug behind it.
const ASK_ISSUE_TO_AWAIT_MS = 3_000 + JOIN_MS + LISTEN_RPC_MS + ANSWER_MS;
const ASK_MS = ASK_ISSUE_TO_AWAIT_MS + 60_000;
// Serial worst case is now ~7.5 min. The watchdog is deliberately NOT unref()'d.
const WATCHDOG_MS = 12 * 60_000;

// The separator in security.ts is an EM DASH (U+2014), not a hyphen. Built from
// its codepoint so no editor, diff, or transfer can quietly downgrade it to a
// hyphen: these must match the fence byte for byte or every payload extraction
// below fails with "fence markers missing".
const EM_DASH = String.fromCharCode(0x2014);
const FENCE_BEGIN = `<<<UNTRUSTED PEER MESSAGE ${EM_DASH} BEGIN>>>`;
const FENCE_END = `<<<UNTRUSTED PEER MESSAGE ${EM_DASH} END>>>`;

const RELAY_POINTER = 'https://sshaipowered.github.io/magpie/relay.txt';

const EXT = '@[a-z0-9][a-z0-9-]{0,30}\\/[a-z0-9][a-z0-9-]{0,30}';
// The ready line, per bin.ts. The "(derived; …)" clause is REQUIRED here: this
// script sets no MAGPIE_EXTENSION, so its absence means the derived-default
// path did not run. That path is where the Windows-only registration bug lived
// (osUsername reads USER, then USERNAME; only the latter exists on Windows).
const READY_RE = new RegExp(
  `^\\[magpie-mcp\\] ready as (${EXT}) \\(derived; set MAGPIE_EXTENSION to change\\) via (\\S+) \\(stdio\\)$`,
  'm',
);
const READY_LOOSE_RE = /^\[magpie-mcp\] ready as .+ \(stdio\)$/m;
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE = `[${CODE_CHARS}]{4}-[${CODE_CHARS}]{4}-[${CODE_CHARS}]{4}`;

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const T0 = Date.now();
const children = [];
let stepNo = 0;

function log(msg) {
  const t = ((Date.now() - T0) / 1000).toFixed(1).padStart(6);
  writeSync(1, `[smoke ${t}s] ${msg}\n`);
}

function step(msg) {
  stepNo += 1;
  log(`step ${String(stepNo).padStart(2)} | ${msg}`);
}

function must(cond, msg) {
  if (!cond) throw new Error(msg);
}

function hardExit(code, reason) {
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  // writeSync, not console.log: Node's stdout pipe is asynchronous on macOS, so
  // process.exit() can truncate the very line CI greps for. ASCII only, so it
  // survives any Windows console code page.
  if (code === 0) writeSync(1, '\nSMOKE PASS\n');
  else writeSync(2, `\nSMOKE FAIL: ${reason}\n`);
  process.exit(code);
}

// Reason first, stack after: the first line is what shows up in the Actions
// failure annotation, and a stack frame there tells the reader nothing.
const die = (err) => {
  const msg = err instanceof Error ? err.message : String(err);
  hardExit(1, err instanceof Error && err.stack ? `${msg}\n${err.stack}` : msg);
};

process.on('unhandledRejection', die);
process.on('uncaughtException', die);

const watchdog = setTimeout(
  () => hardExit(1, `watchdog fired after ${WATCHDOG_MS / 60_000} min at step ${stepNo}`),
  WATCHDOG_MS,
);

function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms waiting for ${label}`)), ms);
  });
  // clearTimeout on settle, both ways: an uncleared timer keeps the loop alive
  // long past the point where the script is done.
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// One magpie-mcp process, spoken to over stdio JSON-RPC
// ---------------------------------------------------------------------------

function startMcp(label, binPath) {
  // Strip MAGPIE_* case-INsensitively. Windows env vars are case-insensitive to
  // the OS but not to JS object keys, so a stray `Magpie_Relay_Url` set on the
  // runner would survive `delete env.MAGPIE_RELAY_URL` and quietly redirect
  // this test at someone else's relay while still going green.
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^magpie_/i.test(k)) delete env[k];

  // No `shell: true`. magpie-mcp(.exe) is a real executable, so CreateProcess
  // handles it directly; a shell would put cmd.exe in between and kill() would
  // then reap the shell and orphan the actual process, hanging the job.
  const child = spawn(binPath, [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);

  const pending = new Map();
  let dead = null;
  let stderrText = '';
  let nextId = 0;

  const failAll = (err) => {
    dead ??= err;
    for (const [, w] of pending) w.reject(dead);
    pending.clear();
  };

  child.on('error', (err) =>
    failAll(new Error(`${label}: could not spawn ${binPath}: ${err.message}`)),
  );
  // A child that dies must fail every in-flight RPC immediately. Without this,
  // the macOS quarantine case (SIGKILL, zero stdout, zero stderr) is
  // indistinguishable from a slow relay and burns the whole timeout before
  // reporting a useless "timed out" instead of "killed on exec".
  child.on('exit', (code, signal) => {
    const hint =
      signal === 'SIGKILL' || code === 137
        ? ' Killed on exec with no output: Gatekeeper rejected the signature (com.apple.quarantine' +
          ' is set, or the Mach-O was modified after signing), or an AV engine took it.'
        : '';
    failAll(new Error(`${label}: magpie-mcp exited early (code=${code} signal=${signal}).${hint}`));
  });
  // Writing to a dead child otherwise throws EPIPE as an unhandled stream
  // error; the exit handler above carries the real cause.
  child.stdin.on('error', () => {});

  // setEncoding installs a StringDecoder, which holds partial UTF-8 sequences
  // back until they are complete. `buf += chunk` on raw Buffers instead splits
  // multi-byte characters at chunk boundaries into U+FFFD, silently corrupting
  // the fence's EM DASH and any non-ASCII peer text. Chunk sizes differ between
  // Windows named pipes and unix pipes, so this only bites on some platforms.
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line.trim() === '') continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // not our frame
      }
      if (msg.id == null) continue;
      const waiter = pending.get(msg.id);
      if (!waiter) continue;
      pending.delete(msg.id);
      // A JSON-RPC error response carries an id too, so matching on id alone
      // would resolve it as if it were a successful result.
      if (msg.error) {
        waiter.reject(
          new Error(`${label}: JSON-RPC error from ${waiter.method}: ${JSON.stringify(msg.error)}`),
        );
      } else {
        waiter.resolve(msg.result);
      }
    }
  });

  child.stderr.on('data', (chunk) => {
    stderrText += chunk;
    writeSync(2, `[${label}] ${chunk}`);
  });

  const rpc = (method, params, ms) => {
    if (dead) return Promise.reject(dead);
    const id = ++nextId;
    const p = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    return withTimeout(p, ms, `${label} ${method}`).finally(() => pending.delete(id));
  };

  const call = async (name, args, ms) => {
    const result = await rpc('tools/call', { name, arguments: args }, ms);
    must(
      result && Array.isArray(result.content) && result.content.length > 0,
      `${label} ${name}: result.content is not a non-empty array: ${JSON.stringify(result)}`,
    );
    for (const c of result.content) {
      must(c.type === 'text', `${label} ${name}: content part is ${c.type}, expected text`);
    }
    return { text: result.content.map((c) => c.text).join('\n'), isError: result.isError === true };
  };

  // guarded() in tools.ts converts EVERY thrown error into an ordinary-looking
  // text result with isError:true. Ignoring that flag is the easiest way to
  // make this whole script pass while nothing actually works, so no caller may
  // read a tool result without going through here or checking isError itself.
  const ok = async (name, args, ms) => {
    const r = await call(name, args, ms);
    must(!r.isError, `${label} ${name} returned isError:\n${r.text}`);
    return r.text;
  };

  const ready = (ms) => {
    let iv;
    const p = new Promise((resolve, reject) => {
      const check = () => {
        if (dead) {
          reject(dead);
          return true;
        }
        const m = stderrText.match(READY_LOOSE_RE);
        if (m) {
          resolve(m[0]);
          return true;
        }
        return false;
      };
      if (check()) return;
      iv = setInterval(check, 100);
    });
    return withTimeout(p, ms, `${label} startup ready line`).finally(() => clearInterval(iv));
  };

  const notifyInitialized = () =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  return { label, child, rpc, call, ok, ready, notifyInitialized, stderr: () => stderrText };
}

// ---------------------------------------------------------------------------
// Fence handling
// ---------------------------------------------------------------------------

// Peer content reaches the model only inside fenceUntrusted's block. Asserting
// against the whole tool output would match the fence's own preamble, which
// contains words like MESSAGE, PEER, agent, project and files — so any
// plain-English assertion is self-satisfying. Everything we check is compared
// against the payload this returns and nothing else.
function fencePayload(text, what) {
  const b = text.indexOf(FENCE_BEGIN);
  // lastIndexOf: peer content may itself contain the END marker (fenceUntrusted
  // does not escape it, which is a real injection gap worth fixing separately).
  const e = text.lastIndexOf(FENCE_END);
  must(b >= 0 && e > b, `${what}: untrusted-peer fence markers missing:\n${text}`);
  const inner = text.slice(b + FENCE_BEGIN.length, e);
  const sep = inner.indexOf('\n---\n');
  must(sep >= 0, `${what}: fence separator missing:\n${text}`);
  return inner.slice(sep + '\n---\n'.length).replace(/\n$/, '');
}

// ---------------------------------------------------------------------------

async function main() {
  const arg = process.argv[2];
  must(arg, 'usage: node scripts/smoke.mjs <path-to-magpie-mcp[.exe]>');

  // Always an absolute path: a bare name with no separator makes libuv search
  // PATH rather than the cwd, which on Windows also probes .cmd/.bat.
  let bin = path.resolve(arg);
  if (!existsSync(bin) && existsSync(`${bin}.exe`)) bin = `${bin}.exe`;
  must(existsSync(bin), `no such binary: ${bin}`);
  log(`binary:   ${bin}`);
  log(`platform: ${process.platform}/${process.arch}, node ${process.version}`);

  // Three DIFFERENT nonces, one per direction. With a single nonce, a relay
  // that echoed our own query back would be indistinguishable from a peer that
  // actually answered.
  const mint = (p) => `${p}-${randomBytes(8).toString('hex').toUpperCase()}`;
  const Q_NONCE = mint('MAGPIEQ');
  const A_NONCE = mint('MAGPIEA');
  const R_NONCE = mint('MAGPIER');
  const Q_TEXT = `smoke-question ${Q_NONCE} :: do not echo this token`;
  // Non-ASCII on purpose: proves the payload survived JSON, AES-GCM, base64,
  // the relay, and the reverse trip without mojibake.
  const A_TEXT = `smoke-answer ${A_NONCE} :: 한글 émoji ✓`;
  const R_TEXT = `AGREED ${R_NONCE} :: smoke complete`;

  // Both children run with NO MAGPIE_* env at all.
  //
  // Recon C specified distinct MAGPIE_EXTENSION values (@alice/planner /
  // @bob/impl) plus MAGPIE_ASK_TIMEOUT_MS, and its identity assertion
  // ("peer === @alice/planner") was one of its false-pass defenses. The
  // operator's spec overrides that: the zero-config path is what a fresh user
  // gets and is exactly where the shipped Windows-only bug lived, so it is the
  // thing worth testing. Consequences, handled explicitly:
  //   - both endpoints derive the SAME @<os-user>/main address, so identity
  //     can no longer distinguish the two sides. The relay routes by opaque
  //     endpoint handle, not by address, so this is fine on the wire; the
  //     directional nonces below carry the proof instead.
  //   - MAGPIE_ASK_TIMEOUT_MS cannot be lowered, so sb_ask's server-side
  //     backstop stays at 15 min. ASK_MS and the watchdog bound it client-side.
  step('start two magpie-mcp processes with a scrubbed environment');
  // Serially, not concurrently. On windows-latest this is a ~60 MB unsigned
  // executable that Defender scans on first exec; two cold execs at once
  // contend for that scan, while the second one after it completes hits the
  // hash cache and starts almost immediately. Concurrency bought nothing here
  // and made the slowest leg the sum of both scans.
  const A = startMcp('A', bin);
  const lineA = await A.ready(READY_MS);
  const B = startMcp('B', bin);
  const lineB = await B.ready(READY_MS);
  const idA = parseReady('A', lineA);
  const idB = parseReady('B', lineB);
  must(
    idA.ext === idB.ext,
    `both endpoints should derive the same address with no MAGPIE_EXTENSION set, got ${idA.ext} and ${idB.ext} (env leak?)`,
  );
  must(idA.relay === idB.relay, `relay mismatch: A=${idA.relay} B=${idB.relay}`);
  log(`  identity ${idA.ext} (derived), relay ${idA.relay}`);

  step('MCP initialize on both sides');
  const initParams = {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'magpie-smoke', version: '0' },
  };
  const inits = await Promise.all([
    A.rpc('initialize', initParams, INIT_MS),
    B.rpc('initialize', initParams, INIT_MS),
  ]);
  for (const [i, r] of inits.entries()) {
    const who = i === 0 ? 'A' : 'B';
    must(
      r?.serverInfo?.name === '@magpie/mcp',
      `${who}: unexpected serverInfo ${JSON.stringify(r?.serverInfo)}`,
    );
    must(r?.capabilities?.tools, `${who}: server does not advertise a tools capability`);
    must(typeof r.protocolVersion === 'string', `${who}: missing protocolVersion`);
  }
  A.notifyInitialized();
  B.notifyInitialized();

  step('tools/list exposes exactly the documented surface');
  const listed = await A.rpc('tools/list', {}, LIST_MS);
  const names = (listed?.tools ?? []).map((t) => t.name).sort();
  const wanted = ['sb_answer', 'sb_ask', 'sb_hangup', 'sb_join', 'sb_listen', 'sb_resolve', 'sb_start'];
  // Set EQUALITY, not a subset check: a tool that fails to register is precisely
  // the bug class this whole workflow exists to catch, and a subset check would
  // wave it through.
  must(
    names.join(',') === wanted.join(','),
    `tool set changed.\n  got:  [${names.join(', ')}]\n  want: [${wanted.join(', ')}]`,
  );
  const byName = new Map(listed.tools.map((t) => [t.name, t]));
  const argKeys = {
    sb_start: ['topic'],
    sb_join: ['code'],
    sb_ask: ['callId', 'question'],
    sb_listen: ['callId', 'timeoutMs'],
    sb_answer: ['callId', 'inReplyTo', 'text'],
    sb_resolve: ['callId', 'summary'],
  };
  for (const [tool, keys] of Object.entries(argKeys)) {
    const props = byName.get(tool)?.inputSchema?.properties ?? {};
    for (const k of keys) {
      must(k in props, `${tool} no longer accepts "${k}" (has: ${Object.keys(props).join(', ')})`);
    }
  }

  // A test machine that cannot report failure is worse than no test. Prove the
  // assertion machinery can go red before trusting anything it says is green.
  // Doubles as the regression test for 100b3c9: a rejected join used to wedge
  // the cached relay client, so step 7's real join had to keep working after
  // this one is refused.
  step('negative control: sb_join on an unregistered code must be refused');
  const bogus = await B.call('sb_join', { code: 'ZZZZ-ZZZZ-ZZZZ' }, JOIN_MS);
  must(bogus.isError, `NEGATIVE CONTROL FAILED: joining a nonexistent rendezvous succeeded:\n${bogus.text}`);
  must(
    /relay error \[UNKNOWN_RENDEZVOUS\]/.test(bogus.text),
    `NEGATIVE CONTROL: wrong failure mode, expected UNKNOWN_RENDEZVOUS:\n${bogus.text}`,
  );

  step('A: sb_start');
  const started = await A.ok('sb_start', { topic: 'release smoke test' }, START_MS);
  const inviteM = started.match(new RegExp(`^ {4}(${CODE})@(\\S+)$`, 'm'));
  must(inviteM, `sb_start did not print an invite line:\n${started}`);
  const bareM = started.match(new RegExp(`^ {4}(${CODE})$`, 'm'));
  must(bareM, `sb_start did not print a bare pairing code:\n${started}`);
  must(
    bareM[1] === inviteM[1],
    `pairing code ${bareM[1]} does not match the code inside the invite ${inviteM[1]}`,
  );
  must(
    inviteM[2] === idA.relay,
    `invite carries relay ${inviteM[2]} but the process reported ${idA.relay}`,
  );
  const callIdM = started.match(/^callId: (call-[A-Za-z0-9_-]{10,})$/m);
  must(callIdM, `sb_start did not print a well-formed callId:\n${started}`);
  const invite = `${inviteM[1]}@${inviteM[2]}`;
  const callId = callIdM[1];
  log(`  invite ${invite}`);
  log(`  callId ${callId}`);

  step('A: sb_ask with nobody on the line yet (must PARK, not error)');
  let askSettled = false;
  const askP = A.call('sb_ask', { callId, question: Q_TEXT }, ASK_MS);
  askP.then(
    () => {
      askSettled = true;
    },
    () => {
      askSettled = true;
    },
  );
  await sleep(3000);
  must(
    !askSettled,
    'sb_ask returned before any peer joined; the peer-wait path regressed (it used to error out here)',
  );

  step('B: sb_join with the invite');
  const joined = await B.ok('sb_join', { code: invite }, JOIN_MS);
  // No fallback to A's callId if this does not parse. The reference driver had
  // one, which meant a broken join silently continued on the wrong session.
  const joinM = joined.match(new RegExp(`^Joined call (call-[A-Za-z0-9_-]{10,})\\. Connected to peer (${EXT})\\.$`, 'm'));
  must(joinM, `sb_join output did not match the documented shape:\n${joined}`);
  must(!joined.includes('(unknown)'), `sb_join did not learn the peer's address:\n${joined}`);
  const bCallId = joinM[1];
  must(
    joinM[2] === idA.ext,
    `peer address ${joinM[2]} does not match the opener's derived address ${idA.ext}`,
  );
  log(`  B callId ${bCallId}, peer ${joinM[2]}`);

  step("B: sb_listen picks up A's parked question");
  const heard = await B.ok('sb_listen', { callId: bCallId, timeoutMs: LISTEN_TIMEOUT_MS }, LISTEN_RPC_MS);
  // sb_listen reports "nothing arrived" and "call closed" as ORDINARY text, not
  // as isError, so those have to be rejected by hand.
  for (const bad of ['No inbound query', 'is closed', 'has RESOLVED']) {
    must(!heard.includes(bad), `sb_listen returned a non-delivery notice ("${bad}"):\n${heard}`);
  }
  const msgM = heard.match(/^Inbound message id: (msg-[A-Za-z0-9_-]{10,}) {2}\(use as inReplyTo in sb_answer\)$/m);
  must(msgM, `sb_listen did not surface a well-formed inbound message id:\n${heard}`);
  const inReplyTo = msgM[1];
  const qPayload = fencePayload(heard, 'B sb_listen');
  // Byte equality, not includes(): free, and it catches truncation and any
  // encoding damage on the way through.
  must(
    qPayload === Q_TEXT,
    `A->B payload corrupted.\n  sent: ${JSON.stringify(Q_TEXT)}\n  got:  ${JSON.stringify(qPayload)}`,
  );
  log(`  inReplyTo ${inReplyTo}, Q nonce round-tripped intact`);

  step('B: sb_answer');
  const answered = await B.ok('sb_answer', { callId: bCallId, inReplyTo, text: A_TEXT }, ANSWER_MS);
  must(
    new RegExp(`^Answer sent \\(message msg-[A-Za-z0-9_-]{10,}, in reply to ${inReplyTo}\\)\\.$`, 'm').test(answered),
    `sb_answer output did not match the documented shape:\n${answered}`,
  );

  step("A: the parked sb_ask resolves with B's answer");
  const answer = await askP;
  // "Answer sent" on B proves only a local send. This, on A, is the only real
  // end-to-end evidence in the whole script.
  must(!answer.isError, `A sb_ask failed:\n${answer.text}`);
  must(
    answer.text.startsWith(`From ${idB.ext}:\n${FENCE_BEGIN}`),
    `sb_ask result is not a fenced inbound message:\n${answer.text}`,
  );
  const aPayload = fencePayload(answer.text, 'A sb_ask');
  must(
    aPayload === A_TEXT,
    `B->A payload corrupted.\n  sent: ${JSON.stringify(A_TEXT)}\n  got:  ${JSON.stringify(aPayload)}`,
  );
  must(aPayload.includes(A_NONCE), `answer payload is missing the answer nonce ${A_NONCE}`);
  // If our own question came back to us, either the relay echoed it or this
  // script is reading its own buffer. Either way it is not a round trip.
  must(
    !answer.text.includes(Q_NONCE),
    `the question nonce ${Q_NONCE} came back inside A's answer; this is an echo, not a reply:\n${answer.text}`,
  );
  log('  A nonce round-tripped intact, Q nonce absent as required');

  step("B: park a second sb_listen to receive A's resolution");
  const listen2P = B.call('sb_listen', { callId: bCallId, timeoutMs: LISTEN_TIMEOUT_MS }, LISTEN_RPC_MS);
  listen2P.catch(() => {}); // real handling happens at the await below
  await sleep(500);

  step('A: sb_resolve');
  const resolved = await A.ok('sb_resolve', { callId, summary: R_TEXT }, RESOLVE_MS);
  const rLines = resolved.split('\n');
  must(rLines.includes(`Call ${callId} resolved and closed.`), `sb_resolve output unexpected:\n${resolved}`);
  must(rLines.includes(`CONCLUSION: ${R_TEXT}`), `sb_resolve did not echo the summary verbatim:\n${resolved}`);
  const turnsM = resolved.match(/\((\d+) message\(s\) exchanged/);
  must(turnsM, `sb_resolve did not report a turn count:\n${resolved}`);
  // query sent + response received + resolve sent. Anything less means one
  // direction never reached the transcript, i.e. never crossed the wire.
  must(
    Number(turnsM[1]) >= 3,
    `transcript holds only ${turnsM[1]} message(s); a full round trip records at least 3`,
  );

  step("B: the parked sb_listen reports A's resolution");
  const closing = await listen2P;
  must(!closing.isError, `B second sb_listen failed:\n${closing.text}`);
  must(
    closing.text.includes(`The peer has RESOLVED call ${bCallId}.`),
    `B did not observe the resolution:\n${closing.text}`,
  );
  const rPayload = fencePayload(closing.text, 'B resolve notice');
  must(
    rPayload === R_TEXT,
    `resolve payload corrupted.\n  sent: ${JSON.stringify(R_TEXT)}\n  got:  ${JSON.stringify(rPayload)}`,
  );
  must(rPayload.includes(R_NONCE), `resolve payload is missing the resolve nonce ${R_NONCE}`);

  step('negative control: sb_ask on the resolved call must be refused');
  const afterResolve = await A.call('sb_ask', { callId, question: 'x' }, NEG_ASK_MS);
  must(
    afterResolve.isError,
    `NEGATIVE CONTROL FAILED: sb_ask succeeded on a resolved call (store.forget did not run):\n${afterResolve.text}`,
  );
  must(
    /unknown callId/.test(afterResolve.text),
    `NEGATIVE CONTROL: wrong failure mode after resolve:\n${afterResolve.text}`,
  );

  step('no frames were dropped on either side');
  // The happy path can complete while the crypto layer silently discards
  // frames, so scan for the client's own drop diagnostics.
  for (const c of [A, B]) {
    const dropped = c.stderr().match(/^\[magpie\] .*dropped.*$/m);
    must(!dropped, `${c.label} dropped a relay frame: ${dropped?.[0]}`);
  }

  log('all assertions held');
}

function parseReady(label, line) {
  // Distinguish "the pointer never resolved" from "sb_start failed". Without
  // this, a dead pointer file degrades the run to invite-only mode and the
  // failure surfaces several steps later as an unrelated config error.
  must(
    !line.includes('(no default relay'),
    `${label}: no default relay was resolved. The pointer ${RELAY_POINTER} failed or ` +
      `carries no usable ws(s):// URL, so this process is in invite-only mode rather than ` +
      `the zero-config path under test. Line: ${line}`,
  );
  const m = line.match(READY_RE);
  must(m, `${label}: ready line did not match the expected shape: ${line}`);
  must(
    m[2].startsWith('wss://'),
    `${label}: expected the hosted relay over wss://, got ${m[2]}`,
  );
  return { ext: m[1], relay: m[2] };
}

let failure = null;
try {
  await main();
} catch (err) {
  failure = err;
} finally {
  // process.exit() does NOT run finally blocks, so teardown has to happen here,
  // before either exit path. SIGTERM first: on unix bin.ts closes the store and
  // the relay sockets cleanly. On Windows kill() is TerminateProcess and the
  // handler never runs, which is fine — the relay reaps the call on its own.
  for (const c of children) {
    try {
      c.kill('SIGTERM');
      setTimeout(() => {
        try {
          c.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, 5000).unref();
    } catch {
      /* already gone */
    }
  }
}

clearTimeout(watchdog);
if (failure) die(failure);
hardExit(0);
