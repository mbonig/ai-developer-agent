import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifySignature, routeEvent } from '../src/webhook.ts';
import { loadConfig } from '../src/config.ts';

const sign = (s: string, b: string) => 'sha256=' + createHmac('sha256', s).update(b).digest('hex');

test('signature: valid, invalid, missing, malformed', () => {
  assert.equal(verifySignature('s', 'body', sign('s', 'body')), true);
  assert.equal(verifySignature('s', 'body', sign('x', 'body')), false);
  assert.equal(verifySignature('s', 'body', undefined), false);
  assert.equal(verifySignature('s', 'body', 'sha256=zz'), false);
  assert.equal(verifySignature('s', 'body', 'sha1=abc'), false);
});

const base = { repository: { full_name: 'org/repo' }, sender: { type: 'User' }, installation: { id: 9 } };

test('bot sender ignored', () => {
  assert.equal(routeEvent('issue_comment', { ...base, sender: { type: 'Bot' }, action: 'created' }, 'agent').kind, 'ignore');
});

test('label routing', () => {
  const p = { ...base, action: 'labeled', label: { name: 'agent' }, issue: { number: 5 } };
  assert.deepEqual(routeEvent('issues', p, 'agent'), { kind: 'start', owner: 'org', repo: 'repo', issueNumber: 5, installationId: 9 });
  assert.equal(routeEvent('issues', { ...p, label: { name: 'bug' } }, 'agent').kind, 'ignore');
});

const comment = (assoc: string) => ({
  ...base, action: 'created', issue: { number: 5 },
  comment: { author_association: assoc, user: { login: 'u' }, body: 'hi', html_url: 'url', created_at: 't' },
});

test('author authorization', () => {
  for (const a of ['OWNER', 'MEMBER', 'COLLABORATOR']) assert.equal(routeEvent('issue_comment', comment(a), 'agent').kind, 'message');
  for (const a of ['CONTRIBUTOR', 'NONE', 'FIRST_TIMER']) assert.equal(routeEvent('issue_comment', comment(a), 'agent').kind, 'ignore');
});

test('PR comment routes by prNumber', () => {
  const p = comment('OWNER'); (p.issue as any).pull_request = {};
  const r = routeEvent('issue_comment', p, 'agent');
  assert.equal(r.kind === 'message' && r.prNumber, 5);
});

test('inline review comment carries path/line/hunk; empty review ignored', () => {
  const rc = { ...base, action: 'created', pull_request: { number: 7 },
    comment: { author_association: 'MEMBER', user: { login: 'u' }, body: 'x', html_url: 'u', created_at: 't', path: 'a.ts', line: 3, diff_hunk: '@@' } };
  const r = routeEvent('pull_request_review_comment', rc, 'agent');
  assert.ok(r.kind === 'message' && r.msg.path === 'a.ts' && r.msg.line === 3 && r.msg.diffHunk === '@@');
  const rv = { ...base, action: 'submitted', pull_request: { number: 7 }, review: { body: ' ', author_association: 'OWNER', user: { login: 'u' } } };
  assert.equal(routeEvent('pull_request_review', rv, 'agent').kind, 'ignore');
});

test('close events cancel', () => {
  assert.equal(routeEvent('pull_request', { ...base, action: 'closed', pull_request: { number: 7, merged: true } }, 'agent').kind, 'cancel');
  assert.equal(routeEvent('issues', { ...base, action: 'closed', issue: { number: 5 } }, 'agent').kind, 'cancel');
});

test('config validation', () => {
  assert.throws(() => loadConfig({}), /BEDROCK_MODEL_ID/);
  assert.throws(() => loadConfig({ BEDROCK_MODEL_ID: 'm' }), /MAX_TOKENS_PER_ISSUE/);
  assert.throws(() => loadConfig({ BEDROCK_MODEL_ID: 'm', MAX_TOKENS_PER_ISSUE: '-1' }), /positive integer/);
  const c = loadConfig({ BEDROCK_MODEL_ID: 'm', MAX_TOKENS_PER_ISSUE: '100' });
  assert.equal(c.agentLabel, 'agent'); assert.equal(c.wakeDebounceSeconds, 60);
});

test('owner allow-list', () => {
  const p = { ...base, action: 'labeled', label: { name: 'agent' }, issue: { number: 5 } };
  assert.equal(routeEvent('issues', p, 'agent', 'other').kind, 'ignore');
  assert.equal(routeEvent('issues', p, 'agent', 'ORG').kind, 'start');
});
