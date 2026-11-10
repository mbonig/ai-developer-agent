import { listReferencedMicrovms, type Store } from '@agent/shared';

export interface SweeperApi {
  /** All MicroVMs of the segment image that are not already terminating or terminated. */
  listActive(): Promise<Array<{ microvmId: string; startedAt?: Date }>>;
  terminate(microvmId: string): Promise<void>;
}

export interface SweepOptions {
  segmentTimeoutSeconds: number;
  /** A VM younger than this is never swept as unreferenced: the orchestrator records its ID shortly after launch. */
  unreferencedGraceSeconds?: number;
  now?: Date;
}

/** Terminates MicroVMs that exceeded SEGMENT_TIMEOUT + 15 minutes, or that no RUNNING issue references. Returns the IDs terminated. */
export async function sweep(store: Store, api: SweeperApi, o: SweepOptions): Promise<string[]> {
  const now = (o.now ?? new Date()).getTime();
  const grace = (o.unreferencedGraceSeconds ?? 300) * 1000;
  const maxAge = (o.segmentTimeoutSeconds + 15 * 60) * 1000;
  const referenced = await listReferencedMicrovms(store);
  const killed: string[] = [];
  for (const vm of await api.listActive()) {
    const age = vm.startedAt ? now - vm.startedAt.getTime() : Number.POSITIVE_INFINITY;
    const tooOld = age > maxAge;
    const orphan = !referenced.has(vm.microvmId) && age > grace;
    if (tooOld || orphan) { await api.terminate(vm.microvmId); killed.push(vm.microvmId); }
  }
  return killed;
}
