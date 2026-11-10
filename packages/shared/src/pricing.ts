export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number }

export const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
export const addUsage = (a: Usage, b: Usage): Usage => ({
  input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite,
});

// USD per million tokens at global-profile prices, from the AWS Price List for Amazon Bedrock (Claude, US West (Oregon)).
// Cache reads cost 5% of input, 5-minute cache writes 125%. US/regional profiles cost 10% more than global ones.
// Only models whose prices were verified are listed. Anything else is reported without a dollar figure.
const BASE: Array<{ match: RegExp; input: number; output: number }> = [
  { match: /claude-sonnet-5(-5)?(?![\d-])/, input: 2.0, output: 10.0 },
  { match: /claude-opus-5-5/, input: 4.0, output: 20.0 },
  { match: /claude-haiku-5-5/, input: 0.1, output: 0.5 },
];

export function priceFor(modelId: string): { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined {
  const base = BASE.find((b) => b.match.test(modelId));
  if (!base) return undefined;
  const k = modelId.startsWith('global.') ? 1 : 1.1;
  return { input: base.input * k, output: base.output * k, cacheRead: base.input * 0.05 * k, cacheWrite: base.input * 1.25 * k };
}

/** Estimated Bedrock model cost in USD, or undefined when the model's price is not known. */
export function costUsd(u: Usage, modelId: string): number | undefined {
  const p = priceFor(modelId);
  if (!p) return undefined;
  return (u.input * p.input + u.output * p.output + u.cacheRead * p.cacheRead + u.cacheWrite * p.cacheWrite) / 1_000_000;
}

/** Budget tokens: input + output + cache writes, with cache reads at their ~10% cost weight. */
export const weightedTokens = (u: Usage): number => u.input + u.output + u.cacheWrite + Math.ceil(u.cacheRead * 0.1);
