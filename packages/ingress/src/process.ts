import {
  verifySignature, routeEvent, issueKey, recordDelivery, createMeta, getMeta, appendMessage, wake,
  resumeAfterExpiry, restartTerminal, requestCancel, unlinkPr, getPrLink, setExecution, type Store, type Config, type Status,
} from '@agent/shared';

export interface Deps {
  store: Store;
  config: Pick<Config, 'agentLabel' | 'githubOrg' | 'maxTokensPerIssue'>;
  webhookSecret: string;
  /** Starts a durable execution for the issue and returns its ARN. `attempt` makes the execution name unique. */
  startExecution(issueKey: string, attempt: string): Promise<string>;
  /** Completes a durable callback with a payload. */
  sendCallback(callbackId: string, payload: unknown): Promise<void>;
  /** Posts an issue or pull request comment. Optional: without it, dropped events are only logged. */
  postComment?(a: { installationId: number; owner: string; repo: string; number: number; body: string }): Promise<void>;
  log(msg: string, extra?: Record<string, unknown>): void;
}

export interface Req { headers: Record<string, string | undefined>; rawBody: string }
export interface Res { status: number; body: string }

const res = (status: number, body: string): Res => ({ status, body });

export async function processWebhook(d: Deps, req: Req): Promise<Res> {
  const h = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]));
  if (!verifySignature(d.webhookSecret, req.rawBody, h['x-hub-signature-256'])) return res(401, 'invalid signature');

  const deliveryId = h['x-github-delivery'];
  const eventName = h['x-github-event'];
  if (!deliveryId || !eventName) return res(400, 'missing headers');
  if (eventName === 'ping') return res(200, 'pong');

  let payload: unknown;
  try { payload = JSON.parse(req.rawBody); } catch { return res(400, 'bad json'); }

  if (!(await recordDelivery(d.store, deliveryId))) return res(200, 'duplicate');

  const route = routeEvent(eventName, payload, d.config.agentLabel, d.config.githubOrg);
  switch (route.kind) {
    case 'ignore':
      d.log('ignored', { deliveryId, reason: route.reason });
      return res(200, 'ignored');

    case 'start': {
      const key = issueKey(route.owner, route.repo, route.issueNumber);
      const created = await createMeta(d.store, key, route);
      if (!created) {
        // A FAILED or CLOSED run is restarted by relabeling. The execution name must be new: Lambda returns a finished execution for a reused name.
        if (await restartTerminal(d.store, key, { maxTokens: d.config.maxTokensPerIssue })) {
          await setExecution(d.store, key, await d.startExecution(key, String(Date.now())));
          d.log('restarted', { key });
          return res(202, 'restarted');
        }
        d.log('start skipped: state exists', { key });
        await explainDropped(d, key, route.owner, route.repo, route.issueNumber, 'relabel');
        return res(200, 'exists');
      }
      await setExecution(d.store, key, await d.startExecution(key, '1'));
      return res(202, 'started');
    }

    case 'cancel': {
      const key = await resolveKey(d.store, route);
      if (!key) return res(200, 'untracked');
      const r = await requestCancel(d.store, key, route.reason);
      if (r.callbackId) await d.sendCallback(r.callbackId, { cancel: true });
      return res(200, r.flagged ? 'cancel requested' : 'not active');
    }

    case 'prFinished': {
      // A merged or closed pull request does not end the run. It only frees the run to open the next one.
      const key = await getPrLink(d.store, route.owner, route.repo, route.prNumber);
      if (!key) return res(200, 'untracked');
      const issueNumber = Number(/#(\d+)$/.exec(key)![1]);
      const unlinked = await unlinkPr(d.store, key, route.owner, route.repo, issueNumber, route.prNumber);
      d.log('pull request finished', { key, prNumber: route.prNumber, merged: route.merged, unlinked });
      return res(200, unlinked ? 'unlinked' : 'not linked');
    }

    case 'message': {
      const key = await resolveKey(d.store, route);
      if (!key) return res(200, 'untracked');
      const seq = await appendMessage(d.store, key, route.msg);
      if (seq === undefined) {
        d.log('comment dropped: run has ended', { key });
        await explainDropped(d, key, route.owner, route.repo, route.issueNumber ?? route.prNumber, 'comment');
        return res(200, 'not accepting');
      }
      const cb = await wake(d.store, key);
      if (cb) { await d.sendCallback(cb, { wake: true }); return res(202, 'woken'); }
      if (await resumeAfterExpiry(d.store, key)) {
        await setExecution(d.store, key, await d.startExecution(key, String(Date.now())));
        d.log('resumed after expiry', { key });
        return res(202, 'resumed');
      }
      return res(202, 'queued');
    }
  }
}

async function resolveKey(
  store: Store, r: { owner: string; repo: string; issueNumber?: number; prNumber?: number },
): Promise<string | undefined> {
  if (r.issueNumber !== undefined) {
    const k = issueKey(r.owner, r.repo, r.issueNumber);
    return (await getMeta(store, k)) ? k : undefined;
  }
  if (r.prNumber !== undefined) return getPrLink(store, r.owner, r.repo, r.prNumber);
  return undefined;
}

const WHY_ENDED: Partial<Record<Status, string>> = {
  DONE: 'This run ended when the issue was closed. To start it again, reopen the issue and apply the `agent` label.',
  CLOSED: 'This run ended when the issue was closed. To start it again, reopen the issue and apply the `agent` label.',
  FAILED: 'This run stopped after an error. Remove the `agent` label and apply it again to start it again.',
  BUDGET_EXHAUSTED: 'This run used up its token budget, so it will not continue.',
};

/** A comment or relabel that reaches an ended run changes nothing. Say so on the issue, so it is not a silent failure. */
async function explainDropped(
  d: Deps, key: string, owner: string, repo: string, target: number | undefined, what: 'comment' | 'relabel',
): Promise<void> {
  if (!d.postComment || target === undefined) return;
  try {
    const meta = await getMeta(d.store, key);
    const why = meta && WHY_ENDED[meta.status];
    if (!meta || !why) return; // an active run: the relabel was a no-op, and there is nothing to explain
    const lead = what === 'comment' ? 'I did not act on your comment.' : 'I did not restart on that label.';
    await d.postComment({ installationId: meta.installationId, owner, repo, number: target, body: `${lead} ${why}` });
  } catch (e) { d.log('could not explain dropped event', { key, error: String((e as Error)?.message ?? e).slice(0, 200) }); }
}
