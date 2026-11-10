import type { SegmentJob } from '@agent/shared';

export interface SegmentHandle { id: string }

/** The orchestrator depends only on this interface (design D2), so a Fargate launcher could be added later. */
export interface SegmentLauncher {
  launch(job: SegmentJob): Promise<SegmentHandle>;
  /** Idempotent: terminating an already-terminated segment succeeds. */
  terminate(handleId: string): Promise<void>;
}
