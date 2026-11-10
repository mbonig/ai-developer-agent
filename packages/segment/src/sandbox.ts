import { spawnSync } from 'node:child_process';
import { chownSync, lstatSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Agent commands run as an unprivileged user. The MicroVM exposes the execution role's credentials through the
 * metadata service to every process, so that address is blocked for the agent user (firewall owner match), and the
 * harness refuses to run an agent if the block is missing.
 */
export const AGENT_UID = 1001;
export const AGENT_GID = 1001;
export const AGENT_HOME = '/home/agent';

export const sandboxActive = (): boolean =>
  typeof process.getuid === 'function' && process.getuid() === 0 && process.env.SANDBOX !== 'off';

const TABLE = '100';
const PRIO = '100';
const UIDRANGE = `${AGENT_UID}-${AGENT_UID}`;
const run = (args: string[]) => spawnSync('ip', args, { encoding: 'utf8' });

function inPlace(v6: boolean): boolean {
  const f = v6 ? ['-6'] : [];
  const rules = run([...f, 'rule', 'show']).stdout ?? '';
  const routes = run([...f, 'route', 'show', 'table', TABLE]).stdout ?? '';
  return rules.includes(`uidrange ${UIDRANGE}`) && routes.includes('blackhole') && routes.includes(v6 ? 'fd00:ec2::' : '169.254.0.0/16');
}

/**
 * Blackholes the metadata address range for the agent user only, with a uid-based routing rule. Other traffic is unaffected,
 * and the harness (root) keeps its role credentials. (Netfilter owner matching is not available in the MicroVM kernel.)
 * Idempotent. Throws if the IPv4 block cannot be installed.
 */
export function lockDownMetadata(): void {
  if (!inPlace(false)) {
    const r1 = run(['rule', 'add', 'uidrange', UIDRANGE, 'priority', PRIO, 'lookup', TABLE]);
    const r2 = run(['route', 'replace', 'blackhole', '169.254.0.0/16', 'table', TABLE]);
    if (!inPlace(false)) throw new Error(`ip rule/route failed: ${(r1.stderr || r2.stderr || String(r1.error ?? r2.error)).slice(0, 200)}`);
  }
  if (!inPlace(true)) { // best effort: not every VM has IPv6
    run(['-6', 'rule', 'add', 'uidrange', UIDRANGE, 'priority', PRIO, 'lookup', TABLE]);
    run(['-6', 'route', 'replace', 'blackhole', 'fd00:ec2::/32', 'table', TABLE]);
  }
}

export function lockdownInPlace(): boolean { return inPlace(false); }

export interface RunAs { uid: number; gid: number; home: string }
export const agentRunAs = (): RunAs | undefined => (sandboxActive() ? { uid: AGENT_UID, gid: AGENT_GID, home: AGENT_HOME } : undefined);

/** Recursively hands a tree to the agent user. */
export function chownTree(path: string, r: RunAs): void {
  chownSync(path, r.uid, r.gid);
  if (lstatSync(path).isDirectory()) for (const e of readdirSync(path)) chownTree(join(path, e), r);
}

/** Gives the agent ownership of a file the harness just wrote, and of any directories it created above it. */
export function chownNew(file: string, root: string, r: RunAs): void {
  let p = file;
  while (p.startsWith(root) && p !== root && lstatSync(p).uid !== r.uid) { chownSync(p, r.uid, r.gid); p = dirname(p); }
}
