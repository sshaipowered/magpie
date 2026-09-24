/**
 * Default-relay resolution.
 *
 * There is NO hosted default relay and nothing is baked into the binary. A
 * hosted default existed until 2026-09: its address lived in a pointer file on
 * GitHub Pages, and the GitHub account that served it was suspended, which took
 * the pointer down and left every installed binary unable to start a call. A
 * relay you do not run is a dependency you cannot keep alive. Magpie is now
 * self-host only.
 *
 * Resolution precedence:
 *   1. `MAGPIE_RELAY_URL`     — explicit relay. Wins; no network access.
 *   2. `MAGPIE_RELAY_POINTER` — OPTIONAL: an HTTPS text file YOU host whose first
 *                               ws(s):// line is the relay. Lets one operator move
 *                               a team's relay without touching every machine.
 *   3. null                   — invite-only: joiners paste `CODE@ws://…`, starters
 *                               cannot mint an invite until 1 or 2 is set.
 *
 * With neither variable set this module performs no fetch at all.
 */

/** How long to wait on the pointer fetch before falling back to invite-only. */
const FETCH_TIMEOUT_MS = 4000;

/**
 * Extract the relay URL from a `relay.txt` body: the first non-empty,
 * non-comment (`#`) line that is a valid `ws://`/`wss://` URL. Returns null if
 * there is no such line (an as-yet-unconfigured pointer) or the first content
 * line is malformed (surfaced as invite-only rather than a bad connection).
 */
export function parseRelayPointer(body: string): string | null {
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    try {
      const url = new URL(line);
      if (url.protocol === 'ws:' || url.protocol === 'wss:') return line;
    } catch {
      /* fall through to null */
    }
    return null; // first content line was not a valid ws(s) URL
  }
  return null;
}

export interface ResolveOpts {
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Override the pointer URL (else env `MAGPIE_RELAY_POINTER` or the default). */
  pointerUrl?: string;
  /** Diagnostics sink (stderr in production). */
  warn?: (msg: string) => void;
}

/**
 * Resolve the default relay URL. `MAGPIE_RELAY_URL` wins outright; otherwise a
 * pointer file is fetched only if `MAGPIE_RELAY_POINTER` names one. Any failure (offline, 404, malformed, timeout)
 * resolves to null — the agent then works in invite-only mode instead of
 * crashing. Never throws.
 */
export async function resolveDefaultRelay(
  env: NodeJS.ProcessEnv,
  opts: ResolveOpts = {},
): Promise<string | null> {
  const explicit = env.MAGPIE_RELAY_URL?.trim();
  if (explicit) return explicit;

  // An explicitly-empty pointer env is the same as unset: invite-only.
  const pointerRaw = env.MAGPIE_RELAY_POINTER;
  if (pointerRaw !== undefined && pointerRaw.trim() === '') return null;
  const pointerUrl = opts.pointerUrl ?? pointerRaw?.trim();
  if (!pointerUrl) return null; // nothing configured: invite-only, and no network call

  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(pointerUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });
    if (!res.ok) {
      opts.warn?.(`relay pointer ${pointerUrl} returned HTTP ${res.status}`);
      return null;
    }
    const url = parseRelayPointer(await res.text());
    if (!url) opts.warn?.(`relay pointer ${pointerUrl} has no usable ws(s):// URL yet`);
    return url;
  } catch (err) {
    opts.warn?.(
      `could not fetch relay pointer ${pointerUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
