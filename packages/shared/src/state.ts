import {
  DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, TransactWriteCommand, QueryCommand, ScanCommand, DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { TERMINAL_STATUSES, agentBranch, msgSk, prKey, type IssueMeta, type InboxMessage, type Status } from './types.ts';

export interface Store { doc: DynamoDBDocumentClient; table: string }

const now = () => new Date().toISOString();
const isCondFail = (e: unknown) => (e as { name?: string })?.name === 'ConditionalCheckFailedException';
const TERMINAL_VALUES = Object.fromEntries(TERMINAL_STATUSES.map((s, i) => [`:t${i}`, s]));
const NOT_TERMINAL = `NOT (#status IN (${Object.keys(TERMINAL_VALUES).join(',')}))`;

export async function getMeta(s: Store, pk: string): Promise<IssueMeta | undefined> {
  const r = await s.doc.send(new GetCommand({ TableName: s.table, Key: { PK: pk, SK: 'META' }, ConsistentRead: true }));
  return r.Item as IssueMeta | undefined;
}

/** Conditional create. Returns false if a META already exists (a concurrent start won). */
export async function createMeta(
  s: Store, pk: string, init: { owner: string; repo: string; issueNumber: number; installationId: number },
): Promise<boolean> {
  const meta = {
    PK: pk, SK: 'META', status: 'STARTING', phase: 'IMPLEMENT', inboxSeq: 0, consumedSeq: 0, segmentSeq: 0, tokensUsed: 0,
    branch: agentBranch(init.issueNumber),
    transcriptKey: `transcripts/${init.owner}/${init.repo}/${init.issueNumber}.json`,
    installationId: init.installationId, updatedAt: now(),
  };
  try {
    await s.doc.send(new PutCommand({ TableName: s.table, Item: meta, ConditionExpression: 'attribute_not_exists(PK)' }));
    return true;
  } catch (e) { if (isCondFail(e)) return false; throw e; }
}

export async function setExecution(s: Store, pk: string, executionArn: string): Promise<void> {
  await s.doc.send(new UpdateCommand({
    TableName: s.table, Key: { PK: pk, SK: 'META' },
    UpdateExpression: 'SET executionArn = :a, updatedAt = :u',
    ExpressionAttributeValues: { ':a': executionArn, ':u': now() },
  }));
}

/** Append a message; seq equals the new inboxSeq. Returns the seq, or undefined if the issue is terminal/missing. */
export async function appendMessage(
  s: Store, pk: string, msg: Omit<InboxMessage, 'seq'>, maxRetries = 20,
): Promise<number | undefined> {
  for (let i = 0; i < maxRetries; i++) {
    const meta = await getMeta(s, pk);
    if (!meta || (TERMINAL_STATUSES as readonly string[]).includes(meta.status)) return undefined;
    const seq = meta.inboxSeq + 1;
    try {
      await s.doc.send(new TransactWriteCommand({
        TransactItems: [
          { Update: {
            TableName: s.table, Key: { PK: pk, SK: 'META' },
            UpdateExpression: 'SET inboxSeq = :n, updatedAt = :u',
            ConditionExpression: `inboxSeq = :cur AND ${NOT_TERMINAL}`,
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':n': seq, ':cur': meta.inboxSeq, ':u': now(), ...TERMINAL_VALUES },
          } },
          { Put: {
            TableName: s.table, Item: { PK: pk, SK: msgSk(seq), ...msg, seq },
            ConditionExpression: 'attribute_not_exists(PK)',
          } },
        ],
      }));
      return seq;
    } catch (e) {
      const n = (e as { name?: string }).name;
      if (n === 'TransactionCanceledException' || n === 'TransactionConflictException') continue; // lost a race: re-read and retry
      throw e;
    }
  }
  throw new Error('appendMessage: too much contention');
}

/** RUNNING -> WAITING, only if nothing is unread. */
export async function park(s: Store, pk: string, callbackId: string): Promise<boolean> {
  try {
    await s.doc.send(new UpdateCommand({
      TableName: s.table, Key: { PK: pk, SK: 'META' },
      UpdateExpression: 'SET #status = :w, callbackId = :c, updatedAt = :u',
      ConditionExpression: '#status = :r AND inboxSeq = consumedSeq',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':w': 'WAITING', ':r': 'RUNNING', ':c': callbackId, ':u': now() },
    }));
    return true;
  } catch (e) { if (isCondFail(e)) return false; throw e; }
}

/** WAITING -> RUNNING. Returns the prior callbackId only to the winner. */
export async function wake(s: Store, pk: string): Promise<string | undefined> {
  try {
    const r = await s.doc.send(new UpdateCommand({
      TableName: s.table, Key: { PK: pk, SK: 'META' },
      UpdateExpression: 'SET #status = :r, updatedAt = :u REMOVE callbackId',
      ConditionExpression: '#status = :w',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':r': 'RUNNING', ':w': 'WAITING', ':u': now() },
      ReturnValues: 'ALL_OLD',
    }));
    return (r.Attributes as IssueMeta | undefined)?.callbackId;
  } catch (e) { if (isCondFail(e)) return undefined; throw e; }
}

/** EXPIRED -> STARTING. Returns true for the single winner. */
export async function resumeAfterExpiry(s: Store, pk: string): Promise<boolean> {
  try {
    await s.doc.send(new UpdateCommand({
      TableName: s.table, Key: { PK: pk, SK: 'META' },
      UpdateExpression: 'SET #status = :s, updatedAt = :u',
      ConditionExpression: '#status = :e',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':s': 'STARTING', ':e': 'EXPIRED', ':u': now() },
    }));
    return true;
  } catch (e) { if (isCondFail(e)) return false; throw e; }
}

/** Flag cancellation on a non-terminal issue. If WAITING, also wakes it and returns the callbackId to complete. */
export async function requestCancel(s: Store, pk: string, reason: string): Promise<{ flagged: boolean; callbackId?: string }> {
  try {
    await s.doc.send(new UpdateCommand({
      TableName: s.table, Key: { PK: pk, SK: 'META' },
      UpdateExpression: 'SET cancelRequested = :t, closeReason = if_not_exists(closeReason, :r), updatedAt = :u',
      ConditionExpression: `attribute_exists(PK) AND ${NOT_TERMINAL}`,
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':t': true, ':r': reason, ':u': now(), ...TERMINAL_VALUES },
    }));
  } catch (e) { if (isCondFail(e)) return { flagged: false }; throw e; }
  return { flagged: true, callbackId: await wake(s, pk) };
}

export async function consume(s: Store, pk: string, claimedSeq: number): Promise<void> {
  await s.doc.send(new UpdateCommand({
    TableName: s.table, Key: { PK: pk, SK: 'META' },
    UpdateExpression: 'SET consumedSeq = :c, updatedAt = :u',
    ConditionExpression: 'consumedSeq <= :c',
    ExpressionAttributeValues: { ':c': claimedSeq, ':u': now() },
  }));
}

export async function linkPr(s: Store, issuePk: string, owner: string, repo: string, prNumber: number): Promise<void> {
  await s.doc.send(new PutCommand({ TableName: s.table, Item: { PK: prKey(owner, repo, prNumber), SK: 'LINK', issueKey: issuePk } }));
  await s.doc.send(new UpdateCommand({
    TableName: s.table, Key: { PK: issuePk, SK: 'META' },
    UpdateExpression: 'SET prNumber = :p, updatedAt = :u',
    ExpressionAttributeValues: { ':p': prNumber, ':u': now() },
  }));
}

/**
 * A pull request was merged or closed. If it is the one this run is linked to, unlink it and go back to implementing,
 * on a fresh branch, so the next pull request starts clean. The run itself carries on. Returns true when it unlinked.
 */
export async function unlinkPr(s: Store, issuePk: string, owner: string, repo: string, issueNumber: number, prNumber: number): Promise<boolean> {
  const meta = await getMeta(s, issuePk);
  if (!meta || meta.prNumber !== prNumber) return false;
  const nextSeq = (meta.prSeq ?? 1) + 1;
  try {
    await s.doc.send(new UpdateCommand({
      TableName: s.table, Key: { PK: issuePk, SK: 'META' },
      UpdateExpression: 'SET phase = :p, prSeq = :k, branch = :b, updatedAt = :u REMOVE prNumber',
      ConditionExpression: 'prNumber = :n',
      ExpressionAttributeValues: { ':p': 'IMPLEMENT', ':k': nextSeq, ':b': agentBranch(issueNumber, nextSeq), ':n': prNumber, ':u': now() },
    }));
  } catch (e) { if (isCondFail(e)) return false; throw e; } // a duplicate delivery got there first
  await s.doc.send(new DeleteCommand({ TableName: s.table, Key: { PK: prKey(owner, repo, prNumber), SK: 'LINK' } }));
  return true;
}

export async function getPrLink(s: Store, owner: string, repo: string, prNumber: number): Promise<string | undefined> {
  const r = await s.doc.send(new GetCommand({ TableName: s.table, Key: { PK: prKey(owner, repo, prNumber), SK: 'LINK' } }));
  return r.Item?.issueKey as string | undefined;
}

/** Returns true the first time a delivery ID is seen. */
export async function recordDelivery(s: Store, deliveryId: string, ttlHours = 48): Promise<boolean> {
  try {
    await s.doc.send(new PutCommand({
      TableName: s.table,
      Item: { PK: `DELIVERY#${deliveryId}`, SK: 'DELIVERY', ttl: Math.floor(Date.now() / 1000) + ttlHours * 3600 },
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
    return true;
  } catch (e) { if (isCondFail(e)) return false; throw e; }
}

/** STARTING -> RUNNING (no-op if already RUNNING). */
export async function markRunning(s: Store, pk: string): Promise<boolean> {
  try {
    await s.doc.send(new UpdateCommand({
      TableName: s.table, Key: { PK: pk, SK: 'META' },
      UpdateExpression: 'SET #status = :r, updatedAt = :u',
      ConditionExpression: '#status IN (:s, :r)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':r': 'RUNNING', ':s': 'STARTING', ':u': now() },
    }));
    return true;
  } catch (e) { if (isCondFail(e)) return false; throw e; }
}

/** Increments segmentSeq and returns the new value. Call inside a checkpointed step. */
export async function beginSegment(s: Store, pk: string): Promise<number> {
  const r = await s.doc.send(new UpdateCommand({
    TableName: s.table, Key: { PK: pk, SK: 'META' },
    UpdateExpression: 'SET segmentSeq = segmentSeq + :one, updatedAt = :u',
    ExpressionAttributeValues: { ':one': 1, ':u': now() },
    ReturnValues: 'UPDATED_NEW',
  }));
  return r.Attributes!.segmentSeq as number;
}

export async function setMicrovm(s: Store, pk: string, v: { microvmId?: string; segmentCallbackId?: string }): Promise<void> {
  const sets: string[] = ['updatedAt = :u']; const removes: string[] = [];
  const vals: Record<string, unknown> = { ':u': now() };
  for (const k of ['microvmId', 'segmentCallbackId'] as const) {
    if (v[k] === undefined) removes.push(k); else { sets.push(`${k} = :${k}`); vals[`:${k}`] = v[k]; }
  }
  await s.doc.send(new UpdateCommand({
    TableName: s.table, Key: { PK: pk, SK: 'META' },
    UpdateExpression: `SET ${sets.join(', ')}${removes.length ? ' REMOVE ' + removes.join(', ') : ''}`,
    ExpressionAttributeValues: vals,
  }));
}

export async function addTokens(s: Store, pk: string, n: number): Promise<void> {
  await s.doc.send(new UpdateCommand({
    TableName: s.table, Key: { PK: pk, SK: 'META' },
    UpdateExpression: 'SET tokensUsed = tokensUsed + :n, updatedAt = :u',
    ExpressionAttributeValues: { ':n': n, ':u': now() },
  }));
}

export async function setPhase(s: Store, pk: string, phase: 'IMPLEMENT' | 'REVIEW'): Promise<void> {
  await s.doc.send(new UpdateCommand({
    TableName: s.table, Key: { PK: pk, SK: 'META' },
    UpdateExpression: 'SET phase = :p, updatedAt = :u', ExpressionAttributeValues: { ':p': phase, ':u': now() },
  }));
}

/** Move to a final status and clear transient run fields. */
export async function finish(s: Store, pk: string, status: Status, closeReason?: string): Promise<void> {
  await s.doc.send(new UpdateCommand({
    TableName: s.table, Key: { PK: pk, SK: 'META' },
    UpdateExpression: closeReason
      ? 'SET #status = :s, closeReason = :r, updatedAt = :u REMOVE callbackId, microvmId, segmentCallbackId'
      : 'SET #status = :s, updatedAt = :u REMOVE callbackId, microvmId, segmentCallbackId',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':s': status, ':u': now(), ...(closeReason ? { ':r': closeReason } : {}) },
  }));
}

/** WAITING -> EXPIRED. False if a wake got there first. */
export async function expire(s: Store, pk: string): Promise<boolean> {
  try {
    await s.doc.send(new UpdateCommand({
      TableName: s.table, Key: { PK: pk, SK: 'META' },
      UpdateExpression: 'SET #status = :e, updatedAt = :u REMOVE callbackId',
      ConditionExpression: '#status = :w',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':e': 'EXPIRED', ':w': 'WAITING', ':u': now() },
    }));
    return true;
  } catch (e) { if (isCondFail(e)) return false; throw e; }
}

/** Messages in the half-open range (fromExclusive, toInclusive]. */
export async function listMessages(s: Store, pk: string, fromExclusive: number, toInclusive: number): Promise<InboxMessage[]> {
  if (toInclusive <= fromExclusive) return [];
  const r = await s.doc.send(new QueryCommand({
    TableName: s.table, ConsistentRead: true,
    KeyConditionExpression: 'PK = :p AND SK BETWEEN :a AND :b',
    ExpressionAttributeValues: { ':p': pk, ':a': msgSk(fromExclusive + 1), ':b': msgSk(toInclusive) },
  }));
  return (r.Items ?? []) as InboxMessage[];
}

/** MicroVM IDs that RUNNING issues point at. The table only has META items with a microvmId while a segment runs. */
export async function listReferencedMicrovms(s: Store): Promise<Set<string>> {
  const ids = new Set<string>();
  let key: Record<string, unknown> | undefined;
  do {
    const r = await s.doc.send(new ScanCommand({
      TableName: s.table, ExclusiveStartKey: key, ConsistentRead: true,
      FilterExpression: 'SK = :m AND attribute_exists(microvmId) AND #status = :r',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':m': 'META', ':r': 'RUNNING' },
    }));
    for (const i of r.Items ?? []) ids.add(i.microvmId as string);
    key = r.LastEvaluatedKey;
  } while (key);
  return ids;
}

/**
 * Relabeling an issue whose run FAILED, was CLOSED, or is DONE (the issue was closed) starts it again (no active run). BUDGET_EXHAUSTED restarts only while tokens remain under the cap.
 * Returns true for the single winner. Inbox, branch, PR link and transcript are kept so the new run resumes the work.
 */
export async function restartTerminal(s: Store, pk: string, opts: { maxTokens?: number } = {}): Promise<boolean> {
  const exhaustedOk = opts.maxTokens !== undefined && opts.maxTokens > 0;
  try {
    await s.doc.send(new UpdateCommand({
      TableName: s.table, Key: { PK: pk, SK: 'META' },
      UpdateExpression: 'SET #status = :s, updatedAt = :u REMOVE cancelRequested, closeReason, callbackId, microvmId, segmentCallbackId',
      // BUDGET_EXHAUSTED is restartable only while token budget remains (it also covers runs that stopped for other reasons).
      ConditionExpression: exhaustedOk ? '#status IN (:f, :c, :d) OR (#status = :b AND tokensUsed < :cap)' : '#status IN (:f, :c, :d)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':s': 'STARTING', ':f': 'FAILED', ':c': 'CLOSED', ':d': 'DONE', ':u': now(), ...(exhaustedOk ? { ':b': 'BUDGET_EXHAUSTED', ':cap': opts.maxTokens } : {}) },
    }));
    return true;
  } catch (e) { if (isCondFail(e)) return false; throw e; }
}

export async function setBranch(s: Store, pk: string, branch: string): Promise<void> {
  await s.doc.send(new UpdateCommand({
    TableName: s.table, Key: { PK: pk, SK: 'META' },
    UpdateExpression: 'SET branch = :b, updatedAt = :u', ExpressionAttributeValues: { ':b': branch, ':u': now() },
  }));
}

export interface SessionCost {
  seq: number; phase: string; outcome: string; costUsd?: number;
  /** 'subscription' when the session ran on a Claude subscription (costUsd is then an API-equivalent value). */
  billing?: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/** One item per session, keyed by segment number, so a replay overwrites rather than double counts. */
export async function recordSessionCost(s: Store, pk: string, c: SessionCost): Promise<void> {
  await s.doc.send(new PutCommand({ TableName: s.table, Item: { PK: pk, SK: `COST#${String(c.seq).padStart(10, '0')}`, ...c, ...(c.costUsd === undefined ? {} : { costUsd: c.costUsd }), ...(c.billing ? { billing: c.billing } : {}), recordedAt: now() } }));
}

export async function listSessionCosts(s: Store, pk: string): Promise<SessionCost[]> {
  const r = await s.doc.send(new QueryCommand({
    TableName: s.table, ConsistentRead: true,
    KeyConditionExpression: 'PK = :p AND begins_with(SK, :c)', ExpressionAttributeValues: { ':p': pk, ':c': 'COST#' },
  }));
  return (r.Items ?? []) as SessionCost[];
}
