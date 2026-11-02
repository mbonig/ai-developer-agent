import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMicrovmLauncher, baseUrl, type MicrovmApi } from '../src/microvm-launcher.ts';
import type { SegmentJob } from '@agent/shared';

const job = { issueKey: 'ISSUE#o/r#1', segmentSeq: 2, callbackId: 'cb' } as SegmentJob;
const opts = { imageArn: 'arn:img', imageVersion: '1.0', executionRoleArn: 'arn:role', segmentTimeoutSeconds: 7200, sleep: async () => {} };

function api(over: Partial<MicrovmApi> = {}) {
  const calls: string[] = [];
  const a: MicrovmApi = {
    run: async (x) => { calls.push(`run:${x.clientToken}`); assert.ok(JSON.parse(x.runHookPayload).key); assert.deepEqual(x.idle, { maxIdleDurationSeconds: 7200, suspendedDurationSeconds: 0, autoResumeEnabled: false }); return { microvmId: 'vm1', endpoint: 'https://vm1.example/', state: 'PENDING' }; },
    get: async () => { calls.push('get'); return { state: 'RUNNING', endpoint: 'https://vm1.example/' }; },
    authToken: async (id, port) => { calls.push(`token:${port}`); return 'T'; },
    terminate: async (id) => { calls.push(`term:${id}`); },
    ...over,
  };
  return { a, calls };
}

test('launch: waits for RUNNING, mints a port-scoped token, POSTs the job', async () => {
  const { a, calls } = api(); const seen: Array<[string, RequestInit]> = [];
  const l = createMicrovmLauncher(a, { ...opts, fetchImpl: (async (u: string, i: RequestInit) => { seen.push([u, i]); return new Response('', { status: 202 }); }) as unknown as typeof fetch });
  assert.deepEqual(await l.launch(job), { id: 'vm1' });
  assert.equal(seen[0][0], 'https://vm1.example/segment');
  assert.equal((seen[0][1].headers as Record<string, string>)['X-aws-proxy-auth'], 'T');
  assert.deepEqual(JSON.parse(seen[0][1].body as string), job);
  assert.deepEqual(calls.map((c) => c.split(':')[0]), ['run', 'get', 'token']);
});

test('each VM gets its own secret, delivered at run time and in the job POST header', async () => {
  const keys: string[] = []; const headers: string[] = [];
  const ok = (async (_u: string, i: RequestInit) => { headers.push((i.headers as Record<string, string>)['X-Segment-Key']); return new Response('', { status: 202 }); }) as unknown as typeof fetch;
  for (let i = 0; i < 2; i++) {
    const { a } = api({ run: async (x) => { keys.push(JSON.parse(x.runHookPayload).key); return { microvmId: 'v', endpoint: 'https://e', state: 'RUNNING' }; } });
    await createMicrovmLauncher(a, { ...opts, fetchImpl: ok }).launch(job);
  }
  assert.notEqual(keys[0], keys[1]); assert.ok(keys[0].length >= 32); assert.deepEqual(headers, keys);
});

test('retries 5xx and connection errors until accepted', async () => {
  const { a } = api(); let n = 0;
  const f = (async () => { n++; if (n === 1) throw new Error('ECONNREFUSED'); if (n === 2) return new Response('', { status: 503 }); return new Response('', { status: 202 }); }) as unknown as typeof fetch;
  await createMicrovmLauncher(a, { ...opts, fetchImpl: f }).launch(job);
  assert.equal(n, 3);
});

test('a rejected job terminates the VM and fails', async () => {
  const { a, calls } = api();
  const f = (async () => new Response('', { status: 400 })) as unknown as typeof fetch;
  await assert.rejects(createMicrovmLauncher(a, { ...opts, fetchImpl: f }).launch(job), /rejected/);
  assert.ok(calls.includes('term:vm1'));
});

test('terminate is idempotent for already-gone VMs but surfaces other errors', async () => {
  const gone = Object.assign(new Error('x'), { name: 'ResourceNotFoundException' });
  await createMicrovmLauncher(api({ terminate: async () => { throw gone; } }).a, opts).terminate('vm1');
  const denied = Object.assign(new Error('x'), { name: 'AccessDeniedException' });
  await assert.rejects(createMicrovmLauncher(api({ terminate: async () => { throw denied; } }).a, opts).terminate('vm1'), /x/);
});

test('endpoint without a scheme (as the service returns it) becomes an https URL', () => {
  assert.equal(baseUrl('abc.lambda-microvm.us-west-2.on.aws'), 'https://abc.lambda-microvm.us-west-2.on.aws');
  assert.equal(baseUrl('https://x.example/'), 'https://x.example');
});
