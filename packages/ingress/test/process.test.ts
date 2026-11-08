import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { DynamoDBClient, CreateTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { getMeta, linkPr, issueKey, type Store } from '@agent/shared';
import { processWebhook, type Deps } from '../src/process.ts';

const PORT = 8124; const SECRET = 'test-signing-key';
const raw = new DynamoDBClient({ endpoint: `http://localhost:${PORT}`, region: 'us-east-1', credentials: { accessKeyId: 'x', secretAccessKey: 'x' } });
const store: Store = { doc: DynamoDBDocumentClient.from(raw), table: 'agent' };
const cname = `ddb-ingress-test-${process.pid}`;
let started: string[] = []; let callbacks: Array<[string, unknown]> = []; let posted: Array<{ number: number; body: string }> = [];
const deps: Deps = {
  store, config: { agentLabel: 'agent', githubOrg: 'mbonig', maxTokensPerIssue: 1000, agentBackend: 'bedrock' }, webhookSecret: SECRET,
  startExecution: async (k, a) => { started.push(`${k}:${a}`); return 'arn:exec'; },
  sendCallback: async (id, p) => { callbacks.push([id, p]); }, log: () => {},
  postComment: async (a) => { posted.push({ number: a.number, body: a.body }); },
};
let d = 0;
const send = (event: string, payload: object, secret = SECRET, delivery = `d${++d}`) => {
  const body = JSON.stringify(payload);
  return processWebhook(deps, { rawBody: body, headers: {
    'X-GitHub-Event': event, 'X-GitHub-Delivery': delivery,
    'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex') } });
};
const repo = { repository: { full_name: 'mbonig/app' }, sender: { type: 'User' }, installation: { id: 7 } };
const labeled = (n: number, issue: Record<string, unknown> = {}) => ({ ...repo, action: 'labeled', label: { name: 'agent' }, issue: { number: n, ...issue } });
const comment = (n: number, assoc = 'OWNER', body = 'hi') => ({ ...repo, action: 'created', issue: { number: n },
  comment: { author_association: assoc, user: { login: 'u' }, body, html_url: 'u', created_at: 't' } });
const setStatus = (pk: string, s: string, cb?: string) => store.doc.send(new UpdateCommand({
  TableName: 'agent', Key: { PK: pk, SK: 'META' },
  UpdateExpression: cb ? 'SET #s = :s, callbackId = :c' : 'SET #s = :s',
  ExpressionAttributeNames: { '#s': 'status' },
  ExpressionAttributeValues: cb ? { ':s': s, ':c': cb } : { ':s': s } }));

before(async () => {
  assert.equal(spawnSync('docker', ['run', '-d', '--rm', '--name', cname, '-p', `${PORT}:8000`, 'amazon/dynamodb-local', '-jar', 'DynamoDBLocal.jar', '-inMemory']).status, 0);
  for (let i = 0; i < 50; i++) {
    try { await raw.send(new CreateTableCommand({ TableName: 'agent', BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'PK', AttributeType: 'S' }, { AttributeName: 'SK', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }, { AttributeName: 'SK', KeyType: 'RANGE' }] })); return; }
    catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  throw new Error('ddb local did not start');
});
after(() => { spawnSync('docker', ['rm', '-f', cname]); raw.destroy(); });

test('bad signature: 401 and no side effects', async () => {
  const r = await send('issues', labeled(1), 'wrong');
  assert.equal(r.status, 401); assert.equal(started.length, 0);
  assert.equal(await getMeta(store, issueKey('mbonig', 'app', 1)), undefined);
});

test('label starts exactly one execution; duplicate delivery and relabel do nothing', async () => {
  started = [];
  assert.equal((await send('issues', labeled(2), SECRET, 'same')).status, 202);
  assert.equal((await send('issues', labeled(2), SECRET, 'same')).body, 'duplicate');
  assert.equal((await send('issues', labeled(2))).body, 'exists');
  assert.deepEqual(started, ['ISSUE#mbonig/app#2:1']);
  assert.equal((await getMeta(store, issueKey('mbonig', 'app', 2)))?.executionArn, 'arn:exec');
});

test('wrong org is ignored', async () => {
  assert.equal((await send('issues', { ...labeled(3), repository: { full_name: 'evil/app' } })).body, 'ignored');
});

test('comment while running queues without callback; unauthorized ignored', async () => {
  callbacks = []; const pk = issueKey('mbonig', 'app', 2);
  await setStatus(pk, 'RUNNING');
  assert.equal((await send('issue_comment', comment(2))).body, 'queued');
  assert.equal((await send('issue_comment', comment(2, 'NONE'))).body, 'ignored');
  assert.equal(callbacks.length, 0); assert.equal((await getMeta(store, pk))?.inboxSeq, 1);
});

test('comment while waiting wakes once', async () => {
  callbacks = []; const pk = issueKey('mbonig', 'app', 2);
  await setStatus(pk, 'WAITING', 'cb1');
  const rs = await Promise.all([send('issue_comment', comment(2)), send('issue_comment', comment(2))]);
  assert.equal(rs.filter((r) => r.body === 'woken').length, 1);
  assert.deepEqual(callbacks, [['cb1', { wake: true }]]);
});

test('comment on expired issue restarts with a fresh execution name', async () => {
  started = []; const pk = issueKey('mbonig', 'app', 2);
  await setStatus(pk, 'EXPIRED');
  assert.equal((await send('issue_comment', comment(2))).body, 'resumed');
  assert.equal(started.length, 1); assert.match(started[0], /^ISSUE#mbonig\/app#2:\d{10,}$/);
  assert.equal((await getMeta(store, pk))?.status, 'STARTING');
});

test('PR review comment routes via LINK; PR merge unlinks and leaves the run alone; the issue closing cancels and wakes', async () => {
  callbacks = []; const pk = issueKey('mbonig', 'app', 2);
  await linkPr(store, pk, 'mbonig', 'app', 50);
  await setStatus(pk, 'RUNNING');
  const rc = { ...repo, action: 'created', pull_request: { number: 50 }, comment: { author_association: 'MEMBER', user: { login: 'u' }, body: 'x', html_url: 'u', created_at: 't', path: 'a.ts', line: 1, diff_hunk: '@@' } };
  assert.equal((await send('pull_request_review_comment', rc)).body, 'queued');
  assert.equal((await send('pull_request_review_comment', { ...rc, pull_request: { number: 999 } })).body, 'untracked');
  await setStatus(pk, 'WAITING', 'cb2');
  assert.equal((await send('pull_request', { ...repo, action: 'closed', pull_request: { number: 50, merged: true } })).body, 'unlinked');
  assert.deepEqual(callbacks, []);
  let m = (await getMeta(store, pk))!;
  assert.equal(m.status, 'WAITING'); assert.equal(m.cancelRequested, undefined); assert.equal(m.prNumber, undefined); assert.equal(m.branch, 'agent/issue-2-2');
  assert.equal((await send('pull_request', { ...repo, action: 'closed', pull_request: { number: 50, merged: true } })).body, 'untracked'); // the link is gone
  assert.equal((await send('issues', { ...repo, action: 'closed', issue: { number: 2 } })).body, 'cancel requested');
  assert.deepEqual(callbacks, [['cb2', { cancel: true }]]);
  m = (await getMeta(store, pk))!; assert.equal(m.cancelRequested, true); assert.equal(m.closeReason, 'issue closed');
});

test('relabeling a FAILED issue restarts it with a new execution name; an exhausted run restarts only under the cap; DONE and active runs are left alone', async () => {
  const pk = issueKey('mbonig', 'app', 20);
  started = [];
  assert.equal((await send('issues', labeled(20))).status, 202);
  assert.equal((await send('issues', labeled(20))).body, 'exists');              // active run: ignored
  await setStatus(pk, 'FAILED');
  assert.equal((await send('issues', labeled(20))).body, 'restarted');
  assert.equal(started.length, 2); assert.match(started[1], /^ISSUE#mbonig\/app#20:\d{10,}$/);
  assert.equal((await getMeta(store, pk))?.status, 'STARTING');
  await setStatus(pk, 'DONE');
  assert.equal((await send('issues', labeled(20))).body, 'restarted');           // the issue was closed, then reopened and relabeled
  await setStatus(pk, 'CLOSED');
  assert.equal((await send('issues', labeled(20))).body, 'restarted');
  posted = [];
  await setStatus(pk, 'BUDGET_EXHAUSTED');                                        // tokensUsed is 0, under the cap: restartable
  assert.equal((await send('issues', labeled(20))).body, 'restarted');
  await setStatus(pk, 'BUDGET_EXHAUSTED');
  await store.doc.send(new UpdateCommand({ TableName: 'agent', Key: { PK: pk, SK: 'META' }, UpdateExpression: 'SET tokensUsed = :t', ExpressionAttributeValues: { ':t': 1000 } }));
  assert.equal((await send('issues', labeled(20))).body, 'exists');              // at the cap: final
});

test('a comment or relabel that reaches an ended run is answered on the issue', async () => {
  const pk = issueKey('mbonig', 'app', 30); posted = [];
  await send('issues', labeled(30));
  await setStatus(pk, 'DONE');
  assert.equal((await send('issue_comment', comment(30))).body, 'not accepting');
  assert.equal(posted.length, 1); assert.equal(posted[0].number, 30); assert.match(posted[0].body, /did not act on your comment.*issue was closed.*reopen the issue/s);
  await setStatus(pk, 'RUNNING');
  await send('issues', labeled(30));                                             // an active run: nothing to explain
  assert.equal(posted.length, 1);
  await setStatus(pk, 'BUDGET_EXHAUSTED');
  await store.doc.send(new UpdateCommand({ TableName: 'agent', Key: { PK: pk, SK: 'META' }, UpdateExpression: 'SET tokensUsed = :t', ExpressionAttributeValues: { ':t': 1000 } }));
  assert.equal((await send('issues', labeled(30))).body, 'exists');
  assert.equal(posted.length, 2); assert.match(posted[1].body, /did not restart.*token budget/s);
});

test('failing to post the explanation does not fail the webhook', async () => {
  const pk = issueKey('mbonig', 'app', 31);
  await send('issues', labeled(31)); await setStatus(pk, 'FAILED');
  const ok = deps.postComment; deps.postComment = async () => { throw new Error('boom'); };
  try { assert.equal((await send('issue_comment', comment(31))).body, 'not accepting'); } finally { deps.postComment = ok; }
});

test('a clear request in the issue body is stored silently, with no comment posted', async () => {
  posted = []; const pk = issueKey('mbonig', 'app', 40);
  await send('issues', labeled(40, { title: 'Add a widget', body: 'Please use claude and sonnet 5.5 for this.' }));
  assert.deepEqual((await getMeta(store, pk))?.modelOverride, { backend: 'claude-code', modelId: 'claude-sonnet-5-5' });
  assert.equal(posted.length, 0);
});

test('an unclear request in the issue body is stored as a best guess, and explained in a comment', async () => {
  posted = []; const pk = issueKey('mbonig', 'app', 41);
  await send('issues', labeled(41, { title: 'Add a widget', body: 'use bedrock and kimi k3' }));
  assert.deepEqual((await getMeta(store, pk))?.modelOverride, { backend: 'bedrock' });
  assert.equal(posted.length, 1); assert.equal(posted[0].number, 41); assert.match(posted[0].body, /kimi.*not an Anthropic model/is);
});

test('plain issue text with no request leaves the override unset', async () => {
  posted = []; const pk = issueKey('mbonig', 'app', 42);
  await send('issues', labeled(42, { title: 'Fix a bug', body: 'The bedrock integration throws on empty input.' }));
  assert.equal((await getMeta(store, pk))?.modelOverride, undefined);
  assert.equal(posted.length, 0);
});

test('a later comment can clarify an earlier ambiguous request, replacing the stored override', async () => {
  posted = []; const pk = issueKey('mbonig', 'app', 43);
  await send('issues', labeled(43, { title: 'Add a widget', body: 'use sonnet 5.5' })); // ambiguous: no backend named
  assert.deepEqual((await getMeta(store, pk))?.modelOverride, { backend: 'bedrock', modelId: 'us.anthropic.claude-sonnet-5-5' });
  await setStatus(pk, 'RUNNING');
  await send('issue_comment', comment(43, 'OWNER', 'Sorry, I meant use claude code with that.'));
  assert.deepEqual((await getMeta(store, pk))?.modelOverride, { backend: 'claude-code' });
});
