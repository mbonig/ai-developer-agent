import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, chown, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message } from '@aws-sdk/client-bedrock-runtime';
import { addUsage, costUsd, emptyUsage, type AgentBackend, type SegmentJob, type SegmentResult, type InboxMessage, type Config, type Usage } from '@agent/shared';
import * as g from './git.ts';
import { agentRunAs, chownTree, lockDownMetadata, lockdownInPlace, sandboxActive } from './sandbox.ts';
import { runAgent, appendUserTurn, type ConverseFn } from './loop.ts';
import { compactIfNeeded } from './compact.ts';
import { detectMode } from './mode.ts';
import { packDir, packFactoryState, unpackDir, unpackFactoryState } from './factory-state.ts';
import { runClaudeSession } from './claude-code.ts';
import { firstTurn, followUpTurn, systemPrompt } from './prompts.ts';

export interface IssueInfo { title: string; body: string; author: string }

export interface HarnessDeps {
  config: Pick<Config, 'bedrockModelId' | 'maxTurnsPerSegment' | 'transcriptCompactTokens' | 'runCommandTimeoutSeconds' | 'toolOutputMaxBytes'> & Partial<Pick<Config, 'claudeCodeBudgetMultiplier'>>;
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
  /** Which model backend runs the agent. Defaults to Bedrock. Used when `getAgentBackend` is not provided. */
  agentBackend?: AgentBackend;
  /** Looks up the backend for each segment (an SSM parameter in the deployment), so it can change without a redeploy. Takes precedence over `agentBackend`. */
  getAgentBackend?(): Promise<AgentBackend>;
  /** The Claude subscription token from `claude setup-token`. Without one the Claude Code backend cannot run. */
  getClaudeToken?(): Promise<string | undefined>;
  loadClaudeSession?(job: SegmentJob): Promise<Buffer | undefined>;
  saveClaudeSession?(job: SegmentJob, state: Buffer): Promise<void>;
  /** Uploads the segment's own log, because stdout from inside a run does not reach CloudWatch. */
  saveDebugLog?(job: SegmentJob, text: string): Promise<void>;
  /** Parent of the fixed working directory used by the Claude Code backend (default /work). Sessions are keyed by directory. */
  workBase?: string;
  claudeBin?: string;
  /** How Claude Code starts the harness MCP server (default: this program with --mcp-server). */
  mcpCommand?: { command: string; args: string[] };
  claudeTimeoutMs?: number;
  cloneUrl?(owner: string, repo: string): string;
  now?(): number;
  log?(msg: string, extra?: Record<string, unknown>): void;
}

/** A stable UUID per issue, so every segment of an issue names the same Claude Code session. */
export function sessionIdFor(issueKey: string): string {
  const h = createHash('sha1').update(`ai-developer-agent:${issueKey}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

class Coded extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

const TOKEN_MAX_AGE_MS = 50 * 60 * 1000;

/** Runs one work segment. Never throws: the outcome always goes back through the durable callback. */
export async function runSegment(d: HarnessDeps, job: SegmentJob): Promise<void> {
  const now = d.now ?? Date.now;
  const lines: string[] = [];
  const base = d.log ?? (() => {});
  const log = (msg: string, extra?: Record<string, unknown>) => { lines.push(JSON.stringify({ t: new Date().toISOString(), msg, ...extra })); base(msg, extra); };
  let backend: AgentBackend;
  try {
    // The issue's own request (if any) overrides the deployment default, and needs no SSM lookup.
    backend = job.modelOverride?.backend ?? (d.getAgentBackend ? await d.getAgentBackend() : d.agentBackend ?? 'claude-code');
  } catch (e) {
    // Never guess: running the wrong backend could spend money the operator chose not to.
    log('backend lookup failed', { message: (e as Error).message });
    await d.reportFailure(job.callbackId, 'SEGMENT_ERROR', `Could not determine the model backend: ${(e as Error).message}`.slice(0, 500)).catch((e2) => log('failure report failed', { message: String(e2) }));
    if (d.saveDebugLog) await d.saveDebugLog(job, lines.join('\n')).catch(() => {});
    return;
  }
  const modelId = job.modelOverride?.modelId;
  log('backend selected', { backend, modelId: modelId ?? '(default)', fromIssue: !!job.modelOverride });
  let dir: string;
  if (backend === 'claude-code') {
    // Claude Code keys its sessions by working directory, so the path must be the same in every segment.
    dir = join(d.workBase ?? '/work', 'job');
    await rm(dir, { recursive: true, force: true }); await mkdir(dir, { recursive: true });
  } else {
    dir = await mkdtemp(join(tmpdir(), `segment-${job.segmentSeq}-`));
  }
  await chmod(dir, 0o755); // the agent user must be able to reach the workspace
  const work = join(dir, 'repo');
  try {
    // The Claude Code backend needs the subscription token. Never fall back to Bedrock: that would spend money the operator chose not to.
    let claudeToken: string | undefined;
    if (backend === 'claude-code') {
      claudeToken = d.getClaudeToken ? await d.getClaudeToken() : undefined;
      if (!claudeToken) throw new Coded('BACKEND_NOT_CONFIGURED', 'The Claude Code backend is selected but no Claude subscription token is configured. Store one with `claude setup-token` in the ai-developer-agent/claude-code-oauth-token secret.');
    }

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
    /** Where main-checkout edits go in factory mode, when the factory itself could not be used. */
    const fallbackBranch = job.branch.startsWith('factory/') ? undefined : job.branch;
    try {
      await g.cloneRepo(remoteUrl, work, token);
      swampKey = d.enableFactory && d.getSwampKey ? await d.getSwampKey() : undefined;
      const factoryUsable = !!d.enableFactory && (!d.getSwampKey || !!swampKey);
      if (d.enableFactory && d.getSwampKey && !swampKey) log('factory unavailable: no swamp API key is configured');
      modeInfo = detectMode(work, { ENABLE_FACTORY: factoryUsable ? 'true' : 'false' });
      if (modeInfo.mode === 'factory') {
        // The factory creates its own worktree and branch factory/<key> from origin/main. Resume it if an earlier segment pushed it.
        branch = factoryBranch(job);
        if (await g.remoteHasBranch(work, branch, await freshToken())) await g.fetchBranchLocal(work, branch, await freshToken());
        // When the factory cannot run, the agent falls back to editing the main checkout. Earlier fallback work lives on the agent branch.
        if (fallbackBranch && await g.remoteHasBranch(work, fallbackBranch, await freshToken())) await g.checkoutBranch(work, fallbackBranch, await freshToken());
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
    let agentEnv: Record<string, string | undefined> | undefined; let swampPath: string | undefined;
    if (modeInfo.mode === 'factory' && swampKey) {
      // swamp reads its token from a file. It is readable by the agent user, because the agent runs swamp.
      const keyFile = join(dir, 'swamp-api-key');
      await writeFile(keyFile, swampKey, { mode: 0o400 });
      if (runAs) await chown(keyFile, runAs.uid, runAs.gid);
      agentEnv = { ...process.env, SWAMP_API_KEY_FILE: keyFile };
      // Claude Code scrubs credential-looking variables (SWAMP_API_KEY_FILE among them) from the commands it runs, so swamp never saw the key.
      // A `swamp` wrapper first on PATH sets the variable itself, whatever the agent's environment holds.
      const real = (process.env.PATH ?? '').split(':').map((p) => join(p, 'swamp')).find((p) => existsSync(p)) ?? '/usr/local/bin/swamp';
      await mkdir(join(dir, 'bin'), { recursive: true });
      await writeFile(join(dir, 'bin', 'swamp'), `#!/bin/sh\nSWAMP_API_KEY_FILE='${keyFile}' exec '${real}' "$@"\n`, { mode: 0o755 });
      swampPath = `${join(dir, 'bin')}:${process.env.PATH ?? ''}`;
    }
    const configDir = join(dir, 'claude-config');
    let hadSession = false;
    if (backend === 'claude-code') {
      await mkdir(configDir, { recursive: true });
      const saved = d.loadClaudeSession ? await d.loadClaudeSession(job) : undefined;
      if (saved) { await unpackDir(configDir, saved); hadSession = true; }
      if (runAs) chownTree(configDir, runAs);
    }
    if (runAs) chownTree(work, runAs); // from here on, git runs as the agent user, except publish()

    const inbox = await d.loadInbox(job);
    let outcome: import('@agent/shared').SegmentOutcome; let tokensUsed: number; let usage: Usage; let cost: number | undefined; let billing: 'bedrock' | 'subscription'; let transcript: Message[] | undefined;

    if (backend === 'claude-code') {
      // Subscription tokens count 1/mult against the per-issue budget, so the budget handed to Claude Code is mult times the remaining
      // budget and the tokens reported back are divided by mult. The orchestrator then keeps one budget in Bedrock-equivalent units.
      const mult = d.config.claudeCodeBudgetMultiplier ?? 2;
      const issue = hadSession ? undefined : await d.getIssue(await freshToken(), job.owner, job.repo, job.issueNumber);
      const prompt = issue
        ? firstTurn({ owner: job.owner, repo: job.repo, number: job.issueNumber, ...issue, baseBranch: base }, inbox)
        : followUpTurn(inbox);
      const res = await runClaudeSession({
        workDir: work, configDir, prompt, systemPrompt: systemPrompt(job.phase, branch, `${job.owner}/${job.repo}`, modeInfo.mode, 'claude-code'),
        phase: job.phase, sessionId: sessionIdFor(job.issueKey), resume: hadSession, token: claudeToken!,
        maxTurns: d.config.maxTurnsPerSegment, tokenBudget: job.tokenBudgetRemaining * mult, timeoutMs: d.claudeTimeoutMs ?? 100 * 60 * 1000,
        outcomeFile: join(configDir, 'outcome.json'), mcpConfigPath: join(configDir, 'mcp.json'),
        mcp: d.mcpCommand ?? { command: process.execPath, args: [process.argv[1] ?? '', '--mcp-server'] },
        runAs, claudeBin: d.claudeBin, model: modelId, log,
        extraEnv: agentEnv?.SWAMP_API_KEY_FILE ? { SWAMP_API_KEY_FILE: agentEnv.SWAMP_API_KEY_FILE, ...(swampPath ? { PATH: swampPath } : {}) } : undefined,
      });
      outcome = res.outcome; tokensUsed = Math.ceil(res.tokensUsed / mult); usage = res.usage; cost = res.costUsd; billing = 'subscription';
    } else {
      const activeModelId = modelId ?? d.config.bedrockModelId;
      let messages = (await d.loadTranscript(job.transcriptKey)) ?? [];
      let overhead = 0; let overheadUsage: Usage = emptyUsage();
      if (messages.length === 0) {
        const issue = await d.getIssue(await freshToken(), job.owner, job.repo, job.issueNumber);
        messages = [{ role: 'user', content: [{ text: firstTurn({ owner: job.owner, repo: job.repo, number: job.issueNumber, ...issue, baseBranch: base }, inbox) }] }];
      } else {
        const c = await compactIfNeeded({
          converse: d.converse, modelId: activeModelId, messages, thresholdTokens: d.config.transcriptCompactTokens,
          diff: await g.diffAgainstDefault(work, base).catch(() => ''), log,
        });
        messages = c.messages; overhead = c.tokensUsed; overheadUsage = c.usage;
        if (c.compacted) log('transcript compacted', { usedFallback: !!c.usedFallback });
        appendUserTurn(messages, [{ text: followUpTurn(inbox) }]);
      }
      const run = await runAgent({
        converse: d.converse, modelId: activeModelId, phase: job.phase, branch, repoSlug: `${job.owner}/${job.repo}`, mode: modeInfo.mode, messages,
        toolCtx: { root: work, runCommandTimeoutSeconds: d.config.runCommandTimeoutSeconds, toolOutputMaxBytes: d.config.toolOutputMaxBytes, runAs, env: agentEnv },
        maxTurns: d.config.maxTurnsPerSegment, tokenBudgetRemaining: Math.max(0, job.tokenBudgetRemaining - overhead),
      });
      outcome = run.outcome; tokensUsed = run.tokensUsed + overhead; usage = addUsage(run.usage, overheadUsage);
      cost = costUsd(usage, activeModelId); billing = 'bedrock'; transcript = run.messages;
    }

    // Persist, in order: commit, push, state and transcript, then report.
    // publishNote says, in words for the people on the issue, why nothing new reached GitHub. It stays undefined when work was published.
    let publishedBranch: string | undefined; let headSha: string; let publishNote: string | undefined;
    const ahead = (ref: string) => g.commitsAhead(work, base, ref).catch(() => 0);
    if (modeInfo.mode === 'factory') {
      if (!(await g.localBranchExists(work, branch))) {
        // The agent may have followed a naming rule in the repository instead of the harness's key. Adopt its branch when there is exactly one with work on it.
        const others = (await g.localBranches(work, 'factory/')).filter((b) => b !== branch);
        const withWork: string[] = [];
        for (const b of others) { const wt = await g.worktreeFor(work, b); if (wt) await g.commitAll(wt, `factory: work on issue #${job.issueNumber} (segment ${job.segmentSeq})`); if (await ahead(`refs/heads/${b}`) > 0) withWork.push(b); }
        if (withWork.length === 1) {
          log('factory branch has a different name, publishing it', { expected: branch, found: withWork[0] });
          branch = withWork[0];
        } else if (others.length > 0) {
          publishNote = `The factory did not create branch \`${branch}\`, which is the branch I publish. I found ${others.map((b) => `\`${b}\``).join(', ')} instead, and ${withWork.length === 0 ? 'none of them had commits' : 'could not tell which one to use'}, so nothing was pushed.`;
        } else {
          publishNote = `The factory never created branch \`${branch}\` (or any \`factory/\` branch), so there was nothing to push.`;
        }
      }
      const wt = await g.worktreeFor(work, branch);
      if (wt) await g.commitAll(wt, `factory: work on issue #${job.issueNumber} (segment ${job.segmentSeq})`);
      if (await g.localBranchExists(work, branch)) {
        try { await g.publish(work, branch, remoteUrl, await freshToken(), `refs/heads/${branch}`); }
        catch (e) { throw new Coded('PUSH_FAILED', (e as Error).message); }
        publishedBranch = branch; headSha = await g.refSha(work, `refs/heads/${branch}`);
        if (await ahead(`refs/heads/${branch}`) === 0) publishNote = `Branch \`${branch}\` has no commits beyond \`${base}\`.`;
      } else if (fallbackBranch && await g.commitMainCheckout(work, fallbackBranch, `agent: work on issue #${job.issueNumber} (segment ${job.segmentSeq})`) && await ahead('HEAD') > 0) {
        // No factory branch, but the agent changed the main checkout: the documented fallback when the factory cannot run. Publish it on the agent branch.
        log('factory branch missing, publishing main-checkout changes', { branch: fallbackBranch });
        try { await g.publish(work, fallbackBranch, remoteUrl, await freshToken()); }
        catch (e) { throw new Coded('PUSH_FAILED', (e as Error).message); }
        publishedBranch = fallbackBranch; publishNote = undefined; headSha = await g.headSha(work);
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
      if (await ahead('HEAD') === 0) publishNote = `No files in the repository changed, so branch \`${branch}\` has nothing beyond \`${base}\`.`;
    }
    if (publishNote) log('nothing new published', { publishNote });
    if (transcript) await d.saveTranscript(job.transcriptKey, transcript);
    if (backend === 'claude-code' && d.saveClaudeSession) {
      const session = await packDir(configDir);
      if (session) await d.saveClaudeSession(job, session);
    }
    await d.reportSuccess(job.callbackId, {
      ...outcome, tokensUsed, headSha, usage, billing, ...(cost !== undefined ? { costUsd: cost } : {}), ...(publishedBranch ? { branch: publishedBranch } : {}), ...(publishNote ? { publishNote } : {}),
    });
  } catch (e) {
    const code = e instanceof Coded ? e.code : (e as { code?: unknown }).code === 'BACKEND_NOT_CONFIGURED' ? 'BACKEND_NOT_CONFIGURED' : 'SEGMENT_ERROR';
    log('segment failed', { code, message: (e as Error).message });
    await d.reportFailure(job.callbackId, code, (code === 'BACKEND_NOT_CONFIGURED' ? `BACKEND_NOT_CONFIGURED: ${(e as Error).message}` : (e as Error).message).slice(0, 500)).catch((e2) => log('failure report failed', { message: String(e2) }));
  } finally {
    if (d.saveDebugLog) await d.saveDebugLog(job, lines.join('\n')).catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** The factory's branch for this issue: factory/gh-<n> for the first pull request, factory/gh-<n>-<k> for the k-th. */
export function factoryBranch(job: Pick<SegmentJob, 'issueNumber' | 'branch'>): string {
  if (job.branch.startsWith('factory/')) return job.branch; // an earlier segment published the factory's branch under its own name
  const k = new RegExp(`^agent/issue-${job.issueNumber}-(\\d+)$`).exec(job.branch)?.[1];
  return `factory/gh-${job.issueNumber}${k ? `-${k}` : ''}`;
}
