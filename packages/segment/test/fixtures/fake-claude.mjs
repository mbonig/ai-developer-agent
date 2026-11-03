#!/usr/bin/env node
// A stand-in for the `claude` CLI. It speaks the same stream-json events (shapes captured from the real CLI) and, like the real
// harness MCP server would, writes the outcome file. FAKE_SCENARIO picks the behavior; FAKE_RECORD collects what it was run with.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const val = (flag) => { const i = args.indexOf(flag); return i === -1 ? undefined : args[i + 1]; };
const scenario = process.env.FAKE_SCENARIO ?? 'questions';
const sessionId = val('--session-id') ?? val('--resume') ?? 'no-session';
const mcp = JSON.parse(readFileSync(val('--mcp-config'), 'utf8')).mcpServers.harness;
const outcomeFile = mcp.env.HARNESS_OUTCOME_FILE; const phase = mcp.env.HARNESS_PHASE;

if (process.env.FAKE_RECORD) {
  appendFileSync(process.env.FAKE_RECORD, JSON.stringify({
    args, cwd: process.cwd(),
    env: { token: process.env.CLAUDE_CODE_OAUTH_TOKEN, scrub: process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, maxTurns: process.env.CLAUDE_CODE_MAX_TURNS, configDir: process.env.CLAUDE_CONFIG_DIR, home: process.env.HOME,
      awsVars: Object.keys(process.env).filter((k) => k.startsWith('AWS_')), swamp: process.env.SWAMP_API_KEY_FILE },
    sessionFileExisted: process.env.CLAUDE_CONFIG_DIR ? existsSync(join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'p', `${sessionId}.jsonl`)) : false,
  }) + '\n');
}
const emit = (o) => process.stdout.write(JSON.stringify({ ...o, session_id: sessionId }) + '\n');
const usage = (n = 1) => ({ input_tokens: 100 * n, cache_creation_input_tokens: 2000 * n, cache_read_input_tokens: 50000 * n, output_tokens: 300 * n });
const result = (extra = {}) => emit({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', num_turns: 4, result: 'All done.', total_cost_usd: 0.42, usage: usage(), ...extra });
const outcome = (tool, input) => writeFileSync(outcomeFile, JSON.stringify({ tool, input }));

emit({ type: 'system', subtype: 'init', cwd: process.cwd(), model: 'claude-fake' });
emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1793687400, rateLimitType: 'five_hour' } });
emit({ type: 'assistant', message: { id: 'msg_1', role: 'assistant', usage: usage() } });
// keep a copy of the session on disk, like the real CLI does, so the harness can save and restore it
if (process.env.CLAUDE_CONFIG_DIR) { mkdirSync(join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'p'), { recursive: true }); writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'p', `${sessionId}.jsonl`), '{"turn":1}\n'); }

const resumed = args.includes('--resume');
switch (scenario) {
  case 'questions': outcome('ask_questions', { markdown: 'Which colour?' }); result(); break;
  case 'finish': {
    writeFileSync(join(process.cwd(), 'feature.txt'), 'built by the fake\n');
    outcome('finish', phase === 'IMPLEMENT' ? { title: 'Add feature', body: 'Does it' } : { summary: 'Renamed things' }); result(); break;
  }
  case 'max_turns': result({ subtype: 'error_max_turns', is_error: true, terminal_reason: 'max_turns', result: '' }); break;
  case 'rate_limited': {
    emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 900, rateLimitType: 'five_hour' } });
    result({ subtype: 'error_during_execution', is_error: true, terminal_reason: 'error', result: '5-hour limit reached' }); break;
  }
  case 'error': result({ subtype: 'error_during_execution', is_error: true, terminal_reason: 'error', result: 'something broke' }); break;
  case 'nudge': if (resumed) outcome('finish', { title: 'After nudge', body: 'ok' }); result({ result: resumed ? 'done now' : 'I think I am finished.' }); break;
  case 'never_terminal': result({ result: 'Still just talking.' }); break;
  case 'budget': emit({ type: 'assistant', message: { id: 'msg_2', role: 'assistant', usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 5_000_000 } } }); await new Promise((r) => setTimeout(r, 30000)); break;
  case 'hang': await new Promise((r) => setTimeout(r, 30000)); break;
  default: throw new Error(`unknown scenario ${scenario}`);
}
