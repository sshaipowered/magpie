/**
 * Deriving a usable `@owner/role` address when the operator did not supply one.
 *
 * `MAGPIE_EXTENSION` used to be mandatory: the MCP wrote a one-line complaint to
 * stderr and exited 1. That is fine for the CLI, where the human sees the
 * message, but an MCP server is launched by a host (Claude Code, Codex,
 * Antigravity) that usually swallows stderr — so the operator saw "server failed
 * to start" with no cause. Anyone registering the command by hand, which is
 * exactly what we tell Antigravity users to do, hit that wall.
 *
 * So an unset extension now falls back to `@<os-user>/main`.
 *
 * The OS username cannot be used raw. EXTENSION_RE is deliberately strict
 * (lowercase alphanumerics and hyphens, since these ids reach the filesystem),
 * while real usernames are not: macOS full-name accounts ("Sang Hoon"),
 * corporate logins ("John.Doe"), and Windows domain names ("CORP\\alice") all
 * fail it. An unsanitized `@$(whoami)/main` therefore traded the old confusing
 * exit for a different confusing exit. Everything invalid collapses to hyphens
 * here, and a name that survives none of it falls back to `agent`.
 */

/** Mirrors EXTENSION_RE's per-segment rule: [a-z0-9] then up to 30 of [a-z0-9-]. */
const MAX_SEGMENT = 31;

/** Used when the OS gives us nothing salvageable (empty, or all-unicode). */
export const FALLBACK_OWNER = 'agent';

/** The role half of a derived address. Owners vary; the default role does not. */
export const DEFAULT_ROLE = 'main';

/**
 * Coerce arbitrary text into one valid extension segment, or '' if nothing
 * usable survives. Truncation happens BEFORE the trailing-hyphen trim, so a cut
 * that lands mid-hyphen-run cannot leave a trailing '-'.
 */
export function sanitizeSegment(raw: string): string {
  const collapsed = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '');
  return collapsed.slice(0, MAX_SEGMENT).replace(/-+$/, '');
}

/**
 * The OS username, from the env vars every platform we ship on sets.
 * `os.userInfo()` is deliberately not consulted: it throws on systems where the
 * uid has no passwd entry (common in containers), and this runs at startup.
 */
export function osUsername(env: NodeJS.ProcessEnv): string {
  return env.MAGPIE_DEFAULT_OWNER || env.USER || env.USERNAME || env.LOGNAME || '';
}

/**
 * The address to use when `MAGPIE_EXTENSION` is unset. Always returns something
 * EXTENSION_RE accepts, so callers never have to handle a derivation failure.
 */
export function defaultExtension(env: NodeJS.ProcessEnv): string {
  const owner = sanitizeSegment(osUsername(env)) || FALLBACK_OWNER;
  return `@${owner}/${DEFAULT_ROLE}`;
}

/**
 * Resolve the extension to run as: an explicit `MAGPIE_EXTENSION` if set (kept
 * verbatim so an invalid one still gets its own precise error downstream),
 * otherwise a derived default.
 */
export function resolveExtension(env: NodeJS.ProcessEnv): {
  extension: string;
  derived: boolean;
} {
  const explicit = env.MAGPIE_EXTENSION?.trim();
  if (explicit) return { extension: explicit, derived: false };
  return { extension: defaultExtension(env), derived: true };
}
