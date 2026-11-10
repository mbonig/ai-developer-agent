export type AgentBackend = 'bedrock' | 'claude-code';

/** A per-issue override of which backend (and optionally which model) runs the agent, in place of the deployment default. */
export interface ModelOverride {
  backend: AgentBackend;
  /** The backend's own model id (a Claude Code `--model` value, or a Bedrock model/inference-profile id). Omitted means that backend's configured default. */
  modelId?: string;
}

/** Validates a backend name from configuration. `source` names where it came from, for the error message. */
export function parseAgentBackend(value: string | undefined, source: string): AgentBackend {
  const v = value?.trim();
  if (v !== 'bedrock' && v !== 'claude-code') throw new Error(`${source} must be "bedrock" or "claude-code", got "${value ?? ''}"`);
  return v;
}

export interface Config {
  /** Which model backend runs the agent: Amazon Bedrock (default) or Claude Code on a Claude subscription. */
  agentBackend: AgentBackend;
  githubOrg: string;
  agentLabel: string;
  bedrockModelId: string;
  maxTokensPerIssue: number;
  /** Claude Code runs on a subscription, so its tokens count 1/N against maxTokensPerIssue (N times the raw tokens). Bedrock tokens count in full. */
  claudeCodeBudgetMultiplier: number;
  maxTurnsPerSegment: number;
  transcriptCompactTokens: number;
  humanWaitTimeoutSeconds: number;
  segmentTimeoutSeconds: number;
  segmentMaxAttempts: number;
  wakeDebounceSeconds: number;
  runCommandTimeoutSeconds: number;
  toolOutputMaxBytes: number;
  prDraft: boolean;
  sweeperIntervalMinutes: number;
  microvmVcpu: number;
  microvmMemoryGb: number;
}

type Env = Record<string, string | undefined>;

function int(env: Env, name: string, def?: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    if (def === undefined) throw new Error(`Missing required config ${name}`);
    return def;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Config ${name} must be a positive integer, got "${raw}"`);
  return n;
}

export function loadConfig(env: Env = process.env): Config {
  const backend = parseAgentBackend(env.AGENT_BACKEND || 'claude-code', 'AGENT_BACKEND');
  // The Bedrock model id is only needed by the Bedrock backend.
  const modelId = env.BEDROCK_MODEL_ID || (backend === 'claude-code' ? 'claude-code' : '');
  if (!modelId) throw new Error('Missing required config BEDROCK_MODEL_ID');
  return {
    agentBackend: backend,
    githubOrg: env.GITHUB_ORG || 'mbonig',
    agentLabel: env.AGENT_LABEL || 'agent',
    bedrockModelId: modelId,
    maxTokensPerIssue: int(env, 'MAX_TOKENS_PER_ISSUE'),
    claudeCodeBudgetMultiplier: int(env, 'CLAUDE_CODE_BUDGET_MULTIPLIER', 2),
    maxTurnsPerSegment: int(env, 'MAX_TURNS_PER_SEGMENT', 150),
    transcriptCompactTokens: int(env, 'TRANSCRIPT_COMPACT_TOKENS', 120000),
    humanWaitTimeoutSeconds: int(env, 'HUMAN_WAIT_TIMEOUT_SECONDS', 7 * 86400),
    segmentTimeoutSeconds: int(env, 'SEGMENT_TIMEOUT_SECONDS', 7200),
    segmentMaxAttempts: int(env, 'SEGMENT_MAX_ATTEMPTS', 2),
    wakeDebounceSeconds: int(env, 'WAKE_DEBOUNCE_SECONDS', 60),
    runCommandTimeoutSeconds: int(env, 'RUN_COMMAND_TIMEOUT_SECONDS', 600),
    toolOutputMaxBytes: int(env, 'TOOL_OUTPUT_MAX_BYTES', 32768),
    prDraft: env.PR_DRAFT === 'true',
    sweeperIntervalMinutes: int(env, 'SWEEPER_INTERVAL_MINUTES', 15),
    microvmVcpu: int(env, 'MICROVM_VCPU', 4),
    microvmMemoryGb: int(env, 'MICROVM_MEMORY_GB', 8),
  };
}
