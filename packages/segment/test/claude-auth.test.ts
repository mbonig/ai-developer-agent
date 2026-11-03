import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAuthFailure, ClaudeAuthError } from '../src/claude-code.ts';

test('recognizes authentication failures', () => {
  assert.ok(isAuthFailure({ text: 'Invalid API key · Please run /login' }));
  assert.ok(isAuthFailure({ text: 'x', apiErrorStatus: 401 }));
  assert.ok(isAuthFailure({ text: 'OAuth token has expired' }));
});
test('does not flag ordinary failures', () => {
  assert.ok(!isAuthFailure({ text: 'Tool execution failed', apiErrorStatus: 500 }));
});
test('auth error carries the non-retryable code', () => {
  assert.equal(new ClaudeAuthError('x').code, 'BACKEND_NOT_CONFIGURED');
});

import { handleMcp } from '../src/mcp-server.ts';
test('finish with the wrong fields is rejected, not recorded', () => {
  const r = handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'finish', arguments: { title: 't', body: 'b' } } }, { outcomeFile: '/nonexistent/out.json', phase: 'REVIEW' }) as { result: { isError?: boolean; content: { text: string }[] } };
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /summary/);
});
