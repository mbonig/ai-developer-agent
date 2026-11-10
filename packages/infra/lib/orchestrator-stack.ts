import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import { bundle } from './bundle.ts';
import { settings } from './props.ts';
import { IMAGE_VERSION_PARAM, type SandboxStack } from './sandbox-stack.ts';
import type { StateStack } from './state-stack.ts';

export interface OrchestratorProps extends StackProps { state: StateStack; sandbox: SandboxStack }

/** The per-issue durable orchestrator. Ingress and segments reach it through the `live` alias. */
export class OrchestratorStack extends Stack {
  readonly fn: lambda.Function;
  readonly alias: lambda.Alias;

  constructor(scope: Construct, id: string, props: OrchestratorProps) {
    super(scope, id, props);
    const cfg = settings(this);
    const { state, sandbox } = props;

    this.fn = new lambda.Function(this, 'Orchestrator', {
      runtime: lambda.Runtime.NODEJS_24_X, architecture: lambda.Architecture.ARM_64, handler: 'index.handler',
      code: lambda.Code.fromAsset(bundle('orchestrator', 'packages/orchestrator/src/lambda.ts')),
      timeout: Duration.minutes(5), memorySize: 512,
      // One year is the platform maximum for a durable execution. Human waits are bounded separately by HUMAN_WAIT_TIMEOUT.
      durableConfig: { executionTimeout: Duration.days(365), retentionPeriod: Duration.days(30) },
      environment: {
        TABLE_NAME: state.table.tableName,
        TOKEN_VENDOR_FUNCTION: state.tokenVendor.functionArn,
        MICROVM_IMAGE_ARN: sandbox.image.attrImageArn,
        MICROVM_IMAGE_VERSION_PARAM: IMAGE_VERSION_PARAM,
        SEGMENT_ROLE_ARN: sandbox.segmentRole.roleArn,
        BEDROCK_MODEL_ID: cfg.bedrockModelId,
        MAX_TOKENS_PER_ISSUE: cfg.maxTokensPerIssue,
        GITHUB_ORG: cfg.githubOrg,
        AGENT_LABEL: cfg.agentLabel,
      },
    });
    this.alias = new lambda.Alias(this, 'Live', { aliasName: 'live', version: this.fn.currentVersion });

    state.table.grantReadWriteData(this.fn);
    this.fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'], resources: [Stack.of(this).formatArn({ service: 'ssm', resource: 'parameter', resourceName: IMAGE_VERSION_PARAM.slice(1) })],
    }));
    state.tokenVendor.grantInvoke(this.fn);
    this.fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['lambda:RunMicrovm', 'lambda:GetMicrovm', 'lambda:TerminateMicrovm', 'lambda:CreateMicrovmAuthToken', 'lambda:ListMicrovms'],
      resources: ['*'],
    }));
    // RunMicrovm attaches the default egress connector (public internet), which needs its own pass permission.
    this.fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['lambda:PassNetworkConnector'], resources: [`arn:aws:lambda:${this.region}:aws:network-connector:aws-network-connector:*`],
    }));
    this.fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'], resources: [sandbox.segmentRole.roleArn],
      conditions: { StringEquals: { 'iam:PassedToService': 'lambda.amazonaws.com' } },
    }));

    // Callback permissions. Kept in separate policies so they can name the function without a dependency cycle.
    const callbackActions = ['lambda:SendDurableExecutionCallbackSuccess', 'lambda:SendDurableExecutionCallbackFailure'];
    const fnArns = [this.fn.functionArn, `${this.fn.functionArn}:*`];
    new iam.Policy(this, 'SelfCallbackPolicy', {
      roles: [this.fn.role!], statements: [new iam.PolicyStatement({ actions: callbackActions, resources: fnArns })],
    });
    // Segments report their result with the same calls. The role lives in the sandbox stack, so import it mutably.
    const segmentRole = iam.Role.fromRoleArn(this, 'ImportedSegmentRole', sandbox.segmentRole.roleArn, { mutable: true });
    new iam.Policy(this, 'SegmentCallbackPolicy', {
      roles: [segmentRole], statements: [new iam.PolicyStatement({ actions: callbackActions, resources: fnArns })],
    });

    // Alarm on issues that end FAILED.
    const failed = new logs.MetricFilter(this, 'FailedFilter', {
      logGroup: this.fn.logGroup, filterPattern: logs.FilterPattern.literal('{ $.msg = "issue finished" && $.status = "FAILED" }'),
      metricNamespace: 'AiDeveloperAgent', metricName: 'IssuesFailed', metricValue: '1',
    });
    const failedAlarm = new cw.Alarm(this, 'FailedAlarm', {
      metric: failed.metric({ statistic: 'Sum', period: Duration.minutes(5) }), threshold: 1, evaluationPeriods: 1,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING, alarmDescription: 'An issue run ended in FAILED',
    });
    // Bedrock throttles for the configured model.
    const throttles = new cw.Alarm(this, 'BedrockThrottleAlarm', {
      metric: new cw.Metric({ namespace: 'AWS/Bedrock', metricName: 'InvocationThrottles', dimensionsMap: { ModelId: cfg.bedrockModelId }, statistic: 'Sum', period: Duration.minutes(5) }),
      threshold: 5, evaluationPeriods: 1, treatMissingData: cw.TreatMissingData.NOT_BREACHING, alarmDescription: 'Bedrock is throttling the agent',
    });
    if (state.alarmTopic) for (const a of [failedAlarm, throttles]) a.addAlarmAction({ bind: () => ({ alarmActionArn: state.alarmTopic!.topicArn }) });
  }
}
