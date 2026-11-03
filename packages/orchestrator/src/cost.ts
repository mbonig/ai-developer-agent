import type { SessionCost } from '@agent/shared';

export const COST_MARKER = 'agent-cost';

const usd = (n: number) => `$${n < 100 ? n.toFixed(2) : Math.round(n).toLocaleString('en-US')}`;
const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}K` : String(n));

const OUTCOME: Record<string, string> = {
  questions: 'asked questions', done: 'opened the pull request', revised: 'revised after feedback', budget_exhausted: 'stopped at its token budget', continue: 'reached its turn limit and carried on', rate_limited: 'hit the Claude usage limit and waited',
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

  const sub = sessions.filter((s) => s.billing === 'subscription');
  const bedrockSessions = sessions.filter((s) => s.billing !== 'subscription');
  const subValue = sub.reduce((n, s) => n + (s.costUsd ?? 0), 0);
  const bedrockPriced = bedrockSessions.filter((s) => s.costUsd !== undefined);
  const bedrockTotal = bedrockPriced.reduce((n, s) => n + (s.costUsd ?? 0), 0);
  const bedrockAllPriced = bedrockPriced.length === bedrockSessions.length;
  const cell = (s: SessionCost) => s.billing === 'subscription'
    ? `included in the subscription${s.costUsd === undefined ? '' : ` (API-equivalent ${usd(s.costUsd)})`}`
    : s.costUsd === undefined ? 'n/a' : usd(s.costUsd);
  const rows = sessions.map((s) => `| ${s.seq} | ${s.phase === 'REVIEW' ? 'Review' : 'Implementation'}: ${OUTCOME[s.outcome] ?? s.outcome} | ${cell(s)} |`);

  let headline: string; let totalCell: string; let footnote: string;
  if (sessions.length === 0) { headline = 'No sessions recorded yet.'; totalCell = ''; footnote = ''; }
  else if (bedrockSessions.length === 0) {
    headline = `**Included in your Claude subscription:** ${sessions.length} session${sessions.length === 1 ? '' : 's'} on Claude Code, with no per-token billing. Their API-equivalent value is about ${usd(subValue)}, which is what the same usage would cost at API prices. It updates after each session.`;
    totalCell = `included (API-equivalent ${usd(subValue)})`;
    footnote = 'Usage counts against your subscription limits. The API-equivalent value is an estimate reported by Claude Code. It excludes attempts that failed before reporting, and AWS compute and storage, which are small by comparison.';
  } else {
    const money = bedrockAllPriced ? usd(bedrockTotal) : `${usd(bedrockTotal)}+ (some sessions could not be priced)`;
    headline = `**${money}** in total across ${bedrockSessions.length} session${bedrockSessions.length === 1 ? '' : 's'}: estimated Amazon Bedrock model usage (\`${modelId}\`) for every session on this issue, including questions, replies to comments, and revisions.${sub.length ? ` A further ${sub.length} session${sub.length === 1 ? ' was' : 's were'} included in a Claude subscription (API-equivalent about ${usd(subValue)}, not billed per token).` : ''} It updates after each session.`;
    totalCell = `**${bedrockAllPriced ? usd(bedrockTotal) : `${usd(bedrockTotal)}+`}**`;
    footnote = 'An estimate from token counts at AWS list prices. It excludes attempts that failed before reporting, and AWS compute and storage, which are small by comparison.';
  }
  return [
    `<!-- ${COST_MARKER}:start -->`,
    '### Cost of this change',
    '',
    headline,
    '',
    '| Session | What happened | Model cost |',
    '|---|---|---|',
    ...rows,
    `| | **Total** | ${totalCell ? (bedrockSessions.length === 0 ? `**${totalCell}**` : totalCell) : ''} |`,
    '',
    `Tokens: ${tokens(sum.input)} input, ${tokens(sum.cacheRead)} cache reads, ${tokens(sum.cacheWrite)} cache writes, ${tokens(sum.output)} output. ${footnote}`,
    `<!-- ${COST_MARKER}:end -->`,
  ].join('\n');
}
