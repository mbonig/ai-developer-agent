import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { handleMcp, mcpTools } from '../src/mcp-server.ts';
import { feed, newStreamState, streamUsage, rateLimitedFor, runClaudeSession, type ClaudeRunArgs } from '../src/claude-code.ts';
import { loadConfig, parseAgentBackend } from '@agent/shared';

const FAKE = resolve(import.meta.dirname, 'fixtures/fake-claude.mjs');

// ---- config
test('agentBackend: default bedrock, claude-code accepted without a Bedrock model, anything else rejected', () => {
  assert.equal(loadConfig({ BEDROCK_MODEL_ID: 'm', MAX_TOKENS_PER_ISSUE: '10' }).agentBackend, 'bedrock');
  assert.equal(loadConfig({ AGENT_BACKEND: 'claude-code', MAX_TOKENS_PER_ISSUE: '10' }).agentBackend, 'claude-code');
  assert.throws(() => loadConfig({ MAX_TOKENS_PER_ISSUE: '10' }), /BEDROCK_MODEL_ID/);               // bedrock still needs its model
  assert.throws(() => loadConfig({ AGENT_BACKEND: 'gpt', MAX_TOKENS_PER_ISSUE: '10' }), /AGENT_BACKEND/);
});

test('parseAgentBackend: accepts the two names (trimmed) and rejects anything else', () => {
  assert.equal(parseAgentBackend('bedrock', 'p'), 'bedrock');
  assert.equal(parseAgentBackend(' claude-code\n', 'p'), 'claude-code');
  assert.throws(() => parseAgentBackend('Claude', '/x/param'), /\/x\/param must be/);
  assert.throws(() => parseAgentBackend(undefined, 'p'), /got ""/);
});

// ---- MCP server
test('MCP tools depend on the phase, and a call records the outcome once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-')); const file = join(dir, 'out.json');
  const impl = mcpTools('IMPLEMENT').find((t) => t.name === 'finish')!; const rev = mcpTools('REVIEW').find((t) => t.name === 'finish')!;
  assert.deepEqual(impl.inputSchema.required, ['title', 'body']); assert.deepEqual(rev.inputSchema.required, ['summary']);

  const env = { outcomeFile: file, phase: 'IMPLEMENT' as const };
  const init = handleMcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, env)!;
  assert.equal((init.result as { protocolVersion: string }).protocolVersion, '2025-03-26');
  assert.equal(handleMcp({ jsonrpc: '2.0', method: 'notifications/initialized' }, env), undefined);                 // a notification gets no reply
  assert.equal(((handleMcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, env)!.result as { tools: unknown[] }).tools).length, 2);
  assert.equal(existsSync(file), false);
  handleMcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'finish', arguments: { title: 'T', body: 'B' } } }, env);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { tool: 'finish', input: { title: 'T', body: 'B' } });
  const again = handleMcp({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ask_questions', arguments: { markdown: 'later?' } } }, env)!;
  assert.match(JSON.stringify(again), /already recorded/); assert.equal(JSON.parse(readFileSync(file, 'utf8')).tool, 'finish'); // the first call wins
  assert.match(JSON.stringify(handleMcp({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'rm_rf' } }, env)), /unknown tool/);
  assert.equal((handleMcp({ jsonrpc: '2.0', id: 6, method: 'nope' }, env) as { error: { code: number } }).error.code, -32601);
});

test('the MCP server works over real stdio, as Claude Code will use it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-')); const file = join(dir, 'out.json');
  const server = spawn(process.execPath, ['--input-type=module', '-e', `import { runMcpServer } from ${JSON.stringify(resolve(import.meta.dirname, '../src/mcp-server.ts'))}; runMcpServer();`],
    { env: { ...process.env, HARNESS_OUTCOME_FILE: file, HARNESS_PHASE: 'REVIEW' } });
  const lines: string[] = []; let buf = '';
  server.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) !== -1) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); } });
  const send = (o: object) => server.stdin.write(JSON.stringify(o) + '\n');
  const until = async (n: number) => { for (let i = 0; i < 100 && lines.length < n; i++) await new Promise((r) => setTimeout(r, 50)); };
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }); send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'finish', arguments: { summary: 'Done in review' } } });
  await until(2); server.stdin.end();
  assert.equal(lines.length, 2); assert.match(lines[1], /Recorded/);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { tool: 'finish', input: { summary: 'Done in review' } });
});

// ---- stream parser (event shapes captured from the real CLI)
test('the parser folds init, assistant, rate-limit and result events, and counts each message once', () => {
  const s = newStreamState();
  const lines = [
    { type: 'system', subtype: 'init', session_id: 'sess-1' },
    { type: 'assistant', session_id: 'sess-1', message: { id: 'm1', usage: { input_tokens: 2, cache_creation_input_tokens: 20806, cache_read_input_tokens: 11266, output_tokens: 4 } } },
    { type: 'assistant', session_id: 'sess-1', message: { id: 'm1', usage: { input_tokens: 2, cache_creation_input_tokens: 20806, cache_read_input_tokens: 11266, output_tokens: 9 } } },   // same message, updated
    { type: 'assistant', session_id: 'sess-1', message: { id: 'm2', usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 32000, output_tokens: 50 } } },
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1793687400, rateLimitType: 'five_hour' } },
    { type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', num_turns: 2, result: 'ready', total_cost_usd: 0.4192814, usage: { input_tokens: 3, cache_creation_input_tokens: 20806, cache_read_input_tokens: 43266, output_tokens: 59 } },
  ];
  for (const l of lines) feed(s, JSON.stringify(l)); feed(s, 'not json'); feed(s, '');
  assert.equal(s.sessionId, 'sess-1');
  assert.deepEqual(streamUsage(s), { input: 3, output: 59, cacheRead: 43266, cacheWrite: 20806 });
  assert.equal(s.result!.costUsd, 0.4192814); assert.equal(s.result!.isError, false); assert.equal(s.result!.numTurns, 2);
  assert.equal(rateLimitedFor(s), undefined);                                  // an "allowed" window is not a limit
});

test('usage limits: a rejected window waits until its reset, an error that mentions a limit waits a default time', () => {
  const now = 1_000_000;
  const rejected = newStreamState(); feed(rejected, JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: now + 900 } }));
  assert.equal(rateLimitedFor(rejected, now), 900);
  const soon = newStreamState(); feed(soon, JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: now + 5 } }));
  assert.equal(rateLimitedFor(soon, now), 60);                                  // never a busy loop
  const textOnly = newStreamState(); feed(textOnly, JSON.stringify({ type: 'result', is_error: true, subtype: 'error', result: 'Claude usage limit reached. Your limit resets at 3pm.' }));
  assert.equal(rateLimitedFor(textOnly, now), 1800);
  const warn = newStreamState(); feed(warn, JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt: now + 100 } }));
  assert.equal(rateLimitedFor(warn, now), undefined);
  const plainError = newStreamState(); feed(plainError, JSON.stringify({ type: 'result', is_error: true, subtype: 'error_during_execution', result: 'something broke' }));
  assert.equal(rateLimitedFor(plainError, now), undefined);
});

// ---- runner against a fake claude
function args(scenario: string, over: Partial<ClaudeRunArgs> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-')); const record = join(dir, 'record.jsonl');
  const a: ClaudeRunArgs = {
    workDir: dir, configDir: join(dir, 'cfg'), prompt: 'Do the thing', systemPrompt: 'You are an agent.', phase: 'IMPLEMENT', sessionId: '11111111-2222-5333-a444-555555555555', resume: false,
    token: 'sk-ant-oat-test-token', maxTurns: 150, tokenBudget: 10_000_000, timeoutMs: 20_000, outcomeFile: join(dir, 'outcome.json'), mcpConfigPath: join(dir, 'mcp.json'),
    mcp: { command: 'node', args: ['mcp.js'] }, claudeBin: FAKE, extraEnv: { FAKE_SCENARIO: scenario, FAKE_RECORD: record }, ...over,
  };
  writeFileSync(join(dir, 'x'), ''); 
  return { a, runs: () => (existsSync(record) ? readFileSync(record, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []) };
}

test('runner: questions and finish map to outcomes, with usage and API-equivalent cost', async () => {
  process.env.AWS_ACCESS_KEY_ID = 'must-not-leak';
  const q = args('questions'); const rq = await runClaudeSession(q.a);
  assert.deepEqual(rq.outcome, { type: 'questions', markdown: 'Which colour?' });
  assert.deepEqual(rq.usage, { input: 100, output: 300, cacheRead: 50000, cacheWrite: 2000 }); assert.equal(rq.costUsd, 0.42);
  assert.equal(rq.tokensUsed, 100 + 300 + 2000 + 5000);                                         // cache reads at 10%

  const impl = await runClaudeSession(args('finish').a);
  assert.deepEqual(impl.outcome, { type: 'done', pr: { title: 'Add feature', body: 'Does it' } });
  const rev = await runClaudeSession(args('finish', { phase: 'REVIEW' }).a);
  assert.deepEqual(rev.outcome, { type: 'revised', summaryMarkdown: 'Renamed things' });

  // how it was launched: first run names the session, never resumes; strict MCP; no permission prompts; the token only in its environment
  const [run] = q.runs();
  assert.ok(run.args.includes('--session-id') && !run.args.includes('--resume'));
  assert.equal(run.args[run.args.indexOf('--session-id') + 1], '11111111-2222-5333-a444-555555555555');
  for (const f of ['-p', '--verbose', '--strict-mcp-config', '--dangerously-skip-permissions', '--append-system-prompt']) assert.ok(run.args.includes(f), f);
  assert.equal(run.args[run.args.indexOf('--output-format') + 1], 'stream-json');
  assert.ok(!run.args.some((x: string) => x.includes('sk-ant-oat-test-token')), 'the token is not on the command line');
  assert.equal(run.env.token, 'sk-ant-oat-test-token'); assert.equal(run.env.scrub, '1'); assert.equal(run.env.maxTurns, '150');
  assert.deepEqual(run.env.awsVars, []);                                                         // the parent's AWS credentials do not reach it
  delete process.env.AWS_ACCESS_KEY_ID;
});

test('runner: turn limit continues, usage limit waits, plain errors throw', async () => {
  assert.deepEqual((await runClaudeSession(args('max_turns').a)).outcome, { type: 'continue' });
  const lim = (await runClaudeSession(args('rate_limited').a)).outcome as { type: string; retryAfterSeconds: number };
  assert.equal(lim.type, 'rate_limited'); assert.ok(lim.retryAfterSeconds > 800 && lim.retryAfterSeconds <= 900, String(lim.retryAfterSeconds));
  await assert.rejects(runClaudeSession(args('error').a), /something broke/);
});

test('runner: ending without a terminal tool is nudged once through a resumed session, then becomes questions', async () => {
  const n = args('nudge'); const r = await runClaudeSession(n.a);
  assert.deepEqual(r.outcome, { type: 'done', pr: { title: 'After nudge', body: 'ok' } });
  const [first, second] = n.runs();
  assert.ok(!first.args.includes('--resume')); assert.ok(second.args.includes('--resume')); assert.match(second.args[1], /mcp__harness__finish/);
  assert.equal(r.usage.output, 600);                                                              // both runs are counted

  const never = await runClaudeSession(args('never_terminal').a);
  assert.deepEqual(never.outcome, { type: 'questions', markdown: 'Still just talking.' });
});

test('runner: a resumed session uses --resume; the token budget and the timeout stop a runaway run', async () => {
  const r = args('questions', { resume: true }); await runClaudeSession(r.a);
  assert.ok(r.runs()[0].args.includes('--resume') && !r.runs()[0].args.includes('--session-id'));
  const t0 = Date.now();
  const b = await runClaudeSession(args('budget', { tokenBudget: 1_000_000 }).a);
  assert.equal(b.outcome.type, 'budget_exhausted'); assert.ok(Date.now() - t0 < 15_000, 'killed promptly');
  await assert.rejects(runClaudeSession(args('hang', { timeoutMs: 500 }).a), /did not finish/);
});
