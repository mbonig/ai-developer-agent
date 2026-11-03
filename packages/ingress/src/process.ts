import {
  verifySignature, routeEvent, issueKey, recordDelivery, createMeta, getMeta, appendMessage, wake,
  resumeAfterExpiry, restartTerminal, requestCancel, getPrLink, setExecution, type Store, type Config,
} from '@agent/shared';

export interface Deps {
  store: Store;
  config: Pick<Config, 'agentLabel' | 'githubOrg' | 'maxTokensPerIssue'>;
  webhookSecret: string;
  /** Starts a durable execution for the issue and returns its ARN. `attempt` makes the execution name unique. */
  startExecution(issueKey: string, attempt: string): Promise<string>;
  /** Completes a durable callback with a payload. */
  sendCallback(callbackId: string, payload: unknown): Promise<void>;
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

    case 'message': {
      const key = await resolveKey(d.store, route);
      if (!key) return res(200, 'untracked');
      const seq = await appendMessage(d.store, key, route.msg);
      if (seq === undefined) return res(200, 'not accepting');
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
