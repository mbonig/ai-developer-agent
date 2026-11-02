import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DynamoDBClient, CreateTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createMeta, setMicrovm, markRunning, issueKey, type Store } from '@agent/shared';
import { sweep } from '../src/sweeper.ts';

const PORT = 8126;
const raw = new DynamoDBClient({ endpoint: `http://localhost:${PORT}`, region: 'us-east-1', credentials: { accessKeyId: 'x', secretAccessKey: 'x' } });
const store: Store = { doc: DynamoDBDocumentClient.from(raw), table: 'agent' };
const cname = `ddb-sweep-test-${process.pid}`;

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

test('sweeps orphans and over-age VMs, keeps referenced and fresh ones', async () => {
  const k = issueKey('o', 'r', 1);
  await createMeta(store, k, { owner: 'o', repo: 'r', issueNumber: 1, installationId: 1 });
  await markRunning(store, k); await setMicrovm(store, k, { microvmId: 'vm-live', segmentCallbackId: 'cb' });
  const now = new Date('2026-11-01T12:00:00Z'); const ago = (s: number) => new Date(now.getTime() - s * 1000);
  const killed: string[] = [];
  const out = await sweep(store, {
    listActive: async () => [
      { microvmId: 'vm-live', startedAt: ago(600) },          // referenced, young: keep
      { microvmId: 'vm-orphan', startedAt: ago(900) },        // unreferenced, past grace: sweep
      { microvmId: 'vm-fresh', startedAt: ago(30) },          // unreferenced but inside grace: keep
      { microvmId: 'vm-old', startedAt: ago(7200 + 901) },    // referenced? no, and too old: sweep
    ],
    terminate: async (id) => { killed.push(id); },
  }, { segmentTimeoutSeconds: 7200, now });
  assert.deepEqual(out.sort(), ['vm-old', 'vm-orphan']); assert.deepEqual(killed.sort(), ['vm-old', 'vm-orphan']);
});

test('a referenced VM past SEGMENT_TIMEOUT + 15 minutes is still swept', async () => {
  const now = new Date('2026-11-01T12:00:00Z');
  const out = await sweep(store, {
    listActive: async () => [{ microvmId: 'vm-live', startedAt: new Date(now.getTime() - (7200 + 901) * 1000) }],
    terminate: async () => {},
  }, { segmentTimeoutSeconds: 7200, now });
  assert.deepEqual(out, ['vm-live']);
});
