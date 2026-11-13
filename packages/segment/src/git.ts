import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_GID, AGENT_HOME, AGENT_UID, sandboxActive } from './sandbox.ts';

export class GitError extends Error {
  args: string[]; code: number | null; stderr: string;
  constructor(args: string[], code: number | null, stderr: string) {
    super(`git ${args[0]} failed (${code}): ${stderr.slice(0, 300)}`);
    this.args = args; this.code = code; this.stderr = stderr;
  }
}

export interface GitOpts { cwd?: string; token?: string; /** Run as the unprivileged agent user (only when the sandbox is active). */ asAgent?: boolean }

/**
 * Runs git with the credential passed through GIT_CONFIG_* environment variables for this one process.
 * The token never reaches argv, `.git/config`, or the working tree (spec: harness-owned git credentials).
 */
export function git(args: string[], o: GitOpts = {}): Promise<string> {
  const agent = !!o.asAgent && sandboxActive();
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '', HOME: agent ? AGENT_HOME : (process.env.HOME ?? '/tmp'), GIT_TERMINAL_PROMPT: '0', LANG: 'C',
  };
  if (o.token) {
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.extraHeader';
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`x-access-token:${o.token}`).toString('base64')}`;
  }
  return new Promise((resolve, reject) => {
    const p = spawn('git', args, { cwd: o.cwd, env, uid: agent ? AGENT_UID : undefined, gid: agent ? AGENT_GID : undefined });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new GitError(args, code, err))));
  });
}

const IDENT = ['-c', 'user.name=ai-developer-agent', '-c', 'user.email=ai-developer-agent@users.noreply.github.com'];

export async function cloneRepo(url: string, dir: string, token?: string): Promise<void> {
  await git(['clone', '--quiet', url, dir], { token });
}

export async function remoteHasBranch(dir: string, branch: string, token?: string): Promise<boolean> {
  return (await git(['ls-remote', '--heads', 'origin', branch], { cwd: dir, token })).trim().length > 0;
}

export async function defaultBranch(dir: string, asAgent = false): Promise<string> {
  const ref = (await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: dir, asAgent })).trim();
  return ref.replace(/^origin\//, '');
}

/** Check out `branch` from the remote if it exists, else create it from the default branch. Returns true if it existed. */
export async function checkoutBranch(dir: string, branch: string, token?: string): Promise<boolean> {
  if (await remoteHasBranch(dir, branch, token)) {
    await git(['fetch', '--quiet', 'origin', branch], { cwd: dir, token });
    await git(['checkout', '--quiet', '-B', branch, `origin/${branch}`], { cwd: dir });
    return true;
  }
  await git(['checkout', '--quiet', '-b', branch], { cwd: dir });
  return false;
}

/** Commits all working tree changes. Returns false when there was nothing to commit. */
export async function commitAll(dir: string, message: string): Promise<boolean> {
  // Runs as the agent user, with hooks off: the agent controls this repository's config and hooks.
  const o = { cwd: dir, asAgent: true };
  const NOHOOKS = ['-c', 'core.hooksPath=/dev/null'];
  await git([...NOHOOKS, 'add', '-A'], o);
  if ((await git([...NOHOOKS, 'status', '--porcelain'], o)).trim() === '') return false;
  await git([...NOHOOKS, ...IDENT, 'commit', '--quiet', '--no-verify', '-m', message], o);
  return true;
}

/**
 * Commits main-checkout changes onto `branch` (created from HEAD if needed), leaving out factory/: `swamp extension pull` rewrites tracked files there.
 * Returns true when HEAD is on `branch` afterwards, whether or not there was anything new to commit.
 */
export async function commitMainCheckout(dir: string, branch: string, message: string): Promise<boolean> {
  const o = { cwd: dir, asAgent: true };
  const NOHOOKS = ['-c', 'core.hooksPath=/dev/null'];
  await git([...NOHOOKS, 'add', '-A', '--', '.', ':(exclude)factory'], o);
  const staged = (await git([...NOHOOKS, 'diff', '--cached', '--name-only'], o)).trim() !== '';
  const current = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], o)).trim();
  if (current !== branch) {
    if (!staged) return false; // nothing to carry over, and HEAD is still the default branch
    await git(['checkout', '--quiet', '-B', branch], o);
  }
  if (staged) await git([...NOHOOKS, ...IDENT, 'commit', '--quiet', '--no-verify', '-m', message], o);
  return true;
}

/**
 * Publishes HEAD of the agent's repository to `remoteUrl`.
 * The agent can edit its repo's config and hooks (URL rewrites, hooks, credential helpers), so the token is never used
 * there. Commits are fetched into a fresh repository that only the harness has touched, and pushed from that one.
 */
export async function publish(workDir: string, branch: string, remoteUrl: string, token?: string, ref = 'HEAD'): Promise<void> {
  // The agent user writes a bundle file; the harness never opens the agent-owned repository, so git's ownership check never applies.
  const base = await mkdtemp(join(tmpdir(), 'publish-'));
  try {
    await chmod(base, 0o777); // the agent user must be able to write the bundle here
    const bundle = join(base, 'work.bundle');
    await git(['-c', 'core.hooksPath=/dev/null', 'bundle', 'create', '--quiet', bundle, ref], { cwd: workDir, asAgent: true });
    const clean = join(base, 'clean');
    await mkdir(clean);
    await git(['init', '--quiet'], { cwd: clean });
    await git(['fetch', '--quiet', bundle, `${ref}:refs/heads/publish`], { cwd: clean });
    await git(['push', '--quiet', remoteUrl, `refs/heads/publish:refs/heads/${branch}`], { cwd: clean, token });
  } finally { await rm(base, { recursive: true, force: true }); }
}

export async function headSha(dir: string): Promise<string> {
  return (await git(['rev-parse', 'HEAD'], { cwd: dir, asAgent: true })).trim();
}

export async function diffAgainstDefault(dir: string, base: string): Promise<string> {
  return git(['-c', 'core.hooksPath=/dev/null', 'diff', `origin/${base}...HEAD`], { cwd: dir, asAgent: true });
}

/** Makes a remote branch available as a local branch without checking it out (the factory adds its own worktree for it). */
export async function fetchBranchLocal(dir: string, branch: string, token?: string): Promise<void> {
  await git(['fetch', '--quiet', 'origin', `${branch}:refs/heads/${branch}`], { cwd: dir, token });
}

export async function localBranchExists(dir: string, branch: string): Promise<boolean> {
  try { await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: dir, asAgent: true }); return true; } catch { return false; }
}

/** Local branch names under `prefix` (for example `factory/`). */
export async function localBranches(dir: string, prefix: string): Promise<string[]> {
  const out = await git(['for-each-ref', '--format=%(refname:short)', `refs/heads/${prefix}`], { cwd: dir, asAgent: true });
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** How many commits `ref` has that `origin/<base>` does not. */
export async function commitsAhead(dir: string, base: string, ref: string): Promise<number> {
  return Number((await git(['rev-list', '--count', `origin/${base}..${ref}`], { cwd: dir, asAgent: true })).trim());
}

export async function refSha(dir: string, ref: string): Promise<string> {
  return (await git(['rev-parse', ref], { cwd: dir, asAgent: true })).trim();
}

/** Path of the worktree that has `branch` checked out, if any (the main checkout counts). */
export async function worktreeFor(dir: string, branch: string): Promise<string | undefined> {
  const out = await git(['worktree', 'list', '--porcelain'], { cwd: dir, asAgent: true });
  for (const block of out.split('\n\n')) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    if (path && new RegExp(`^branch refs/heads/${branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').test(block)) return path;
  }
  return undefined;
}
