import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ConverseCommandOutput, Message } from '@aws-sdk/client-bedrock-runtime';
import type { SegmentJob, SegmentResult } from '@agent/shared';
import { runSegment, sessionIdFor, type HarnessDeps } from '../src/harness.ts';
import { createSegmentServer } from '../src/server.ts';

const sh = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' });
const reply = (content: object[]): ConverseCommandOutput => ({ output: { message: { role: 'assistant', content } }, stopReason: 'tool_use', usage: { inputTokens: 100, outputTokens: 10, totalTokens: 0 }, $metadata: {}, metrics: { latencyMs: 0 } }) as unknown as ConverseCommandOutput;
const use = (id: string, name: string, input: object) => ({ toolUse: { toolUseId: id, name, input } });

function remote() {
  const root = mkdtempSync(join(tmpdir(), 'h-')); const bare = join(root, 'r.git'); const seed = join(root, 'seed');
  execFileSync('git', ['init', '--bare', '-b', 'main', bare]); execFileSync('git', ['clone', '-q', bare, seed]);
  writeFileSync(join(seed, 'README.md'), '# app\n'); sh(seed, 'add', '-A');
  sh(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'); sh(seed, 'push', '-q', 'origin', 'HEAD:main');
  return { root, bare, seed };
}

const job = (over: Partial<SegmentJob> = {}): SegmentJob => ({
  issueKey: 'ISSUE#o/r#7', owner: 'o', repo: 'r', issueNumber: 7, installationId: 1, phase: 'IMPLEMENT', segmentSeq: 1, callbackId: 'cb',
  inbox: { fromExclusive: 0, toInclusive: 0 }, transcriptKey: 't.json', branch: 'agent/issue-7', prNumber: null, tokenBudgetRemaining: 100000, ...over });

function remoteWith(files: Record<string, string>) {
  const r = remote();
  for (const [f, c] of Object.entries(files)) { mkdirSync(join(r.seed, f.split('/').slice(0, -1).join('/') || '.'), { recursive: true }); writeFileSync(join(r.seed, f), c); }
  sh(r.seed, 'add', '-A'); sh(r.seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'files'); sh(r.seed, 'push', '-q', 'origin', 'HEAD:main');
  return r;
}

function deps(bare: string, script: Array<() => ConverseCommandOutput>, over: Partial<HarnessDeps> = {}) {
  const store = new Map<string, Message[]>(); const ok: SegmentResult[] = []; const bad: Array<[string, string]> = []; const prompts: string[] = []; let tokens = 0;
  const d: HarnessDeps = {
    config: { bedrockModelId: 'm', maxTurnsPerSegment: 10, transcriptCompactTokens: 100000, runCommandTimeoutSeconds: 5, toolOutputMaxBytes: 2000 },
    getToken: async () => `tok${++tokens}`,
    getIssue: async () => ({ title: 'Add greeting', body: 'Please add hello.txt', author: 'maintainer' }),
    loadTranscript: async (k) => store.get(k), saveTranscript: async (k, m) => { store.set(k, structuredClone(m)); },
    loadInbox: async () => [],
    converse: async (i) => { prompts.push(JSON.stringify(i.messages)); return script.shift()!(); },
    reportSuccess: async (_c, r) => { ok.push(r); }, reportFailure: async (_c, code, msg) => { bad.push([code, msg]); },
    cloneUrl: () => bare, ...over,
  };
  return { d, store, ok, bad, prompts, tokenCalls: () => tokens };
}

test('first segment: clones, creates branch, agent edits, commit + push + transcript + callback', async () => {
  const { bare, root } = remote();
  const h = deps(bare, [
    () => reply([use('1', 'write_file', { path: 'hello.txt', content: 'hi\n' })]),
    () => reply([use('2', 'finish', { title: 'Add hello', body: 'Adds hello.txt' })]),
  ]);
  await runSegment(h.d, job());
  assert.equal(h.bad.length, 0);
  assert.equal(h.ok.length, 1); assert.equal(h.ok[0].type, 'done'); assert.equal(h.ok[0].tokensUsed, 220);
  const check = join(root, 'check'); execFileSync('git', ['clone', '-q', '-b', 'agent/issue-7', bare, check]);
  assert.equal(readFileSync(join(check, 'hello.txt'), 'utf8'), 'hi\n');
  assert.equal(sh(check, 'rev-parse', 'HEAD').trim(), h.ok[0].headSha);
  assert.match(sh(check, 'log', '-1', '--format=%s'), /issue #7 \(segment 1\)/);
  assert.ok(h.store.get('t.json')!.length >= 3);
  assert.match(h.prompts[0], /Add greeting/); assert.match(h.prompts[0], /untrusted_github_content/);
});

test('resumed segment: sees the pushed work and transcript, new comments appended', async () => {
  const { bare } = remote();
  const first = deps(bare, [() => reply([use('1', 'write_file', { path: 'a.txt', content: 'a' })]), () => reply([use('2', 'ask_questions', { markdown: 'Which colour?' })])]);
  await runSegment(first.d, job());
  assert.equal(first.ok[0].type, 'questions');

  const second = deps(bare, [
    () => reply([use('3', 'read_file', { path: 'a.txt' })]),
    () => reply([use('4', 'finish', { title: 'Done', body: 'b' })]),
  ], { loadTranscript: async (k) => first.store.get(k), loadInbox: async () => [{ seq: 1, source: 'issue_comment', author: 'maintainer', body: 'Blue please', url: 'u', createdAt: 't' }] });
  await runSegment(second.d, job({ segmentSeq: 2, inbox: { fromExclusive: 0, toInclusive: 1 } }));
  assert.equal(second.ok[0].type, 'done');
  assert.match(second.prompts[0], /Which colour\?/); assert.match(second.prompts[0], /Blue please/);
  assert.ok(!/Add greeting/.test(second.prompts[0].split('Blue please')[1] ?? ''));
  const msgs = second.store.get('t.json') ?? first.store.get('t.json')!;
  for (let i = 0; i < msgs.length - 1; i++) assert.notEqual(msgs[i].role, msgs[i + 1].role); // roles alternate
});

test('rejected push reports PUSH_FAILED and does not save the transcript', async () => {
  const { bare, root } = remote();
  const h = deps(bare, [() => {
    // Someone else advances the branch while the agent works.
    const other = join(root, 'other'); execFileSync('git', ['clone', '-q', bare, other]);
    sh(other, 'checkout', '-q', '-b', 'agent/issue-7'); writeFileSync(join(other, 'x'), 'x'); sh(other, 'add', '-A');
    sh(other, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x'); sh(other, 'push', '-q', 'origin', 'agent/issue-7');
    return reply([use('1', 'write_file', { path: 'mine.txt', content: 'm' })]);
  }, () => reply([use('2', 'finish', { title: 'T', body: 'B' })])]);
  await runSegment(h.d, job());
  assert.equal(h.ok.length, 0); assert.equal(h.bad[0][0], 'PUSH_FAILED'); assert.equal(h.store.size, 0);
});

test('clone failure and crashes become callback failures; the work dir is cleaned up', async () => {
  const segDirs = () => readdirSync(tmpdir()).filter((n) => n.startsWith('segment-1-')).length;
  const before = segDirs();
  const h = deps('/nonexistent/repo.git', []);
  await runSegment(h.d, job());
  assert.equal(h.bad[0][0], 'CLONE_FAILED');
  const { bare } = remote();
  const h2 = deps(bare, [() => { throw new Error('model exploded'); }]);
  await runSegment(h2.d, job());
  assert.deepEqual([h2.bad[0][0], h2.bad[0][1]], ['SEGMENT_ERROR', 'model exploded']);
  assert.equal(segDirs(), before); // work dirs removed after both failures
});

test('token is refreshed before push when the segment has run longer than 50 minutes', async () => {
  const { bare } = remote(); let t = 1_000_000;
  const h = deps(bare, [() => { t += 51 * 60 * 1000; return reply([use('1', 'finish', { title: 'T', body: 'B' })]); }], { now: () => t });
  await runSegment(h.d, job());
  assert.equal(h.ok.length, 1);
  assert.ok(h.tokenCalls() >= 2);
});

test('server: 202 quickly, duplicate segmentSeq starts one loop, bad input is 400, hooks return 200', async () => {
  let runs = 0; let release!: () => void; const gate = new Promise<void>((r) => (release = r));
  const server = createSegmentServer(async () => { runs++; await gate; });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port; const url = (p: string) => `http://127.0.0.1:${port}${p}`;
  const post = (body: unknown) => fetch(url('/segment'), { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });
  const t0 = Date.now();
  assert.equal((await post(job())).status, 202); assert.ok(Date.now() - t0 < 1000);
  assert.equal((await post(job())).status, 202);
  assert.equal((await post(job({ segmentSeq: 2 }))).status, 202);
  assert.equal((await post('{nope')).status, 400); assert.equal((await post({ x: 1 })).status, 400);
  assert.equal((await fetch(url('/ready'))).status, 200);
  assert.equal((await fetch(url('/aws/lambda-microvms/runtime/v1/ready'))).status, 200);
  assert.equal((await fetch(url('/aws/lambda-microvms/runtime/v1/run'), { method: 'POST', body: '{}' })).status, 200); assert.equal((await fetch(url('/nope'))).status, 404);
  assert.equal(runs, 2);
  release(); server.close();
});

test('server with requireKey: jobs need the key delivered by the run hook, which is accepted only once', async () => {
  let runs = 0;
  const server = createSegmentServer(async () => { runs++; }, { requireKey: true });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port; const base = `http://127.0.0.1:${port}`;
  const post = (headers: Record<string, string> = {}) => fetch(`${base}/segment`, { method: 'POST', headers, body: JSON.stringify(job()) });
  assert.equal((await post()).status, 503);                                           // no key yet: not ready
  const hook = `${base}/aws/lambda-microvms/runtime/v1/run`;
  const envelope = { microvmId: 'microvm-1', runHookPayload: JSON.stringify({ key: 'k'.repeat(48) }) }; // the platform's format
  assert.equal((await fetch(hook, { method: 'POST', body: JSON.stringify(envelope) })).status, 200);
  assert.equal((await fetch(hook, { method: 'POST', body: JSON.stringify({ key: 'x'.repeat(48) }) })).status, 200); // an attacker's later call is ignored
  assert.equal((await post()).status, 403); assert.equal((await post({ 'X-Segment-Key': 'x'.repeat(48) })).status, 403);
  assert.equal((await post({ 'X-Segment-Key': 'k'.repeat(48) })).status, 202);
  assert.equal(runs, 1); server.close();
});

test('the repository decides the work mode: OpenSpec repos get the proposal-first prompt, others do not', async () => {
  const systems: string[] = [];
  const run = async (bare: string) => {
    const h = deps(bare, [() => reply([use('1', 'finish', { title: 'Proposal: x', body: 'b' })])], {
      converse: async (i) => { systems.push(JSON.stringify(i.system)); return reply([use('1', 'finish', { title: 'Proposal: x', body: 'b' })]); },
    });
    await runSegment(h.d, job()); return h;
  };
  await run(remoteWith({ 'openspec/config.yaml': 'schema: spec-driven\n' }).bare);
  await run(remote().bare);
  assert.match(systems[0], /Do NOT write application code yet/);
  assert.ok(!systems[1].includes('Do NOT write application code yet'));
});

const FACTORY_FILES = { 'factory/.swamp.yaml': 'swampVersion: x\n', 'factory/models/m.yaml': 'm: 1\n', '.claude/commands/factory.md': '# factory\n' };

test('factory mode: the factory worktree branch is committed and published, and its state travels between segments', async () => {
  const { bare, root } = remoteWith(FACTORY_FILES);
  const wt = join(mkdtempSync(join(tmpdir(), 'fwt-')), 'gh-7');
  let saved: Buffer | undefined; const outputs: string[] = [];
  const first = deps(bare, [
    () => reply([use('1', 'run_command', { command: `git worktree add -q -b factory/gh-7 ${wt} origin/main && echo planned > ${wt}/plan.md && mkdir -p factory/.swamp/data && echo item-state > factory/.swamp/data/gh-7.txt` })]),
    () => reply([use('2', 'ask_questions', { markdown: 'Plan ready. Reply approved to continue.' })]),
  ], { enableFactory: true, saveFactoryState: async (_j, b) => { saved = b; } });
  await runSegment(first.d, job());
  assert.equal(first.bad.length, 0, JSON.stringify(first.bad));
  assert.equal(first.ok[0].type, 'questions'); assert.equal(first.ok[0].branch, 'factory/gh-7');
  const check = join(root, 'check'); execFileSync('git', ['clone', '-q', '-b', 'factory/gh-7', bare, check]);
  assert.equal(readFileSync(join(check, 'plan.md'), 'utf8'), 'planned\n');          // the harness committed the worktree for the agent
  assert.ok(saved && saved.length > 50, 'factory state was packed');
  assert.match(sh(check, 'log', '-1', '--format=%s'), /factory: work on issue #7/);

  // Next segment, fresh VM: the state comes back and the branch is available locally for `git worktree add`.
  const second = deps(bare, [
    () => reply([use('3', 'run_command', { command: 'cat factory/.swamp/data/gh-7.txt; git branch --list factory/gh-7' })]),
    () => reply([use('4', 'finish', { title: 'Add thing', body: 'Closes #7' })]),
  ], { enableFactory: true, loadFactoryState: async () => saved, loadTranscript: async (k) => first.store.get(k) });
  await runSegment(second.d, job({ segmentSeq: 2 }));
  assert.equal(second.bad.length, 0, JSON.stringify(second.bad));
  const out = JSON.stringify(second.store.get('t.json') ?? first.store.get('t.json'));
  assert.match(out, /item-state/); assert.match(out, /factory\/gh-7/);
  assert.equal(second.ok[0].type, 'done'); assert.equal(second.ok[0].branch, 'factory/gh-7');
  void outputs;
});

test('factory mode with no factory branch yet publishes nothing and reports no branch', async () => {
  const { bare, root } = remoteWith(FACTORY_FILES);
  const h = deps(bare, [() => reply([use('1', 'ask_questions', { markdown: 'Which factory?' })])], { enableFactory: true });
  await runSegment(h.d, job());
  assert.equal(h.ok[0].type, 'questions'); assert.equal(h.ok[0].branch, undefined);
  assert.equal(execFileSync('git', ['--git-dir', bare, 'branch', '--list', 'factory/*'], { encoding: 'utf8' }).trim(), '');
  void root;
});

test('a repository with a factory is treated as OpenSpec/plain unless the factory is enabled', async () => {
  const { bare } = remoteWith({ ...FACTORY_FILES, 'openspec/config.yaml': 'schema: spec-driven\n' });
  const h = deps(bare, [() => reply([use('1', 'finish', { title: 'Proposal: x', body: 'b' })])]);
  await runSegment(h.d, job());
  assert.equal(h.ok[0].branch, undefined);
  assert.match(execFileSync('git', ['--git-dir', bare, 'branch', '--list', 'agent/issue-7'], { encoding: 'utf8' }), /agent\/issue-7/);
});

test('the factory is used only when a swamp token is configured; the agent gets it as a key file, and otherwise falls back', async () => {
  const withKey = remoteWith({ ...FACTORY_FILES, 'openspec/config.yaml': 'schema: spec-driven\n' });
  const seen: string[] = []; const systems: string[] = [];
  const mk = (bare: string, key: string | undefined) => deps(bare, [
    () => reply([use('1', 'run_command', { command: 'echo "file=$SWAMP_API_KEY_FILE"; cat "$SWAMP_API_KEY_FILE"; env | grep -c "^AWS_" || true' })]),
    () => reply([use('2', 'ask_questions', { markdown: 'q' })]),
  ], { enableFactory: true, getSwampKey: async () => key });
  const h1 = mk(withKey.bare, 'swamp-token-123');
  const orig = h1.d.converse; h1.d.converse = async (i) => { systems.push(JSON.stringify(i.system)); return orig(i); };
  await runSegment(h1.d, job());
  seen.push(JSON.stringify(h1.store.get('t.json')));
  assert.match(systems[0], /swamp software factory/);
  assert.match(seen[0], /swamp-token-123/); assert.match(seen[0], /file=\/.*swamp-api-key/);
  assert.match(seen[0], /swamp-token-1230/); // the token, then a count of 0 AWS_* variables visible to the agent

  const h2 = mk(withKey.bare, undefined); const sys2: string[] = [];
  const o2 = h2.d.converse; h2.d.converse = async (i) => { sys2.push(JSON.stringify(i.system)); return o2(i); };
  await runSegment(h2.d, job({ segmentSeq: 2 }));
  assert.ok(!/swamp software factory/.test(sys2[0])); assert.match(sys2[0], /Do NOT write application code yet/);
});

test('each session reports raw token usage and a priced cost; unknown models report usage only', async () => {
  const { bare } = remote();
  const priced = deps(bare, [
    () => reply([use('1', 'write_file', { path: 'a.txt', content: 'a' })]),
    () => reply([use('2', 'finish', { title: 'T', body: 'B' })]),
  ], { config: { bedrockModelId: 'us.anthropic.claude-sonnet-5', maxTurnsPerSegment: 10, transcriptCompactTokens: 100000, runCommandTimeoutSeconds: 5, toolOutputMaxBytes: 2000 } });
  await runSegment(priced.d, job());
  const r = priced.ok[0];
  assert.deepEqual(r.usage, { input: 200, output: 20, cacheRead: 0, cacheWrite: 0 });          // two calls of 100 in / 10 out
  assert.ok(Math.abs(r.costUsd! - (200 * 2.2 + 20 * 11) / 1e6) < 1e-12, String(r.costUsd));
  const unpriced = deps(remote().bare, [() => reply([use('1', 'finish', { title: 'T', body: 'B' })])]);
  await runSegment(unpriced.d, job());
  assert.equal(unpriced.ok[0].costUsd, undefined); assert.equal(unpriced.ok[0].usage?.input, 100);
});

// ---- Claude Code backend
import { chmodSync } from 'node:fs';
const FAKE_CLAUDE = join(import.meta.dirname, 'fixtures/fake-claude.mjs');

/** A `claude` stand-in with a fixed scenario, since the harness does not pass arbitrary environment to it. */
function fakeClaude(scenario: string) {
  const dir = mkdtempSync(join(tmpdir(), 'fc-')); const bin = join(dir, 'claude'); const record = join(dir, 'record.jsonl');
  writeFileSync(bin, `#!/bin/sh\nFAKE_SCENARIO=${scenario} FAKE_RECORD=${record} exec ${process.execPath} ${FAKE_CLAUDE} "$@"\n`); chmodSync(bin, 0o755);
  return { bin, runs: () => readFileSync(record, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) };
}

function ccDeps(bare: string, fc: { bin: string }, over: Partial<HarnessDeps> = {}) {
  const h = deps(bare, [], { agentBackend: 'claude-code', getClaudeToken: async () => 'sk-ant-oat-test', claudeBin: fc.bin, workBase: mkdtempSync(join(tmpdir(), 'wb-')),
    mcpCommand: { command: 'node', args: ['unused.js'] }, ...over });
  return h;
}

test('backend lookup: the looked-up backend wins over the static one', async () => {
  const { bare } = remote(); const fc = fakeClaude('finish');
  const h = ccDeps(bare, fc, { agentBackend: 'bedrock', getAgentBackend: async () => 'claude-code' });
  await runSegment(h.d, job());
  assert.equal(h.bad.length, 0, JSON.stringify(h.bad));
  assert.equal(h.ok[0].billing, 'subscription');
});

test('backend lookup: a failed lookup fails the segment and never falls back to a backend', async () => {
  const { bare } = remote(); const fc = fakeClaude('finish'); let converseCalls = 0;
  const h = ccDeps(bare, fc, { getAgentBackend: async () => { throw new Error('ParameterNotFound'); }, converse: async () => { converseCalls++; throw new Error('should not run'); } });
  await runSegment(h.d, job());
  assert.equal(h.ok.length, 0); assert.equal(converseCalls, 0);
  assert.equal(h.bad.length, 1); assert.equal(h.bad[0][0], 'SEGMENT_ERROR'); assert.match(h.bad[0][1], /Could not determine the model backend: ParameterNotFound/);
});

test('Claude Code backend: runs in a fixed directory, publishes the branch, saves the session, reports subscription billing and API-equivalent cost', async () => {
  const { bare, root } = remote(); const fc = fakeClaude('finish'); let saved: Buffer | undefined;
  const h = ccDeps(bare, fc, { saveClaudeSession: async (_j, b) => { saved = b; } });
  await runSegment(h.d, job());
  assert.equal(h.bad.length, 0, JSON.stringify(h.bad));
  const r = h.ok[0];
  assert.equal(r.type, 'done'); assert.equal(r.billing, 'subscription'); assert.equal(r.costUsd, 0.42);
  assert.deepEqual(r.usage, { input: 100, output: 300, cacheRead: 50000, cacheWrite: 2000 }); assert.equal(r.tokensUsed, 7400);
  assert.equal(h.prompts.length, 0, 'Bedrock is never called');
  const check = join(root, 'check'); execFileSync('git', ['clone', '-q', '-b', 'agent/issue-7', bare, check]);
  assert.equal(readFileSync(join(check, 'feature.txt'), 'utf8'), 'built by the fake\n');           // the harness committed what the agent wrote
  const [run] = fc.runs();
  assert.equal(run.args[run.args.indexOf('--session-id') + 1], sessionIdFor('ISSUE#o/r#7'));
  assert.match(run.cwd, /\/job\/repo$/); assert.match(run.args[1], /Add greeting/);                // first prompt carries the issue
  assert.ok(saved && saved.length > 50, 'the Claude config directory was saved');
  assert.equal(h.store.size, 0, 'no Bedrock transcript is written');
});

test('Claude Code backend: the next segment restores the session, resumes it, and sees the new comments', async () => {
  const { bare } = remote(); const fc = fakeClaude('finish'); let saved: Buffer | undefined;
  const wb = mkdtempSync(join(tmpdir(), 'wb-'));
  await runSegment(ccDeps(bare, fc, { workBase: wb, saveClaudeSession: async (_j, b) => { saved = b; } }).d, job());

  const second = ccDeps(bare, fc, { workBase: wb, loadClaudeSession: async () => saved,
    loadInbox: async () => [{ seq: 1, source: 'issue_comment', author: 'maintainer', body: 'Blue please', url: 'u', createdAt: 't' }] });
  await runSegment(second.d, job({ segmentSeq: 2, phase: 'REVIEW', inbox: { fromExclusive: 0, toInclusive: 1 } }));
  assert.equal(second.bad.length, 0, JSON.stringify(second.bad));
  assert.equal(second.ok[0].type, 'revised');
  const [first, resumed] = fc.runs();
  assert.equal(first.sessionFileExisted, false); assert.equal(resumed.sessionFileExisted, true);   // the session came back from storage
  assert.ok(resumed.args.includes('--resume') && !resumed.args.includes('--session-id'));
  assert.equal(resumed.args[resumed.args.indexOf('--resume') + 1], sessionIdFor('ISSUE#o/r#7'));
  assert.equal(resumed.cwd, first.cwd);                                                               // same path, so Claude Code finds the session
  assert.match(resumed.args[1], /Blue please/); assert.doesNotMatch(resumed.args[1], /Add greeting/);  // a resume gets only the new activity
});

test('Claude Code backend without a token fails clearly and never falls back to Bedrock', async () => {
  const { bare } = remote(); const fc = fakeClaude('finish');
  const h = ccDeps(bare, fc, { getClaudeToken: async () => undefined });
  await runSegment(h.d, job());
  assert.equal(h.ok.length, 0); assert.equal(h.bad[0][0], 'BACKEND_NOT_CONFIGURED'); assert.match(h.bad[0][1], /claude setup-token/);
  assert.equal(h.prompts.length, 0);
  assert.throws(() => fc.runs(), /ENOENT/);                                                         // Claude Code was not started either
});

test('Claude Code turn limit and usage limit come back as continue and rate_limited', async () => {
  const { bare } = remote();
  const a = ccDeps(bare, fakeClaude('max_turns')); await runSegment(a.d, job());
  assert.equal(a.ok[0].type, 'continue');
  const b = ccDeps(remote().bare, fakeClaude('rate_limited')); await runSegment(b.d, job());
  const out = b.ok[0] as { type: string; retryAfterSeconds?: number }; assert.equal(out.type, 'rate_limited'); assert.ok((out.retryAfterSeconds ?? 0) > 800);
});
