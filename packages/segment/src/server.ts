import { createServer, type Server } from 'node:http';
import type { SegmentJob } from '@agent/shared';

/** The run hook body is an envelope: `{ microvmId, runHookPayload: "<the string we passed>" }`. A bare `{ key }` is also accepted. */
export function extractKey(body: string): string | undefined {
  const env = JSON.parse(body);
  const inner = typeof env.runHookPayload === 'string' ? JSON.parse(env.runHookPayload) : env;
  return typeof inner?.key === 'string' ? inner.key : undefined;
}

const HOOK_PREFIX = '/aws/lambda-microvms/runtime/v1/';

/**
 * Segment server: POST /segment returns 202 immediately and works in the background.
 * Nothing is initialized at snapshot time: run() builds clients only when a job arrives.
 */
export interface ServerOptions {
  onRunHook?: () => void;
  /**
   * Require the per-segment secret. The orchestrator sends it as the run hook payload (read once, kept in memory) and in the
   * X-Segment-Key header of the job POST. Without it, the agent could POST jobs to this server over loopback.
   */
  requireKey?: boolean;
}

export function createSegmentServer(run: (job: SegmentJob) => Promise<void>, o: ServerOptions = {}): Server {
  const seen = new Set<number>();
  let key: string | undefined;
  return createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    // Image build hooks (ready/validate) and runtime hooks (run/resume/suspend/terminate) only need a 200.
    if (path === `${HOOK_PREFIX}run` || path === `${HOOK_PREFIX}resume`) o.onRunHook?.();
    if (path === `${HOOK_PREFIX}run` && req.method === 'POST' && key === undefined) {
      let b = ''; req.on('data', (d) => { b += d; });
      req.on('end', () => { try { const k = extractKey(b); if (typeof k === 'string' && k.length >= 16 && key === undefined) key = k; } catch { /* no key */ } res.writeHead(200).end('ok'); });
      return;
    }
    if (path.startsWith(HOOK_PREFIX) || (req.method === 'GET' && (path === '/ready' || path === '/validate' || path === '/health'))) { res.writeHead(200).end('ok'); req.resume(); return; }
    if (req.method !== 'POST' || path !== '/segment') { res.writeHead(404).end(); return; }
    if (o.requireKey) {
      if (key === undefined) { res.writeHead(503).end('not ready'); return; }
      if (req.headers['x-segment-key'] !== key) { res.writeHead(403).end('forbidden'); return; }
    }
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 1_000_000) req.destroy(); });
    req.on('end', () => {
      let job: SegmentJob;
      try { job = JSON.parse(body); } catch { res.writeHead(400).end('bad json'); return; }
      if (!job || typeof job.segmentSeq !== 'number' || !job.callbackId || !job.owner || !job.repo) { res.writeHead(400).end('invalid job'); return; }
      res.writeHead(202).end('accepted');
      if (seen.has(job.segmentSeq)) return; // duplicate POST: acknowledge, never start a second loop
      seen.add(job.segmentSeq);
      run(job).catch((e) => console.error(JSON.stringify({ msg: 'segment crashed', error: String(e) })));
    });
  });
}
