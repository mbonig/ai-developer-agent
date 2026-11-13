import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DynamoDBClient, CreateTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { CallbackTimeoutError } from '@aws/durable-execution-sdk-js';
import { createMeta, getMeta, appendMessage, wake, requestCancel, unlinkPr, issueKey, loadConfig, type Store, type SegmentJob } from '@agent/shared';
import { orchestrate, noChangeComment, type Ctx, type OrchDeps } from '../src/orchestrate.ts';
import { createGithubApi, markerComment, replaceSection, type GithubApi } from '../src/github.ts';
import { renderCostSection } from '../src/cost.ts';

const PORT = 8125;
const raw = new DynamoDBClient({ endpoint: `http://localhost:${PORT}`, region: 'us-east-1', credentials: { accessKeyId: 'x', secretAccessKey: 'x' } });
const store: Store = { doc: DynamoDBDocumentClient.from(raw), table: 'agent' };
const cname = `ddb-orch-test-${process.pid}`;
const config = loadConfig({ BEDROCK_MODEL_ID: 'm', MAX_TOKENS_PER_ISSUE: '1000', WAKE_DEBOUNCE_SECONDS: '5', SEGMENT_MAX_ATTEMPTS: '2' });
const msg = (b: string) => ({ source: 'issue_comment' as const, author: 'u', body: b, url: 'u', createdAt: 't' });

type Seg = (job: SegmentJob) => Promise<object | Error> | object | Error;
type Reply = () => Promise<object | 'timeout'>;

function harness(segments: Seg[], replies: Reply[], opts: { noCommits?: boolean } = {}) {
  const log = { steps: [] as string[], waits: [] as string[], jobs: [] as SegmentJob[], launched: 0, terminated: [] as string[],
    comments: [] as string[], started: [] as string[], prs: [] as string[], selfWakes: [] as string[], cost: [] as string[] };
  let lastJob: SegmentJob | undefined;
  const ctx = {
    step: async (name: string, fn: () => unknown) => { log.steps.push(name); return fn(); },
    wait: async (name: string) => { log.waits.push(name); },
    waitForCallback: async (_n: string, submitter: (id: string) => Promise<void>) => {
      await submitter(`segcb-${log.jobs.length}`);
      const r = await segments.shift()!(lastJob!);
      if (r instanceof Error) throw r;
      return JSON.stringify(r);
    },
    createCallback: async (name: string) => {
      const run = replies.shift()!;
      const reply = { then: (res: (v: unknown) => void, rej: (e: unknown) => void) =>
        run().then((p) => (p === 'timeout' ? rej(new CallbackTimeoutError(name as never, undefined as never)) : res(JSON.stringify(p))), rej) };
      return [reply, `humancb-${name}`];
    },
  } as unknown as Ctx;
  const github: GithubApi = {
    async postComment(a) { if (a.marker.includes(':start:')) { log.started.push(`${a.number}|${a.body}`); return true; } const m = `${a.number}:${a.marker}`; if (log.comments.some((c) => c.startsWith(m + '|'))) return false; log.comments.push(`${m}|${a.body}`); return true; },
    async upsertPrSection(a) { log.cost.push(`${a.number}|${a.markdown}`); },
    async openPr(a) { if (opts.noCommits) return undefined; log.prs.push(`${a.head}|${a.title}|${a.body}|${a.draft}`); return 76 + log.prs.length; },
  };
  const deps: OrchDeps = {
    store, config, github,
    launcher: {
      async launch(job) { log.jobs.push(job); lastJob = job; log.launched++; return { id: `vm-${log.launched}` }; },
      async terminate(id) { log.terminated.push(id); },
    },
    sendCallback: async (id) => { log.selfWakes.push(id); },
  };
  return { ctx, deps, log };
}

let n = 200;
const fresh = async () => { const k = issueKey('mbonig', 'app', ++n); await createMeta(store, k, { owner: 'mbonig', repo: 'app', issueNumber: n, installationId: 5 }); return { key: k, num: n }; };
const setStatus = (pk: string, f: Record<string, unknown>) => store.doc.send(new UpdateCommand({ TableName: 'agent', Key: { PK: pk, SK: 'META' },
  UpdateExpression: 'SET ' + Object.keys(f).map((k, i) => `#k${i} = :v${i}`).join(', '),
  ExpressionAttributeNames: Object.fromEntries(Object.keys(f).map((k, i) => [`#k${i}`, k])),
  ExpressionAttributeValues: Object.fromEntries(Object.values(f).map((v, i) => [`:v${i}`, v])) }));

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

test('lifecycle: questions -> answer -> PR -> review -> revised -> issue closed', async () => {
  const { key, num } = await fresh();
  const { ctx, deps, log } = harness(
    [
      () => ({ type: 'questions', markdown: 'Which DB?', tokensUsed: 100, headSha: 'a' }),
      () => ({ type: 'done', pr: { title: 'Add thing', body: 'Does it' }, tokensUsed: 200, headSha: 'b' }),
      () => ({ type: 'revised', summaryMarkdown: 'Fixed review', tokensUsed: 50, headSha: 'c' }),
    ],
    [
      async () => { await appendMessage(store, key, msg('Postgres')); assert.ok(await wake(store, key)); return { wake: true }; },
      async () => { await appendMessage(store, key, msg('please rename')); assert.ok(await wake(store, key)); return { wake: true }; },
      async () => { await requestCancel(store, key, 'issue closed'); return { cancel: true }; },
    ],
  );
  const out = await orchestrate(ctx, { issueKey: key }, deps);
  assert.equal(out.status, 'DONE');
  const m = (await getMeta(store, key))!;
  assert.equal(m.status, 'DONE'); assert.equal(m.phase, 'REVIEW'); assert.equal(m.prNumber, 77);
  assert.equal(m.tokensUsed, 350); assert.equal(m.consumedSeq, 2); assert.equal(m.segmentSeq, 3);
  assert.equal(log.launched, 3); assert.deepEqual(log.terminated, ['vm-1', 'vm-2', 'vm-3']);
  assert.equal(log.prs.length, 1); assert.match(log.prs[0], new RegExp(`agent/issue-${num}\\|Add thing\\|Does it\\n\\nCloses #${num}\\|false$`));
  assert.equal(log.comments.length, 3); // questions, "opened PR", revised
  assert.ok(log.comments[0].startsWith(`${num}:${key}:1|Which DB?`));
  assert.ok(log.comments.some((c) => c.startsWith('77:')));   // revised goes to the PR
  assert.deepEqual(log.waits, ['debounce-1', 'debounce-2']);  // no debounce after cancel
  assert.deepEqual(log.jobs.map((j) => j.inbox), [{ fromExclusive: 0, toInclusive: 0 }, { fromExclusive: 0, toInclusive: 1 }, { fromExclusive: 1, toInclusive: 2 }]);
  assert.deepEqual(log.jobs.map((j) => j.phase), ['IMPLEMENT', 'IMPLEMENT', 'REVIEW']);
  assert.equal(log.jobs[0].tokenBudgetRemaining, 1000);
});

test('a merged PR does not end the run: a later comment starts the next PR on a fresh branch', async () => {
  const { key, num } = await fresh();
  const { ctx, deps, log } = harness(
    [
      () => ({ type: 'done', pr: { title: 'First half', body: 'PWA' }, tokensUsed: 10, headSha: 'a' }),
      () => ({ type: 'done', pr: { title: 'Second half', body: 'Flutter' }, tokensUsed: 10, headSha: 'b' }),
    ],
    [
      async () => { // the first PR is merged while the run waits: it is unlinked and the run carries on
        assert.equal(await unlinkPr(store, key, 'mbonig', 'app', num, 77), true);
        assert.equal((await getMeta(store, key))!.status, 'WAITING');
        await appendMessage(store, key, msg('now the Flutter half')); assert.ok(await wake(store, key)); return { wake: true };
      },
      async () => { await requestCancel(store, key, 'issue closed'); return { cancel: true }; },
    ],
  );
  const out = await orchestrate(ctx, { issueKey: key }, deps);
  assert.equal(out.status, 'DONE');
  assert.deepEqual(log.jobs.map((j) => [j.phase, j.branch, j.prNumber]), [
    ['IMPLEMENT', `agent/issue-${num}`, null], ['IMPLEMENT', `agent/issue-${num}-2`, null]]);
  assert.match(log.prs[0], new RegExp(`^agent/issue-${num}\\|First half`));
  assert.match(log.prs[1], new RegExp(`^agent/issue-${num}-2\\|Second half`));
  const m = (await getMeta(store, key))!;
  assert.equal(m.prNumber, 78); assert.equal(m.phase, 'REVIEW'); assert.equal(m.prSeq, 2);
});

test('comment during segment blocks park and self-wakes without debounce', async () => {
  const { key } = await fresh();
  const { ctx, deps, log } = harness(
    [
      async () => { await appendMessage(store, key, msg('late comment')); return { type: 'questions', markdown: 'Q?', tokensUsed: 10, headSha: 'a' }; },
      () => ({ type: 'questions', markdown: 'Q2?', tokensUsed: 10, headSha: 'a' }),
    ],
    [
      async () => ({ wake: true }),                                // self-woken: status must still be RUNNING
      async () => { await requestCancel(store, key, 'issue closed'); return { cancel: true }; },
    ],
  );
  // The first reply resolves via the orchestrator's own callback; check state while it "waits".
  const before = deps.sendCallback;
  deps.sendCallback = async (id, p) => { assert.equal((await getMeta(store, key))!.status, 'RUNNING'); await before(id, p); };
  const out = await orchestrate(ctx, { issueKey: key }, deps);
  assert.equal(out.status, 'DONE');
  assert.deepEqual(log.selfWakes, ['humancb-human-1']);
  assert.equal(log.waits.length, 0);
  assert.deepEqual(log.jobs[1].inbox, { fromExclusive: 0, toInclusive: 1 });
});

test('human wait timeout expires the issue and comments', async () => {
  const { key } = await fresh();
  const { ctx, deps, log } = harness([() => ({ type: 'questions', markdown: 'Q?', tokensUsed: 1, headSha: 'a' })], [async () => 'timeout']);
  const out = await orchestrate(ctx, { issueKey: key }, deps);
  assert.equal(out.status, 'EXPIRED');
  const m = (await getMeta(store, key))!; assert.equal(m.status, 'EXPIRED'); assert.equal(m.callbackId, undefined);
  assert.ok(log.comments.some((c) => c.includes('pausing')));
});

test('segment retried once then FAILED; every attempt terminated', async () => {
  const { key } = await fresh();
  const { ctx, deps, log } = harness([() => new Error('boom'), () => new Error('boom again')], []);
  const out = await orchestrate(ctx, { issueKey: key }, deps);
  assert.equal(out.status, 'FAILED');
  assert.equal(log.launched, 2); assert.deepEqual(log.terminated, ['vm-1', 'vm-2']);
  const m = (await getMeta(store, key))!; assert.equal(m.status, 'FAILED'); assert.equal(m.consumedSeq, 0); assert.equal(m.microvmId, undefined);
  assert.ok(log.comments[0].includes('boom again'));
  assert.ok(log.comments[0].includes(':1:failed'));
});

test('retry succeeds and consumes the same range', async () => {
  const { key } = await fresh(); await appendMessage(store, key, msg('start'));
  const { ctx, deps, log } = harness(
    [() => new Error('transient'), () => ({ type: 'questions', markdown: 'Q?', tokensUsed: 5, headSha: 'a' })],
    [async () => { await requestCancel(store, key, 'issue closed'); return { cancel: true }; }]);
  await orchestrate(ctx, { issueKey: key }, deps);
  assert.deepEqual(log.jobs.map((j) => j.inbox), [{ fromExclusive: 0, toInclusive: 1 }, { fromExclusive: 0, toInclusive: 1 }]);
  assert.equal((await getMeta(store, key))!.consumedSeq, 1);
});

test('budget: exhausted before a segment, and reported by a segment', async () => {
  const a = await fresh(); await setStatus(a.key, { tokensUsed: 1000 });
  const h1 = harness([], []);
  assert.equal((await orchestrate(h1.ctx, { issueKey: a.key }, h1.deps)).status, 'BUDGET_EXHAUSTED');
  assert.equal(h1.log.launched, 0);

  const b = await fresh();
  const h2 = harness([() => ({ type: 'budget_exhausted', summaryMarkdown: 'Ran out; did X', tokensUsed: 900, headSha: 'a' })], []);
  assert.equal((await orchestrate(h2.ctx, { issueKey: b.key }, h2.deps)).status, 'BUDGET_EXHAUSTED');
  const m = (await getMeta(store, b.key))!; assert.equal(m.status, 'BUDGET_EXHAUSTED'); assert.equal(m.tokensUsed, 900);
});

test('budget exhausted with pushed work opens a draft PR; with no commits it does not', async () => {
  const a = await fresh();
  const h1 = harness([() => ({ type: 'budget_exhausted', summaryMarkdown: 'Did most of it', tokensUsed: 10, headSha: 'a' })], []);
  assert.equal((await orchestrate(h1.ctx, { issueKey: a.key }, h1.deps)).status, 'BUDGET_EXHAUSTED');
  assert.equal(h1.log.prs.length, 1); assert.match(h1.log.prs[0], /WIP: work on #\d+.*Did most of it.*Refs #\d+\|true$/s);
  const m = (await getMeta(store, a.key))!; assert.equal(m.prNumber, 77); assert.equal(m.status, 'BUDGET_EXHAUSTED');
  assert.ok(h1.log.comments.some((c) => c.includes('draft #77')));

  const b = await fresh();
  const h2 = harness([() => ({ type: 'budget_exhausted', summaryMarkdown: 'Nothing yet', tokensUsed: 10, headSha: 'a' })], [], { noCommits: true });
  assert.equal((await orchestrate(h2.ctx, { issueKey: b.key }, h2.deps)).status, 'BUDGET_EXHAUSTED');
  assert.equal(h2.log.prs.length, 0); assert.equal((await getMeta(store, b.key))!.prNumber, undefined);
});

test('finishing without changes posts a note instead of failing, and keeps waiting', async () => {
  const { key } = await fresh();
  const { ctx, deps, log } = harness(
    [() => ({ type: 'done', pr: { title: 'Nothing to do', body: 'The distance already updates live in client/lib/parts.dart.' }, tokensUsed: 1, headSha: 'a',
      publishNote: 'The factory never created branch `factory/gh-7`.' })],
    [async () => { await requestCancel(store, key, 'issue closed'); return { cancel: true }; }], { noCommits: true });
  assert.equal((await orchestrate(ctx, { issueKey: key }, deps)).status, 'DONE');
  const c = log.comments.find((x) => x.includes('no changes to propose'));
  assert.ok(c, JSON.stringify(log.comments));
  assert.match(c, /never created branch `factory\/gh-7`/);                       // what the harness found
  assert.match(c, /> \*\*Nothing to do\*\*\n> \n> The distance already updates live/); // what the agent said, quoted
});

test('the no-change comment falls back to the branch when the harness gave no reason, and says when the agent gave no summary', () => {
  const c = noChangeComment('agent/issue-7', undefined, { title: ' ', body: '' });
  assert.match(c, /branch `agent\/issue-7` has no commits beyond the default branch/);
  assert.match(c, /nothing \(I gave no summary\)/);
  assert.ok(noChangeComment('b', 'x', { title: 't', body: 'y'.repeat(70000) }).length < 65000);
});

test('cancel flagged while a segment runs stops before posting', async () => {
  const { key } = await fresh();
  const { ctx, deps, log } = harness([async () => { await requestCancel(store, key, 'issue closed'); return { type: 'questions', markdown: 'Q?', tokensUsed: 1, headSha: 'a' }; }], []);
  assert.equal((await orchestrate(ctx, { issueKey: key }, deps)).status, 'DONE');
  assert.equal(log.comments.length, 0);
});

test('github client is idempotent: comment marker and PR by head branch', async () => {
  let aheadBy = 2; let compareStatus = 200; const calls: string[] = []; const comments: Array<{ body: string }> = []; const prs: Array<{ number: number }> = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    const path = url.replace('https://api.github.com', ''); const method = init.method!; calls.push(`${method} ${path.split('?')[0]}`);
    const j = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s });
    if (method === 'GET' && path.includes('/comments')) return j(comments);
    if (method === 'POST' && path.includes('/comments')) { comments.push(JSON.parse(init.body as string)); return j({}, 201); }
    if (method === 'GET' && path.includes('/pulls')) return j(prs);
    if (method === 'GET' && path.includes('/compare/')) return compareStatus === 200 ? j({ ahead_by: aheadBy }) : j({}, compareStatus);
    if (method === 'GET') return j({ default_branch: 'main' });
    if (method === 'POST' && path.includes('/pulls')) { prs.push({ number: 9 }); return j({ number: 9 }, 201); }
    return j({}, 404);
  }) as unknown as typeof fetch;
  const gh = createGithubApi(async () => 'tok', fakeFetch);
  const a = { installationId: 1, owner: 'o', repo: 'r', number: 3, body: 'hello', marker: 'k:1' };
  assert.equal(await gh.postComment(a), true);
  assert.equal(await gh.postComment(a), false);
  assert.equal(comments.length, 1); assert.ok(comments[0].body.endsWith(markerComment('k:1')));
  const pr = { installationId: 1, owner: 'o', repo: 'r', head: 'agent/issue-3', title: 't', body: 'b', draft: false };
  assert.equal(await gh.openPr(pr), 9); assert.equal(await gh.openPr(pr), 9);
  assert.equal(calls.filter((c) => c === 'POST /repos/o/r/pulls').length, 1);
  prs.length = 0; aheadBy = 0; // a branch with no commits has nothing to propose
  assert.equal(await gh.openPr(pr), undefined);
  assert.equal(calls.filter((c) => c === 'POST /repos/o/r/pulls').length, 1);
  compareStatus = 404; assert.equal(await gh.openPr(pr), undefined);                // a branch that was never pushed has nothing to propose
  compareStatus = 502; await assert.rejects(gh.openPr(pr), /502/);                 // a GitHub error is not mistaken for "no changes"
});

test('a segment that published a different branch (factory mode) opens the PR from it and records it', async () => {
  const { key } = await fresh();
  const { ctx, deps, log } = harness(
    [() => ({ type: 'done', pr: { title: 'T', body: 'B' }, tokensUsed: 1, headSha: 'a', branch: 'factory/gh-7' })],
    [async () => { await requestCancel(store, key, 'issue closed'); return { cancel: true }; }]);
  await orchestrate(ctx, { issueKey: key }, deps);
  assert.match(log.prs[0], /^factory\/gh-7\|/);
  assert.equal((await getMeta(store, key))!.branch, 'factory/gh-7');
});

const U = (input: number, cacheRead: number, cacheWrite: number, output: number) => ({ input, cacheRead, cacheWrite, output });

test('the PR description carries a running cost across every session, including the ones before the PR existed', async () => {
  const { key } = await fresh();
  const { ctx, deps, log } = harness(
    [
      () => ({ type: 'questions', markdown: 'Which DB?', tokensUsed: 1, headSha: 'a', costUsd: 0.31, usage: U(100, 1_000_000, 50_000, 4_000) }),
      () => ({ type: 'done', pr: { title: 'T', body: 'B' }, tokensUsed: 1, headSha: 'b', costUsd: 1.5, usage: U(200, 4_000_000, 90_000, 20_000) }),
      () => ({ type: 'revised', summaryMarkdown: 'Fixed', tokensUsed: 1, headSha: 'c', costUsd: 0.64, usage: U(50, 800_000, 20_000, 6_000) }),
    ],
    [
      async () => { await appendMessage(store, key, msg('Postgres')); await wake(store, key); return { wake: true }; },
      async () => { await appendMessage(store, key, msg('rename it')); await wake(store, key); return { wake: true }; },
      async () => { await requestCancel(store, key, 'issue closed'); return { cancel: true }; },
    ]);
  await orchestrate(ctx, { issueKey: key }, deps);
  // No PR existed after session 1 (nothing to update). The PR opened in session 2 already shows sessions 1 and 2. Session 3 updates it again.
  assert.equal(log.cost.length, 2);
  assert.match(log.cost[0], /^77\|[\s\S]*\$1\.81\*\* in total across 2 sessions/);
  assert.match(log.cost[1], /^77\|[\s\S]*\$2\.45\*\* in total across 3 sessions/);
  assert.match(log.cost[1], /\| 1 \| Implementation: asked questions \| \$0\.31 \|/);
  assert.match(log.cost[1], /\| 2 \| Implementation: opened the pull request \| \$1\.50 \|/);
  assert.match(log.cost[1], /\| 3 \| Review: revised after feedback \| \$0\.64 \|/);
  assert.match(log.cost[1], /\*\*\$2\.45\*\*/);
});

test('a session on a model without a known price is shown as n/a and the total is marked as a lower bound', () => {
  const md = renderCostSection([
    { seq: 1, phase: 'IMPLEMENT', outcome: 'questions', costUsd: 0.5, usage: U(1, 2, 3, 4) },
    { seq: 2, phase: 'REVIEW', outcome: 'revised', usage: U(1, 2, 3, 4) },
  ], 'some.unpriced-model');
  assert.match(md, /\$0\.50\+ \(some sessions could not be priced\)/); assert.match(md, /\| 2 \| Review: revised after feedback \| n\/a \|/);
  assert.match(md, /^<!-- agent-cost:start -->/); assert.match(md, /<!-- agent-cost:end -->$/);
  assert.match(renderCostSection([], 'm'), /No sessions recorded yet/);
});

test('replaceSection replaces the marked block in place, appends when absent, and the real client only PATCHes on change', async () => {
  const section = (n: string) => `<!-- agent-cost:start -->\n${n}\n<!-- agent-cost:end -->`;
  assert.equal(replaceSection(`Body\n\n${section('old')}\n\nFooter`, 'agent-cost', section('new')), `Body\n\n${section('new')}\n\nFooter`);
  assert.equal(replaceSection('Body', 'agent-cost', section('x')), `Body\n\n${section('x')}\n`);

  let body = 'Description\n\nCloses #1'; const patches: string[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (init.method === 'PATCH') { body = JSON.parse(init.body as string).body; patches.push(body); return new Response('{}'); }
    return new Response(JSON.stringify({ body }));
  }) as unknown as typeof fetch;
  const gh = createGithubApi(async () => 't', fetchImpl);
  const a = { installationId: 1, owner: 'o', repo: 'r', number: 9, marker: 'agent-cost', markdown: section('v1') };
  await gh.upsertPrSection(a); await gh.upsertPrSection(a);                // second call: nothing changed
  await gh.upsertPrSection({ ...a, markdown: section('v2') });
  assert.equal(patches.length, 2); assert.ok(body.startsWith('Description') && body.includes('Closes #1') && body.includes('v2') && !body.includes('v1'));
});

test('a turn-limit session starts the next one immediately, and after too many in a row the agent stops to tell people', async () => {
  const cont = () => ({ type: 'continue', tokensUsed: 5, headSha: 'a', costUsd: 0.1, usage: U(1, 2, 3, 4) });
  const a = await fresh();
  const h1 = harness([cont, cont, () => ({ type: 'questions', markdown: 'Which?', tokensUsed: 1, headSha: 'b' })],
    [async () => { await requestCancel(store, a.key, 'issue closed'); return { cancel: true }; }]);
  await orchestrate(h1.ctx, { issueKey: a.key }, h1.deps);
  assert.equal(h1.log.launched, 3); assert.equal(h1.log.selfWakes.length, 0);
  assert.deepEqual(h1.log.waits, []);                              // never waited for a person between the continued sessions
  assert.equal(h1.log.comments.length, 1); assert.match(h1.log.comments[0], /Which\?/);   // no comment per continued session
  assert.deepEqual(h1.log.jobs.map((j) => j.segmentSeq), [1, 2, 3]);

  const b = await fresh();
  const h2 = harness(Array.from({ length: 7 }, () => cont),
    [async () => { await requestCancel(store, b.key, 'issue closed'); return { cancel: true }; }]);
  await orchestrate(h2.ctx, { issueKey: b.key }, h2.deps);
  assert.equal(h2.log.launched, 7);
  assert.ok(h2.log.comments.some((c) => c.includes('7 sessions in a row')));                 // then it waits for a reply
  assert.equal((await getMeta(store, b.key))!.status, 'DONE');
});

test('github client: finishing over an existing draft PR updates it and marks it ready; a normal PR is left alone', async () => {
  const calls: string[] = []; let drafts = true;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = url.replace('https://api.github.com', ''); calls.push(`${init.method} ${path.split('?')[0]}`);
    const j = (o: unknown) => new Response(JSON.stringify(o));
    if (path.startsWith('/graphql')) return j({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } });
    if (init.method === 'GET' && path.includes('/pulls')) return j([{ number: 71, draft: drafts, node_id: 'PR_node' }]);
    return j({});
  }) as unknown as typeof fetch;
  const gh = createGithubApi(async () => 't', fetchImpl);
  const a = { installationId: 1, owner: 'o', repo: 'r', head: 'factory/gh-70', title: 'Real title', body: 'Real body', draft: false };
  assert.equal(await gh.openPr(a), 71);
  assert.deepEqual(calls.filter((c) => !c.startsWith('GET')), ['PATCH /repos/o/r/pulls/71', 'POST /graphql']);
  calls.length = 0; drafts = false;
  assert.equal(await gh.openPr(a), 71);
  assert.deepEqual(calls.filter((c) => !c.startsWith('GET')), []);
});

test('a usage limit waits for the reset with a durable wait and then carries on; after too many it pauses for a human', async () => {
  const limited = (s: number) => () => ({ type: 'rate_limited', retryAfterSeconds: s, tokensUsed: 0, headSha: 'a' });
  const a = await fresh();
  const h1 = harness([limited(900), () => ({ type: 'questions', markdown: 'Which?', tokensUsed: 1, headSha: 'b' })],
    [async () => { await requestCancel(store, a.key, 'issue closed'); return { cancel: true }; }]);
  await orchestrate(h1.ctx, { issueKey: a.key }, h1.deps);
  assert.deepEqual(h1.log.waits, ['limit-wait-1']);                                   // one wait, no human involved
  assert.equal(h1.log.launched, 2); assert.equal(h1.log.selfWakes.length, 0);
  assert.equal(h1.log.comments.filter((c) => c.includes('usage limit')).length, 1);   // said once, when it began
  assert.match(h1.log.comments.find((c) => c.includes('usage limit'))!, /about 15 minutes/);

  const b = await fresh();
  const h2 = harness(Array.from({ length: 9 }, () => limited(600)), [async () => { await requestCancel(store, b.key, 'issue closed'); return { cancel: true }; }]);
  await orchestrate(h2.ctx, { issueKey: b.key }, h2.deps);
  assert.equal(h2.log.waits.length, 8); assert.equal(h2.log.launched, 9);              // eight waits, then it stops asking the limit to clear
  assert.ok(h2.log.comments.some((c) => c.includes('keep hitting my Claude usage limit')));
});

test('a very long limit wait is capped, and a limit wait never runs below a minute', async () => {
  const mk = (s: number) => () => ({ type: 'rate_limited', retryAfterSeconds: s, tokensUsed: 0, headSha: 'a' });
  const waitSecs: number[] = [];
  for (const [asked, expected] of [[999_999, 6 * 3600], [5, 60]] as const) {
    const { key } = await fresh();
    const h = harness([mk(asked), () => ({ type: 'questions', markdown: 'q', tokensUsed: 1, headSha: 'b' })], [async () => { await requestCancel(store, key, 'issue closed'); return { cancel: true }; }]);
    const orig = (h.ctx as unknown as { wait: (n: string, d: { seconds: number }) => Promise<void> }).wait;
    (h.ctx as unknown as { wait: unknown }).wait = async (n: string, d: { seconds: number }) => { waitSecs.push(d.seconds); return orig(n, d); };
    await orchestrate(h.ctx, { issueKey: key }, h.deps);
    assert.equal(waitSecs.at(-1), expected);
  }
});

test('the PR cost section shows subscription sessions as included, with the API-equivalent value, and never as billed money', () => {
  const only = renderCostSection([
    { seq: 1, phase: 'IMPLEMENT', outcome: 'questions', billing: 'subscription', costUsd: 1.1, usage: U(1, 2, 3, 4) },
    { seq: 2, phase: 'IMPLEMENT', outcome: 'rate_limited', billing: 'subscription', costUsd: 0.4, usage: U(1, 2, 3, 4) },
    { seq: 3, phase: 'REVIEW', outcome: 'revised', billing: 'subscription', costUsd: 2.0, usage: U(1, 2, 3, 4) },
  ], 'claude-code');
  assert.match(only, /Included in your Claude subscription/); assert.match(only, /about \$3\.50/);
  assert.match(only, /\| 1 \| Implementation: asked questions \| included in the subscription \(API-equivalent \$1\.10\) \|/);
  assert.match(only, /hit the Claude usage limit and waited/); assert.match(only, /no per-token billing/);
  assert.doesNotMatch(only, /Amazon Bedrock model usage/); assert.match(only, /\| \| \*\*Total\*\* \| \*\*included \(API-equivalent \$3\.50\)\*\* \|/);

  const mixed = renderCostSection([
    { seq: 1, phase: 'IMPLEMENT', outcome: 'questions', costUsd: 2.0, usage: U(1, 2, 3, 4) },
    { seq: 2, phase: 'IMPLEMENT', outcome: 'done', billing: 'subscription', costUsd: 5.0, usage: U(1, 2, 3, 4) },
  ], 'us.anthropic.claude-sonnet-5');
  assert.match(mixed, /\*\*\$2\.00\*\* in total across 1 session: estimated Amazon Bedrock/);   // only the Bedrock session is money
  assert.match(mixed, /A further 1 session was included in a Claude subscription \(API-equivalent about \$5\.00, not billed per token\)/);
});

test('billing is recorded per session, so the PR section can tell the backends apart', async () => {
  const { key } = await fresh();
  const { ctx, deps, log } = harness(
    [() => ({ type: 'done', pr: { title: 'T', body: 'B' }, tokensUsed: 1, headSha: 'a', costUsd: 1.25, billing: 'subscription', usage: U(1, 2, 3, 4) })],
    [async () => { await requestCancel(store, key, 'issue closed'); return { cancel: true }; }]);
  await orchestrate(ctx, { issueKey: key }, deps);
  assert.match(log.cost.at(-1)!, /included in the subscription \(API-equivalent \$1\.25\)/);
});

test('a run says it has started: once per run, on the issue the first time and as a resume afterwards, and never blocks the work', async () => {
  const cont = () => ({ type: 'continue', tokensUsed: 5, headSha: 'a' });
  const cancel = (key: string) => async () => { await requestCancel(store, key, 'issue closed'); return { cancel: true }; };

  // a brand new issue: one comment on the issue, even though the run goes through several continued sessions
  const a = await fresh(); const num = Number(a.key.split('#').pop());
  const h1 = harness([cont, cont, () => ({ type: 'questions', markdown: 'Which?', tokensUsed: 1, headSha: 'b' })], [cancel(a.key)]);
  await orchestrate(h1.ctx, { issueKey: a.key }, h1.deps);
  assert.equal(h1.log.started.length, 1);
  assert.match(h1.log.started[0], new RegExp(`^${num}\\\\|I have started working on this`)); assert.match(h1.log.started[0], /20 to 45 minutes/);
  assert.equal(h1.log.comments.length, 1);                                      // only the questions: the started comment is separate

  // a run that already did sessions (restart or resume after expiry) says it is picking the work back up, on the PR when there is one
  const b = await fresh(); await setStatus(b.key, { segmentSeq: 3, prNumber: 55 });
  const h2 = harness([() => ({ type: 'questions', markdown: 'q', tokensUsed: 1, headSha: 'c' })], [cancel(b.key)]);
  await orchestrate(h2.ctx, { issueKey: b.key }, h2.deps);
  assert.match(h2.log.started[0], /^55\|I am picking this back up/);

  // the comment is keyed by where the run starts, so a replay of the same start does not repeat it
  assert.equal(new Set([h1.log.started[0]]).size, 1);

  // if posting it fails, the work still runs
  const c = await fresh();
  const h3 = harness([() => ({ type: 'questions', markdown: 'q', tokensUsed: 1, headSha: 'd' })], [cancel(c.key)]);
  const real = h3.deps.github.postComment;
  h3.deps.github.postComment = async (x) => { if (x.marker.includes(':start:')) throw new Error('GitHub is down'); return real(x); };
  const logged: string[] = []; h3.deps.log = (m) => { logged.push(m); };
  await orchestrate(h3.ctx, { issueKey: c.key }, h3.deps);
  assert.equal(h3.log.launched, 1); assert.ok(logged.includes('started comment failed'));
});
