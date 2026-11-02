import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { cloneRepo, checkoutBranch, commitAll, publish, headSha, defaultBranch, git, GitError } from '../src/git.ts';

const sh = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' });

function makeRemote() {
  const root = mkdtempSync(join(tmpdir(), 'git-'));
  const bare = join(root, 'remote.git'); const seed = join(root, 'seed');
  execFileSync('git', ['init', '--bare', '-b', 'main', bare]);
  execFileSync('git', ['clone', '-q', bare, seed]);
  writeFileSync(join(seed, 'a.txt'), 'one\n');
  sh(seed, 'add', '-A'); sh(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'); sh(seed, 'push', '-q', 'origin', 'HEAD:main');
  return { root, bare };
}

test('first segment creates the branch from default; resumed segment sees pushed work', async () => {
  const { root, bare } = makeRemote();
  const a = join(root, 'w1');
  await cloneRepo(bare, a, 'secret-token');
  assert.equal(await defaultBranch(a), 'main');
  assert.equal(await checkoutBranch(a, 'agent/issue-1', 'secret-token'), false);
  writeFileSync(join(a, 'b.txt'), 'two\n');
  assert.equal(await commitAll(a, 'agent: issue #1'), true);
  assert.equal(await commitAll(a, 'nothing'), false);
  await publish(a, 'agent/issue-1', bare, 'secret-token');
  const sha = await headSha(a);

  const b = join(root, 'w2');
  await cloneRepo(bare, b);
  assert.equal(await checkoutBranch(b, 'agent/issue-1'), true);
  assert.equal(await headSha(b), sha);
  assert.equal(readFileSync(join(b, 'b.txt'), 'utf8'), 'two\n');
});

test('the token is never written to .git/config', async () => {
  const { root, bare } = makeRemote();
  const a = join(root, 'w');
  await cloneRepo(bare, a, 'secret-token');
  await checkoutBranch(a, 'agent/x', 'secret-token');
  const cfg = readFileSync(join(a, '.git', 'config'), 'utf8');
  assert.ok(!cfg.includes('secret-token') && !cfg.includes(Buffer.from('x-access-token:secret-token').toString('base64')));
  assert.ok(!cfg.includes('extraHeader'));
});

test('rejected push surfaces as GitError', async () => {
  const { root, bare } = makeRemote();
  const a = join(root, 'a'); const b = join(root, 'b');
  await cloneRepo(bare, a); await cloneRepo(bare, b);
  for (const [dir, f] of [[a, 'x'], [b, 'y']] as const) {
    await checkoutBranch(dir, 'agent/c'); writeFileSync(join(dir, f), f); await commitAll(dir, f);
  }
  await publish(a, 'agent/c', bare);
  await assert.rejects(publish(b, 'agent/c', bare), (e) => e instanceof GitError);
  void git;
});

test('publish ignores agent-controlled repo config and hooks (URL rewrites, pre-push hooks)', async () => {
  const { root, bare } = makeRemote();
  const evil = join(root, 'evil.git'); execFileSync('git', ['init', '--bare', '-b', 'main', evil]);
  const a = join(root, 'w'); await cloneRepo(bare, a); await checkoutBranch(a, 'agent/z');
  // The agent plants a URL rewrite that would send pushes (and the token header) elsewhere, plus hooks.
  sh(a, 'config', `url.${evil}.insteadOf`, bare);
  const marker = join(root, 'hook-ran');
  for (const h of ['pre-commit', 'pre-push', 'post-commit']) {
    writeFileSync(join(a, '.git', 'hooks', h), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  }
  writeFileSync(join(a, 'f.txt'), 'f');
  assert.equal(await commitAll(a, 'work'), true);
  await publish(a, 'agent/z', bare, 'secret-token');
  assert.ok(!existsSync(marker), 'no agent-planted hook may run');
  assert.match(execFileSync('git', ['--git-dir', bare, 'branch', '--list', 'agent/z'], { encoding: 'utf8' }), /agent\/z/);
  assert.equal(execFileSync('git', ['--git-dir', evil, 'branch', '--list'], { encoding: 'utf8' }).trim(), '');
});
