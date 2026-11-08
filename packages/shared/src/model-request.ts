import type { AgentBackend, ModelOverride } from './config.ts';

export interface ModelRequestResult {
  /** True when the text contains something that reads like a request for a specific backend or model at all. */
  requested: boolean;
  /** Set when the request was clear enough to act on without asking anyone. */
  resolved?: ModelOverride;
  /**
   * Set when a request was recognized but could not be pinned down with confidence. `markdown` is the comment to
   * post asking for clarification; `bestGuess` is what the agent uses in the meantime.
   */
  clarification?: { markdown: string; bestGuess: ModelOverride };
}

const ENGINES: Array<{ backend: AgentBackend; name: string; re: RegExp }> = [
  // A bare "claude" immediately followed by a model family name (with or without a hyphen, e.g. "claude-sonnet-5-5"
  // or "claude sonnet 5.5") is a model name, not a request to run on the Claude Code backend.
  { backend: 'claude-code', name: 'Claude Code', re: /\bclaude(?:[\s-]?code)?\b(?!-?\s*(?:sonnet|opus|haiku))/i },
  { backend: 'bedrock', name: 'Amazon Bedrock', re: /\b(?:amazon\s+|aws\s+)?bedrock\b/i },
];

const engineName = (b: AgentBackend) => ENGINES.find((e) => e.backend === b)!.name;

/** Never includes `modelId` at all when there is none: callers persist this, and DynamoDB rejects an explicit `undefined`. */
const override = (backend: AgentBackend, modelId?: string): ModelOverride => (modelId ? { backend, modelId } : { backend });

/** Anthropic model families both backends can run. Everything else is Bedrock-only, and only by its exact id: there is no verified catalog of ids to guess from. */
const ANTHROPIC_FAMILIES = ['sonnet', 'opus', 'haiku'];

const FAMILY_RE = /\b(sonnet|opus|haiku|kimi|nova|titan|llama|mistral|gemini|gpt)\b(?:[\s-]*(k?\d+(?:[.-]\d+)*))?/i;

/** A literal model/inference-profile id, given verbatim in backticks so there is nothing to guess. */
const LITERAL_RE = /`([^`]+)`/;

/** Clauses that introduce a backend/model request, e.g. "use claude and sonnet 5.5", "switch to bedrock". Runs to the end of the line, not the sentence, so a decimal version like "5.5" or a backtick-quoted id is never cut short. */
const DIRECTIVE_RE = /\b(?:please\s+)?(?:use|switch(?:\s+it)?\s+to|run\s+(?:it\s+)?(?:with|on))\s+([^\n]{1,160})/gi;

const describe = (o: ModelOverride): string => (o.modelId ? `${engineName(o.backend)} with \`${o.modelId}\`` : `${engineName(o.backend)}, with its default model`);

const clarifyMarkdown = (bestGuess: ModelOverride, reason: string): string =>
  `${reason}. For now I will use ${describe(bestGuess)}. If that is not right, tell me exactly which backend ` +
  '(Claude Code or Amazon Bedrock) and model you want, for example "use claude and sonnet 5.5", "use bedrock and sonnet 5.5", ' +
  'or a literal model/inference-profile id in backticks.';

/** Builds a model id for a known Anthropic family and version, in the shape each backend expects. Undefined for anything else: we do not guess ids we cannot verify. */
function buildModelId(backend: AgentBackend, family: string, version: string): string | undefined {
  if (!ANTHROPIC_FAMILIES.includes(family)) return undefined;
  const id = `claude-${family}-${version.replace(/\./g, '-')}`;
  return backend === 'bedrock' ? `us.anthropic.${id}` : id;
}

/**
 * Looks for a request to run on a particular backend/model, e.g. "use claude and sonnet 5.5" or "use bedrock and
 * kimi k3". `currentBackend` is used as the engine for a clear model-only request, and as the fallback when nothing
 * can be told at all.
 *
 *  - Both backend and model clear (a known Anthropic family and version) -> `resolved`, applied silently.
 *  - Something was asked for but is not clear enough (no backend, an unversioned or non-Anthropic model, or an
 *    unrecognized clause) -> `clarification`, with a question to ask and the agent's best guess to use meanwhile.
 *  - Nothing that reads like a request -> neither is set.
 */
export function parseModelRequest(text: string, currentBackend: AgentBackend): ModelRequestResult {
  for (const m of text.matchAll(DIRECTIVE_RE)) {
    const clause = m[1];
    const engine = ENGINES.find((e) => e.re.test(clause));
    const literal = LITERAL_RE.exec(clause)?.[1];
    const family = FAMILY_RE.exec(clause);
    if (!engine && !literal && !family) continue; // this clause is not about models or backends

    if (literal) {
      if (engine) return { requested: true, resolved: override(engine.backend, literal) };
      const bestGuess = override(currentBackend, literal);
      return { requested: true, clarification: { bestGuess, markdown: clarifyMarkdown(bestGuess, `I found the model id \`${literal}\` but could not tell which backend to run it on`) } };
    }

    if (engine && !family) return { requested: true, resolved: override(engine.backend) };

    if (family) {
      const name = family[1].toLowerCase();
      const version = family[2];
      const isAnthropic = ANTHROPIC_FAMILIES.includes(name);
      const backend = engine?.backend ?? currentBackend;
      const modelId = version && isAnthropic ? buildModelId(backend, name, version) : undefined;
      if (engine && version && isAnthropic) return { requested: true, resolved: override(backend, modelId) };

      const reason = !engine
        ? `I could not tell whether you want Claude Code or Amazon Bedrock for "${name}${version ? ` ${version}` : ''}"`
        : !isAnthropic
          ? `"${name}" is not an Anthropic model, so I do not have a confirmed id for it on ${engineName(engine.backend)}`
          : `I could not tell which version of "${name}" you want`;
      const bestGuess = override(backend, modelId);
      return { requested: true, clarification: { bestGuess, markdown: clarifyMarkdown(bestGuess, reason) } };
    }

    // The clause names a backend but nothing else was recognized in it.
    const bestGuess = override(currentBackend);
    return { requested: true, clarification: { bestGuess, markdown: clarifyMarkdown(bestGuess, 'I could not tell which model or backend you mean') } };
  }
  return { requested: false };
}
