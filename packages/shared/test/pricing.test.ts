import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costUsd, priceFor, addUsage, emptyUsage } from '../src/pricing.ts';

const U = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 };

test('prices match the AWS Price List: regional profiles cost 10% over global, cache reads 5%, writes 125%', () => {
  const eq = (a: number | undefined, b: number) => assert.ok(a !== undefined && Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  eq(costUsd(U, 'us.anthropic.claude-sonnet-5'), 2.2 + 11 + 0.11 + 2.75);
  eq(costUsd(U, 'global.anthropic.claude-sonnet-5-5'), 2.0 + 10 + 0.10 + 2.5);
  eq(costUsd(U, 'us.anthropic.claude-sonnet-5-5'), 2.2 + 11 + 0.11 + 2.75);
  eq(costUsd(U, 'us.anthropic.claude-opus-5-5'), 4.4 + 22 + 0.22 + 5.5);
  eq(costUsd(U, 'global.anthropic.claude-haiku-5-5'), 0.1 + 0.5 + 0.005 + 0.125);
});

test('unverified models have no price rather than a wrong one', () => {
  for (const m of ['us.anthropic.claude-sonnet-4-6', 'us.anthropic.claude-sonnet-5-20260101-v1:0', 'amazon.nova-pro', 'x']) assert.equal(priceFor(m), undefined, m);
});

test('a realistic session: mostly cache reads', () => {
  const c = costUsd({ input: 228, output: 85_702, cacheRead: 17_169_177, cacheWrite: 243_054 }, 'us.anthropic.claude-sonnet-5')!;
  assert.ok(Math.abs(c - 3.50) < 0.02, String(c)); // matches the ~$3.50 computed for the issue #66 run
  assert.deepEqual(addUsage(emptyUsage(), { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }), { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
});
