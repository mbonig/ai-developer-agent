import type {
  ConverseCommandInput, ConverseCommandOutput, Message, ContentBlock, ToolResultBlock,
} from '@aws-sdk/client-bedrock-runtime';
import { addUsage, emptyUsage, type Phase, type SegmentOutcome, type Usage } from '@agent/shared';
import { execTool, type ToolCtx } from './tools.ts';
import { toolSpecs, subagentToolSpecs, TERMINAL } from './toolspecs.ts';
import { systemPrompt } from './prompts.ts';
import type { WorkMode } from './mode.ts';

export type ConverseFn = (input: ConverseCommandInput) => Promise<ConverseCommandOutput>;

export interface LoopArgs {
  converse: ConverseFn;
  modelId: string;
  phase: Phase;
  branch: string;
  /** owner/repo, used in prompt guidance about links. */
  repoSlug?: string;
  /** How the work is done in this repository (factory, OpenSpec proposal-first, or plain). */
  mode?: WorkMode;
  messages: Message[];
  toolCtx: ToolCtx;
  maxTurns: number;
  tokenBudgetRemaining: number;
  maxOutputTokens?: number;
  sleep?: (ms: number) => Promise<void>;
}
export interface LoopResult { outcome: SegmentOutcome; messages: Message[]; tokensUsed: number; /** Raw token counts for this loop, including reviewer subagents and the budget summary. */ usage: Usage }

const RETRYABLE = /Throttling|ModelTimeout|ServiceUnavailable|InternalServer|ModelNotReady|TooManyRequests/i;

export function usageOf(u: ConverseCommandOutput['usage']): Usage {
  return { input: u?.inputTokens ?? 0, output: u?.outputTokens ?? 0, cacheRead: u?.cacheReadInputTokens ?? 0, cacheWrite: u?.cacheWriteInputTokens ?? 0 };
}

/** Tokens charged against the budget: input + output, with cache reads at their ~10% cost weight. */
export function chargedTokens(u: ConverseCommandOutput['usage']): number {
  if (!u) return 0;
  return (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheWriteInputTokens ?? 0) + Math.ceil((u.cacheReadInputTokens ?? 0) * 0.1);
}

/** Appends blocks as a user turn, merging into a trailing user message (Converse requires alternating roles). */
export function appendUserTurn(messages: Message[], blocks: ContentBlock[]): void {
  const last = messages[messages.length - 1];
  if (last?.role === 'user') last.content = [...(last.content ?? []), ...blocks];
  else messages.push({ role: 'user', content: blocks });
}

async function callWithRetry(converse: ConverseFn, input: ConverseCommandInput, sleep: (ms: number) => Promise<void>): Promise<ConverseCommandOutput> {
  for (let attempt = 1; ; attempt++) {
    try { return await converse(input); }
    catch (e) {
      const name = `${(e as { name?: string }).name ?? ''} ${(e as Error).message ?? ''}`;
      if (attempt >= 6 || !RETRYABLE.test(name)) throw e;
      await sleep(Math.min(1000 * 2 ** (attempt - 1), 30_000) + Math.floor(Math.random() * 250));
    }
  }
}

export function buildRequest(a: Pick<LoopArgs, 'modelId' | 'phase' | 'branch' | 'maxOutputTokens' | 'repoSlug' | 'mode'>, messages: Message[]): ConverseCommandInput {
  return {
    modelId: a.modelId,
    // Cache points after the system prompt and after the tool definitions.
    system: [{ text: systemPrompt(a.phase, a.branch, a.repoSlug, a.mode) }, { cachePoint: { type: 'default' } }],
    toolConfig: {
      tools: [
        ...toolSpecs(a.phase, a.mode).map((t) => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.schema as never } } })),
        { cachePoint: { type: 'default' } },
      ],
    },
    messages: withMessageCachePoint(messages),
    inferenceConfig: { maxTokens: a.maxOutputTokens ?? 32_000 },
  };
}

/**
 * Marks the end of the conversation as cacheable, so each turn re-reads the earlier turns from cache instead of paying
 * full input price for them. Applied to a copy: the stored transcript never contains cache points.
 */
export function withMessageCachePoint(messages: Message[]): Message[] {
  if (messages.length === 0) return messages;
  const copy = messages.slice();
  const last = copy[copy.length - 1];
  copy[copy.length - 1] = { ...last, content: [...(last.content ?? []), { cachePoint: { type: 'default' } }] };
  return copy;
}

const textOf = (m?: Message) => (m?.content ?? []).flatMap((b) => (b.text ? [b.text] : [])).join('\n').trim();

async function summarize(a: LoopArgs, messages: Message[], sleep: (ms: number) => Promise<void>): Promise<{ text: string; tokens: number; usage: Usage }> {
  const probe: Message[] = structuredClone(messages);
  appendUserTurn(probe, [{ text: 'You are out of budget. Do NOT call any tool. Reply with a concise markdown summary of what is done, what remains, and any blockers.' }]);
  const r = await callWithRetry(a.converse, buildRequest(a, probe), sleep);
  return { text: textOf(r.output?.message) || 'I ran out of budget before finishing. My progress is saved on the branch.', tokens: chargedTokens(r.usage), usage: usageOf(r.usage) };
}

/**
 * An independent session for one reviewer lens: clean context, read-only intent, and a terminal report tool.
 * Its token use counts against the parent's budget.
 */
export async function runSubagent(a: {
  converse: ConverseFn; modelId: string; toolCtx: ToolCtx; instructions: string; task: string;
  tokenBudget: number; maxTurns?: number; sleep: (ms: number) => Promise<void>;
}): Promise<{ report: string; tokens: number; ok: boolean; usage: Usage }> {
  const system = `${a.instructions}\n\nYou are an independent reviewer in a clean session with no memory of any earlier conversation. Read the code and run read-only commands (git diff, git log, git show, tests, linters). Do not modify, create or delete any files. Report only what you verified. When you are done, call report with your findings in markdown.`;
  const messages: Message[] = [{ role: 'user', content: [{ text: a.task }] }];
  const request = () => ({
    modelId: a.modelId, system: [{ text: system }, { cachePoint: { type: 'default' as const } }],
    toolConfig: { tools: [...subagentToolSpecs().map((t) => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.schema as never } } })), { cachePoint: { type: 'default' as const } }] },
    messages: withMessageCachePoint(messages), inferenceConfig: { maxTokens: 16_000 },
  });
  let tokens = 0; let nudges = 0; let usage = emptyUsage();
  for (let turn = 0; turn < (a.maxTurns ?? 40); turn++) {
    if (tokens >= a.tokenBudget) return { report: 'The reviewer ran out of token budget before reporting.', tokens, ok: false, usage };
    const res = await callWithRetry(a.converse, request(), a.sleep);
    tokens += chargedTokens(res.usage); usage = addUsage(usage, usageOf(res.usage));
    const msg = res.output?.message; if (!msg) throw new Error('subagent model returned no message');
    messages.push(msg);
    const uses = (msg.content ?? []).flatMap((b) => (b.toolUse ? [b.toolUse] : []));
    if (uses.length === 0) {
      if (nudges++ < 2) { appendUserTurn(messages, [{ text: 'Call report with your findings when you are done.' }]); continue; }
      return { report: textOf(msg) || 'The reviewer produced no report.', tokens, ok: true, usage };
    }
    const results: ToolResultBlock[] = []; let report: string | undefined;
    for (const u of uses) {
      const input = (u.input ?? {}) as Record<string, unknown>;
      if (u.name === 'report') { report ??= String(input.markdown ?? ''); results.push({ toolUseId: u.toolUseId, content: [{ text: 'Report delivered.' }] }); continue; }
      const r = await execTool(u.name!, input, a.toolCtx);
      results.push({
        toolUseId: u.toolUseId, status: r.isError ? 'error' : 'success',
        content: r.image ? [{ text: r.text }, { image: { format: r.image.format, source: { bytes: r.image.bytes } } }] : [{ text: r.text || '(no output)' }],
      });
    }
    appendUserTurn(messages, results.map((toolResult) => ({ toolResult })));
    if (report !== undefined) return { report: report || 'The reviewer delivered an empty report.', tokens, ok: true, usage };
  }
  return { report: 'The reviewer hit its turn limit before reporting.', tokens, ok: false, usage };
}

export async function runAgent(a: LoopArgs): Promise<LoopResult> {
  const sleep = a.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const messages = a.messages;
  let tokensUsed = 0; let nudges = 0; let usage = emptyUsage();

  for (let turn = 0; turn < a.maxTurns; turn++) {
    if (tokensUsed >= a.tokenBudgetRemaining) break;
    const res = await callWithRetry(a.converse, buildRequest(a, messages), sleep);
    tokensUsed += chargedTokens(res.usage); usage = addUsage(usage, usageOf(res.usage));
    const assistant = res.output?.message;
    if (!assistant) throw new Error('model returned no message');
    messages.push(assistant);

    const uses = (assistant.content ?? []).flatMap((b) => (b.toolUse ? [b.toolUse] : []));
    if (uses.length === 0) {
      // The model answered in prose. Nudge it toward a terminal tool, then fall back to treating the prose as questions.
      if (res.stopReason === 'max_tokens') { appendUserTurn(messages, [{ text: 'Your reply was cut off. Continue, using tools.' }]); continue; }
      if (nudges++ < 2) { appendUserTurn(messages, [{ text: 'Call finish when the work is complete, or ask_questions if you are blocked.' }]); continue; }
      const text = textOf(assistant) || 'I could not make progress.';
      return { outcome: { type: 'questions', markdown: text }, messages, tokensUsed, usage };
    }

    // Execute every requested tool, in order; results go back in one user turn.
    const results: ToolResultBlock[] = []; let terminal: { name: string; input: Record<string, unknown> } | undefined;
    for (const u of uses) {
      const input = (u.input ?? {}) as Record<string, unknown>;
      if (TERMINAL.has(u.name!)) {
        if (!terminal) terminal = { name: u.name!, input };
        results.push({ toolUseId: u.toolUseId, content: [{ text: 'Recorded. The harness will publish this and wait for humans.' }] });
      } else if (u.name === 'run_subagent' && a.mode === 'factory') {
        const sub = await runSubagent({
          converse: a.converse, modelId: a.modelId, toolCtx: a.toolCtx, sleep,
          instructions: String(input.instructions ?? ''), task: String(input.task ?? ''),
          tokenBudget: Math.max(0, a.tokenBudgetRemaining - tokensUsed),
        });
        tokensUsed += sub.tokens; usage = addUsage(usage, sub.usage);
        results.push({ toolUseId: u.toolUseId, content: [{ text: sub.report }], status: sub.ok ? 'success' : 'error' });
      } else {
        const r = await execTool(u.name!, input, a.toolCtx);
        results.push({
          toolUseId: u.toolUseId, status: r.isError ? 'error' : 'success',
          content: r.image ? [{ text: r.text }, { image: { format: r.image.format, source: { bytes: r.image.bytes } } }] : [{ text: r.text || '(no output)' }],
        });
      }
    }
    appendUserTurn(messages, results.map((toolResult) => ({ toolResult })));

    if (terminal) {
      if (terminal.name === 'ask_questions') {
        const markdown = typeof terminal.input.markdown === 'string' ? terminal.input.markdown : '';
        return { outcome: { type: 'questions', markdown: markdown || '(no questions provided)' }, messages, tokensUsed, usage };
      }
      if (a.phase === 'IMPLEMENT') {
        const title = String(terminal.input.title ?? '').trim() || 'Implement issue';
        return { outcome: { type: 'done', pr: { title, body: String(terminal.input.body ?? '') } }, messages, tokensUsed, usage };
      }
      return { outcome: { type: 'revised', summaryMarkdown: String(terminal.input.summary ?? '') || 'Addressed the feedback.' }, messages, tokensUsed, usage };
    }
  }

  const s = await summarize(a, messages, sleep);
  return { outcome: { type: 'budget_exhausted', summaryMarkdown: s.text }, messages, tokensUsed: tokensUsed + s.tokens, usage: addUsage(usage, s.usage) };
}
