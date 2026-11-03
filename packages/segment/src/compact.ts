import type { Message } from '@aws-sdk/client-bedrock-runtime';
import type { ConverseFn } from './loop.ts';
import { callWithRetry, chargedTokens, usageOf } from './loop.ts';
import { addUsage, emptyUsage, type Usage } from '@agent/shared';

/** Rough size estimate: ~3.5 characters per token over everything the model would see. */
export function estimateTokens(messages: Message[]): number {
  return Math.ceil(JSON.stringify(messages).length / 3.5);
}

function render(messages: Message[]): string {
  return messages.map((m) => {
    const parts = (m.content ?? []).map((b) => {
      if (b.text) return b.text;
      if (b.toolUse) return `[tool call ${b.toolUse.name} ${JSON.stringify(b.toolUse.input).slice(0, 400)}]`;
      if (b.toolResult) return `[tool result ${(b.toolResult.content ?? []).map((c) => c.text ?? '').join(' ').slice(0, 500)}]`;
      return '';
    }).filter(Boolean);
    return `${m.role!.toUpperCase()}: ${parts.join('\n')}`;
  }).join('\n\n');
}

const MAX_DIFF_CHARS = 60_000;
const HEAD_CHARS = 40_000;      // the request and the early plan
const TAIL_CHARS = 360_000;     // the most recent work
const FALLBACK_TAIL_CHARS = 60_000;

/** The transcript as text, bounded so a very long run cannot make the summary request itself huge. */
function renderBounded(messages: Message[]): string {
  const full = render(messages);
  if (full.length <= HEAD_CHARS + TAIL_CHARS) return full;
  return `${full.slice(0, HEAD_CHARS)}\n\n...[the middle of the transcript is omitted]...\n\n${full.slice(-TAIL_CHARS)}`;
}

/**
 * If the transcript is over the threshold, replace it with one user turn holding a model-written summary,
 * the outstanding questions and answers, and the current diff against the default branch.
 *
 * Compaction must never fail a run. The model reasons before it writes, so a small output allowance can be used up before any
 * text appears: the request is retried with a larger one, and if there is still no summary the end of the real transcript is
 * used instead.
 */
export async function compactIfNeeded(a: {
  converse: ConverseFn; modelId: string; messages: Message[]; thresholdTokens: number; diff: string;
  sleep?: (ms: number) => Promise<void>; log?: (msg: string, extra?: Record<string, unknown>) => void;
}): Promise<{ messages: Message[]; compacted: boolean; tokensUsed: number; usage: Usage; usedFallback?: boolean }> {
  if (estimateTokens(a.messages) <= a.thresholdTokens) return { messages: a.messages, compacted: false, tokensUsed: 0, usage: emptyUsage() };

  const sleep = a.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const transcript = renderBounded(a.messages);
  let usage = emptyUsage(); let tokens = 0; let summary = '';
  for (const maxTokens of [32_000, 64_000]) {
    try {
      const res = await callWithRetry(a.converse, {
        modelId: a.modelId,
        system: [{ text: 'You summarize an engineering session so another engineer can continue it. Be specific and factual. Reply with the summary as plain text.' }],
        messages: [{ role: 'user', content: [{ text:
          `Summarize this session. Include: the goal, decisions made and why, what is done, what remains, important files, ` +
          `and every question asked of humans together with its answer or "unanswered".\n\n<transcript>\n${transcript}\n</transcript>` }] }],
        inferenceConfig: { maxTokens },
      }, sleep);
      usage = addUsage(usage, usageOf(res.usage)); tokens += chargedTokens(res.usage);
      summary = (res.output?.message?.content ?? []).map((b) => b.text ?? '').join('\n').trim();
      if (summary) break;
      a.log?.('compaction returned no text, retrying with a larger output allowance', { maxTokens, stopReason: res.stopReason });
    } catch (e) {
      a.log?.('compaction request failed', { maxTokens, error: String((e as Error)?.message ?? e).slice(0, 200) });
    }
  }
  let usedFallback = false;
  if (!summary) {
    usedFallback = true;
    summary = `(An automatic summary could not be produced. This is the end of the earlier conversation, as text. Check the repository and any saved state for the rest.)\n\n${render(a.messages).slice(-FALLBACK_TAIL_CHARS)}`;
  }
  const diff = a.diff.length > MAX_DIFF_CHARS ? `${a.diff.slice(0, MAX_DIFF_CHARS)}\n...[diff truncated]...` : a.diff;
  const text = `Summary of the work so far (earlier messages were compacted):\n\n${summary}\n\nCurrent changes on the branch versus the default branch:\n\`\`\`diff\n${diff || '(no changes yet)'}\n\`\`\``;
  return { messages: [{ role: 'user', content: [{ text }] }], compacted: true, tokensUsed: tokens, usage, usedFallback };
}
