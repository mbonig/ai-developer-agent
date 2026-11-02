import { isAbsolute, relative, resolve, sep } from 'node:path';
import { realpathSync } from 'node:fs';

/** Resolve `p` inside `root`; throws if it escapes (including via symlinks). */
export function confinePath(root: string, p: string): string {
  const realRoot = realpathSync(root);
  const abs = resolve(realRoot, p);
  let real = abs;
  try { real = realpathSync(abs); } catch { /* not yet existing: lexical check only */ }
  for (const candidate of [abs, real]) {
    const rel = relative(realRoot, candidate);
    if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
      throw new Error(`Path escapes repository: ${p}`);
    }
  }
  return abs;
}

/** Keep head and tail of `s` within `maxBytes` total. */
export function truncateOutput(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  const half = Math.floor(maxBytes / 2);
  const head = buf.subarray(0, half).toString('utf8');
  const tail = buf.subarray(buf.length - half).toString('utf8');
  return `${head}\n...[truncated ${buf.length - 2 * half} bytes]...\n${tail}`;
}

/** Exact single-match replacement. */
export function applyEdit(content: string, oldStr: string, newStr: string): string {
  if (oldStr === '') throw new Error('old string must not be empty');
  const count = content.split(oldStr).length - 1;
  if (count !== 1) throw new Error(`old string matched ${count} times; it must match exactly once`);
  return content.replace(oldStr, () => newStr);
}

const ENV_ALLOW = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'CI', 'NODE_ENV', 'DO_NOT_TRACK', 'OPENSPEC_TELEMETRY', 'SWAMP_API_KEY_FILE'];

/** Environment for run_command: allow-list only, so no AWS/GitHub credentials leak. */
export function scrubbedEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ENV_ALLOW) if (env[k] !== undefined) out[k] = env[k]!;
  return out;
}
