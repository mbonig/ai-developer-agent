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
  transcriptKey: string;
  installationId: number;
  tokensUsed: number;
  cancelRequested?: boolean;
  closeReason?: string;
  microvmId?: string;
  segmentCallbackId?: string;
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
}

export type SegmentOutcome =
  | { type: 'questions'; markdown: string }
  | { type: 'done'; pr: { title: string; body: string } }
  | { type: 'revised'; summaryMarkdown: string }
  | { type: 'budget_exhausted'; summaryMarkdown: string };

export type SegmentResult = SegmentOutcome & {
  tokensUsed: number; headSha: string;
  /** Raw token counts for the whole session (agent, reviewer subagents, compaction), and their estimated cost. */
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd?: number;
  /** The branch the segment published, when it differs from the issue's default agent branch (factory mode). */
  branch?: string;
};

export const issueKey = (owner: string, repo: string, n: number) => `ISSUE#${owner}/${repo}#${n}`;
export const prKey = (owner: string, repo: string, n: number) => `PR#${owner}/${repo}#${n}`;
export const msgSk = (seq: number) => `MSG#${String(seq).padStart(10, '0')}`;
