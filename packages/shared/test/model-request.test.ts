import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseModelRequest } from '../src/model-request.ts';

test('no request: plain text never triggers a guess, even when it names a backend in passing', () => {
  assert.equal(parseModelRequest('This bug is in the bedrock integration code.', 'bedrock').requested, false);
  assert.equal(parseModelRequest('Claude Code is a great tool.', 'bedrock').requested, false);
  assert.equal(parseModelRequest('', 'bedrock').requested, false);
});

test("the issue's own examples: engine and a versioned Anthropic model both resolve silently", () => {
  assert.deepEqual(parseModelRequest('Please use claude and sonnet 5.5 for this.', 'bedrock').resolved, { backend: 'claude-code', modelId: 'claude-sonnet-5-5' });
  assert.deepEqual(parseModelRequest('use claude and opus 5.5', 'bedrock').resolved, { backend: 'claude-code', modelId: 'claude-opus-5-5' });
  assert.deepEqual(parseModelRequest('use bedrock and sonnet 5.5', 'claude-code').resolved, { backend: 'bedrock', modelId: 'us.anthropic.claude-sonnet-5-5' });
});

test('"use bedrock and kimi k3": the backend is clear, but there is no verified id for a non-Anthropic model, so it asks', () => {
  const r = parseModelRequest('use bedrock and kimi k3', 'claude-code');
  assert.equal(r.requested, true);
  assert.equal(r.resolved, undefined);
  assert.deepEqual(r.clarification?.bestGuess, { backend: 'bedrock' });
  assert.match(r.clarification!.markdown, /kimi.*not an Anthropic model/i);
});

test('engine only (no model mentioned) resolves to a plain backend switch', () => {
  assert.deepEqual(parseModelRequest('switch to bedrock', 'claude-code').resolved, { backend: 'bedrock' });
  assert.deepEqual(parseModelRequest('please use claude code for this one', 'bedrock').resolved, { backend: 'claude-code' });
});

test('a model family alone, with no backend named, is ambiguous: best guess uses the current backend', () => {
  const r = parseModelRequest('use sonnet 5.5', 'claude-code');
  assert.equal(r.resolved, undefined);
  assert.deepEqual(r.clarification?.bestGuess, { backend: 'claude-code', modelId: 'claude-sonnet-5-5' });
  assert.match(r.clarification!.markdown, /Claude Code or Amazon Bedrock/);
});

test('a model family with no version is ambiguous even with a backend named', () => {
  const r = parseModelRequest('use claude and opus', 'bedrock');
  assert.equal(r.resolved, undefined);
  assert.deepEqual(r.clarification?.bestGuess, { backend: 'claude-code' });
  assert.match(r.clarification!.markdown, /which version/i);
});

test('a literal model id in backticks is used as-is when a backend is also named', () => {
  const r = parseModelRequest('use bedrock model `us.anthropic.claude-sonnet-9`', 'claude-code');
  assert.deepEqual(r.resolved, { backend: 'bedrock', modelId: 'us.anthropic.claude-sonnet-9' });
});

test('a literal model id without a backend is ambiguous, with the literal as the best guess', () => {
  const r = parseModelRequest('use `moonshotai.kimi-k3-v1:0`', 'bedrock');
  assert.equal(r.resolved, undefined);
  assert.deepEqual(r.clarification?.bestGuess, { backend: 'bedrock', modelId: 'moonshotai.kimi-k3-v1:0' });
});

test('a directive with nothing recognizable in it is left alone rather than guessed at', () => {
  assert.equal(parseModelRequest('use the fastest option available', 'bedrock').requested, false);
});

test('"claude" written as part of a model name (claude-sonnet, claude opus) is not read as the engine', () => {
  const bare = parseModelRequest('use claude-sonnet-5-5', 'bedrock'); // unspecified engine: ambiguous, not resolved
  assert.equal(bare.resolved, undefined);
  assert.deepEqual(bare.clarification?.bestGuess, { backend: 'bedrock', modelId: 'us.anthropic.claude-sonnet-5-5' });
  const r = parseModelRequest('use claude opus 5.5', 'bedrock');
  assert.equal(r.resolved, undefined); // ambiguous: "claude opus" names a model, not Claude Code
});

test('an override never carries an explicit `modelId: undefined` (DynamoDB rejects it; the key must simply be absent)', () => {
  const r = parseModelRequest('use bedrock and kimi k3', 'claude-code');
  assert.ok(!('modelId' in r.clarification!.bestGuess));
  const e = parseModelRequest('switch to bedrock', 'claude-code');
  assert.ok(!('modelId' in e.resolved!));
});
