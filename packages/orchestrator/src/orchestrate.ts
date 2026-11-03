import { CallbackTimeoutError, type DurableContext } from '@aws/durable-execution-sdk-js';
import {
  getMeta, markRunning, beginSegment, setMicrovm, addTokens, consume, park, expire, finish, linkPr, setPhase, setBranch, recordSessionCost, listSessionCosts, emptyUsage,
  type Store, type Config, type SegmentJob, type SegmentResult, type IssueMeta,
} from '@agent/shared';
import type { SegmentLauncher } from './launcher.ts';
import type { GithubApi } from './github.ts';
import { COST_MARKER, renderCostSection } from './cost.ts';

export type Ctx = Pick<DurableContext, 'step' | 'wait' | 'createCallback' | 'waitForCallback'>;

export interface OrchDeps {
  store: Store;
  config: Config;
  launcher: SegmentLauncher;
  github: GithubApi;
  /** Completes one of our own durable callbacks. */
  sendCallback(callbackId: string, payload: unknown): Promise<void>;
  /** Optional structured logging. The durable history truncates errors, so failures are logged here. */
  log?(msg: string, extra?: Record<string, unknown>): void;
}

/** Sessions in a row that may end at the turn limit before the agent stops to tell people where it is. Tokens remain the real limit. */
const MAX_AUTO_CONTINUES = 6;
/** Usage-limit waits in a row before the agent stops to tell people. Each wait lasts until the limit resets (capped at 6 hours). */
const MAX_LIMIT_WAITS = 8;
const MAX_LIMIT_WAIT_SECONDS = 6 * 3600;

const parseKey = (k: string) => {
  const m = /^ISSUE#([^/]+)\/([^#]+)#(\d+)$/.exec(k);
  if (!m) throw new Error(`bad issue key ${k}`);
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
};

const parsePayload = <T>(x: unknown): T => (typeof x === 'string' ? JSON.parse(x) : x) as T;

export async function orchestrate(ctx: Ctx, input: { issueKey: string }, d: OrchDeps): Promise<{ status: string }> {
  const { store, config: c } = d;
  const key = input.issueKey;
  const { owner, repo, number: issueNumber } = parseKey(key);

  const comment = (name: string, meta: IssueMeta, target: number, body: string, marker: string) =>
    ctx.step(name, () => d.github.postComment({ installationId: meta.installationId, owner, repo, number: target, body, marker: `${key}:${marker}` }));

  const finalizeCancel = async (iter: number, meta: IssueMeta) => {
    const status = meta.closeReason === 'merged' ? 'DONE' : 'CLOSED';
    await ctx.step(`finish-cancel-${iter}`, () => finish(store, key, status, meta.closeReason));
    return { status };
  };

  let continues = 0; let limitWaits = 0;
  for (let iter = 1; ; iter++) {
    const meta = (await ctx.step(`load-${iter}`, () => getMeta(store, key)))!;
    if (!meta) throw new Error(`no state for ${key}`);
    if (meta.cancelRequested) return finalizeCancel(iter, meta);
    await ctx.step(`running-${iter}`, () => markRunning(store, key));

    // Budget check before each segment (5.8).
    if (meta.tokensUsed >= c.maxTokensPerIssue) {
      await comment(`budget-comment-${iter}`, meta, meta.prNumber ?? issueNumber,
        `I have used my token budget for this issue (${meta.tokensUsed} of ${c.maxTokensPerIssue}) and will stop here.`, `budget:${meta.segmentSeq}`);
      await ctx.step(`finish-budget-${iter}`, () => finish(store, key, 'BUDGET_EXHAUSTED'));
      return { status: 'BUDGET_EXHAUSTED' };
    }

    // Say so when a run begins, so people are not left wondering: the first session is silent until it has questions or a pull request.
    if (iter === 1) {
      const resumed = meta.segmentSeq > 0;
      await ctx.step('started-comment', async () => {
        try {
          await d.github.postComment({
            installationId: meta.installationId, owner, repo, number: meta.prNumber ?? issueNumber, marker: `${key}:start:${meta.segmentSeq}`,
            body: resumed
              ? 'I am picking this back up now. I will comment here when I have questions, an update, or a pull request.'
              : 'I have started working on this. I will comment here when I have questions or a pull request. A session often takes 20 to 45 minutes, so it may be quiet until then.',
          });
        } catch (e) { d.log?.('started comment failed', { issueKey: key, error: String((e as Error)?.message ?? e).slice(0, 200) }); } // never let this block the work
      });
    }

    const claimed = await ctx.step(`claim-${iter}`, async () => (await getMeta(store, key))!.inboxSeq);
    const segmentSeq = await ctx.step(`begin-${iter}`, () => beginSegment(store, key));
    const target = meta.prNumber ?? issueNumber;

    // Run the segment, retrying up to SEGMENT_MAX_ATTEMPTS (5.5).
    let result: SegmentResult | undefined;
    let lastError = 'unknown error';
    for (let attempt = 1; attempt <= c.segmentMaxAttempts && !result; attempt++) {
      try {
        const raw = await ctx.waitForCallback<string>(
          `segment-${iter}-${attempt}`,
          async (callbackId) => {
            const job: SegmentJob = {
              issueKey: key, owner, repo, issueNumber, installationId: meta.installationId, phase: meta.phase,
              segmentSeq, callbackId, inbox: { fromExclusive: meta.consumedSeq, toInclusive: claimed },
              transcriptKey: meta.transcriptKey, branch: meta.branch, prNumber: meta.prNumber ?? null,
              tokenBudgetRemaining: c.maxTokensPerIssue - meta.tokensUsed,
            };
            const h = await d.launcher.launch(job);
            await setMicrovm(store, key, { microvmId: h.id, segmentCallbackId: callbackId });
          },
          { timeout: { seconds: c.segmentTimeoutSeconds } },
        );
        result = parsePayload<SegmentResult>(raw);
      } catch (e) {
        lastError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        d.log?.('segment attempt failed', { issueKey: key, segmentSeq, attempt, error: lastError.slice(0, 500) });
      } finally {
        // Always terminate before any retry launches.
        await ctx.step(`terminate-${iter}-${attempt}`, async () => {
          const m = await getMeta(store, key);
          if (m?.microvmId) await d.launcher.terminate(m.microvmId);
          await setMicrovm(store, key, {});
        });
      }
    }

    if (!result) {
      d.log?.('segment failed', { issueKey: key, segmentSeq, attempts: c.segmentMaxAttempts, error: lastError });
      await comment(`fail-comment-${iter}`, meta, target,
        `I hit an error and could not continue after ${c.segmentMaxAttempts} attempts: \`${lastError.slice(0, 300)}\``, `${segmentSeq}:failed`);
      await ctx.step(`finish-failed-${iter}`, () => finish(store, key, 'FAILED'));
      return { status: 'FAILED' };
    }

    const r = result;
    await ctx.step(`account-${iter}`, async () => {
      await addTokens(store, key, r.tokensUsed ?? 0); await consume(store, key, claimed);
      await recordSessionCost(store, key, { seq: segmentSeq, phase: meta.phase, outcome: r.type, usage: r.usage ?? emptyUsage(), ...(r.costUsd === undefined ? {} : { costUsd: r.costUsd }), ...(r.billing === 'subscription' ? { billing: 'subscription' } : {}) });
    });

    // The PR description shows what the work has cost so far, across every session on this issue.
    const updateCost = (name: string, prNumber: number) => ctx.step(name, async () => {
      await d.github.upsertPrSection({
        installationId: meta.installationId, owner, repo, number: prNumber, marker: COST_MARKER,
        markdown: renderCostSection(await listSessionCosts(store, key), c.bedrockModelId),
      });
    });
    if (meta.prNumber) await updateCost(`cost-${iter}`, meta.prNumber);

    // Factory mode publishes its own branch (factory/gh-N). Open pull requests from it, and use it from now on.
    const head = r.branch ?? meta.branch;
    if (r.branch && r.branch !== meta.branch) await ctx.step(`branch-${iter}`, () => setBranch(store, key, r.branch!));

    const after = (await ctx.step(`reload-${iter}`, () => getMeta(store, key)))!;
    if (after.cancelRequested) return finalizeCancel(iter, after);

    if (r.type !== 'continue') continues = 0;
    if (r.type !== 'rate_limited') limitWaits = 0;
    switch (r.type) {
      case 'rate_limited': {
        // The Claude subscription's usage window is used up. Wait for it to reset (a durable wait, so no compute), then carry on.
        const seconds = Math.min(Math.max(r.retryAfterSeconds, 60), MAX_LIMIT_WAIT_SECONDS);
        if (++limitWaits === 1) {
          await comment(`limit-comment-${iter}`, meta, target,
            `I have used up my Claude usage limit for now. I will carry on in about ${Math.max(1, Math.round(seconds / 60))} minutes, when it resets.`, `${segmentSeq}:limit`);
        }
        if (limitWaits <= MAX_LIMIT_WAITS) {
          d.log?.('usage limit reached, waiting', { issueKey: key, segmentSeq, seconds, limitWaits });
          await ctx.wait(`limit-wait-${iter}`, { seconds });
          continue;
        }
        limitWaits = 0;
        await comment(`limit-pause-comment-${iter}`, meta, target,
          'I keep hitting my Claude usage limit, so I am pausing here. Reply (anything is fine) when you want me to try again.', `${segmentSeq}:limitpause`);
        break;
      }
      case 'continue':
        // The session ran out of turns, not tokens. The work is saved, so start the next session without waiting for anyone.
        if (++continues <= MAX_AUTO_CONTINUES) { d.log?.('continuing after turn limit', { issueKey: key, segmentSeq, continues }); continue; }
        continues = 0;
        await comment(`continue-comment-${iter}`, meta, target,
          `I have worked through ${MAX_AUTO_CONTINUES + 1} sessions in a row and am not finished. I am pausing so you can see where things stand. Reply (anything is fine) and I will keep going.`, `${segmentSeq}:continue`);
        break;
      case 'questions':
        await comment(`q-comment-${iter}`, meta, target, r.markdown, `${segmentSeq}`);
        break;
      case 'revised':
        await comment(`rev-comment-${iter}`, meta, target, r.summaryMarkdown, `${segmentSeq}`);
        break;
      case 'budget_exhausted': {
        await comment(`budget-comment-${iter}`, meta, target, r.summaryMarkdown, `${segmentSeq}`);
        // Keep the work reviewable: open a draft PR for whatever was pushed, if anything was.
        if (!meta.prNumber) {
          const draft = await ctx.step(`draft-pr-${iter}`, () => d.github.openPr({
            installationId: meta.installationId, owner, repo, head, draft: true,
            title: `WIP: work on #${issueNumber} (token budget used up)`,
            body: `${r.summaryMarkdown}\n\n---\nThis is a draft: the agent stopped when it reached its token budget, so the work may be incomplete or untested.\n\nRefs #${issueNumber}`,
          }) ?? null);
          if (draft) {
            await ctx.step(`link-draft-${iter}`, () => linkPr(store, key, owner, repo, draft));
            await updateCost(`cost-draft-${iter}`, draft);
            await comment(`draft-comment-${iter}`, meta, issueNumber, `I opened draft #${draft} with the work so far.`, `${segmentSeq}:draft`);
          }
        }
        await ctx.step(`finish-budget-${iter}`, () => finish(store, key, 'BUDGET_EXHAUSTED'));
        return { status: 'BUDGET_EXHAUSTED' };
      }
      case 'done': {
        const body = `${r.pr.body}\n\nCloses #${issueNumber}`;
        const prNumber = await ctx.step(`open-pr-${iter}`, () =>
          d.github.openPr({ installationId: meta.installationId, owner, repo, head, title: r.pr.title, body, draft: c.prDraft }));
        if (prNumber === undefined) { // nothing was changed, so there is nothing to propose
          await comment(`nochange-comment-${iter}`, meta, issueNumber, 'I finished without making any changes, so there is no pull request to open. Reply if you expected changes.', `${segmentSeq}:nochange`);
          break;
        }
        await ctx.step(`link-pr-${iter}`, async () => { await linkPr(store, key, owner, repo, prNumber); await setPhase(store, key, 'REVIEW'); });
        await updateCost(`cost-pr-${iter}`, prNumber);
        await comment(`pr-comment-${iter}`, meta, issueNumber, `I opened #${prNumber} for this issue.`, `${segmentSeq}:pr`);
        break;
      }
    }

    // Human wait. createCallback + conditional park avoids relying on completing a callback inside its submitter (design D4).
    const [reply, callbackId] = await ctx.createCallback<string>(`human-${iter}`, { timeout: { seconds: c.humanWaitTimeoutSeconds } });
    const parked = await ctx.step(`park-${iter}`, () => park(store, key, callbackId));
    if (!parked) await ctx.step(`selfwake-${iter}`, () => d.sendCallback(callbackId, { wake: true }));

    let payload: { wake?: boolean; cancel?: boolean } = {};
    try {
      payload = parsePayload(await reply) ?? {};
    } catch (e) {
      if (!(e instanceof CallbackTimeoutError)) throw e;
      const expired = await ctx.step(`expire-${iter}`, () => expire(store, key));
      if (expired) {
        await comment(`expire-comment-${iter}`, meta, meta.prNumber ?? issueNumber,
          `I have not heard back in ${Math.round(c.humanWaitTimeoutSeconds / 86400)} days, so I am pausing. Comment here to resume.`, `${segmentSeq}:expired`);
        return { status: 'EXPIRED' };
      }
    }
    if (parked && !payload.cancel) await ctx.wait(`debounce-${iter}`, { seconds: c.wakeDebounceSeconds });
  }
}
