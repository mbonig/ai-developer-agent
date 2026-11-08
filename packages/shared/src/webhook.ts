import { createHmac, timingSafeEqual } from 'node:crypto';
import type { MsgSource } from './types.ts';

export function verifySignature(secret: string, rawBody: string | Buffer, header: string | undefined): boolean {
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(header.slice('sha256='.length), 'hex');
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

const AUTHORIZED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export const isAuthorizedAssociation = (a: string | undefined): boolean => !!a && AUTHORIZED.has(a);

export type Route =
  | { kind: 'ignore'; reason: string }
  | { kind: 'start'; owner: string; repo: string; issueNumber: number; installationId: number }
  /** The issue closed: the only event that ends a run. */
  | { kind: 'cancel'; owner: string; repo: string; issueNumber: number; reason: string }
  /** A pull request was merged or closed. The run carries on; the PR is just unlinked so the next one can start. */
  | { kind: 'prFinished'; owner: string; repo: string; prNumber: number; merged: boolean }
  | {
      kind: 'message';
      owner: string;
      repo: string;
      issueNumber?: number; // set when the target is an issue
      prNumber?: number; // set when the target is a PR (needs LINK lookup)
      msg: {
        source: MsgSource; author: string; body: string; url: string; createdAt: string;
        path?: string; line?: number; diffHunk?: string;
      };
    };

/* eslint-disable @typescript-eslint/no-explicit-any */
export function routeEvent(eventName: string, p: any, agentLabel: string, allowedOrg?: string): Route {
  if (p?.sender?.type === 'Bot') return { kind: 'ignore', reason: 'bot sender' };
  const [owner, repo] = String(p?.repository?.full_name ?? '/').split('/');
  if (!owner || !repo) return { kind: 'ignore', reason: 'no repository' };
  if (allowedOrg && owner.toLowerCase() !== allowedOrg.toLowerCase()) return { kind: 'ignore', reason: `owner ${owner} not allowed` };
  const authorOk = (assoc: string | undefined) => isAuthorizedAssociation(assoc);

  switch (`${eventName}.${p.action}`) {
    case 'issues.labeled':
      if (p.label?.name !== agentLabel) return { kind: 'ignore', reason: 'other label' };
      return { kind: 'start', owner, repo, issueNumber: p.issue.number, installationId: p.installation?.id };
    case 'issues.closed':
      return { kind: 'cancel', owner, repo, issueNumber: p.issue.number, reason: 'issue closed' };
    case 'pull_request.closed':
      return { kind: 'prFinished', owner, repo, prNumber: p.pull_request.number, merged: !!p.pull_request.merged };
    case 'issue_comment.created': {
      const c = p.comment;
      if (!authorOk(c?.author_association)) return { kind: 'ignore', reason: `unauthorized author ${c?.user?.login}` };
      const isPr = !!p.issue?.pull_request;
      return {
        kind: 'message', owner, repo,
        ...(isPr ? { prNumber: p.issue.number } : { issueNumber: p.issue.number }),
        msg: { source: isPr ? 'pr_comment' : 'issue_comment', author: c.user.login, body: c.body ?? '', url: c.html_url, createdAt: c.created_at },
      };
    }
    case 'pull_request_review.submitted': {
      const r = p.review;
      if (!r?.body?.trim()) return { kind: 'ignore', reason: 'empty review body' };
      if (!authorOk(r.author_association)) return { kind: 'ignore', reason: `unauthorized author ${r.user?.login}` };
      return {
        kind: 'message', owner, repo, prNumber: p.pull_request.number,
        msg: { source: 'review', author: r.user.login, body: r.body, url: r.html_url, createdAt: r.submitted_at },
      };
    }
    case 'pull_request_review_comment.created': {
      const c = p.comment;
      if (!authorOk(c?.author_association)) return { kind: 'ignore', reason: `unauthorized author ${c?.user?.login}` };
      return {
        kind: 'message', owner, repo, prNumber: p.pull_request.number,
        msg: {
          source: 'review_comment', author: c.user.login, body: c.body ?? '', url: c.html_url, createdAt: c.created_at,
          path: c.path, line: c.line ?? c.original_line, diffHunk: c.diff_hunk,
        },
      };
    }
    default:
      return { kind: 'ignore', reason: `unhandled ${eventName}.${p.action}` };
  }
}
