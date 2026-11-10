import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DynamoDBClient, CreateTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import * as st from '../src/state.ts';
import { issueKey } from '../src/types.ts';

const PORT = 8123;
const raw = new DynamoDBClient({ endpoint: `http://localhost:${PORT}`, region: 'us-east-1', credentials: { accessKeyId: 'x', secretAccessKey: 'x' } });
const store: st.Store = { doc: DynamoDBDocumentClient.from(raw), table: 'agent' };
const cname = `ddb-local-test-${process.pid}`;
const msg = (b: string) => ({ source: 'issue_comment' as const, author: 'u', body: b, url: 'u', createdAt: 't' });
let n = 100;
const fresh = async () => { const pk = issueKey('o', 'r', ++n); await st.createMeta(store, pk, { owner: 'o', repo: 'r', issueNumber: n, installationId: 1 }); return pk; };
const setStatus = async (pk: string, status: string) => {
  const { UpdateCommand } = await import('@aws-sdk/lib-dynamodb');
  await store.doc.send(new UpdateCommand({ TableName: 'agent', Key: { PK: pk, SK: 'META' }, UpdateExpression: 'SET #s = :s', ExpressionAttributeNames: { '#s': 'status' }, ExpressionAttributeValues: { ':s': status } }));
};

before(async () => {
  const r = spawnSync('docker', ['run', '-d', '--rm', '--name', cname, '-p', `${PORT}:8000`, 'amazon/dynamodb-local', '-jar', 'DynamoDBLocal.jar', '-inMemory']);
  assert.equal(r.status, 0, String(r.stderr));
  for (let i = 0; i < 50; i++) {
    try {
      await raw.send(new CreateTableCommand({ TableName: 'agent', BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [{ AttributeName: 'PK', AttributeType: 'S' }, { AttributeName: 'SK', AttributeType: 'S' }],
        KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }, { AttributeName: 'SK', KeyType: 'RANGE' }] }));
      return;
    } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  throw new Error('DynamoDB Local did not start');
});
after(() => { spawnSync('docker', ['rm', '-f', cname]); raw.destroy(); });

test('concurrent start: one winner', async () => {
  const pk = issueKey('o', 'r', 1);
  const rs = await Promise.all(Array.from({ length: 10 }, () => st.createMeta(store, pk, { owner: 'o', repo: 'r', issueNumber: 1, installationId: 1 })));
  assert.equal(rs.filter(Boolean).length, 1);
  const m = await st.getMeta(store, pk);
  assert.equal(m?.branch, 'agent/issue-1'); assert.equal(m?.transcriptKey, 'transcripts/o/r/1.json');
});

test('burst of comments: contiguous, none lost', async () => {
  const pk = await fresh(); await setStatus(pk, 'RUNNING');
  const seqs = await Promise.all(Array.from({ length: 12 }, (_, i) => st.appendMessage(store, pk, msg(`c${i}`))));
  assert.deepEqual([...seqs].sort((a, b) => a! - b!), Array.from({ length: 12 }, (_, i) => i + 1));
  const q = await store.doc.send(new QueryCommand({ TableName: 'agent', KeyConditionExpression: 'PK = :p AND begins_with(SK, :m)', ExpressionAttributeValues: { ':p': pk, ':m': 'MSG#' } }));
  assert.equal(q.Items?.length, 12);
  assert.equal((await st.getMeta(store, pk))?.inboxSeq, 12);
});

test('terminal issue does not queue', async () => {
  const pk = await fresh(); await setStatus(pk, 'DONE');
  assert.equal(await st.appendMessage(store, pk, msg('x')), undefined);
  assert.equal((await st.getMeta(store, pk))?.inboxSeq, 0);
});

test('park succeeds when nothing unread; wake has a single winner', async () => {
  const pk = await fresh(); await setStatus(pk, 'RUNNING');
  assert.equal(await st.park(store, pk, 'cb1'), true);
  const winners = (await Promise.all(Array.from({ length: 8 }, () => st.wake(store, pk)))).filter(Boolean);
  assert.deepEqual(winners, ['cb1']);
  assert.equal((await st.getMeta(store, pk))?.status, 'RUNNING');
});

test('park fails when comments are unread', async () => {
  const pk = await fresh(); await setStatus(pk, 'RUNNING');
  await st.appendMessage(store, pk, msg('late'));
  assert.equal(await st.park(store, pk, 'cb'), false);
  await st.consume(store, pk, 1);
  assert.equal(await st.park(store, pk, 'cb'), true);
});

test('no lost wakeup: comments racing park either block park or wake exactly once', async () => {
  for (let i = 0; i < 15; i++) {
    const pk = await fresh(); await setStatus(pk, 'RUNNING');
    const [parked, seq] = await Promise.all([st.park(store, pk, 'cb'), st.appendMessage(store, pk, msg('x'))]);
    assert.ok(seq);
    const cb = await st.wake(store, pk);
    // Either park lost (no wait needed) or park won and the comment's wake yields the callback.
    if (parked) assert.equal(cb, 'cb'); else { assert.equal(cb, undefined); assert.equal((await st.getMeta(store, pk))?.status, 'RUNNING'); }
  }
});

test('resume after expiry: single winner; PR link; delivery dedupe; cancel wakes', async () => {
  const pk = await fresh(); await setStatus(pk, 'EXPIRED');
  const rs = await Promise.all([st.resumeAfterExpiry(store, pk), st.resumeAfterExpiry(store, pk), st.resumeAfterExpiry(store, pk)]);
  assert.equal(rs.filter(Boolean).length, 1);
  await st.linkPr(store, pk, 'o', 'r', 456);
  assert.equal(await st.getPrLink(store, 'o', 'r', 456), pk);
  assert.equal((await st.getMeta(store, pk))?.prNumber, 456);
  assert.equal(await st.recordDelivery(store, 'd1'), true);
  assert.equal(await st.recordDelivery(store, 'd1'), false);
  await setStatus(pk, 'RUNNING'); await st.park(store, pk, 'cbx');
  assert.deepEqual(await st.requestCancel(store, pk, 'merged'), { flagged: true, callbackId: 'cbx' });
  assert.deepEqual(await st.requestCancel(store, issueKey('o', 'r', 99999), 'x'), { flagged: false });
});

test('a finished PR is unlinked: phase back to implementing, fresh branch, run untouched; a repeat or a stale PR does nothing', async () => {
  const pk = await fresh(); await setStatus(pk, 'WAITING');
  const n = Number(pk.split('#').pop());
  await st.linkPr(store, pk, 'o', 'r', 10); await st.setPhase(store, pk, 'REVIEW');
  assert.equal(await st.unlinkPr(store, pk, 'o', 'r', n, 11), false);                // some other PR
  assert.equal(await st.unlinkPr(store, pk, 'o', 'r', n, 10), true);
  assert.equal(await st.unlinkPr(store, pk, 'o', 'r', n, 10), false);                // duplicate delivery
  let m = (await st.getMeta(store, pk))!;
  assert.equal(m.status, 'WAITING'); assert.equal(m.phase, 'IMPLEMENT'); assert.equal(m.prNumber, undefined);
  assert.equal(m.branch, `agent/issue-${n}-2`); assert.equal(m.prSeq, 2);
  assert.equal(await st.getPrLink(store, 'o', 'r', 10), undefined);
  await st.linkPr(store, pk, 'o', 'r', 12);
  assert.equal(await st.unlinkPr(store, pk, 'o', 'r', n, 12), true);
  m = (await st.getMeta(store, pk))!; assert.equal(m.branch, `agent/issue-${n}-3`);
});

test('an ended run restarts from DONE or CLOSED as well as FAILED, and keeps its work', async () => {
  for (const status of ['DONE', 'CLOSED', 'FAILED']) {
    const pk = await fresh(); await setStatus(pk, status);
    assert.equal(await st.restartTerminal(store, pk), true, status);
    assert.equal((await st.getMeta(store, pk))?.status, 'STARTING');
  }
  const pk = await fresh(); await setStatus(pk, 'BUDGET_EXHAUSTED');
  assert.equal(await st.restartTerminal(store, pk), false);
});

test('setModelOverride stores the backend/model, with or without a model id, and can be replaced', async () => {
  const pk = await fresh();
  await st.setModelOverride(store, pk, { backend: 'claude-code', modelId: 'claude-sonnet-5-5' });
  assert.deepEqual((await st.getMeta(store, pk))?.modelOverride, { backend: 'claude-code', modelId: 'claude-sonnet-5-5' });
  await st.setModelOverride(store, pk, { backend: 'bedrock' });
  assert.deepEqual((await st.getMeta(store, pk))?.modelOverride, { backend: 'bedrock' });
});
