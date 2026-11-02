import { randomBytes } from 'node:crypto';
import type { SegmentJob } from '@agent/shared';
import type { SegmentLauncher, SegmentHandle } from './launcher.ts';

/** The slice of the MicroVM control plane that the launcher needs. */
export interface MicrovmApi {
  run(a: {
    imageArn: string; imageVersion: string; executionRoleArn: string; clientToken: string;
    idle: { maxIdleDurationSeconds: number; suspendedDurationSeconds: number; autoResumeEnabled: boolean };
    /** JSON delivered to the run hook: `{ key }`. */
    runHookPayload: string;
    maximumDurationInSeconds: number;
  }): Promise<{ microvmId: string; endpoint: string; state: string }>;
  get(microvmId: string): Promise<{ state: string; endpoint: string }>;
  authToken(microvmId: string, port: number, minutes: number): Promise<string>;
  terminate(microvmId: string): Promise<void>;
}

export interface MicrovmLauncherOptions {
  imageArn: string; imageVersion: string; executionRoleArn: string;
  segmentTimeoutSeconds: number;
  port?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for the VM to reach RUNNING and accept the job. */
  startupTimeoutMs?: number;
}

/** The service returns a bare hostname (no scheme); accept either form. */
export const baseUrl = (endpoint: string) => (/^https?:\/\//.test(endpoint) ? endpoint : `https://${endpoint}`).replace(/\/$/, '');

const TERMINAL = new Set(['TERMINATING', 'TERMINATED']);

export function createMicrovmLauncher(api: MicrovmApi, o: MicrovmLauncherOptions): SegmentLauncher {
  const port = o.port ?? 8080;
  const doFetch = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const startupTimeoutMs = o.startupTimeoutMs ?? 120_000;

  return {
    async launch(job: SegmentJob): Promise<SegmentHandle> {
      // A fresh secret per VM. The agent cannot read it, so it cannot submit jobs to the segment server on its own.
      const key = randomBytes(24).toString('hex');
      const clientToken = randomBytes(24).toString('hex');
      const vm = await api.run({
        imageArn: o.imageArn, imageVersion: o.imageVersion, executionRoleArn: o.executionRoleArn, clientToken,
        // Idle is measured by inbound traffic only, so keep the VM from suspending for the whole segment (design risk 1).
        idle: { maxIdleDurationSeconds: o.segmentTimeoutSeconds, suspendedDurationSeconds: 0, autoResumeEnabled: false },
        maximumDurationInSeconds: Math.min(o.segmentTimeoutSeconds + 900, 28_800),
        runHookPayload: JSON.stringify({ key }),
      });

      try {
        const deadline = Date.now() + startupTimeoutMs;
        let state = vm.state; let endpoint = vm.endpoint;
        while (state !== 'RUNNING') {
          if (TERMINAL.has(state) || Date.now() > deadline) throw new Error(`MicroVM ${vm.microvmId} not running (state ${state})`);
          await sleep(1000);
          ({ state, endpoint } = await api.get(vm.microvmId));
        }

        const token = await api.authToken(vm.microvmId, port, 15);
        for (let attempt = 1; ; attempt++) {
          try {
            const r = await doFetch(`${baseUrl(endpoint)}/segment`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-aws-proxy-auth': token, 'X-aws-proxy-port': String(port), 'X-Segment-Key': key },
              body: JSON.stringify(job),
            });
            if (r.status === 202) break;
            if (r.status < 500) throw new Error(`segment server rejected the job: ${r.status}`);
          } catch (e) {
            if (e instanceof Error && e.message.startsWith('segment server rejected')) throw e;
          }
          if (Date.now() > deadline) throw new Error('segment server did not accept the job in time');
          await sleep(Math.min(500 * attempt, 5000));
        }
      } catch (e) {
        await api.terminate(vm.microvmId).catch(() => {}); // do not leak a VM we could not hand work to
        throw e;
      }
      return { id: vm.microvmId };
    },

    async terminate(id: string): Promise<void> {
      try { await api.terminate(id); } catch (e) {
        const name = (e as { name?: string }).name ?? '';
        if (!/NotFound|ResourceNotFound|Terminat/i.test(name)) throw e; // already gone is success
      }
    },
  };
}
