import type { ModelOverride } from './config.ts';

export const TERMINAL_STATUSES = ['DONE', 'CLOSED', 'FAILED', 'BUDGET_EXHAUSTED'] as const;
export const STATUSES = ['STARTING', 'RUNNING', 'WAITING', 'EXPIRED', ...TERMINAL_STATUSES] as const;
export type Status = (typeof STATUSES)[number];
export type Phase = 'IMPLEMENT' | 'REVIEW';

export function isTerminal(s: Status): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(s);
}

export interface IssueMeta {
  status: Status;
  phase: Phase;
  executionArn?: string;
  callbackId?: string;
  inboxSeq: number;
  consumedSeq: number;
  segmentSeq: number;
  branch: string;
  prNumber?: number;
  /** Which pull request this run is on (1 for the first). Each one gets its own branch. */
  prSeq?: number;
  transcriptKey: string;
  installationId: number;
  tokensUsed: number;
  cancelRequested?: boolean;
  closeReason?: string;
  microvmId?: string;
  segmentCallbackId?: string;
  /** This issue's own backend/model, when the issue text asked for one. Overrides the deployment default for every segment. */
  modelOverride?: ModelOverride;
  updatedAt: string;
}

export type MsgSource = 'issue_comment' | 'pr_comment' | 'review' | 'review_comment';

export interface InboxMessage {
  seq: number;
  source: MsgSource;
  author: string;
  body: string;
  url: string;
  createdAt: string;
  path?: string;
  line?: number;
  diffHunk?: string;
}

export interface SegmentJob {
  issueKey: string;
  owner: string;
  repo: string;
  issueNumber: number;
  installationId: number;
  phase: Phase;
  segmentSeq: number;
  callbackId: string;
  inbox: { fromExclusive: number; toInclusive: number };
  transcriptKey: string;
  branch: string;
  prNumber: number | null;
  tokenBudgetRemaining: number;
  /** This issue's own backend/model, when it asked for one. Overrides the deployment default for this segment. */
  modelOverride?: ModelOverride;
}

export type SegmentOutcome =
  | { type: 'questions'; markdown: string }
  | { type: 'done'; pr: { title: string; body: string } }
  | { type: 'revised'; summaryMarkdown: string }
  | { type: 'budget_exhausted'; summaryMarkdown: string }
  /** The session hit its turn limit with token budget left. The work is saved and the next session simply carries on. */
  | { type: 'continue' }
  /** The Claude subscription's usage window is used up. Wait this long, then carry on. */
  | { type: 'rate_limited'; retryAfterSeconds: number };

export type SegmentResult = SegmentOutcome & {
  tokensUsed: number; headSha: string;
  /** Raw token counts for the whole session (agent, reviewer subagents, compaction), and their estimated cost. */
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd?: number;
  /** 'subscription' when the session ran on a Claude subscription: costUsd is then an API-equivalent value, not money billed per token. */
  billing?: 'bedrock' | 'subscription';
  /** The branch the segment published, when it differs from the issue's default agent branch (factory mode). */
  branch?: string;
};

export const issueKey = (owner: string, repo: string, n: number) => `ISSUE#${owner}/${repo}#${n}`;
/** The branch for the k-th pull request of an issue: agent/issue-<n> for the first, agent/issue-<n>-<k> after that. */
export const agentBranch = (issueNumber: number, k = 1) => (k <= 1 ? `agent/issue-${issueNumber}` : `agent/issue-${issueNumber}-${k}`);
export const prKey = (owner: string, repo: string, n: number) => `PR#${owner}/${repo}#${n}`;
export const msgSk = (seq: number) => `MSG#${String(seq).padStart(10, '0')}`;
