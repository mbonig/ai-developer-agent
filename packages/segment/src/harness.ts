import { chmod, chown, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message } from '@aws-sdk/client-bedrock-runtime';
import { addUsage, costUsd, emptyUsage, type SegmentJob, type SegmentResult, type InboxMessage, type Config, type Usage } from '@agent/shared';
import * as g from './git.ts';
import { agentRunAs, chownTree, lockDownMetadata, lockdownInPlace, sandboxActive } from './sandbox.ts';
import { runAgent, appendUserTurn, type ConverseFn } from './loop.ts';
import { compactIfNeeded } from './compact.ts';
import { detectMode } from './mode.ts';
import { packFactoryState, unpackFactoryState } from './factory-state.ts';
import { firstTurn, followUpTurn } from './prompts.ts';

export interface IssueInfo { title: string; body: string; author: string }

export interface HarnessDeps {
  config: Pick<Config, 'bedrockModelId' | 'maxTurnsPerSegment' | 'transcriptCompactTokens' | 'runCommandTimeoutSeconds' | 'toolOutputMaxBytes'>;
  getToken(installationId: number, repo: string): Promise<string>;
  getIssue(token: string, owner: string, repo: string, number: number): Promise<IssueInfo>;
  loadTranscript(key: string): Promise<Message[] | undefined>;
  saveTranscript(key: string, messages: Message[]): Promise<void>;
  loadInbox(job: SegmentJob): Promise<InboxMessage[]>;
  converse: ConverseFn;
  reportSuccess(callbackId: string, result: SegmentResult): Promise<void>;
  reportFailure(callbackId: string, code: string, message: string): Promise<void>;
  /** Whether the swamp software factory may be used when a repository has one. */
  enableFactory?: boolean;
  /** The swamp-club collective token the swamp CLI needs. Without one the factory is treated as unavailable. */
  getSwampKey?(): Promise<string | undefined>;
  loadFactoryState?(job: SegmentJob): Promise<Buffer | undefined>;
  saveFactoryState?(job: SegmentJob, state: Buffer): Promise<void>;
  cloneUrl?(owner: string, repo: string): string;
  now?(): number;
  log?(msg: string, extra?: Record<string, unknown>): void;
}

class Coded extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

const TOKEN_MAX_AGE_MS = 50 * 60 * 1000;

/** Runs one work segment. Never throws: the outcome always goes back through the durable callback. */
export async function runSegment(d: HarnessDeps, job: SegmentJob): Promise<void> {
  const now = d.now ?? Date.now;
  const log = d.log ?? (() => {});
  const dir = await mkdtemp(join(tmpdir(), `segment-${job.segmentSeq}-`));
  await chmod(dir, 0o755); // the agent user must be able to reach the workspace
  const work = join(dir, 'repo');
  try {
    // Fail closed: never run the agent unless the metadata service is blocked for it.
    if (sandboxActive()) {
      try { if (!lockdownInPlace()) lockDownMetadata(); } catch (e) { throw new Coded('LOCKDOWN_FAILED', (e as Error).message); }
      if (!lockdownInPlace()) throw new Coded('LOCKDOWN_FAILED', 'metadata service block is not in place');
    }

    // Token refresh for long segments: a token older than 50 minutes is replaced before it is used again.
    let token = await d.getToken(job.installationId, job.repo); let tokenAt = now();
    const freshToken = async () => {
      if (now() - tokenAt > TOKEN_MAX_AGE_MS) { token = await d.getToken(job.installationId, job.repo); tokenAt = now(); }
      return token;
    };

    // Rehydrate: clone, branch, transcript, inbox.
    const remoteUrl = (d.cloneUrl ?? ((o, r) => `https://github.com/${o}/${r}.git`))(job.owner, job.repo);
    let modeInfo: ReturnType<typeof detectMode>;
    let swampKey: string | undefined;
    let branch = job.branch;
    try {
      await g.cloneRepo(remoteUrl, work, token);
      swampKey = d.enableFactory && d.getSwampKey ? await d.getSwampKey() : undefined;
      const factoryUsable = !!d.enableFactory && (!d.getSwampKey || !!swampKey);
      if (d.enableFactory && d.getSwampKey && !swampKey) log('factory unavailable: no swamp API key is configured');
      modeInfo = detectMode(work, { ENABLE_FACTORY: factoryUsable ? 'true' : 'false' });
      if (modeInfo.mode === 'factory') {
        // The factory creates its own worktree and branch factory/<key> from origin/main. Resume it if an earlier segment pushed it.
        branch = `factory/gh-${job.issueNumber}`;
        if (await g.remoteHasBranch(work, branch, await freshToken())) await g.fetchBranchLocal(work, branch, await freshToken());
      } else {
        await g.checkoutBranch(work, branch, await freshToken());
      }
    } catch (e) { throw new Coded('CLONE_FAILED', (e as Error).message); }
    const base = await g.defaultBranch(work);
    log('work mode', { mode: modeInfo.mode, reason: modeInfo.reason, branch });
    const factoryDir = join(work, 'factory');
    if (modeInfo.mode === 'factory' && d.loadFactoryState) {
      const saved = await d.loadFactoryState(job);
      if (saved) await unpackFactoryState(factoryDir, saved);
    }
    const runAs = agentRunAs();
    let agentEnv: Record<string, string | undefined> | undefined;
    if (modeInfo.mode === 'factory' && swampKey) {
      // swamp reads its token from a file. It is readable by the agent user, because the agent runs swamp.
      const keyFile = join(dir, 'swamp-api-key');
      await writeFile(keyFile, swampKey, { mode: 0o400 });
      if (runAs) await chown(keyFile, runAs.uid, runAs.gid);
      agentEnv = { ...process.env, SWAMP_API_KEY_FILE: keyFile };
    }
    if (runAs) chownTree(work, runAs); // from here on, git runs as the agent user, except publish()

    let messages = (await d.loadTranscript(job.transcriptKey)) ?? [];
    const inbox = await d.loadInbox(job);
    let overhead = 0; let overheadUsage: Usage = emptyUsage();

    if (messages.length === 0) {
      const issue = await d.getIssue(await freshToken(), job.owner, job.repo, job.issueNumber);
      messages = [{ role: 'user', content: [{ text: firstTurn({ owner: job.owner, repo: job.repo, number: job.issueNumber, ...issue, baseBranch: base }, inbox) }] }];
    } else {
      const c = await compactIfNeeded({
        converse: d.converse, modelId: d.config.bedrockModelId, messages, thresholdTokens: d.config.transcriptCompactTokens,
        diff: await g.diffAgainstDefault(work, base).catch(() => ''), log,
      });
      messages = c.messages; overhead = c.tokensUsed; overheadUsage = c.usage;
      if (c.compacted) log('transcript compacted', { usedFallback: !!c.usedFallback });
      appendUserTurn(messages, [{ text: followUpTurn(inbox) }]);
    }

    const run = await runAgent({
      converse: d.converse, modelId: d.config.bedrockModelId, phase: job.phase, branch, repoSlug: `${job.owner}/${job.repo}`, mode: modeInfo.mode, messages,
      toolCtx: { root: work, runCommandTimeoutSeconds: d.config.runCommandTimeoutSeconds, toolOutputMaxBytes: d.config.toolOutputMaxBytes, runAs, env: agentEnv },
      maxTurns: d.config.maxTurnsPerSegment, tokenBudgetRemaining: Math.max(0, job.tokenBudgetRemaining - overhead),
    });

    // Persist, in order: commit, push, state and transcript, then report.
    let publishedBranch: string | undefined; let headSha: string;
    if (modeInfo.mode === 'factory') {
      const wt = await g.worktreeFor(work, branch);
      if (wt) await g.commitAll(wt, `factory: work on issue #${job.issueNumber} (segment ${job.segmentSeq})`);
      if (await g.localBranchExists(work, branch)) {
        try { await g.publish(work, branch, remoteUrl, await freshToken(), `refs/heads/${branch}`); }
        catch (e) { throw new Coded('PUSH_FAILED', (e as Error).message); }
        publishedBranch = branch; headSha = await g.refSha(work, `refs/heads/${branch}`);
      } else {
        headSha = await g.refSha(work, 'HEAD'); // the factory has not created its branch yet, so there is nothing to publish
      }
      const state = await packFactoryState(factoryDir);
      if (state && d.saveFactoryState) await d.saveFactoryState(job, state);
    } else {
      await g.commitAll(work, `agent: work on issue #${job.issueNumber} (segment ${job.segmentSeq})`);
      try { await g.publish(work, branch, remoteUrl, await freshToken()); }
      catch (e) { throw new Coded('PUSH_FAILED', (e as Error).message); }
      headSha = await g.headSha(work);
    }
    await d.saveTranscript(job.transcriptKey, run.messages);
    const usage = addUsage(run.usage, overheadUsage);
    const cost = { usage, ...(costUsd(usage, d.config.bedrockModelId) !== undefined ? { costUsd: costUsd(usage, d.config.bedrockModelId) } : {}) };
    await d.reportSuccess(job.callbackId, { ...run.outcome, tokensUsed: run.tokensUsed + overhead, headSha, ...cost, ...(publishedBranch ? { branch: publishedBranch } : {}) });
  } catch (e) {
    const code = e instanceof Coded ? e.code : 'SEGMENT_ERROR';
    log('segment failed', { code, message: (e as Error).message });
    await d.reportFailure(job.callbackId, code, (e as Error).message.slice(0, 500)).catch((e2) => log('failure report failed', { message: String(e2) }));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
