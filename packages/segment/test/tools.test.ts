import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execTool, type ToolCtx } from '../src/tools.ts';

const mk = (over: Partial<ToolCtx> = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'tools-'));
  mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src/a.ts'), 'line1\nneedle here\nline3\n');
  mkdirSync(join(root, 'node_modules')); writeFileSync(join(root, 'node_modules/x.js'), 'needle');
  return { root, c: { root, runCommandTimeoutSeconds: 5, toolOutputMaxBytes: 2000, env: { PATH: process.env.PATH, HOME: '/tmp', AWS_SECRET_ACCESS_KEY: 'topsecret', GITHUB_TOKEN: 'ghs_x' }, ...over } as ToolCtx };
};

test('list_files skips node_modules; read_file supports line ranges', async () => {
  const { c } = mk();
  assert.equal((await execTool('list_files', {}, c)).text, 'src/a.ts');
  assert.equal((await execTool('read_file', { path: 'src/a.ts', start_line: 2, end_line: 2 }, c)).text, '2\tneedle here');
});

test('path escape is an error and reads nothing', async () => {
  const { c } = mk();
  for (const [t, i] of [['read_file', { path: '../../etc/passwd' }], ['write_file', { path: '../x', content: 'x' }], ['list_files', { path: '..' }]] as const) {
    const r = await execTool(t, i, c); assert.equal(r.isError, true); assert.match(r.text, /escapes/);
  }
});

test('write/edit; ambiguous edit names the count', async () => {
  const { root, c } = mk();
  await execTool('write_file', { path: 'new/dir/f.txt', content: 'a a' }, c);
  assert.equal(readFileSync(join(root, 'new/dir/f.txt'), 'utf8'), 'a a');
  const bad = await execTool('edit_file', { path: 'new/dir/f.txt', old_string: 'a', new_string: 'b' }, c);
  assert.equal(bad.isError, true); assert.match(bad.text, /matched 2 times/);
  assert.equal((await execTool('edit_file', { path: 'src/a.ts', old_string: 'needle', new_string: 'pin' }, c)).isError, undefined);
});

test('grep finds matches, ignores node_modules, reports none', async () => {
  const { c } = mk();
  const r = await execTool('grep', { pattern: 'needle' }, c);
  assert.match(r.text, /src\/a\.ts:2:needle here/); assert.ok(!r.text.includes('node_modules'));
  assert.equal((await execTool('grep', { pattern: 'zzzz' }, c)).text, 'no matches');
});

test('run_command: exit code, no credentials in env, cwd is the repo', async () => {
  const { c, root } = mk();
  const r = await execTool('run_command', { command: 'env; pwd; exit 3' }, c);
  assert.match(r.text, /^exit code: 3/); assert.equal(r.isError, true);
  assert.ok(!/AWS_|GITHUB_TOKEN|topsecret|ghs_x/.test(r.text)); assert.ok(r.text.includes(root.replace(/\/$/, '')));
});

test('run_command timeout kills the whole process group and returns partial output', async () => {
  const { c } = mk({ runCommandTimeoutSeconds: 1 });
  const t0 = Date.now();
  const r = await execTool('run_command', { command: 'echo partial; sleep 30 & sleep 30; echo never' }, c);
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(r.isError, true); assert.match(r.text, /timed out/); assert.match(r.text, /partial/); assert.ok(!r.text.includes('never'));
});

test('large output keeps head and tail', async () => {
  const { c } = mk({ toolOutputMaxBytes: 200 });
  const r = await execTool('run_command', { command: 'seq 1 5000' }, c);
  assert.match(r.text, /truncated/); assert.ok(r.text.includes('\n1\n')); assert.ok(r.text.trimEnd().endsWith('5000'));
});

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('view_image returns the file as an image, and refuses non-images, oversize files and escapes', async () => {
  const { root, c } = mk();
  writeFileSync(join(root, 'shot.png'), PNG_1PX); writeFileSync(join(root, 'big.png'), Buffer.alloc(3_600_000)); writeFileSync(join(root, 'notes.txt'), 'x');
  const ok = await execTool('view_image', { path: 'shot.png' }, c);
  assert.equal(ok.isError, undefined); assert.equal(ok.image?.format, 'png');
  assert.ok(ok.image!.bytes instanceof Uint8Array && ok.image!.bytes.length === PNG_1PX.length);
  assert.match((await execTool('view_image', { path: 'big.png' }, c)).text, /limit/);
  assert.match((await execTool('view_image', { path: 'notes.txt' }, c)).text, /supports png/);
  assert.match((await execTool('view_image', { path: '../../etc/passwd' }, c)).text, /escapes/);
});
