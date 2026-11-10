import { withDurableExecution, type DurableContext } from '@aws/durable-execution-sdk-js';
import { LambdaClient, InvokeCommand, SendDurableExecutionCallbackSuccessCommand } from '@aws-sdk/client-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { loadConfig } from '@agent/shared';
import { orchestrate, type OrchDeps } from './orchestrate.ts';
import { createGithubApi } from './github.ts';
import type { SegmentLauncher } from './launcher.ts';
import { createMicrovmLauncher } from './microvm-launcher.ts';
import { createMicrovmAwsApi } from './microvm-aws.ts';

const lambda = new LambdaClient({});
const ssm = new SSMClient({});
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));

async function installationToken(installationId: number, repo: string): Promise<string> {
  const r = await lambda.send(new InvokeCommand({
    FunctionName: process.env.TOKEN_VENDOR_FUNCTION!, Payload: JSON.stringify({ installationId, repo }),
  }));
  if (r.FunctionError) throw new Error(`token vendor failed: ${Buffer.from(r.Payload ?? []).toString().slice(0, 200)}`);
  return JSON.parse(Buffer.from(r.Payload!).toString()).token as string;
}

/** The durable SDK truncates step errors in its history, so log launcher failures where we can read them. */
function withErrorLogging(l: SegmentLauncher): SegmentLauncher {
  const log = (op: string, e: unknown) => console.error(JSON.stringify({ msg: `launcher ${op} failed`, name: (e as Error)?.name, error: String((e as Error)?.message ?? e).slice(0, 500) }));
  return {
    launch: (job) => l.launch(job).catch((e) => { log('launch', e); throw e; }),
    terminate: (id) => l.terminate(id).catch((e) => { log('terminate', e); throw e; }),
  };
}

let versionCache: { v: string; at: number } | undefined;
/** Latest active image version, cached briefly. Falls back to an env override for tests. */
async function imageVersion(): Promise<string> {
  if (process.env.MICROVM_IMAGE_VERSION) return process.env.MICROVM_IMAGE_VERSION;
  if (versionCache && Date.now() - versionCache.at < 300_000) return versionCache.v;
  const r = await ssm.send(new GetParameterCommand({ Name: process.env.MICROVM_IMAGE_VERSION_PARAM! }));
  versionCache = { v: r.Parameter!.Value!, at: Date.now() };
  return versionCache.v;
}

async function buildDeps(): Promise<OrchDeps> {
  const imageVersionNow = await imageVersion();
  const config = loadConfig(process.env);
  return {
    store: { doc, table: process.env.TABLE_NAME! },
    config,
    github: createGithubApi(installationToken),
    launcher: withErrorLogging(createMicrovmLauncher(createMicrovmAwsApi(), {
      imageArn: process.env.MICROVM_IMAGE_ARN!, imageVersion: imageVersionNow,
      executionRoleArn: process.env.SEGMENT_ROLE_ARN!, segmentTimeoutSeconds: config.segmentTimeoutSeconds,
    })),
    log: (msg, extra) => console.log(JSON.stringify({ msg, ...extra })),
    async sendCallback(callbackId, payload) {
      await lambda.send(new SendDurableExecutionCallbackSuccessCommand({ CallbackId: callbackId, Result: Buffer.from(JSON.stringify(payload)) }));
    },
  };
}

export const handler = withDurableExecution(async (event: { issueKey: string }, ctx: DurableContext) => {
  const result = await orchestrate(ctx, event, await buildDeps());
  console.log(JSON.stringify({ msg: 'issue finished', issueKey: event.issueKey, status: result.status }));
  return result;
});
