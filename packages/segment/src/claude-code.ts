import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { addUsage, emptyUsage, weightedTokens, type Phase, type SegmentOutcome, type Usage } from '@agent/shared';
import type { RunAs } from './sandbox.ts';

/** What the stream-json output of `claude -p --verbose` told us, folded as it arrives. */
export interface StreamState {
  sessionId?: string;
  permissionMode?: string;
  /** Latest usage per assistant message id, so repeated events for one message are not counted twice. */
  perMessage: Map<string, Usage>;
  rateLimit?: { status: string; resetsAt?: number };
  result?: {
    subtype?: string; isError: boolean; terminalReason?: string; text: string; usage: Usage; costUsd?: number; numTurns?: number; apiErrorStatus?: unknown;
  };
}

export const newStreamState = (): StreamState => ({ perMessage: new Map() });

const toUsage = (u: Record<string, unknown> | undefined): Usage => ({
  input: Number(u?.input_tokens ?? 0), output: Number(u?.output_tokens ?? 0),
  cacheRead: Number(u?.cache_read_input_tokens ?? 0), cacheWrite: Number(u?.cache_creation_input_tokens ?? 0),
});

export const streamUsage = (s: StreamState): Usage => [...s.perMessage.values()].reduce(addUsage, emptyUsage());

/** Folds one line of stream-json into the state. Lines that are not JSON, or that we do not care about, are ignored. */
export function feed(s: StreamState, line: string): void {
  let e: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { e = JSON.parse(line); } catch { return; }
  if (typeof e.session_id === 'string') s.sessionId = e.session_id;
  switch (e.type) {
    case 'assistant': {
      const id = e.message?.id; if (typeof id === 'string' && e.message?.usage) s.perMessage.set(id, toUsage(e.message.usage));
      break;
    }
    case 'system':
      if (e.subtype === 'init' && typeof e.permissionMode === 'string') s.permissionMode = e.permissionMode;
      break;
    case 'rate_limit_event': {
      const i = e.rate_limit_info;
      if (i && typeof i.status === 'string') s.rateLimit = { status: i.status, resetsAt: typeof i.resetsAt === 'number' ? i.resetsAt : undefined };
      break;
    }
    case 'result':
      s.result = {
        subtype: e.subtype, isError: !!e.is_error, terminalReason: e.terminal_reason, text: typeof e.result === 'string' ? e.result : '',
        usage: toUsage(e.usage), costUsd: typeof e.total_cost_usd === 'number' ? e.total_cost_usd : undefined, numTurns: e.num_turns, apiErrorStatus: e.api_error_status,
      };
      break;
  }
}

const LIMIT_TEXT = /usage limit|5-hour limit|weekly limit|rate.?limit|too many requests|overloaded|\b429\b/i;
const DEFAULT_RETRY_SECONDS = 1800;

/** Seconds to wait when the run ended because a usage window is exhausted, or undefined if it did not. */
export function rateLimitedFor(s: StreamState, nowSec = Math.floor(Date.now() / 1000)): number | undefined {
  const blocked = s.rateLimit && s.rateLimit.status !== 'allowed' && s.rateLimit.status !== 'allowed_warning';
  const errorLooksLikeLimit = !!s.result?.isError && LIMIT_TEXT.test(s.result.text);
  if (!blocked && !errorLooksLikeLimit) return undefined;
  const reset = s.rateLimit?.resetsAt;
  return Math.max(60, reset ? reset - nowSec : DEFAULT_RETRY_SECONDS);
}

export interface ClaudeRunArgs {
  workDir: string;
  configDir: string;
  prompt: string;
  systemPrompt: string;
  phase: Phase;
  sessionId: string;
  resume: boolean;
  token: string;
  maxTurns: number;
  /** Stop the run when it has used this many budget tokens. */
  tokenBudget: number;
  timeoutMs: number;
  outcomeFile: string;
  mcpConfigPath: string;
  mcp: { command: string; args: string[] };
  runAs?: RunAs;
  claudeBin?: string;
  extraEnv?: Record<string, string>;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface OneRun { state: StreamState; budgetKilled: boolean; timedOut: boolean; exitCode: number | null; stderr: string }

const ALLOWED_TOOLS = 'Bash,Read,Write,Edit,MultiEdit,NotebookEdit,Glob,Grep,Task,Agent,Skill,TodoWrite,WebFetch,WebSearch,mcp__harness';
let traced = 0;
/** Logs the few stream events that explain a failure: the init settings and tool errors. Segment stdout does not reach CloudWatch, so the harness uploads this log to S3. */
function traceLine(a: ClaudeRunArgs, line: string): void {
  let e: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { e = JSON.parse(line); } catch { return; }
  if (e.type === 'system' && e.subtype === 'init') a.log?.('claude init', { permissionMode: e.permissionMode, model: e.model, version: e.claude_code_version, apiKeySource: e.apiKeySource, tools: Array.isArray(e.tools) ? e.tools.length : undefined, mcp: e.mcp_servers });
  if (e.type === 'user' && Array.isArray(e.message?.content) && traced < 15) {
    for (const b of e.message.content) if (b?.type === 'tool_result' && b.is_error) { traced++; a.log?.('claude tool error', { text: JSON.stringify(b.content).slice(0, 300) }); }
  }
}

/** Runs `claude -p` once. Never throws for a non-zero exit: the caller decides from the stream and the outcome file. */
export function runClaudeOnce(a: ClaudeRunArgs): Promise<OneRun> {
  writeFileSync(a.mcpConfigPath, JSON.stringify({ mcpServers: { harness: { command: a.mcp.command, args: a.mcp.args, env: { HARNESS_OUTCOME_FILE: a.outcomeFile, HARNESS_PHASE: a.phase } } } }));
  // Bypass mode only takes effect when consent is recorded in the user settings; a fresh config directory has none, and Claude Code then silently falls back to the default mode and denies every tool.
  mkdirSync(a.configDir, { recursive: true });
  const settingsFile = `${a.configDir}/settings.json`;
  let settings: Record<string, unknown> = {};
  try { settings = JSON.parse(readFileSync(settingsFile, 'utf8')); } catch { /* none yet */ }
  writeFileSync(settingsFile, JSON.stringify({ ...settings, skipDangerousModePermissionPrompt: true }));
  const args = [
    '-p', a.prompt, '--output-format', 'stream-json', '--verbose',
    // The MicroVM is the sandbox and this runs as a non-root user, so Claude Code's own permission prompts add nothing.
    '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions',
    // With CLAUDE_CODE_SUBPROCESS_ENV_SCRUB set, Claude Code forces the default permission mode and ignores the bypass flag, so every tool is allowed explicitly.
    // The MicroVM is still the sandbox. `mcp__harness` allows both harness tools.
    '--allowedTools', ALLOWED_TOOLS,
    '--mcp-config', a.mcpConfigPath, '--strict-mcp-config',
    '--append-system-prompt', a.systemPrompt,
    ...(a.resume ? ['--resume', a.sessionId] : ['--session-id', a.sessionId]),
  ];
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '', HOME: a.runAs?.home ?? process.env.HOME ?? '/tmp', LANG: 'C.UTF-8',
    CLAUDE_CONFIG_DIR: a.configDir, CLAUDE_CODE_OAUTH_TOKEN: a.token,
    // Ask Claude Code to keep credentials out of the commands it runs.
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
    CLAUDE_CODE_MAX_TURNS: String(a.maxTurns), DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1', OPENSPEC_TELEMETRY: '0',
    ...a.extraEnv,
  };
  return new Promise((resolve, reject) => {
    const p = spawn(a.claudeBin ?? 'claude', args, { cwd: a.workDir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'], uid: a.runAs?.uid, gid: a.runAs?.gid });
    const state = newStreamState(); let buf = ''; let stderr = ''; let budgetKilled = false; let timedOut = false;
    const kill = () => { try { process.kill(-p.pid!, 'SIGKILL'); } catch { /* already gone */ } };
    p.stdout!.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1); feed(state, line); traceLine(a, line);
        if (!budgetKilled && weightedTokens(streamUsage(state)) >= a.tokenBudget) { budgetKilled = true; a.log?.('token budget reached, stopping Claude Code'); kill(); }
      }
    });
    p.stderr!.on('data', (d: Buffer) => { stderr = (stderr + d.toString('utf8')).slice(-4000); });
    const timer = setTimeout(() => { timedOut = true; kill(); }, a.timeoutMs);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => { clearTimeout(timer); kill(); if (buf.trim()) feed(state, buf); resolve({ state, budgetKilled, timedOut, exitCode: code, stderr }); });
  });
}

/** The subscription token was rejected. Retrying cannot help, so this maps to a non-retryable failure code. */
export class ClaudeAuthError extends Error { code = 'BACKEND_NOT_CONFIGURED'; }

export function isAuthFailure(r: { text: string; apiErrorStatus?: unknown }): boolean {
  if (r.apiErrorStatus === 401) return true;
  return /invalid (api key|bearer|token|authentication)|not logged in|please run \/login|authentication[_ ]error|oauth token (has )?expired|failed to authenticate|\b401\b/i.test(r.text);
}

export interface ClaudeSessionResult { outcome: SegmentOutcome; usage: Usage; costUsd?: number; sessionId: string; tokensUsed: number }

const NUDGE = 'You have not finished. If the work is complete, call mcp__harness__finish. If you are blocked, call mcp__harness__ask_questions. Do not stop without calling one of them.';

/** Reads and removes the outcome file the MCP server wrote, if any. */
function readOutcome(file: string, phase: Phase): SegmentOutcome | undefined {
  if (!existsSync(file)) return undefined;
  let rec: { tool?: string; input?: Record<string, unknown> };
  try { rec = JSON.parse(readFileSync(file, 'utf8')); } finally { rmSync(file, { force: true }); }
  const i = rec.input ?? {};
  if (rec.tool === 'ask_questions') return { type: 'questions', markdown: String(i.markdown ?? '') || '(no questions provided)' };
  if (rec.tool === 'finish') {
    if (phase === 'IMPLEMENT') return { type: 'done', pr: { title: String(i.title ?? '').trim() || 'Implement issue', body: String(i.body ?? '') } };
    return { type: 'revised', summaryMarkdown: String(i.summary ?? '') || 'Addressed the feedback.' };
  }
  return undefined;
}

/**
 * Runs Claude Code for one work segment: the first run, and at most one resumed run if it ended without calling a terminal tool.
 * Maps what happened to the same outcomes the Bedrock loop produces.
 */
export async function runClaudeSession(a: ClaudeRunArgs): Promise<ClaudeSessionResult> {
  let usage = emptyUsage(); let cost: number | undefined; let resume = a.resume; let prompt = a.prompt;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const run = await runClaudeOnce({ ...a, prompt, resume, tokenBudget: Math.max(0, a.tokenBudget - weightedTokens(usage)) });
    const s = run.state;
    const ran = s.result?.usage && weightedTokens(s.result.usage) > 0 ? s.result.usage : streamUsage(s);
    usage = addUsage(usage, ran);
    if (s.result?.costUsd !== undefined) cost = (cost ?? 0) + s.result.costUsd;
    const done = (outcome: SegmentOutcome): ClaudeSessionResult => ({ outcome, usage, costUsd: cost, sessionId: s.sessionId ?? a.sessionId, tokensUsed: weightedTokens(usage) });

    const outcome = readOutcome(a.outcomeFile, a.phase);
    if (outcome) return done(outcome);
    if (run.timedOut) throw new Error(`Claude Code did not finish within ${Math.round(a.timeoutMs / 60000)} minutes`);
    if (run.budgetKilled) return done({ type: 'budget_exhausted', summaryMarkdown: 'I reached my token budget for this issue. My work so far is saved on the branch.' });
    const wait = rateLimitedFor(s);
    if (wait !== undefined) return done({ type: 'rate_limited', retryAfterSeconds: wait });
    if (s.permissionMode && s.permissionMode !== 'bypassPermissions') a.log?.('Claude Code is not in bypassPermissions mode; tools may be denied', { permissionMode: s.permissionMode });
    a.log?.('claude run finished', { exitCode: run.exitCode, subtype: s.result?.subtype, isError: s.result?.isError, text: s.result?.text.slice(0, 300), stderr: run.stderr.slice(-500) });
    if (!s.result) throw new Error(`Claude Code ended without a result (exit ${run.exitCode}): ${run.stderr.slice(-300)}`);
    if (s.result.subtype === 'error_max_turns' || s.result.terminalReason === 'max_turns') return done({ type: 'continue' });
    if (s.result.isError && isAuthFailure(s.result)) throw new ClaudeAuthError(`Claude Code could not authenticate. The subscription token is missing, invalid or expired. Run \`claude setup-token\` and store the new token in the ai-developer-agent/claude-code-oauth-token secret. Detail: ${s.result.text.slice(0, 200)}`);
    if (s.result.isError) throw new Error(`Claude Code failed (${s.result.subtype ?? 'error'}): ${s.result.text.slice(0, 300)}`);

    // It finished talking without a terminal tool. Resume once and ask it to call one.
    a.log?.('Claude Code ended without a terminal tool', { attempt });
    if (attempt === 2) return done({ type: 'questions', markdown: s.result.text.trim() || 'I could not make progress.' });
    resume = true; prompt = NUDGE;
  }
  throw new Error('unreachable');
}
