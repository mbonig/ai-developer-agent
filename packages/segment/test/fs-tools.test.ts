import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { confinePath, truncateOutput, applyEdit, scrubbedEnv } from '../src/fs-tools.ts';

test('path confinement', () => {
  const root = mkdtempSync(join(tmpdir(), 'repo-'));
  assert.ok(confinePath(root, 'a/b.txt').endsWith('a/b.txt'));
  assert.throws(() => confinePath(root, '../../etc/passwd'), /escapes/);
  assert.throws(() => confinePath(root, '/etc/passwd'), /escapes/);
  symlinkSync('/etc', join(root, 'link'));
  assert.throws(() => confinePath(root, 'link/passwd'), /escapes/);
});

test('truncation keeps head and tail', () => {
  const out = truncateOutput('a'.repeat(100) + 'b'.repeat(100), 40);
  assert.ok(out.startsWith('a'.repeat(20)) && out.endsWith('b'.repeat(20)) && out.includes('truncated'));
  assert.equal(truncateOutput('short', 40), 'short');
});

test('edit requires exactly one match', () => {
  assert.equal(applyEdit('x y', 'y', 'z'), 'x z');
  assert.throws(() => applyEdit('y y', 'y', 'z'), /2 times/);
  assert.throws(() => applyEdit('abc', 'q', 'z'), /0 times/);
});

test('scrubbed env drops credentials', () => {
  const e = scrubbedEnv({ PATH: '/bin', AWS_SECRET_ACCESS_KEY: 's', GITHUB_TOKEN: 't', HOME: '/h' });
  assert.deepEqual(Object.keys(e).sort(), ['HOME', 'PATH']);
});
