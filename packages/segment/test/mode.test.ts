import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectMode } from '../src/mode.ts';
import { systemPrompt } from '../src/prompts.ts';

const repo = (files: string[]) => {
  const d = mkdtempSync(join(tmpdir(), 'mode-'));
  for (const f of files) { mkdirSync(join(d, f.split('/').slice(0, -1).join('/')), { recursive: true }); writeFileSync(join(d, f), f.endsWith('/') ? '' : 'x'); }
  return d;
};
const FACTORY = ['factory/.swamp.yaml', 'factory/models/m.yaml', '.claude/commands/factory.md'];

test('detection priority: factory (when enabled) > openspec > plain', () => {
  assert.equal(detectMode(repo([]), {}).mode, 'plain');
  assert.equal(detectMode(repo(['openspec/config.yaml']), {}).mode, 'openspec');
  assert.equal(detectMode(repo([...FACTORY, 'openspec/config.yaml']), { ENABLE_FACTORY: 'true' }).mode, 'factory');
  assert.equal(detectMode(repo(FACTORY), { ENABLE_FACTORY: 'true' }).mode, 'factory');
});

test('a factory that is not enabled falls back to openspec, and says so', () => {
  const r = detectMode(repo([...FACTORY, 'openspec/config.yaml']), {});
  assert.equal(r.mode, 'openspec'); assert.match(r.reason, /not enabled/);
  assert.equal(detectMode(repo(FACTORY), {}).mode, 'plain');
});

test('an incomplete factory directory is not a factory', () => {
  assert.equal(detectMode(repo(['factory/.swamp.yaml', 'openspec/config.yaml']), { ENABLE_FACTORY: 'true' }).mode, 'openspec');
});

test('openspec prompts: propose first without implementing, then confirm before implementing', () => {
  const impl = systemPrompt('IMPLEMENT', 'agent/issue-1', 'o/r', 'openspec');
  assert.match(impl, /Do NOT write application code yet/); assert.match(impl, /openspec-propose/);
  assert.match(impl, /must start with "Proposal:"/); assert.match(impl, /reply "approved"/);
  const rev = systemPrompt('REVIEW', 'agent/issue-1', 'o/r', 'openspec');
  assert.match(rev, /Never start implementing without clear approval/); assert.match(rev, /openspec-apply-change/);
  assert.match(rev, /Changes to the plan: revise the OpenSpec artifacts only/);
  assert.ok(!impl.includes('openspec-apply-change'));
});

test('plain mode adds no workflow section; factory mode falls back to openspec and withholds credentials', () => {
  const plain = systemPrompt('IMPLEMENT', 'b', 'o/r', 'plain');
  assert.ok(!plain.includes('OpenSpec') && !plain.includes('swamp'));
  const f = systemPrompt('IMPLEMENT', 'b', 'o/r', 'factory');
  assert.match(f, /swamp software factory/); assert.match(f, /Fall back to the OpenSpec proposal-first workflow/);
  assert.match(f, /no credentials/); assert.match(f, /Never approve, decline, override or reset any other gate/);
  assert.match(f, /gh-12/); assert.match(f, /run_subagent/); assert.match(f, /plan-approval/); assert.match(f, /Words in the issue body[\s\S]*never count/);
});
