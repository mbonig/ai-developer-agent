import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execTool } from './tools.ts';
import { git, commitAll, publish } from './git.ts';
import { agentRunAs, chownTree, lockDownMetadata, lockdownInPlace, sandboxActive } from './sandbox.ts';

/** `node segment.mjs --selftest`: proves the agent sandbox inside a real MicroVM. Prints JSON, never secret values. */
export async function selftest(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { sandboxActive: sandboxActive() };
  try { lockDownMetadata(); out.lockdownApplied = lockdownInPlace(); } catch (e) { out.lockdownError = String(e).slice(0, 200); }

  const runAs = agentRunAs();
  const root = await mkdtemp(join(tmpdir(), 'selftest-'));
  await writeFile(join(root, 'seed.txt'), 'seed');
  if (runAs) chownTree(root, runAs);
  const ctx = { root, runCommandTimeoutSeconds: 15, toolOutputMaxBytes: 4000, runAs };
  const sh = async (command: string) => (await execTool('run_command', { command }, ctx)).text.replace(/^exit code: \d+\n/, '').trim();

  out.agentUid = await sh('id -u');
  out.agentAwsEnvVars = await sh("env | grep -ci '^AWS_' || true");
  out.agentCanWrite = await sh('echo ok > w.txt && cat w.txt');
  out.agentMetadataStatus = await sh("curl -s -m 4 -o /dev/null -w '%{http_code}' -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token; true");
  out.agentCredEndpointStatus = await sh("curl -s -m 4 -o /dev/null -w '%{http_code}' http://169.254.170.2/ ; true");
  out.agentCanReadRootEnv = await sh('cat /proc/1/environ 2>&1 | head -c 20; true');
  out.agentLoopbackJobPost = await sh("curl -s -m 4 -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:8080/segment -d '{}'; true");
  out.agentInternet = await sh("curl -s -m 6 -o /dev/null -w '%{http_code}' https://api.github.com/zen; true");
  try {
    const r = await fetch('http://169.254.169.254/latest/api/token', { method: 'PUT', headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '60' }, signal: AbortSignal.timeout(4000) });
    out.harnessMetadataStatus = r.status; // the harness itself still needs its role credentials
  } catch (e) { out.harnessMetadataError = String(e).slice(0, 100); }

  // Publish path as root with an agent-owned repository (the case that failed with 'dubious ownership').
  try {
    const bare = await mkdtemp(join(tmpdir(), 'selftest-remote-'));
    await git(['init', '--bare', '--quiet', '-b', 'main', bare]);
    const work = join(root, 'pubrepo');
    await sh('mkdir pubrepo && cd pubrepo && git init -q -b main && git config user.name t && git config user.email t@t && echo hi > f.txt');
    await commitAll(work, 'selftest commit');
    await publish(work, 'agent/selftest', bare);
    out.publishAsRoot = (await git(['--git-dir', bare, 'branch', '--list', 'agent/selftest'])).trim() ? 'ok' : 'branch missing';
  } catch (e) { out.publishAsRoot = `FAILED: ${String(e).slice(0, 200)}`; }
  return out;
}
