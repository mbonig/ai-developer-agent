import { existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

/**
 * A minimal MCP server (stdio, newline-delimited JSON-RPC) that Claude Code talks to. It exposes the two terminal tools the
 * Bedrock loop has, so both backends end a session the same way. A call writes {tool, input} to HARNESS_OUTCOME_FILE.
 * The first call wins.
 */
type Phase = 'IMPLEMENT' | 'REVIEW';

export function mcpTools(phase: Phase) {
  const str = (description: string) => ({ type: 'string', description });
  return [
    { name: 'ask_questions', description: 'Ask the humans on the issue or pull request questions and stop working until they reply. Use only when blocked. Call it once, then stop.',
      inputSchema: { type: 'object', properties: { markdown: str('The questions, as markdown') }, required: ['markdown'] } },
    phase === 'IMPLEMENT'
      ? { name: 'finish', description: 'Call when the work is complete. The harness commits your changes and opens a pull request with this title and body. Call it once, then stop.',
          inputSchema: { type: 'object', properties: { title: str('Pull request title'), body: str('Pull request description in markdown') }, required: ['title', 'body'] } }
      : { name: 'finish', description: 'Call when you have addressed the review feedback. The summary is posted on the pull request. Call it once, then stop.',
          inputSchema: { type: 'object', properties: { summary: str('Summary of what you changed, in markdown') }, required: ['summary'] } },
  ];
}

export interface McpEnv { outcomeFile: string; phase: Phase }

type Rpc = { jsonrpc: '2.0'; id?: number | string; method: string; params?: Record<string, unknown> };

/** Handles one JSON-RPC message. Returns the response to send, or undefined for notifications. */
export function handleMcp(msg: Rpc, env: McpEnv): Record<string, unknown> | undefined {
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
  if (msg.id === undefined) return undefined; // notification, such as notifications/initialized
  switch (msg.method) {
    case 'initialize':
      return reply({ protocolVersion: (msg.params?.protocolVersion as string) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'harness', version: '1.0.0' } });
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: mcpTools(env.phase) });
    case 'tools/call': {
      const name = String(msg.params?.name ?? ''); const input = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      if (!mcpTools(env.phase).some((t) => t.name === name)) return reply({ isError: true, content: [{ type: 'text', text: `unknown tool ${name}` }] });
      // A resumed session remembers the other phase's schema, so the model can call finish with the wrong fields. Reject so it corrects itself.
      const required = ((mcpTools(env.phase).find((t) => t.name === name)?.inputSchema as { required?: string[] }).required) ?? [];
      const missing = required.filter((k) => typeof input[k] !== 'string' || !(input[k] as string).trim());
      if (missing.length) return reply({ isError: true, content: [{ type: 'text', text: `Not recorded. ${name} requires: ${required.join(', ')}. Missing: ${missing.join(', ')}. Call it again with those fields.` }] });
      if (existsSync(env.outcomeFile)) return reply({ content: [{ type: 'text', text: 'An outcome was already recorded. Stop now.' }] });
      writeFileSync(env.outcomeFile, JSON.stringify({ tool: name, input }));
      return reply({ content: [{ type: 'text', text: 'Recorded. Stop now: the harness will publish your work and wait for the humans.' }] });
    }
    default: return fail(-32601, `method not found: ${msg.method}`);
  }
}

export function runMcpServer(env: McpEnv = { outcomeFile: process.env.HARNESS_OUTCOME_FILE ?? '', phase: process.env.HARNESS_PHASE === 'REVIEW' ? 'REVIEW' : 'IMPLEMENT' }): void {
  if (!env.outcomeFile) { console.error('HARNESS_OUTCOME_FILE is required'); process.exit(2); }
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg: Rpc;
    try { msg = JSON.parse(line); } catch { return; }
    const res = handleMcp(msg, env);
    if (res) process.stdout.write(JSON.stringify(res) + '\n');
  });
  rl.on('close', () => process.exit(0));
}
