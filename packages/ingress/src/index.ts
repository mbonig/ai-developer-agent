import { LambdaClient, InvokeCommand, SendDurableExecutionCallbackSuccessCommand } from '@aws-sdk/client-lambda';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { processWebhook, type Deps } from './process.ts';

const lambda = new LambdaClient({});
const secrets = new SecretsManagerClient({});
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
let secretCache: string | undefined;

// The webhook secret is read by the function at runtime (the role is granted read on this one secret only).
async function webhookSecret(): Promise<string> {
  secretCache ??= (await secrets.send(new GetSecretValueCommand({ SecretId: process.env.WEBHOOK_SECRET_ARN! }))).SecretString!;
  return secretCache;
}

/** Posts an issue or pull request comment as the GitHub App, with a token from the token vendor. */
async function postComment(a: { installationId: number; owner: string; repo: string; number: number; body: string }): Promise<void> {
  const t = await lambda.send(new InvokeCommand({
    FunctionName: process.env.TOKEN_VENDOR_FUNCTION!, Payload: JSON.stringify({ installationId: a.installationId, repo: a.repo }),
  }));
  if (t.FunctionError) throw new Error('token vendor failed');
  const token = JSON.parse(Buffer.from(t.Payload!).toString()).token as string;
  const r = await fetch(`https://api.github.com/repos/${a.owner}/${a.repo}/issues/${a.number}/comments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'ai-developer-agent' },
    body: JSON.stringify({ body: a.body }),
  });
  if (!r.ok) throw new Error(`GitHub comment failed: ${r.status}`);
}

const safeName = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 60);

export async function handler(event: { headers: Record<string, string>; body?: string; isBase64Encoded?: boolean }) {
  const rawBody = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '');
  const deps: Deps = {
    store: { doc, table: process.env.TABLE_NAME! },
    config: { agentLabel: process.env.AGENT_LABEL || 'agent', githubOrg: process.env.GITHUB_ORG || 'mbonig', maxTokensPerIssue: Number(process.env.MAX_TOKENS_PER_ISSUE || 0) },
    webhookSecret: await webhookSecret(),
    async startExecution(issueKey, attempt) {
      const r = await lambda.send(new InvokeCommand({
        FunctionName: process.env.ORCHESTRATOR_FUNCTION_ARN!, // must be a qualified (alias) ARN
        InvocationType: 'Event',
        DurableExecutionName: `${safeName(issueKey)}-${attempt}`,
        Payload: JSON.stringify({ issueKey }),
      }));
      return (r as { DurableExecutionArn?: string }).DurableExecutionArn ?? '';
    },
    async sendCallback(callbackId, payload) {
      await lambda.send(new SendDurableExecutionCallbackSuccessCommand({
        CallbackId: callbackId, Result: Buffer.from(JSON.stringify(payload)),
      }));
    },
    ...(process.env.TOKEN_VENDOR_FUNCTION ? { postComment } : {}),
    log: (msg, extra) => console.log(JSON.stringify({ msg, ...extra })),
  };
  const r = await processWebhook(deps, { headers: event.headers ?? {}, rawBody });
  return { statusCode: r.status, body: r.body };
}
