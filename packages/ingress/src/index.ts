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
    log: (msg, extra) => console.log(JSON.stringify({ msg, ...extra })),
  };
  const r = await processWebhook(deps, { headers: event.headers ?? {}, rawBody });
  return { statusCode: r.status, body: r.body };
}
