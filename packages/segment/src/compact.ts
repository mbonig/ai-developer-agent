import type { Message } from '@aws-sdk/client-bedrock-runtime';
import type { ConverseFn } from './loop.ts';
import { chargedTokens, usageOf } from './loop.ts';
import { emptyUsage, type Usage } from '@agent/shared';

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

/**
 * If the transcript is over the threshold, replace it with one user turn holding a model-written summary,
 * the outstanding questions and answers, and the current diff against the default branch.
 */
export async function compactIfNeeded(a: {
  converse: ConverseFn; modelId: string; messages: Message[]; thresholdTokens: number; diff: string;
}): Promise<{ messages: Message[]; compacted: boolean; tokensUsed: number; usage: Usage }> {
  if (estimateTokens(a.messages) <= a.thresholdTokens) return { messages: a.messages, compacted: false, tokensUsed: 0, usage: emptyUsage() };

  const res = await a.converse({
    modelId: a.modelId,
    system: [{ text: 'You summarize an engineering session so another engineer can continue it. Be specific and factual.' }],
    messages: [{ role: 'user', content: [{ text:
      `Summarize this session. Include: the goal, decisions made and why, what is done, what remains, important files, ` +
      `and every question asked of humans together with its answer or "unanswered".\n\n<transcript>\n${render(a.messages)}\n</transcript>` }] }],
    inferenceConfig: { maxTokens: 8000 },
  });
  const summary = (res.output?.message?.content ?? []).map((b) => b.text ?? '').join('\n').trim();
  if (!summary) throw new Error('compaction produced no summary');
  const diff = a.diff.length > MAX_DIFF_CHARS ? `${a.diff.slice(0, MAX_DIFF_CHARS)}\n...[diff truncated]...` : a.diff;
  const text = `Summary of the work so far (earlier messages were compacted):\n\n${summary}\n\nCurrent changes on the branch versus the default branch:\n\`\`\`diff\n${diff || '(no changes yet)'}\n\`\`\``;
  return { messages: [{ role: 'user', content: [{ text }] }], compacted: true, tokensUsed: chargedTokens(res.usage), usage: usageOf(res.usage) };
}
