import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DynamoDBClient, CreateTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { withDurableExecution, type DurableContext } from '@aws/durable-execution-sdk-js';
import { LocalDurableTestRunner, WaitingOperationStatus } from '@aws/durable-execution-sdk-js-testing';
import { createMeta, getMeta, appendMessage, wake, requestCancel, issueKey, loadConfig, type Store } from '@agent/shared';
import { orchestrate, type OrchDeps } from '../src/orchestrate.ts';
import type { GithubApi } from '../src/github.ts';

const PORT = 8128;
const raw = new DynamoDBClient({ endpoint: `http://localhost:${PORT}`, region: 'us-east-1', credentials: { accessKeyId: 'x', secretAccessKey: 'x' } });
const store: Store = { doc: DynamoDBDocumentClient.from(raw), table: 'agent' };
const cname = `ddb-durable-selfwake-${process.pid}`;
const config = loadConfig({ BEDROCK_MODEL_ID: 'm', MAX_TOKENS_PER_ISSUE: '100000', WAKE_DEBOUNCE_SECONDS: '60', SEGMENT_MAX_ATTEMPTS: '1' });
const msg = (b: string) => ({ source: 'issue_comment' as const, author: 'u', body: b, url: 'u', createdAt: 't' });

before(async () => {
  assert.equal(spawnSync('docker', ['run', '-d', '--rm', '--name', cname, '-p', `${PORT}:8000`, 'amazon/dynamodb-local', '-jar', 'DynamoDBLocal.jar', '-inMemory']).status, 0);
  for (let i = 0; i < 50; i++) {
    try { await raw.send(new CreateTableCommand({ TableName: 'agent', BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'PK', AttributeType: 'S' }, { AttributeName: 'SK', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }, { AttributeName: 'SK', KeyType: 'RANGE' }] })); break; }
    catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  await LocalDurableTestRunner.setupTestEnvironment({ skipTime: true });
});
after(async () => { await LocalDurableTestRunner.teardownTestEnvironment(); spawnSync('docker', ['rm', '-f', cname]); raw.destroy(); });

function build(runnerRef: { r?: LocalDurableTestRunner }) {
  const log = { comments: [] as string[], prs: [] as string[], launched: 0, terminated: [] as string[], selfWakes: 0 };
  const github: GithubApi = {
    async postComment(a) { const k = `${a.number}:${a.marker}`; if (log.comments.some((c) => c.startsWith(k + '|'))) return false; log.comments.push(`${k}|${a.body}`); return true; },
    async upsertPrSection() { /* cost section: covered in orchestrate.test.ts */ },
    async openPr(a) { if (!log.prs.includes(a.head)) log.prs.push(a.head); return 42; },
  };
  const deps: OrchDeps = {
    store, config, github,
    launcher: { async launch() { log.launched++; return { id: `vm-${log.launched}` }; }, async terminate(id) { log.terminated.push(id); } },
    // A real SendDurableExecutionCallbackSuccess against our own callback, routed through the runner.
    sendCallback: async (id, payload) => {
      log.selfWakes++;
      const ops = runnerRef.r!.getOperation('human-1'); assert.equal(ops.getCallbackDetails()!.callbackId, id);
      await ops.sendCallbackSuccess(JSON.stringify(payload));
    },
  };
  const handler = withDurableExecution(async (event: { issueKey: string }, ctx: DurableContext) => orchestrate(ctx, event, deps));
  return { handler, log };
}

let n = 300;
const fresh = async () => { const k = issueKey('mbonig', 'app', ++n); await createMeta(store, k, { owner: 'mbonig', repo: 'app', issueNumber: n, installationId: 5 }); return k; };
const result = (o: object) => JSON.stringify({ tokensUsed: 10, headSha: 'abc', ...o });

test('real durable runtime: unread comment -> park fails -> the orchestrator completes its own callback', async () => {
  const key = await fresh();
  const ref: { r?: LocalDurableTestRunner } = {};
  const { handler, log } = build(ref);
  ref.r = new LocalDurableTestRunner({ handlerFunction: handler });
  const run = ref.r.run({ payload: { issueKey: key } });

  const seg1 = ref.r.getOperation('segment-1-1'); await seg1.waitForData(WaitingOperationStatus.SUBMITTED);
  await appendMessage(store, key, msg('arrived while the segment ran'));
  await seg1.sendCallbackSuccess(result({ type: 'questions', markdown: 'Q?' }));

  // No human reply is sent: the orchestrator must wake itself and start segment 2 with the unread comment.
  const seg2 = ref.r.getOperation('segment-2-1'); await seg2.waitForData(WaitingOperationStatus.SUBMITTED);
  assert.equal(log.selfWakes, 1);
  assert.equal((await getMeta(store, key))!.status, 'RUNNING');
  await requestCancel(store, key, 'closed');
  await seg2.sendCallbackSuccess(result({ type: 'questions', markdown: 'Q2?' }));

  const res = await run;
  assert.equal(res.getResult()?.status, 'CLOSED');
});
