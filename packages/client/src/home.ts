import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where Magpie keeps per-user state: `~/.magpie` unless `MAGPIE_HOME` says
 * otherwise. The installer already honours the same variable for `bin/`, so
 * one override relocates everything. Read on every call, never cached, so a
 * test can point it at a temp dir after import.
 */
export function magpieHome(): string {
  const o = process.env.MAGPIE_HOME?.trim();
  return o ? o : join(homedir(), '.magpie');
}
