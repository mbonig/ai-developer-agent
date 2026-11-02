import type { SessionCost } from '@agent/shared';

export const COST_MARKER = 'agent-cost';

const usd = (n: number) => `$${n < 100 ? n.toFixed(2) : Math.round(n).toLocaleString('en-US')}`;
const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}K` : String(n));

const OUTCOME: Record<string, string> = {
  questions: 'asked questions', done: 'opened the pull request', revised: 'revised after feedback', budget_exhausted: 'stopped at its token budget',
};

/** The PR-description section: running total plus one row per session, covering every session worked on the issue. */
export function renderCostSection(all: SessionCost[], modelId: string): string {
  const sessions = [...all].sort((a, b) => a.seq - b.seq);
  const priced = sessions.filter((s) => s.costUsd !== undefined);
  const total = priced.reduce((n, s) => n + (s.costUsd ?? 0), 0);
  const sum = sessions.reduce((u, s) => ({
    input: u.input + s.usage.input, output: u.output + s.usage.output, cacheRead: u.cacheRead + s.usage.cacheRead, cacheWrite: u.cacheWrite + s.usage.cacheWrite,
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const allPriced = priced.length === sessions.length && sessions.length > 0;

  const rows = sessions.map((s) => `| ${s.seq} | ${s.phase === 'REVIEW' ? 'Review' : 'Implementation'}: ${OUTCOME[s.outcome] ?? s.outcome} | ${s.costUsd === undefined ? 'n/a' : usd(s.costUsd)} |`);
  return [
    `<!-- ${COST_MARKER}:start -->`,
    '### Cost of this change',
    '',
    sessions.length === 0
      ? 'No sessions recorded yet.'
      : `**${allPriced ? usd(total) : `${usd(total)}+ (some sessions could not be priced)`}** in total across ${sessions.length} session${sessions.length === 1 ? '' : 's'}: estimated Amazon Bedrock model usage (\`${modelId}\`) for every session on this issue, including questions, replies to comments, and revisions. It updates after each session.`,
    '',
    '| Session | What happened | Model cost |',
    '|---|---|---|',
    ...rows,
    `| | **Total** | **${allPriced ? usd(total) : `${usd(total)}+`}** |`,
    '',
    `Tokens: ${tokens(sum.input)} input, ${tokens(sum.cacheRead)} cache reads, ${tokens(sum.cacheWrite)} cache writes, ${tokens(sum.output)} output. An estimate from token counts at AWS list prices. It excludes attempts that failed before reporting, and AWS compute and storage, which are small by comparison.`,
    `<!-- ${COST_MARKER}:end -->`,
  ].join('\n');
}
