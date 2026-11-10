import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * How the agent should do the work in this repository, in priority order:
 *  - factory: a swamp software factory (stagecraft) is present and enabled
 *  - openspec: OpenSpec is set up; propose a spec first and wait for approval before implementing
 *  - plain: neither
 */
export type WorkMode = 'factory' | 'openspec' | 'plain';

export interface ModeInfo { mode: WorkMode; reason: string }

export function detectMode(repoDir: string, env: Record<string, string | undefined> = process.env): ModeInfo {
  const has = (p: string) => existsSync(join(repoDir, p));
  const factoryPresent = has('factory/.swamp.yaml') && has('factory/models') && (has('.claude/commands/factory.md') || has('factory/README.md'));
  if (factoryPresent && env.ENABLE_FACTORY === 'true') return { mode: 'factory', reason: 'swamp software factory found in factory/' };
  const factoryNote = factoryPresent ? ' (a swamp factory exists but is not enabled for this deployment)' : '';
  if (has('openspec/config.yaml')) return { mode: 'openspec', reason: `OpenSpec found in openspec/${factoryNote}` };
  return { mode: 'plain', reason: `no factory or OpenSpec found${factoryNote}` };
}
