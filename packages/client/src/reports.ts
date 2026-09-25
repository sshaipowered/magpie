import { dirname, join, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { CallId } from '@magpie/protocol';
import type { CallOutcome, CallReport } from '@magpie/protocol';
import { magpieHome } from './home.js';

/**
 * On-disk store of end-of-call reports under `~/.magpie/calls/`. This is the
 * "report on termination" surface: even if a human was away when their agent
 * finished a call, the conclusion + transcript wait here. It is also the
 * machine-readable hand-off point for anything downstream: one JSON per call,
 * the `CallReport` shape verbatim. Files are 0600; the transcript is
 * plaintext-on-this-machine (the user's own side of the call).
 *
 * Lived in the CLI until 2026-09; the MCP server writes here too now.
 */
export const CALLS_DIR = 'calls';

export function callsDir(): string {
  return join(magpieHome(), CALLS_DIR);
}

/**
 * Resolve `<calls dir>/<callId>.json` and refuse anything that lands outside
 * the directory. The wire layer already rejects a callId that fails the schema;
 * this is the second line, because the value comes from the relay and a path is
 * the one place where getting it wrong writes to an arbitrary file.
 */
function reportPath(callId: string): string {
  // The schema is the real guard: it admits no separator and no dots, so no
  // value that passes it can name anything but a file in this directory.
  if (!CallId.safeParse(callId).success) {
    throw new Error(`refusing a report path for a malformed callId: ${callId}`);
  }
  const dir = resolve(callsDir());
  const path = resolve(dir, `${callId}.json`);
  if (dirname(path) !== dir) {
    throw new Error(`refusing a report path outside ${dir}: ${callId}`);
  }
  return path;
}

/** Persist a report. Returns the file path. */
export function saveReport(r: CallReport): string {
  const path = reportPath(r.callId);
  mkdirSync(callsDir(), { recursive: true });
  writeFileSync(path, JSON.stringify(r, null, 2), { encoding: 'utf8', mode: 0o600 });
  return path;
}

/** All saved reports, newest first. */
export function listReports(): CallReport[] {
  const dir = callsDir();
  if (!existsSync(dir)) return [];
  const out: CallReport[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, f), 'utf8')) as CallReport);
    } catch {
      // skip unreadable
    }
  }
  return out.sort((a, b) => (a.endedAt < b.endedAt ? 1 : -1));
}

/** One report by callId, or null. */
export function readReport(callId: string): CallReport | null {
  let path: string;
  try {
    path = reportPath(callId);
  } catch {
    return null;
  }
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CallReport;
  } catch {
    return null;
  }
}

const OUTCOME_LABEL: Record<CallOutcome, string> = {
  resolved: '✅ resolved',
  'turn-cap': '⛔ turn cap reached',
  'hung-up': '📴 hung up',
  disconnected: '🔌 disconnected',
};

export function outcomeLabel(o: CallOutcome): string {
  return OUTCOME_LABEL[o] ?? o;
}

/** A human-readable report block printed when a call ends. */
export function renderReport(r: CallReport): string {
  const lines = [
    '',
    '════════════ CALL REPORT ════════════',
    `Topic:   ${r.topic}`,
    `With:    ${r.peer ?? '(unknown)'}${r.identity?.peer ? `  [${r.identity.peer.fingerprint}]` : ''}`,
    `Outcome: ${outcomeLabel(r.outcome)}`,
  ];
  if (r.summary) {
    lines.push('', 'Summary:', r.summary);
  } else if (r.outcome !== 'resolved') {
    lines.push('', '(ended without a resolution summary)');
  }
  if (r.agreed?.length) lines.push('', 'Agreed:', ...r.agreed.map((a) => `  • ${a}`));
  if (r.contested?.length) {
    lines.push('', 'Contested:');
    for (const c of r.contested) {
      lines.push(`  • ${c.point}`);
      if (c.mine) lines.push(`      mine:   ${c.mine}`);
      if (c.theirs) lines.push(`      theirs: ${c.theirs}`);
    }
  }
  lines.push('', `Turns: ${r.turns}  ·  ${r.startedAt} → ${r.endedAt}`, '═════════════════════════════════════');
  return lines.join('\n');
}
