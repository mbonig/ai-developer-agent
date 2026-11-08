import { BedrockRuntimeClient, ConverseCommand, type Message } from '@aws-sdk/client-bedrock-runtime';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  LambdaClient, InvokeCommand, SendDurableExecutionCallbackSuccessCommand, SendDurableExecutionCallbackFailureCommand,
} from '@aws-sdk/client-lambda';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { listMessages, loadConfig, parseAgentBackend, type SegmentJob } from '@agent/shared';
import { createSegmentServer } from './server.ts';
import { runSegment, type HarnessDeps } from './harness.ts';
import { lockDownMetadata, sandboxActive } from './sandbox.ts';
import { selftest } from './selftest.ts';
import { parseTranscript, serializeTranscript } from './transcript.ts';

const factoryStateKey = (job: SegmentJob) => `factory-state/${job.owner}/${job.repo}/${job.issueNumber}.tgz`;
const claudeSessionKey = (job: SegmentJob) => `claude-session/${job.owner}/${job.repo}/${job.issueNumber}.tgz`;

// `node segment.mjs --mcp-server` is how Claude Code starts the harness's MCP server (the outcome tools).
if (process.argv.includes('--mcp-server')) {
  const { runMcpServer } = await import('./mcp-server.ts');
  runMcpServer();
  await new Promise(() => {}); // runs until Claude Code closes its end
}

/** Builds AWS clients. Called only after a job arrives, never at image snapshot time. */
function buildDeps(): HarnessDeps {
  const config = loadConfig(process.env);
  const region = process.env.AWS_REGION ?? process.env.AGENT_REGION;
  const lambda = new LambdaClient({ region });
  const s3 = new S3Client({ region });
  const bedrock = new BedrockRuntimeClient({ region });
  const store = { doc: DynamoDBDocumentClient.from(new DynamoDBClient({ region })), table: process.env.TABLE_NAME! };
  const bucket = process.env.TRANSCRIPT_BUCKET!;

  return {
    config,
    async getToken(installationId, repo) {
      const r = await lambda.send(new InvokeCommand({ FunctionName: process.env.TOKEN_VENDOR_FUNCTION!, Payload: JSON.stringify({ installationId, repo }) }));
      if (r.FunctionError) throw new Error('token vendor failed');
      return JSON.parse(Buffer.from(r.Payload!).toString()).token as string;
    },
    async getIssue(token, owner, repo, number) {
      const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${number}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'ai-developer-agent' },
      });
      if (!r.ok) throw new Error(`GitHub issue fetch failed: ${r.status}`);
      const j = (await r.json()) as { title: string; body?: string | null; user?: { login?: string } };
      return { title: j.title, body: j.body ?? '', author: j.user?.login ?? 'unknown' };
    },
    async loadTranscript(key) {
      try {
        const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return parseTranscript(await r.Body!.transformToString());
      } catch (e) {
        if ((e as { name?: string }).name === 'NoSuchKey') return undefined;
        throw e;
      }
    },
    async saveTranscript(key, messages) {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: serializeTranscript(messages), ContentType: 'application/json' }));
    },
    enableFactory: process.env.ENABLE_FACTORY === 'true',
    // The swamp-club collective token the swamp CLI needs. "UNSET" is the placeholder the stack creates, meaning not configured yet.
    async getSwampKey() {
      const arn = process.env.SWAMP_API_KEY_SECRET_ARN;
      if (!arn) return undefined;
      const v = (await new SecretsManagerClient({ region }).send(new GetSecretValueCommand({ SecretId: arn }))).SecretString?.trim();
      return v && v !== 'UNSET' ? v : undefined;
    },
    // Which backend runs the agent, and for Claude Code the subscription token from `claude setup-token` ("UNSET" = not configured).
    // Read per segment from SSM so the backend can be flipped without a redeploy. AGENT_BACKEND is the fallback when no parameter is configured.
    async getAgentBackend() {
      const name = process.env.AGENT_BACKEND_PARAM;
      if (!name) return config.agentBackend;
      const r = await new SSMClient({ region }).send(new GetParameterCommand({ Name: name }));
      return parseAgentBackend(r.Parameter?.Value, name);
    },
    async getClaudeToken() {
      const arn = process.env.CLAUDE_CODE_TOKEN_SECRET_ARN;
      if (!arn) return undefined;
      const v = (await new SecretsManagerClient({ region }).send(new GetSecretValueCommand({ SecretId: arn }))).SecretString?.trim();
      return v && v !== 'UNSET' ? v : undefined;
    },
    async loadClaudeSession(job) {
      try {
        const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: claudeSessionKey(job) }));
        return Buffer.from(await r.Body!.transformToByteArray());
      } catch (e) {
        if ((e as { name?: string }).name === 'NoSuchKey') return undefined;
        throw e;
      }
    },
    async saveDebugLog(job, text) {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `debug/${job.owner}/${job.repo}/${job.issueNumber}/${job.segmentSeq}.log`, Body: text, ContentType: 'text/plain' }));
    },
    async saveClaudeSession(job, state) {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: claudeSessionKey(job), Body: state, ContentType: 'application/gzip' }));
    },
    async loadFactoryState(job) {
      try {
        const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: factoryStateKey(job) }));
        return Buffer.from(await r.Body!.transformToByteArray());
      } catch (e) {
        if ((e as { name?: string }).name === 'NoSuchKey') return undefined;
        throw e;
      }
    },
    async saveFactoryState(job, state) {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: factoryStateKey(job), Body: state, ContentType: 'application/gzip' }));
    },
    loadInbox: (job) => listMessages(store, job.issueKey, job.inbox.fromExclusive, job.inbox.toInclusive),
    converse: (input) => bedrock.send(new ConverseCommand(input)),
    async reportSuccess(callbackId, result) {
      await lambda.send(new SendDurableExecutionCallbackSuccessCommand({ CallbackId: callbackId, Result: Buffer.from(JSON.stringify(result)) }));
    },
    async reportFailure(callbackId, code, message) {
      await lambda.send(new SendDurableExecutionCallbackFailureCommand({ CallbackId: callbackId, Error: { ErrorType: code, ErrorMessage: message } }));
    },
    log: (msg, extra) => console.log(JSON.stringify({ msg, ...extra })),
  };
}

if (process.argv.includes('--selftest')) {
  console.log(JSON.stringify(await selftest(), null, 2));
  process.exit(0);
}

// Block the metadata service for the agent user. Applied now and again on the run hook (kernel state may not survive a restore).
const applyLockdown = () => { if (sandboxActive()) try { lockDownMetadata(); } catch (e) { console.error(JSON.stringify({ msg: 'lockdown failed', error: String(e) })); } };
applyLockdown();

const server = createSegmentServer((job: SegmentJob) => runSegment(buildDeps(), job), { onRunHook: applyLockdown, requireKey: process.env.REQUIRE_SEGMENT_KEY !== 'off' });
server.listen(8080, () => console.log(JSON.stringify({ msg: 'segment server listening', port: 8080 })));
